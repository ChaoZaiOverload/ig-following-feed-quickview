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

function render({ posts, followingCount, cachedAt }) {
    const msg = document.getElementById('message');
    if (msg) msg.remove();

    document.getElementById('status').textContent =
        `${posts.length} posts · ${followingCount} following · updated ${cacheAgo(cachedAt)}`;

    const feed = document.getElementById('feed');
    feed.innerHTML = '';

    for (const post of posts) {
        const img = getImageUrl(post);
        if (!img) continue;
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
            <div class="card-header">
                <img src="${escape(post._user.profile_pic_url)}" />
                <a class="username" href="https://instagram.com/${escape(post._user.username)}/" target="_blank">${escape(post._user.username)}</a>
                <span class="time">${timeAgo(post.taken_at)}</span>
            </div>
            <a href="https://instagram.com/p/${escape(post.code)}/" target="_blank">
                <img class="card-img" src="${escape(img)}" loading="lazy" />
            </a>
            ${post.caption?.text ? `<div class="card-caption">${escape(post.caption.text)}</div>` : ''}
        `;
        feed.appendChild(card);
    }
}

function setRefreshing(on) {
    const btn = document.getElementById('refresh');
    btn.disabled = on;
    btn.textContent = on ? '↻ Refreshing...' : '↻ Refresh';
}

// Initial load — returns cache immediately if available
chrome.runtime.sendMessage({ type: 'FETCH_FEED' }, response => {
    if (response?.ok) {
        render(response);
    } else {
        document.getElementById('message').textContent =
            `Error: ${response?.error ?? 'unknown error'}`;
    }
});

document.getElementById('refresh').addEventListener('click', () => {
    setRefreshing(true);
    chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' }, response => {
        setRefreshing(false);
        if (response?.ok) {
            render(response);
        }
    });
});

// Re-render when background finishes a fresh fetch
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.feedCache?.newValue) {
        render(changes.feedCache.newValue);
    }
});
