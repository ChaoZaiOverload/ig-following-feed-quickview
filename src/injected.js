(function () {
    const TAG = "🚀 [IG-FEED]";

    const MAX_AGE_HOURS = 48; // hide posts older than this

    function isSuggested(article) {
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const text = node.textContent.trim();
            if (text === 'Suggested for you' || text === 'Suggested Posts') return true;
        }
        return false;
    }

    function hidePost(article) {
        // Hide up to 5 levels of ancestors until we hit a node with other visible siblings
        let el = article;
        for (let i = 0; i < 5; i++) {
            const parent = el.parentElement;
            if (!parent || parent === document.body) break;
            const visibleSiblings = [...parent.children].filter(
                c => c !== el && c.style.display !== 'none' && c.offsetHeight > 0
            );
            el.style.display = 'none';
            if (visibleSiblings.length > 0) break; // stop — parent has other real content
            el = parent; // parent is now empty too, keep going up
        }
    }

    function isTooOld(article) {
        const time = article.querySelector('time[datetime]');
        if (!time) return false;
        const age = Date.now() - new Date(time.getAttribute('datetime')).getTime();
        return age > MAX_AGE_HOURS * 3600 * 1000;
    }

    function scheduleAutoScroll() { /* disabled — was advancing feed cursor into old content */ }

    function processArticle(article) {
        if (article._igProcessed) return;
        article._igProcessed = true;

        // Hide immediately to prevent flash, reveal only if not suggested
        article.style.opacity = '0';

        Promise.resolve().then(() => {
            if (isSuggested(article)) {
                hidePost(article);
                console.log(TAG, '🚫 hid suggested post');
                scheduleAutoScroll();
            } else if (isTooOld(article)) {
                hidePost(article);
                console.log(TAG, '🕐 hid old post');
            } else {
                article.style.opacity = '';
                applyMultiColumn(article);
            }
        });
    }

    // Apply 2-column grid to the feed container (once, on first real post)
    function applyMultiColumn(article) {
        const parent = article.parentElement;
        if (!parent || parent._igGrid) return;
        parent._igGrid = true;
        parent.style.display = 'grid';
        parent.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
        parent.style.gap = '24px';
        parent.style.alignItems = 'start';
        parent.style.maxWidth = '1260px';
        // Widen ancestor containers that might constrain the width
        let el = parent.parentElement;
        for (let i = 0; i < 4 && el && el !== document.body; i++, el = el.parentElement) {
            el.style.maxWidth = '1260px';
            el.style.width = '100%';
        }
        console.log(TAG, '📐 2-column layout applied');
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'ARTICLE') {
                    processArticle(node);
                } else {
                    node.querySelectorAll('article').forEach(processArticle);
                }
            }
        }
    });

    function start() {
        observer.observe(document.body, { childList: true, subtree: true });
        document.querySelectorAll('article').forEach(processArticle);
        console.log(TAG, '✅ Feed filter active');
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
})();
