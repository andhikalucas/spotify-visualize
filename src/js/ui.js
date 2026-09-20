/* Shell: view registry with lazy init, hash routing, settings, formatters,
   and the virtual list used by any view with more rows than fit on screen. */

/* -- formatting ---------------------------------------------------------- */

const NBSP = ' ';

/* Hardened against untrusted input: `n` may be a raw export field, not
   necessarily a real number (e.g. a string). Number.prototype.toLocaleString
   formats numbers, but String.prototype has no override and falls back to
   Object.prototype.toLocaleString, which just returns the string unchanged
   -- so calling .toLocaleString() directly on an unvalidated value can hand
   markup straight to innerHTML. Coercing through Number() first closes that
   hole for every call site at once. */
function fmtNumber(n) {
  const coerced = Number(n);
  return (Number.isFinite(coerced) ? coerced : 0).toLocaleString('en-US');
}

/** 4213000 -> "1h 10m"; short values fall back to "4:01". */
function fmtDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h) return h + 'h' + NBSP + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm' + NBSP + String(total % 60).padStart(2, '0') + 's';
  return total + 's';
}

/** Track-length style: "4:01". */
function fmtClockDuration(ms) {
  const total = Math.round(ms / 1000);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

/** Minutes past local midnight -> "07:15". */
function fmtTimeOfDay(mins) {
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' +
         String(mins % 60).padStart(2, '0');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday',
                  'Friday', 'Saturday', 'Sunday'];

function dateParts(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(),
           dow: (d.getUTCDay() + 6) % 7 };
}

/** "2026-03-03" -> "3 Mar 2026" (long: "Tuesday, 3 March 2026"). */
function fmtDate(dateStr, long) {
  const p = dateParts(dateStr);
  if (!long) return p.d + ' ' + MONTHS[p.m] + ' ' + p.y;
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                 'August', 'September', 'October', 'November', 'December'][p.m];
  return WEEKDAYS[p.dow] + ', ' + p.d + ' ' + month + ' ' + p.y;
}

/* Export data is untrusted input: it comes from whatever file the visitor
   uploads. Nothing derived from it reaches markup without passing through one
   of these. */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Attribute values. Same rules; named separately so intent is readable. */
const attr = esc;

/** Values expected to be numeric. A JSON string where a number belonged
    cannot then carry markup. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '0';
}

/** Build an open.spotify.com URL, or null. Never interpolate a raw URI
    fragment into an href. */
function safeSpotifyUrl(uri) {
  const m = /^spotify:([a-z]+):([A-Za-z0-9]+)$/.exec(String(uri == null ? '' : uri));
  return m ? 'https://open.spotify.com/' + m[1] + '/' + m[2] : null;
}

function debounce(fn, wait) {
  let t = 0;
  const wrapped = function () {
    clearTimeout(t);
    const args = arguments;
    t = setTimeout(() => fn.apply(null, args), wait);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = function () { clearTimeout(t); fn.apply(null, arguments); };
  return wrapped;
}

/* -- virtual list -------------------------------------------------------- */

/** Windowed renderer: only the visible rows plus an overscan buffer exist
    in the DOM, positioned by translating a window inside a full-height spacer. */
class VirtualList {
  constructor(container, opts) {
    this.el = container;
    this.rowHeight = opts.rowHeight;
    this.renderRow = opts.renderRow;
    this.overscan = opts.overscan == null ? 10 : opts.overscan;
    this.items = [];
    this._range = [-1, -1];
    this._raf = 0;

    this.el.classList.add('vlist');
    this.el.textContent = '';
    this.spacer = document.createElement('div');
    this.spacer.className = 'vlist-spacer';
    this.window = document.createElement('div');
    this.window.className = 'vlist-window';
    this.spacer.appendChild(this.window);
    this.el.appendChild(this.spacer);

    this._onScroll = () => this._schedule();
    this.el.addEventListener('scroll', this._onScroll, { passive: true });
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this._schedule());
      this._ro.observe(this.el);
    }
  }

  setItems(items, keepScroll) {
    this.items = items || [];
    this.spacer.style.height = (this.items.length * this.rowHeight) + 'px';
    if (!keepScroll) this.el.scrollTop = 0;
    this._range = [-1, -1];
    this._render();
  }

  scrollToIndex(i) {
    this.el.scrollTop = Math.max(0, i * this.rowHeight - this.rowHeight * 3);
    this._render();
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _render() {
    const h = this.el.clientHeight || 600;
    const visible = Math.ceil(h / this.rowHeight);
    let start = Math.floor(this.el.scrollTop / this.rowHeight) - this.overscan;
    if (start < 0) start = 0;
    let end = start + visible + this.overscan * 2;
    if (end > this.items.length) end = this.items.length;

    if (start === this._range[0] && end === this._range[1]) return;
    this._range = [start, end];

    const parts = new Array(end - start);
    for (let i = start; i < end; i++) {
      parts[i - start] =
        '<div class="vlist-row" style="height:' + this.rowHeight + 'px" data-i="' + i + '">' +
        this.renderRow(this.items[i], i) + '</div>';
    }
    this.window.style.transform = 'translateY(' + (start * this.rowHeight) + 'px)';
    this.window.innerHTML = parts.join('');
  }

  destroy() {
    this.el.removeEventListener('scroll', this._onScroll);
    if (this._ro) this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}

/* -- app shell ----------------------------------------------------------- */

const ICONS = {
  timeline: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM2.5 8a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0Z"/><path fill="currentColor" d="M7.25 4h1.5v4.1l2.6 1.6-.8 1.3-3.3-2V4Z"/></svg>',
  charts: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M1.5 13.5V6h3v7.5h-3Zm5 0V2h3v11.5h-3Zm5 0V9h3v4.5h-3Z"/></svg>',
  history: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M1.5 3h13v1.6h-13V3Zm0 4.2h13v1.6h-13V7.2Zm0 4.2h9v1.6h-9v-1.6Z"/></svg>',
  library: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h2v12H2V2Zm3.5 0h2v12h-2V2ZM9.6 2.4l1.9-.5 3.1 11.6-1.9.5L9.6 2.4Z"/></svg>',
  extras: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 1.2 9.9 5.4l4.6.5-3.4 3.1.9 4.5L8 11.3 4 13.5l.9-4.5L1.5 5.9l4.6-.5L8 1.2Z"/></svg>',
  settings: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"/><path fill="currentColor" d="m6.9.5-.3 1.8-.9.4-1.5-1-2.2 2.2 1 1.5-.4.9-1.8.3v3.1l1.8.3.4.9-1 1.5 2.2 2.2 1.5-1 .9.4.3 1.8h3.1l.3-1.8.9-.4 1.5 1 2.2-2.2-1-1.5.4-.9 1.8-.3V6.6l-1.8-.3-.4-.9 1-1.5-2.2-2.2-1.5 1-.9-.4L9.1.5H6.9Zm1.3 1.5h.5l.3 1.5 1.9.8 1.2-.8.4.4-.8 1.2.8 1.9 1.5.3v.5l-1.5.3-.8 1.9.8 1.2-.4.4-1.2-.8-1.9.8-.3 1.5h-.5l-.3-1.5-1.9-.8-1.2.8-.4-.4.8-1.2-.8-1.9L2 8.2v-.5l1.5-.3.8-1.9-.8-1.2.4-.4 1.2.8 1.9-.8.2-1.5Z"/></svg>'
};

const App = (function () {
  const views = new Map();
  const listeners = [];
  let current = null;
  const scrollMemory = new Map();

  const settings = {
    tzOffset: -new Date().getTimezoneOffset(),   // the visitor's own zone
    mode: 'both'
  };

  /* -- settings persistence (a per-viewer convenience, never data) -------- */

  function loadSettings() {
    try {
      const raw = localStorage.getItem('spotify-history-settings');
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (e) { /* private mode or blocked storage: defaults are fine */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem('spotify-history-settings', JSON.stringify(settings));
    } catch (e) { /* nothing to recover: settings simply do not persist */ }
  }

  function onChange(fn) { listeners.push(fn); }

  function emitChange(what) {
    for (const fn of listeners) fn(what, settings);
  }

  /* -- view registry ----------------------------------------------------- */

  function registerView(id, def) {
    views.set(id, Object.assign({ id: id, ready: false }, def));
  }

  /** Views whose data is in this upload. A view may declare `available()`;
      without one it is always shown. */
  function visibleViews() {
    return [...views.values()].filter(v => !v.available || v.available());
  }

  function renderNav() {
    const html = visibleViews().map(v =>
      '<button class="nav-item" type="button" data-nav="' + v.id + '">' +
      ICONS[v.id] + '<span>' + esc(v.label) + '</span></button>').join('');
    document.getElementById('nav').innerHTML = html;
    document.getElementById('bottombar').innerHTML = html;
    document.querySelectorAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => navigate('#' + btn.dataset.nav));
    });
  }

  function markNav(id) {
    document.querySelectorAll('[data-nav]').forEach(btn => {
      if (btn.dataset.nav === id) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
  }

  /** Views initialise on first navigation, never at load. */
  function navigate(hash) {
    const clean = (hash || '').replace(/^#/, '');
    const slash = clean.indexOf('/');
    const id = (slash === -1 ? clean : clean.slice(0, slash)) || 'timeline';
    const arg = slash === -1 ? null : decodeURIComponent(clean.slice(slash + 1));
    const view = views.get(id);
    if (!view || (view.available && !view.available())) return navigate('#timeline');

    if (location.hash !== '#' + clean && clean) {
      history.replaceState(null, '', '#' + clean);
    }

    if (current && current !== id) {
      const prev = views.get(current);
      const prevEl = document.getElementById('view-' + current);
      scrollMemory.set(current, prevEl.scrollTop);
      prevEl.hidden = true;
      if (prev.hide) prev.hide();
    }

    const el = document.getElementById('view-' + id);
    el.hidden = false;
    if (!view.ready) { view.init(el); view.ready = true; }
    if (view.show) view.show(arg, el);
    if (current !== id && scrollMemory.has(id)) el.scrollTop = scrollMemory.get(id);
    current = id;
    markNav(id);
  }

  /** Force every view to rebuild against a new dataset. Listeners go too:
      each view re-registers its own when it next initialises, so none is
      left pointing at a view that has been emptied. */
  function resetViews() {
    if (current) {
      const prev = views.get(current);
      if (prev && prev.hide) prev.hide();
    }
    current = null;
    scrollMemory.clear();
    listeners.length = 0;
    views.forEach(function (v) {
      v.ready = false;
      const el = document.getElementById('view-' + v.id);
      if (!el) return;
      el.textContent = '';
      el.className = 'view';
      el.hidden = true;
    });
  }

  /** True when the upload contained `name`. A trailing '*' matches a prefix,
      so 'StreamingHistory_podcast_*' covers every numbered part. */
  function hasFile(name) {
    const present = (Data.loaded && Data.meta.present) || [];
    if (name.endsWith('*')) {
      const prefix = name.slice(0, -1);
      return present.some(function (n) { return n.indexOf(prefix) === 0; });
    }
    return present.indexOf(name) !== -1;
  }

  function setIdentity(account) {
    const name = account && account.displayName;
    document.title = (name ? name + ' - ' : '') + 'Spotify Stats Visualizer';
    document.getElementById('avatar').textContent =
      (name || '?').trim().charAt(0) || '?';
    document.getElementById('brandName').textContent = name || 'Spotify Stats Visualizer';
  }

  /** Make `payload` the loaded export and rebuild everything around it. */
  function useDataset(payload) {
    Data.load(payload);
    if (settings.tzOffset !== payload.meta.tzDefault) Data.reindex(settings.tzOffset);
    // A saved "Podcasts only" would leave every view empty for an upload
    // without podcast history. Fall back for this dataset without saving.
    if (!hasFile('StreamingHistory_podcast_*')) settings.mode = 'both';
    resetViews();
    setIdentity(payload.extras.account || {});
    renderNav();
    Data.warmSearchIndex();
  }

  /** Drop the loaded export from memory entirely. */
  function clearDataset() {
    resetViews();
    Data.clear();
    setIdentity(null);
  }

  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  return {
    settings, registerView, navigate, renderNav, onChange, emitChange,
    loadSettings, saveSettings, toast, resetViews, hasFile,
    useDataset, clearDataset, visibleViews,
    get current() { return current; },
    views
  };
})();

/* -- settings values ------------------------------------------------------ */

const TZ_CHOICES = [
  [-480, 'UTC-8'], [-420, 'UTC-7'], [-360, 'UTC-6'], [-300, 'UTC-5'],
  [0, 'UTC+0'], [60, 'UTC+1'], [120, 'UTC+2'], [330, 'UTC+5:30'],
  [420, 'UTC+7'], [480, 'UTC+8'], [540, 'UTC+9'], [600, 'UTC+10']
];

// Add the visitor's own zone if it is not already one of the presets.
(function () {
  const here = -new Date().getTimezoneOffset();
  if (TZ_CHOICES.some(function (c) { return c[0] === here; })) return;
  const sign = here < 0 ? '-' : '+';
  const abs = Math.abs(here);
  const h = Math.floor(abs / 60), m = abs % 60;
  TZ_CHOICES.push([here, 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '')]);
  TZ_CHOICES.sort(function (a, b) { return a[0] - b[0]; });
})();

const MODES = [['both', 'Both'], ['music', 'Music'], ['podcast', 'Podcasts']];
