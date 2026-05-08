const TAG = '[IG-BG]';
const DEFAULT_APP_ID = '936619743392459';
const DEFAULT_MAX_AGE_HOURS = 48;

async function getSettings() {
    const { appId, maxAgeHours } = await chrome.storage.local.get(['appId', 'maxAgeHours']);
    return {
        appId: appId ?? DEFAULT_APP_ID,
        maxAgeMs: (maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3600 * 1000,
    };
}
const BATCH_SIZE = 5;
const CACHE_KEY = 'feedCache';
const CACHE_TTL = 5 * 60 * 1000; // refresh if older than 5 minutes

async function igFetch(path) {
    const [csrfCookie, { appId }] = await Promise.all([
        chrome.cookies.get({ url: 'https://www.instagram.com', name: 'csrftoken' }),
        getSettings(),
    ]);
    const r = await fetch(`https://www.instagram.com${path}`, {
        credentials: 'include',
        headers: {
            'X-IG-App-ID': appId,
            'X-CSRFToken': csrfCookie?.value ?? '',
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

async function getFollowing(selfId) {
    const all = [];
    let cursor = null;
    do {
        const qs = cursor ? `?count=50&max_id=${cursor}` : '?count=50';
        const d = await igFetch(`/api/v1/friendships/${selfId}/following/${qs}`);
        all.push(...(d.users ?? []));
        cursor = d.next_max_id ?? null;
    } while (cursor);
    return all;
}

async function getUserPosts(user) {
    try {
        const d = await igFetch(`/api/v1/feed/user/${user.pk}/`);
        const { maxAgeMs } = await getSettings();
        const cutoff = Date.now() - maxAgeMs;
        return (d.items ?? [])
            .filter(p => p.taken_at * 1000 > cutoff)
            .map(p => ({ ...p, _user: { username: user.username, profile_pic_url: user.profile_pic_url } }));
    } catch {
        return [];
    }
}

async function fetchAndCache() {
    const selfId = await getSelfId();
    console.log(TAG, `👤 ${selfId}`);

    const following = await getFollowing(selfId);
    console.log(TAG, `👥 ${following.length} following`);

    const posts = [];
    for (let i = 0; i < following.length; i += BATCH_SIZE) {
        const batch = following.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(getUserPosts));
        results.forEach(r => posts.push(...r));
    }

    posts.sort((a, b) => b.taken_at - a.taken_at);
    const data = { posts, followingCount: following.length, cachedAt: Date.now() };
    await chrome.storage.local.set({ [CACHE_KEY]: data });
    console.log(TAG, `💾 cached ${posts.length} posts`);
    return data;
}

async function getFeed() {
    const { feedCache } = await chrome.storage.local.get(CACHE_KEY);
    const isStale = !feedCache || (Date.now() - feedCache.cachedAt) > CACHE_TTL;

    if (isStale) {
        fetchAndCache(); // refresh in background — don't await
    }

    // Return cache immediately if available, otherwise wait for fresh fetch
    return feedCache ?? await fetchAndCache();
}

chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'FETCH_FEED') {
        getFeed()
            .then(data => sendResponse({ ok: true, ...data }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (message.type === 'FORCE_REFRESH') {
        chrome.storage.local.remove(CACHE_KEY);
        fetchAndCache()
            .then(data => sendResponse({ ok: true, ...data }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
});
