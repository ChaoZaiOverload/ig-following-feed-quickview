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

function getImageUrl(post) {
    if (post.media_type === 8) {
        const c = post.carousel_media?.[0]?.image_versions2?.candidates ?? [];
        return c.find(x => x.width <= 640)?.url ?? c[0]?.url;
    }
    const c = post.image_versions2?.candidates ?? [];
    return c.find(x => x.width <= 640)?.url ?? c[0]?.url;
}

function getImageUrls(post) {
    if (post.media_type === 8) {
        return (post.carousel_media ?? []).map(m => {
            const c = m.image_versions2?.candidates ?? [];
            return c.find(x => x.width <= 640)?.url ?? c[0]?.url;
        }).filter(Boolean);
    }
    const url = getImageUrl(post);
    return url ? [url] : [];
}

function buildCard(post, showUser) {
    if (showUser) {
        const url = getImageUrl(post);
        if (!url) return null;

        const card = document.createElement('div');
        card.className = 'card';

        const header = document.createElement('div');
        header.className = 'card-header';
        header.innerHTML = `
            <img src="${escape(post._user.profile_pic_url)}" />
            <a class="username" href="https://instagram.com/${escape(post._user.username)}/" target="_blank">${escape(post._user.username)}</a>
            <span class="time">${timeAgo(post.taken_at)}</span>
        `;
        card.appendChild(header);

        const wrap = document.createElement('div');
        wrap.className = 'card-img-wrap';
        const imgEl = document.createElement('img');
        imgEl.className = 'card-img';
        imgEl.src = url;
        imgEl.loading = 'lazy';
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
        const urls = getImageUrls(post);
        if (!urls.length) return null;

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
        urls.forEach(url => {
            const wrap = document.createElement('div');
            wrap.className = 'card-img-wrap';
            const imgEl = document.createElement('img');
            imgEl.className = 'card-img';
            imgEl.src = url;
            imgEl.loading = 'lazy';
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
    document.getElementById('status').textContent = 'Loading…';
    const msg = document.getElementById('message');
    if (msg) msg.textContent = 'Fetching posts from people you follow...';
    chrome.runtime.sendMessage({ type: 'FETCH_FEED' }, response => {
        const msgEl = document.getElementById('message');
        if (response?.ok) {
            if (msgEl) msgEl.remove();
            renderAllFeed(response);
        } else {
            if (msgEl) msgEl.textContent = `Error: ${response?.error ?? 'unknown error'}`;
        }
    });
}

// --- One User mode ---

let allFollowing = [];
let selectedUser = null;

function renderUserList() {
    const list = document.getElementById('user-list');
    const query = document.getElementById('user-search').value.toLowerCase().trim();
    const filtered = query
        ? allFollowing.filter(u =>
            u.username.toLowerCase().includes(query) ||
            (u.full_name || '').toLowerCase().includes(query))
        : allFollowing;

    list.innerHTML = '';

    if (!filtered.length) {
        list.innerHTML = '<span id="user-hint">No matches</span>';
        return;
    }

    filtered.slice(0, 40).forEach(user => {
        const chip = document.createElement('button');
        chip.className = 'user-chip' + (selectedUser?.pk === user.pk ? ' selected' : '');
        chip.innerHTML = `<img src="${escape(user.profile_pic_url)}" /><span>${escape(user.username)}</span>`;
        chip.addEventListener('click', () => selectUser(user));
        list.appendChild(chip);
    });

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
    chrome.runtime.sendMessage({ type: 'GET_FOLLOWING_LIST' }, response => {
        if (response?.ok) {
            allFollowing = response.users;
            renderUserList();
        } else {
            document.getElementById('user-list').innerHTML =
                `<span id="user-hint">Error: ${response?.error ?? 'unknown'}</span>`;
        }
    });
}

function selectUser(user) {
    selectedUser = user;
    renderUserList();
    document.getElementById('status').textContent = `Loading @${user.username}…`;
    document.getElementById('feed').innerHTML = '';
    chrome.runtime.sendMessage({ type: 'FETCH_USER_FEED', userId: user.pk }, response => {
        if (response?.ok) {
            const posts = response.posts.map(p => ({
                ...p,
                _user: { username: user.username, profile_pic_url: user.profile_pic_url },
            }));
            document.getElementById('status').textContent =
                `${posts.length} posts · @${user.username}`;
            const msg = document.getElementById('message');
            if (msg) msg.remove();
            renderGrid(posts, false);
        } else {
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
    document.getElementById('tab-all').classList.toggle('active', mode === 'all');
    document.getElementById('tab-user').classList.toggle('active', mode === 'user');
    document.getElementById('refresh').style.display = mode === 'all' ? '' : 'none';
    document.getElementById('user-picker').style.display = mode === 'user' ? 'block' : 'none';

    if (mode === 'all') {
        loadAllFeed();
    } else {
        document.getElementById('feed').innerHTML = '';
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
    chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' }, response => {
        setRefreshing(false);
        if (response?.ok) renderAllFeed(response);
    });
});

// Re-render when background finishes a fresh fetch (all-following mode only)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.feedCache?.newValue && mode === 'all') {
        renderAllFeed(changes.feedCache.newValue);
    }
});

// Initial load
loadAllFeed();
