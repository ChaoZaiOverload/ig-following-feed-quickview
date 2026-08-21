function escape(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function timeAgo(taken_at) {
    const s = Math.floor(Date.now() / 1000 - taken_at);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

function cacheAgo(cachedAt) {
    const s = Math.floor((Date.now() - cachedAt) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

let activeProgress = null;

function formatEta(milliseconds) {
    const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
    if (seconds < 60) return `${seconds}s left`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes}m left`;
}

function renderProgress() {
    if (!activeProgress) return;
    const progress = document.getElementById('progress');
    const { percent, label, etaDeadline } = activeProgress;
    const etaMs = etaDeadline == null ? null : Math.max(0, etaDeadline - Date.now());
    const etaText = percent >= 100
        ? 'Ready'
        : etaMs == null
            ? 'Estimating…'
            : formatEta(etaMs);

    progress.hidden = false;
    progress.title = label;
    progress.setAttribute('aria-valuenow', String(percent));
    progress.setAttribute('aria-valuetext', `${percent}% — ${label} — ${etaText}`);
    document.getElementById('progress-label').textContent = `${percent}% · ${etaText}`;
    document.getElementById('progress-bar').style.width = `${percent}%`;
}

function progressMatches(scope, userId) {
    return activeProgress?.scope === scope &&
        (scope !== 'user' || activeProgress.userId === String(userId));
}

function updateProgress(scope, percent, label, userId = null, etaMs = null) {
    if (!progressMatches(scope, userId)) return;
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    activeProgress.percent = value;
    activeProgress.label = label;
    activeProgress.etaDeadline = Number.isFinite(etaMs) && etaMs > 0
        ? Date.now() + etaMs
        : etaMs === 0 ? Date.now() : null;
    renderProgress();
}

function startProgress(scope, userId = null, label = 'Starting') {
    activeProgress = {
        scope,
        userId: userId == null ? null : String(userId),
        percent: 0,
        label,
        etaDeadline: null,
    };
    updateProgress(scope, 0, label, userId);
}

function clearProgress(scope = null, userId = null) {
    if (scope && !progressMatches(scope, userId)) return;
    activeProgress = null;
    document.getElementById('progress').hidden = true;
}

setInterval(renderProgress, 1000);

function candidateUrls(media) {
    return (media?.image_versions2?.candidates ?? [])
        .map(candidate => candidate.url)
        .filter(Boolean);
}

function getImageCandidates(post) {
    if (post.media_type === 8) {
        return candidateUrls(post.carousel_media?.[0]);
    }
    return candidateUrls(post);
}

function getImageCandidateLists(post) {
    if (post.media_type === 8) {
        return (post.carousel_media ?? [])
            .map(candidateUrls)
            .filter(candidates => candidates.length);
    }
    const candidates = getImageCandidates(post);
    return candidates.length ? [candidates] : [];
}

function loadPostImage(img, candidates) {
    let candidateIndex = 0;
    img.addEventListener('error', () => {
        candidateIndex += 1;
        if (candidateIndex < candidates.length) {
            img.src = candidates[candidateIndex];
        } else {
            img.hidden = true;
        }
    });
    img.src = candidates[candidateIndex];
}

function loadAvatar(img, url) {
    if (!url) {
        img.hidden = true;
        return;
    }

    img.referrerPolicy = 'no-referrer';
    let triedBackgroundLoad = false;
    img.addEventListener('error', () => {
        if (triedBackgroundLoad) {
            img.hidden = true;
            return;
        }
        triedBackgroundLoad = true;
        chrome.runtime.sendMessage({ type: 'FETCH_AVATAR', url }, response => {
            if (response?.ok) {
                img.src = response.dataUrl;
            } else {
                img.hidden = true;
            }
        });
    });
    img.src = url;
}

function buildCard(post, showUser) {
    if (showUser) {
        const candidates = getImageCandidates(post);
        if (!candidates.length) return null;

        const card = document.createElement('div');
        card.className = 'card';

        const header = document.createElement('div');
        header.className = 'card-header';
        header.innerHTML = `
            <img alt="" />
            <a class="username" href="https://instagram.com/${escape(post._user.username)}/" target="_blank">${escape(post._user.username)}</a>
            <span class="time">${timeAgo(post.taken_at)}</span>
        `;
        loadAvatar(header.querySelector('img'), post._user.profile_pic_url);
        card.appendChild(header);

        const wrap = document.createElement('div');
        wrap.className = 'card-img-wrap';
        const imgEl = document.createElement('img');
        imgEl.className = 'card-img';
        imgEl.loading = 'lazy';
        loadPostImage(imgEl, candidates);
        wrap.appendChild(imgEl);
        if (post.media_type === 8 && post.carousel_media?.length > 1) {
            const badge = document.createElement('span');
            badge.className = 'carousel-badge';
            badge.textContent = `⧉ ${post.carousel_media.length}`;
            wrap.appendChild(badge);
        }
        const link = document.createElement('a');
        link.href = `https://instagram.com/p/${escape(post.code)}/`;
        link.target = '_blank';
        link.style.display = 'block';
        link.appendChild(wrap);
        card.appendChild(link);

        if (post.caption?.text) {
            const cap = document.createElement('div');
            cap.className = 'card-caption';
            cap.textContent = post.caption.text;
            card.appendChild(cap);
        }
        return card;
    } else {
        // Single-user: full-width post row, each image takes one grid column
        const candidateLists = getImageCandidateLists(post);
        if (!candidateLists.length) return null;

        const card = document.createElement('div');
        card.className = 'card-post';

        const meta = document.createElement('div');
        meta.className = 'post-meta';
        meta.innerHTML = `<span class="time">${timeAgo(post.taken_at)}</span><a href="https://instagram.com/p/${escape(post.code)}/" target="_blank">Open ↗</a>`;
        card.appendChild(meta);

        const images = document.createElement('a');
        images.className = 'post-images';
        images.href = `https://instagram.com/p/${escape(post.code)}/`;
        images.target = '_blank';
        candidateLists.forEach(candidates => {
            const wrap = document.createElement('div');
            wrap.className = 'card-img-wrap';
            const imgEl = document.createElement('img');
            imgEl.className = 'card-img';
            imgEl.loading = 'lazy';
            loadPostImage(imgEl, candidates);
            wrap.appendChild(imgEl);
            images.appendChild(wrap);
        });
        card.appendChild(images);

        if (post.caption?.text) {
            const cap = document.createElement('div');
            cap.className = 'card-caption';
            cap.textContent = post.caption.text;
            card.appendChild(cap);
        }
        return card;
    }
}

function renderGrid(posts, showUser = true) {
    const feed = document.getElementById('feed');
    feed.innerHTML = '';
    for (const post of posts) {
        const card = buildCard(post, showUser);
        if (card) feed.appendChild(card);
    }
}

// --- All Following mode ---

function renderAllFeed({ posts, followingCount, cachedAt }) {
    clearProgress('all');
    const msg = document.getElementById('message');
    if (msg) msg.remove();
    document.getElementById('status').textContent =
        `${posts.length} posts · ${followingCount} following · updated ${cacheAgo(cachedAt)}`;
    renderGrid(posts, true);
}

function setRefreshing(on) {
    const btn = document.getElementById('refresh');
    btn.disabled = on;
    btn.textContent = on ? '↻ Refreshing...' : '↻ Refresh';
}

function loadAllFeed() {
    startProgress('all', null, 'Loading feed');
    document.getElementById('status').textContent = 'Loading…';
    const msg = document.getElementById('message');
    if (msg) msg.textContent = 'Fetching posts from people you follow...';
    chrome.runtime.sendMessage({ type: 'FETCH_FEED' }, response => {
        if (mode !== 'all') return;
        const msgEl = document.getElementById('message');
        if (response?.ok) {
            if (msgEl) msgEl.remove();
            renderAllFeed(response);
        } else {
            clearProgress('all');
            if (msgEl) msgEl.textContent = `Error: ${response?.error ?? 'unknown error'}`;
        }
    });
}

// --- Favorites ---

const FAVORITES_KEY = 'favoriteUsers';
let favoritePks = new Set();
let favoriteUsers = []; // full user objects, persisted independently

async function loadFavorites() {
    return new Promise(resolve => {
        chrome.storage.local.get(FAVORITES_KEY, ({ favoriteUsers: stored }) => {
            favoriteUsers = stored ?? [];
            favoritePks = new Set(favoriteUsers.map(u => u.pk));
            resolve();
        });
    });
}

function saveFavorites() {
    chrome.storage.local.set({ [FAVORITES_KEY]: favoriteUsers });
}

function toggleFavorite(user, event) {
    event.stopPropagation();
    if (favoritePks.has(user.pk)) {
        favoritePks.delete(user.pk);
        favoriteUsers = favoriteUsers.filter(u => u.pk !== user.pk);
    } else {
        favoritePks.add(user.pk);
        favoriteUsers.push({ pk: user.pk, username: user.username, profile_pic_url: user.profile_pic_url });
    }
    saveFavorites();
    renderUserList();
}

function makeChip(user) {
    const isFav = favoritePks.has(user.pk);
    const chip = document.createElement('button');
    chip.className = 'user-chip' +
        (selectedUser?.pk === user.pk ? ' selected' : '') +
        (isFav ? ' favorited' : '');
    chip.innerHTML = `<img alt="" /><span>${escape(user.username)}</span>`;
    loadAvatar(chip.querySelector('img'), user.profile_pic_url);
    const star = document.createElement('button');
    star.className = 'fav-btn';
    star.title = isFav ? 'Unfavorite' : 'Favorite';
    star.textContent = isFav ? '★' : '☆';
    star.addEventListener('click', e => toggleFavorite(user, e));
    chip.appendChild(star);
    chip.addEventListener('click', () => selectUser(user));
    return chip;
}

// --- One User mode ---

let allFollowing = [];
let selectedUser = null;

function renderUserList() {
    const list = document.getElementById('user-list');
    const query = document.getElementById('user-search').value.toLowerCase().trim();

    list.innerHTML = '';

    // Favorites section — always shown at top, not filtered by search
    if (favoriteUsers.length) {
        favoriteUsers.forEach(user => list.appendChild(makeChip(user)));
        const divider = document.createElement('div');
        divider.className = 'fav-divider';
        list.appendChild(divider);
    }

    const nonFavs = allFollowing.filter(u => !favoritePks.has(u.pk));
    const filtered = query
        ? nonFavs.filter(u =>
            u.username.toLowerCase().includes(query) ||
            (u.full_name || '').toLowerCase().includes(query))
        : nonFavs;

    if (!filtered.length && !favoriteUsers.length) {
        list.innerHTML = '<span id="user-hint">No matches</span>';
        return;
    }

    filtered.slice(0, 40).forEach(user => list.appendChild(makeChip(user)));

    if (filtered.length > 40) {
        const more = document.createElement('span');
        more.id = 'user-hint';
        more.style.fontSize = '12px';
        more.style.color = '#8e8e8e';
        more.style.alignSelf = 'center';
        more.textContent = `+${filtered.length - 40} more — type to filter`;
        list.appendChild(more);
    }
}

function loadFollowingList() {
    if (allFollowing.length) {
        renderUserList();
        return;
    }
    document.getElementById('user-list').innerHTML = '<span id="user-hint">Loading following list…</span>';
    loadFavorites().then(() => {
        chrome.runtime.sendMessage({ type: 'GET_FOLLOWING_LIST' }, response => {
            if (response?.ok) {
                allFollowing = response.users;
                renderUserList();
            } else {
                document.getElementById('user-list').innerHTML =
                    `<span id="user-hint">Error: ${response?.error ?? 'unknown'}</span>`;
            }
        });
    });
}

function applyUserFeed(user, posts, cachedAt, fromCache) {
    clearProgress('user', user.pk);
    const cacheInfo = fromCache ? ` · cached ${cacheAgo(cachedAt)}` : '';
    document.getElementById('status').textContent =
        `${posts.length} posts · @${user.username}${cacheInfo}`;
    const msg = document.getElementById('message');
    if (msg) msg.remove();
    renderGrid(posts, false);
}

function selectUser(user) {
    selectedUser = user;
    startProgress('user', user.pk, `Loading @${user.username}`);
    renderUserList();
    document.getElementById('status').textContent = `Loading @${user.username}…`;
    document.getElementById('feed').innerHTML = '';
    chrome.runtime.sendMessage({ type: 'FETCH_USER_FEED', userId: user.pk }, response => {
        if (mode !== 'user' || selectedUser?.pk !== user.pk) return;
        if (response?.ok) {
            const posts = response.posts.map(p => ({
                ...p,
                _user: { username: user.username, profile_pic_url: user.profile_pic_url },
            }));
            applyUserFeed(user, posts, response.cachedAt, response.fromCache);
        } else {
            clearProgress('user', user.pk);
            document.getElementById('status').textContent =
                `Error: ${response?.error ?? 'unknown'}`;
        }
    });
}

// --- Mode switching ---

let mode = 'all';

function switchMode(newMode) {
    if (newMode === mode) return;
    mode = newMode;
    clearProgress();
    document.getElementById('tab-all').classList.toggle('active', mode === 'all');
    document.getElementById('tab-user').classList.toggle('active', mode === 'user');
    document.getElementById('refresh').style.display = mode === 'all' ? '' : 'none';
    document.getElementById('user-picker').style.display = mode === 'user' ? 'block' : 'none';

    document.getElementById('feed').innerHTML = '';
    if (mode === 'all') {
        loadAllFeed();
    } else {
        document.getElementById('status').textContent = selectedUser
            ? `@${selectedUser.username}`
            : 'Select a user above';
        loadFollowingList();
        if (selectedUser) selectUser(selectedUser);
    }
}

document.getElementById('tab-all').addEventListener('click', () => switchMode('all'));
document.getElementById('tab-user').addEventListener('click', () => switchMode('user'));

document.getElementById('user-search').addEventListener('input', renderUserList);

document.getElementById('refresh').addEventListener('click', () => {
    setRefreshing(true);
    startProgress('all', null, 'Refreshing feed');
    chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' }, response => {
        setRefreshing(false);
        if (response?.ok && mode === 'all') {
            renderAllFeed(response);
        } else {
            clearProgress('all');
        }
    });
});

chrome.runtime.onMessage.addListener(message => {
    if (message.type !== 'FETCH_PROGRESS') return;
    updateProgress(message.scope, message.percent, message.label, message.userId, message.etaMs);
});

// Re-render when background finishes a fresh fetch
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.feedCache?.newValue && mode === 'all') {
        renderAllFeed(changes.feedCache.newValue);
    }
    if (changes.userFeedCache?.newValue && mode === 'user' && selectedUser) {
        const entry = changes.userFeedCache.newValue[selectedUser.pk];
        if (entry) {
            const posts = entry.posts.map(p => ({
                ...p,
                _user: { username: selectedUser.username, profile_pic_url: selectedUser.profile_pic_url },
            }));
            applyUserFeed(selectedUser, posts, entry.cachedAt, true);
        }
    }
});

// Initial load
loadAllFeed();
