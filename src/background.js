const TAG = '[IG-BG]';
const DEFAULT_APP_ID = '936619743392459';
const DEFAULT_MAX_AGE_HOURS = 48;
const FOLLOWING_QUERY_HASH = '58712303d941c6855d4e888c5f0cd22f';
const INSTAGRAM_AUTH_RULE_ID = 1;
const INSTAGRAM_AUTH_COOKIE_NAMES = [
    'sessionid',
    'csrftoken',
    'ds_user_id',
    'mid',
    'ig_did',
    'rur',
];
let instagramAuthState = { expiresAt: 0, csrfToken: '', pending: null };

async function getSettings() {
    const { appId, maxAgeHours } = await chrome.storage.local.get(['appId', 'maxAgeHours']);
    return {
        appId: appId ?? DEFAULT_APP_ID,
        maxAgeMs: (maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3600 * 1000,
    };
}
const BATCH_SIZE = 5;
const CACHE_KEY = 'feedCache';
const CACHE_VERSION = 3;
const CACHE_TTL = 5 * 60 * 1000; // refresh if older than 5 minutes
const FOLLOWING_CACHE_KEY = 'followingListCache';
const FOLLOWING_CACHE_TTL = 15 * 60 * 1000;
const USER_FEED_CACHE_KEY = 'userFeedCache';
const USER_FEED_CACHE_TTL = 10 * 60 * 1000;
const avatarCache = new Map();

function sendFetchProgress(scope, percent, details = {}) {
    chrome.runtime.sendMessage({
        type: 'FETCH_PROGRESS',
        scope,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        ...details,
    }, () => void chrome.runtime.lastError);
}

function isAllowedAvatarUrl(rawUrl) {
    try {
        const { protocol, hostname } = new URL(rawUrl);
        return protocol === 'https:' && [
            'cdninstagram.com',
            'fbcdn.net',
        ].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch {
        return false;
    }
}

async function fetchAvatar(url) {
    if (!isAllowedAvatarUrl(url)) throw new Error('Unsupported avatar host');
    if (avatarCache.has(url)) return avatarCache.get(url);

    const pending = (async () => {
        const response = await fetch(url, {
            credentials: 'include',
            referrerPolicy: 'no-referrer',
            cache: 'force-cache',
        });
        if (!response.ok) throw new Error(`Avatar request failed: ${response.status}`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.startsWith('image/')) throw new Error('Avatar response is not an image');

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('Avatar image is too large');
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return `data:${contentType};base64,${btoa(binary)}`;
    })();

    avatarCache.set(url, pending);
    try {
        return await pending;
    } catch (error) {
        avatarCache.delete(url);
        throw error;
    }
}

async function refreshInstagramAuthRule() {
    if (instagramAuthState.expiresAt > Date.now()) {
        return instagramAuthState.csrfToken;
    }
    if (instagramAuthState.pending) return instagramAuthState.pending;

    instagramAuthState.pending = (async () => {
        const cookies = (await Promise.all(INSTAGRAM_AUTH_COOKIE_NAMES.map(name =>
            chrome.cookies.get({ url: 'https://www.instagram.com/', name })
        ))).filter(Boolean);
        const sessionCookie = cookies.find(cookie => cookie.name === 'sessionid');
        if (!sessionCookie?.value) {
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [INSTAGRAM_AUTH_RULE_ID],
            });
            throw new Error('Not logged in to Instagram');
        }

        const cookieHeader = cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [INSTAGRAM_AUTH_RULE_ID],
            addRules: [{
                id: INSTAGRAM_AUTH_RULE_ID,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Cookie', operation: 'set', value: cookieHeader },
                        { header: 'Referer', operation: 'set', value: 'https://www.instagram.com/' },
                    ],
                },
                condition: {
                    regexFilter: '^https://www\\.instagram\\.com/(api/v1/|graphql/query/)',
                    resourceTypes: ['xmlhttprequest'],
                    // Only extension service-worker requests have no tab.
                    tabIds: [chrome.tabs.TAB_ID_NONE],
                },
            }],
        });

        const csrfToken = cookies.find(cookie => cookie.name === 'csrftoken')?.value ?? '';
        instagramAuthState = {
            expiresAt: Date.now() + 60 * 1000,
            csrfToken,
            pending: null,
        };
        return csrfToken;
    })();

    try {
        return await instagramAuthState.pending;
    } catch (error) {
        instagramAuthState = { expiresAt: 0, csrfToken: '', pending: null };
        throw error;
    }
}

async function igFetch(path) {
    const [csrfToken, { appId }] = await Promise.all([
        refreshInstagramAuthRule(),
        getSettings(),
    ]);
    const r = await fetch(`https://www.instagram.com${path}`, {
        credentials: 'include',
        headers: {
            'X-IG-App-ID': appId,
            'X-CSRFToken': csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
        }
    });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
}

async function getSelfId() {
    const cookie = await chrome.cookies.get({ url: 'https://www.instagram.com', name: 'ds_user_id' });
    if (!cookie?.value) throw new Error('Not logged in to Instagram');
    return cookie.value;
}

function normalizeFollowingUser(user) {
    return {
        ...user,
        pk: String(user.pk ?? user.id),
    };
}

async function getFollowingGraphql(selfId, onPage = null) {
    const all = [];
    let cursor = null;
    let page = 0;
    do {
        const variables = {
            id: String(selfId),
            include_reel: true,
            fetch_mutual: false,
            first: 50,
        };
        if (cursor) variables.after = cursor;

        const path = `/graphql/query/?query_hash=${FOLLOWING_QUERY_HASH}` +
            `&variables=${encodeURIComponent(JSON.stringify(variables))}`;
        const d = await igFetch(path);
        const connection = d.data?.user?.edge_follow;
        if (!connection) throw new Error('Unexpected following-list response');

        all.push(...(connection.edges ?? []).map(edge => normalizeFollowingUser(edge.node)));
        cursor = connection.page_info?.has_next_page
            ? connection.page_info.end_cursor
            : null;
        page += 1;
        onPage?.({ loaded: all.length, hasMore: Boolean(cursor), page });
    } while (cursor);
    return all;
}

async function getFollowingRest(selfId, onPage = null) {
    const all = [];
    let cursor = null;
    let page = 0;
    const rankToken = `${selfId}_${crypto.randomUUID().toUpperCase()}`;
    do {
        const params = new URLSearchParams({
            count: '50',
            rank_token: rankToken,
            search_surface: 'follow_list_page',
            query: '',
            enable_groups: 'true',
        });
        if (cursor) params.set('max_id', cursor);
        const d = await igFetch(`/api/v1/friendships/${selfId}/following/?${params}`);
        all.push(...(d.users ?? []).map(normalizeFollowingUser));
        cursor = d.next_max_id ?? null;
        page += 1;
        onPage?.({ loaded: all.length, hasMore: Boolean(cursor), page });
    } while (cursor);
    return all;
}

async function getFollowing(selfId, onPage = null) {
    try {
        return await getFollowingGraphql(selfId, onPage);
    } catch (graphqlError) {
        console.warn(TAG, 'web following-list request failed; trying REST fallback', graphqlError);
        try {
            return await getFollowingRest(selfId, onPage);
        } catch (restError) {
            throw new Error(
                `Unable to load following list: ${graphqlError.message}; fallback: ${restError.message}`
            );
        }
    }
}

function slimPost(post) {
    function compactCandidates(candidates = []) {
        const valid = candidates.filter(candidate => candidate?.url);
        const preferred = valid.find(candidate => candidate.width <= 640) ?? valid[0];
        if (!preferred) return [];

        const alternatives = valid
            .filter(candidate => candidate.url !== preferred.url)
            .sort((a, b) => Math.abs((a.width ?? 640) - 640) - Math.abs((b.width ?? 640) - 640));
        return [preferred, alternatives[0], valid[0], ...alternatives]
            .filter((candidate, index, ordered) =>
                candidate && ordered.findIndex(item => item?.url === candidate.url) === index)
            .slice(0, 3)
            .map(candidate => ({ width: candidate.width, url: candidate.url }));
    }
    const author = post.user ?? post._user;
    const profilePicUrl = post.user?.profile_pic_url
        ?? post.user?.hd_profile_pic_url_info?.url
        ?? post.user?.profile_pic_url_hd
        ?? post._user?.profile_pic_url
        ?? post._user?.hd_profile_pic_url_info?.url
        ?? post._user?.profile_pic_url_hd;
    return {
        pk: post.pk,
        id: post.id,
        code: post.code,
        media_type: post.media_type,
        taken_at: post.taken_at,
        caption: post.caption?.text ? { text: post.caption.text } : undefined,
        image_versions2: post.image_versions2
            ? { candidates: compactCandidates(post.image_versions2.candidates) }
            : undefined,
        carousel_media: post.carousel_media?.map(m => ({
            image_versions2: { candidates: compactCandidates(m.image_versions2?.candidates) },
        })),
        _user: author ? {
            username: post.user?.username ?? post._user?.username,
            profile_pic_url: profilePicUrl,
        } : undefined,
    };
}

async function getUserPosts(user) {
    try {
        const d = await igFetch(`/api/v1/feed/user/${user.pk}/`);
        const { maxAgeMs } = await getSettings();
        const cutoff = Date.now() - maxAgeMs;
        return (d.items ?? [])
            .filter(p => p.taken_at * 1000 > cutoff)
            // The post response contains a fresher author image than the
            // friendships response, which can return a placeholder URL.
            .map(p => slimPost({ ...p, _user: user }));
    } catch {
        return [];
    }
}

async function getCachedFollowing() {
    const { followingListCache } = await chrome.storage.local.get(FOLLOWING_CACHE_KEY);
    if (followingListCache && (Date.now() - followingListCache.cachedAt) < FOLLOWING_CACHE_TTL) {
        return followingListCache.users;
    }
    const selfId = await getSelfId();
    const users = await getFollowing(selfId);
    users.sort((a, b) => a.username.localeCompare(b.username));
    await chrome.storage.local.set({ [FOLLOWING_CACHE_KEY]: { users, cachedAt: Date.now() } });
    return users;
}

const USER_FEED_CACHE_MAX_USERS = 20;

async function fetchUserFeed(userId, reportProgress = false) {
    const posts = [];
    let cursor = null;
    let completedPages = 0;
    const startedAt = Date.now();
    if (reportProgress) {
        sendFetchProgress('user', 5, { userId: String(userId), label: 'Connecting to Instagram' });
    }
    do {
        const qs = cursor ? `?count=12&max_id=${cursor}` : '?count=12';
        const d = await igFetch(`/api/v1/feed/user/${userId}/${qs}`);
        posts.push(...(d.items ?? []));
        cursor = d.next_max_id ?? null;
        completedPages += 1;
        if (reportProgress) {
            const percent = cursor && posts.length < 60
                ? 10 + (Math.min(posts.length, 60) / 60) * 80
                : 95;
            const remainingPages = cursor
                ? Math.max(1, Math.ceil((60 - Math.min(posts.length, 60)) / 12))
                : 0;
            const averagePageMs = (Date.now() - startedAt) / completedPages;
            sendFetchProgress('user', percent, {
                userId: String(userId),
                label: `Fetched ${posts.length} posts`,
                etaMs: remainingPages ? averagePageMs * remainingPages : 0,
            });
        }
        if (posts.length >= 60) break;
    } while (cursor);
    const slimmed = posts.map(p => slimPost(p));
    if (reportProgress) {
        sendFetchProgress('user', 100, { userId: String(userId), label: 'Ready' });
    }
    return slimmed;
}

function evictUserFeedCache(cache, updatedUserId) {
    const entries = Object.entries(cache);
    if (entries.length <= USER_FEED_CACHE_MAX_USERS) return cache;
    // Evict oldest entries, but always keep the one we just wrote
    entries.sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    const evicted = new Set(
        entries.slice(0, entries.length - USER_FEED_CACHE_MAX_USERS).map(([id]) => id)
    );
    evicted.delete(updatedUserId);
    return Object.fromEntries(entries.filter(([id]) => !evicted.has(id)));
}

async function getUserFeed(userId, reportProgress = false) {
    const { userFeedCache } = await chrome.storage.local.get(USER_FEED_CACHE_KEY);
    const cached = userFeedCache?.[userId];
    const isStale = cached && (Date.now() - cached.cachedAt) > USER_FEED_CACHE_TTL;

    if (isStale) {
        fetchUserFeed(userId).then(async posts => {
            const { userFeedCache: cur } = await chrome.storage.local.get(USER_FEED_CACHE_KEY);
            const updated = { ...(cur ?? {}), [userId]: { posts, cachedAt: Date.now() } };
            await chrome.storage.local.set({
                [USER_FEED_CACHE_KEY]: evictUserFeedCache(updated, userId),
            });
        }).catch(e => console.error(TAG, 'user feed refresh failed', e));
    }

    if (cached) return { posts: cached.posts, cachedAt: cached.cachedAt, fromCache: true };

    const posts = await fetchUserFeed(userId, reportProgress);
    const now = Date.now();
    const { userFeedCache: cur } = await chrome.storage.local.get(USER_FEED_CACHE_KEY);
    const updated = { ...(cur ?? {}), [userId]: { posts, cachedAt: now } };
    await chrome.storage.local.set({
        [USER_FEED_CACHE_KEY]: evictUserFeedCache(updated, userId),
    });
    return { posts, cachedAt: now, fromCache: false };
}

async function fetchAndCache(reportProgress = false) {
    if (reportProgress) sendFetchProgress('all', 2, { label: 'Connecting to Instagram' });
    const selfId = await getSelfId();
    console.log(TAG, `👤 ${selfId}`);

    if (reportProgress) sendFetchProgress('all', 5, { label: 'Loading following list' });
    const following = await getFollowing(selfId, reportProgress
        ? ({ loaded, hasMore, page }) => {
            sendFetchProgress('all', hasMore ? Math.min(9, 5 + page) : 10, {
                label: hasMore ? `Found ${loaded} accounts so far` : `Found ${loaded} accounts`,
            });
        }
        : null);
    console.log(TAG, `👥 ${following.length} following`);

    const posts = [];
    const accountFetchStartedAt = Date.now();
    for (let i = 0; i < following.length; i += BATCH_SIZE) {
        const batch = following.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(getUserPosts));
        results.forEach(r => posts.push(...r));
        if (reportProgress) {
            const completed = Math.min(i + batch.length, following.length);
            const percent = 10 + (completed / following.length) * 85;
            const elapsedMs = Date.now() - accountFetchStartedAt;
            const etaMs = completed < following.length
                ? (elapsedMs / completed) * (following.length - completed)
                : 0;
            sendFetchProgress('all', percent, {
                label: `Loaded ${completed} of ${following.length} accounts`,
                etaMs,
            });
        }
    }

    if (reportProgress) sendFetchProgress('all', 98, { label: 'Preparing feed' });
    posts.sort((a, b) => b.taken_at - a.taken_at);
    const data = {
        version: CACHE_VERSION,
        posts,
        followingCount: following.length,
        cachedAt: Date.now(),
    };
    await chrome.storage.local.set({ [CACHE_KEY]: data });
    console.log(TAG, `💾 cached ${posts.length} posts`);
    if (reportProgress) sendFetchProgress('all', 100, { label: 'Ready' });
    return data;
}

async function getFeed(reportProgress = false) {
    const { feedCache } = await chrome.storage.local.get(CACHE_KEY);
    if (!feedCache || feedCache.version !== CACHE_VERSION) {
        return fetchAndCache(reportProgress);
    }

    const isStale = (Date.now() - feedCache.cachedAt) > CACHE_TTL;

    if (isStale) {
        fetchAndCache(); // refresh in background — don't await
    }

    return feedCache;
}

chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'FETCH_FEED') {
        getFeed(true)
            .then(data => sendResponse({ ok: true, ...data }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (message.type === 'FORCE_REFRESH') {
        chrome.storage.local.remove(CACHE_KEY);
        fetchAndCache(true)
            .then(data => sendResponse({ ok: true, ...data }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (message.type === 'GET_FOLLOWING_LIST') {
        getCachedFollowing()
            .then(users => sendResponse({ ok: true, users }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (message.type === 'FETCH_USER_FEED') {
        getUserFeed(message.userId, true)
            .then(data => sendResponse({ ok: true, ...data }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (message.type === 'FETCH_AVATAR') {
        fetchAvatar(message.url)
            .then(dataUrl => sendResponse({ ok: true, dataUrl }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
});
