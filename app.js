'use strict';

/* ---------- base64 helpers (per Dioxamine docs) ---------- */
function utf8ToBase64(str) {
    if (window.dioxamine && dioxamine.utf8ToBase64) return dioxamine.utf8ToBase64(str);
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function base64ToUtf8(b64) {
    if (window.dioxamine && dioxamine.base64ToUtf8) return dioxamine.base64ToUtf8(b64);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}


function getFitAddonCtor() {
    if (window.FitAddon && typeof window.FitAddon === 'function') return window.FitAddon;
    if (window.FitAddon && window.FitAddon.FitAddon) return window.FitAddon.FitAddon;
    throw new Error('FitAddon not found on window - check vendor/xterm-addon-fit.js export');
}


function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

function buildXtermTheme() {
    return {
        background: cssVar('--dioxamine-bg', '#121212'),
        foreground: cssVar('--dioxamine-fg', '#ffffff'),
        cursor: cssVar('--dioxamine-accent', '#64b5f6'),
        cursorAccent: cssVar('--dioxamine-bg', '#121212'),
        selectionBackground: cssVar('--dioxamine-accent', '#2196f3') + '55',
    };
}

function applyThemeToAllTerms() {
    const theme = buildXtermTheme();
    for (const tab of tabs.values()) {
        tab.term.options.theme = theme;
    }
}

const tabs = new Map(); // id -> { id, title, term, fitAddon, session, container, tabEl, alive }
let activeTabId = null;
let tabCounter = 0;

let ctrlSticky = false;
let altSticky = false;

const tabListEl = document.getElementById('tab-list');
const viewportEl = document.getElementById('terminal-viewport');
const newTabBtn = document.getElementById('new-tab-btn');

async function createTab() {
    const id = 'tab-' + (++tabCounter);

    const container = document.createElement('div');
    container.className = 'term-pane';
    container.id = id + '-pane';
    viewportEl.appendChild(container);

    const isFirstTab = tabCounter === 1;

    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.innerHTML =
        '<span class="tab-title">Shell ' + tabCounter + '</span>' +
        (isFirstTab ? '' : '<span class="tab-close">&times;</span>');
    tabEl.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
            closeTab(id);
        } else {
            activateTab(id);
        }
    });
    tabListEl.appendChild(tabEl);

    const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'monospace',
        fontSize: 14,
        theme: buildXtermTheme(),
        allowProposedApi: true,
    });
    const FitAddonCtor = getFitAddonCtor();
    const fitAddon = new FitAddonCtor();
    term.loadAddon(fitAddon);
    term.open(container);

    const tab = {
        id,
        title: 'Shell ' + tabCounter,
        term,
        fitAddon,
        session: null,
        container,
        tabEl,
        alive: true,
        closable: !isFirstTab,
    };
    tabs.set(id, tab);

    activateTab(id);
    // fit only works once the pane is visible/laid out
    requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch (e) {}
        openSessionForTab(tab);
    });

    return tab;
}

async function openSessionForTab(tab) {
    try {
        const session = await dioxamine.openInteractiveShell();

        // tab may have been closed while this await was pending don't
        // resurrect a session onto a disposed tab, just clean it up
        if (!tab.alive || !tabs.has(tab.id)) {
            session.close().catch(() => {});
            return;
        }

        tab.session = session;

        session.onData((b64) => {
            tab.term.write(base64ToUtf8(b64));
        });

        session.onClose((err) => {
            if (!tab.alive || !tabs.has(tab.id)) return;
            tab.alive = false;
            tab.term.writeln('\r\n\x1b[31m[Session closed' + (err ? ': ' + err : '') + ']\x1b[0m');
        });

        tab.term.onData((data) => {
            if (!tab.alive || !tab.session) return;
            const transformed = applyStickyModifiers(data);
            session.write(utf8ToBase64(transformed));
        });

        // send initial dimensions
        session.resize(tab.term.cols, tab.term.rows);
    } catch (e) {
        tab.term.writeln('\x1b[31mFailed to open shell: ' + (e && e.message ? e.message : e) + '\x1b[0m');
        if (window.dioxamine && dioxamine.log) dioxamine.log.e('Terminal', 'openInteractiveShell failed: ' + e);
    }
}

function activateTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    activeTabId = id;

    for (const t of tabs.values()) {
        const isActive = t.id === id;
        t.container.classList.toggle('active', isActive);
        t.tabEl.classList.toggle('active', isActive);
    }

    // re-fit once visible (hidden panes report bogus dimensions)
    requestAnimationFrame(() => {
        try {
            tab.fitAddon.fit();
            if (tab.session) tab.session.resize(tab.term.cols, tab.term.rows);
        } catch (e) {}
        tab.term.focus();
    });
}

function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    if (!tab.closable) return;

    tab.alive = false;

    if (tab.session) {
        tab.session.close().catch(() => {});
    }
    tab.term.dispose();
    tab.container.remove();
    tab.tabEl.remove();
    tabs.delete(id);

    if (activeTabId === id) {
        const remaining = Array.from(tabs.keys());
        if (remaining.length > 0) {
            activateTab(remaining[remaining.length - 1]);
        } else {
            activeTabId = null;
            createTab();
        }
    }
}

newTabBtn.addEventListener('click', () => createTab());

const resizeObserver = new ResizeObserver(() => {
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    try {
        tab.fitAddon.fit();
        if (tab.session) tab.session.resize(tab.term.cols, tab.term.rows);
    } catch (e) {}
});
resizeObserver.observe(viewportEl);


const CTRL_MAP = {
    a: '\x01', b: '\x02', c: '\x03', d: '\x04', e: '\x05', f: '\x06', g: '\x07',
    h: '\x08', i: '\x09', j: '\x0a', k: '\x0b', l: '\x0c', m: '\x0d', n: '\x0e',
    o: '\x0f', p: '\x10', q: '\x11', r: '\x12', s: '\x13', t: '\x14', u: '\x15',
    v: '\x16', w: '\x17', x: '\x18', y: '\x19', z: '\x1a',
    '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f',
};

const NAMED_KEY_SEQUENCES = {
    Escape: '\x1b',
    Tab: '\x09',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
};

function sendToActiveTab(data) {
    const tab = tabs.get(activeTabId);
    if (!tab || !tab.alive || !tab.session) return;
    tab.session.write(utf8ToBase64(data));
}

function clearStickyModifiers() {
    ctrlSticky = false;
    altSticky = false;
    const ctrlBtn = document.getElementById('ctrl-btn');
    const altBtn = document.getElementById('alt-btn');
    if (ctrlBtn) ctrlBtn.classList.remove('sticky-active');
    if (altBtn) altBtn.classList.remove('sticky-active');
}

function refocusActiveTerm() {
    const tab = tabs.get(activeTabId);
    if (tab) tab.term.focus();
}

const keybarEl = document.getElementById('keybar');
keybarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.keybtn');
    if (!btn) return;

    if (btn.id === 'ctrl-btn') {
        ctrlSticky = !ctrlSticky;
        btn.classList.toggle('sticky-active', ctrlSticky);
        refocusActiveTerm();
        return;
    }
    if (btn.id === 'alt-btn') {
        altSticky = !altSticky;
        btn.classList.toggle('sticky-active', altSticky);
        refocusActiveTerm();
        return;
    }

    const key = btn.getAttribute('data-key');
    if (key) {
        const seq = NAMED_KEY_SEQUENCES[key];
        if (seq) {
            sendToActiveTab(seq);
            clearStickyModifiers();
        }
        refocusActiveTerm();
        return;
    }

    const literal = btn.getAttribute('data-literal');
    if (literal) {
        if (ctrlSticky && CTRL_MAP[literal.toLowerCase()]) {
            sendToActiveTab(CTRL_MAP[literal.toLowerCase()]);
        } else if (altSticky) {
            sendToActiveTab('\x1b' + literal);
        } else {
            sendToActiveTab(literal);
        }
        clearStickyModifiers();
        refocusActiveTerm();
    }
});

function applyStickyModifiers(data) {
    if (!ctrlSticky && !altSticky) return data;

    // only intercept single-character input; let everything else pass through
    if (data.length !== 1) {
        clearStickyModifiers();
        return data;
    }

    const ch = data;
    let result = ch;

    if (ctrlSticky && CTRL_MAP[ch.toLowerCase()]) {
        result = CTRL_MAP[ch.toLowerCase()];
    } else if (altSticky) {
        result = '\x1b' + ch;
    }

    clearStickyModifiers();
    return result;
}

function initThemeSync() {
    if (window.dioxamine && dioxamine.onThemeChange) {
        dioxamine.onThemeChange(() => applyThemeToAllTerms());
    }
}

async function boot() {
    initThemeSync();
    await createTab();
}

if (window.dioxamine && window.__dioxamine_bridge_ready) {
    boot();
} else {
    window.addEventListener('dioxamine-bridge-ready', boot, { once: true });
}
