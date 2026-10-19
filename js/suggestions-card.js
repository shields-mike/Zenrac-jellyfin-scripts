/*
    Replaces the search suggestions section on the search page with cards instead of links.

    Modified for Jellyfin 12:
      - Falls back to fetching suggestions itself, so cards also appear on a full page refresh
      - Uses the public ApiClient.getCurrentUserId() instead of a private field
      - Keeps imageTypeLimit instead of deleting it
      - Applies data-src to cards manually (lazy loader does not pick up injected cards)
      - Errors are caught and logged instead of leaving the section hidden
*/

const script = document.currentScript;
const ITEMS_COUNT = script?.dataset.itemsCount ? parseInt(script?.dataset.itemsCount, 10) : 20;
const HORIZONTAL_SCROLL = script?.dataset.horizontalScroll === "true";

function getUserId() {
    try {
        return window.ApiClient?.getCurrentUserId?.() || window.ApiClient?._currentUser?.Id || null;
    } catch {
        return null;
    }
}

function isSearchPage() {
    return location.hash.startsWith('#/search');
}

(function injectCSS() {
    const style = document.createElement('style');
    style.textContent = `
        .verticalSection.searchSuggestions {
            visibility: hidden;
            animation: ssReveal 0s linear 3s forwards;
        }
        @keyframes ssReveal { to { visibility: visible; } }
        .verticalSection.searchSuggestions:has(.custom-scroller) {
            visibility: visible;
        }
        ${!HORIZONTAL_SCROLL ? `
        .verticalSection.searchSuggestions .itemsContainer {
            margin-left: 1.2em;
        }
        .searchSuggestions .custom-scroller-container .emby-scrollbuttons.padded-right {
            display: none !important;
        }
        ` : ''}
    `;
    document.head.appendChild(style);
})();


// ---- Path 1: catch the page's own suggestions request (works on in-app navigation) ----

const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;

function isSuggestionsUrl(url) {
    const userId = getUserId();
    return Boolean(
        userId &&
        typeof url === 'string' &&
        url.includes('/Items') &&
        url.includes(`userId=${userId}`) &&
        isSearchPage() &&
        !url.includes('searchTerm=')
    );
}

XMLHttpRequest.prototype.open = function(method, url, ...args) {
    if (isSuggestionsUrl(url)) {
        const u = new URL(url, location.origin);
        u.searchParams.set('enableImages', 'true');
        u.searchParams.set('limit', ITEMS_COUNT.toString());
        u.searchParams.set('imageTypeLimit', '1');
        url = u.toString();
    }
    this.__url = url;
    return originalOpen.call(this, method, url, ...args);
};

XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', () => {
        if (!isSuggestionsUrl(this.__url)) return;

        let payload;
        try {
            payload = JSON.parse(this.responseText);
        } catch {
            return;
        }
        cachedItems = payload?.Items || [];
        ensureCards();
    });

    return originalSend.apply(this, args);
};


// ---- Rendering ----

let cachedItems = null;
let busy = false;
let pollTimer = null;

function isAlreadyReplaced(parent) {
    return parent.querySelector('.custom-scroller');
}

function needsReplacement(parent) {
    return !isAlreadyReplaced(parent) && parent.querySelector('a, button');
}

function waitForCardBuilder(timeout = 5000, interval = 50) {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const check = () => {
            if (window.cardBuilder) return resolve();
            if (Date.now() - start > timeout) return reject(new Error('window.cardBuilder not available'));
            setTimeout(check, interval);
        };

        check();
    });
}

function loadCardImages(root) {
    root.querySelectorAll('[data-src]').forEach(el => {
        const src = el.getAttribute('data-src');
        if (!src) return;
        if (el.tagName === 'IMG') {
            el.src = src;
        } else {
            el.style.backgroundImage = `url("${src}")`;
        }
        el.removeAttribute('data-src');
    });
}

async function replaceSuggestionContainer(items) {
    await waitForCardBuilder();

    const sections = document.querySelectorAll('.verticalSection.searchSuggestions');

    for (const parent of sections) {
        if (!needsReplacement(parent)) continue;
        if (!items.length) continue;

        parent.innerHTML = '';

        const section = window.cardBuilder.renderCards(
            items,
            'Suggestions',
            null
        );

        parent.appendChild(section);
        loadCardImages(section);

        if (!HORIZONTAL_SCROLL) {
            const itemsContainer = parent.querySelector('.itemsContainer');
            if (itemsContainer) {
                itemsContainer.classList.add('vertical-wrap');
            }
        }
    }
}


// ---- Path 2: fetch suggestions ourselves (covers full page refresh and cached responses) ----

async function fetchItems() {
    const userId = getUserId();
    if (!userId || !window.ApiClient?.getItems) return [];

    const result = await window.ApiClient.getItems(userId, {
        limit: ITEMS_COUNT,
        recursive: true,
        sortBy: 'IsFavoriteOrLiked,Random',
        includeItemTypes: 'Movie,Series',
        enableImages: true,
        enableImageTypes: 'Primary',
        imageTypeLimit: 1,
        enableUserData: true,
        fields: 'PrimaryImageAspectRatio'
    });
    return result?.Items || [];
}

async function ensureCards() {
    if (busy || !isSearchPage()) return;

    const section = document.querySelector('.verticalSection.searchSuggestions');
    if (!section || !needsReplacement(section)) return;

    busy = true;
    try {
        const items = cachedItems?.length ? cachedItems : await fetchItems();
        await replaceSuggestionContainer(items);
    } catch (e) {
        console.warn('[search-cards] failed to build suggestion cards:', e);
    } finally {
        busy = false;
    }
}

function startPolling() {
    clearInterval(pollTimer);
    let tries = 0;
    pollTimer = setInterval(() => {
        ensureCards();
        if (++tries >= 40) clearInterval(pollTimer);
    }, 500);
}

window.addEventListener('hashchange', () => {
    cachedItems = null;
    if (isSearchPage()) startPolling();
});

if (isSearchPage()) startPolling();
