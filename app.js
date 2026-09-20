/* ---- data.js ---- */
/* Data layer: decode the payload, index it, answer range/aggregate queries.
   All timestamps are whole minutes since the Unix epoch (UTC).
   All index ranges are half-open [lo, hi) into the time-sorted plays array. */

const Data = (function () {
  const MIN_PER_DAY = 1440;

  let P = null;               // the raw payload
  let dayList = [];           // [[date, start, end, ms, plays], ...] ordered
  let dayMap = new Map();     // date -> row
  let pdayList = [];
  let pdayMap = new Map();
  let searchIdx = null;       // lazily built, one lowercase string per track
  let tz = 0;                 // active offset in minutes
  const aggCache = new Map();

  /* -- date helpers ------------------------------------------------------ */

  function dateToEpochDay(s) {
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }

  function epochDayToDate(n) {
    return new Date(n * 86400000).toISOString().slice(0, 10);
  }

  function localDate(tsMin, offset) {
    return epochDayToDate(Math.floor((tsMin + (offset ?? tz)) / MIN_PER_DAY));
  }

  function localMinutes(tsMin, offset) {
    const m = (tsMin + (offset ?? tz)) % MIN_PER_DAY;
    return m < 0 ? m + MIN_PER_DAY : m;
  }

  function shiftDate(dateStr, days) {
    return epochDayToDate(dateToEpochDay(dateStr) + days);
  }

  /* -- indexing ---------------------------------------------------------- */

  function indexDays(plays, offset) {
    const rows = [];
    let cur = null, start = 0;
    for (let i = 0; i < plays.length; i++) {
      const day = localDate(plays[i][0], offset);
      if (day !== cur) {
        if (cur !== null) rows.push(closeRow(plays, cur, start, i));
        cur = day;
        start = i;
      }
    }
    if (cur !== null) rows.push(closeRow(plays, cur, start, plays.length));
    return rows;
  }

  function closeRow(plays, day, start, end) {
    let ms = 0;
    for (let i = start; i < end; i++) ms += plays[i][2];
    return [day, start, end, ms, end - start];
  }

  function adopt(rows, isPodcast) {
    const map = new Map();
    for (const r of rows) map.set(r[0], r);
    if (isPodcast) { pdayList = rows; pdayMap = map; }
    else { dayList = rows; dayMap = map; }
  }

  /* -- binary search ----------------------------------------------------- */

  /** First index whose timestamp is >= ts. O(log n). */
  function lowerBound(plays, ts) {
    let lo = 0, hi = plays.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (plays[mid][0] < ts) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** [lo, hi) covering local days startDate..endDate inclusive. */
  function rangeFor(startDate, endDate, isPodcast) {
    const plays = isPodcast ? P.podcast.plays : P.plays;
    if (!startDate || !endDate) return [0, plays.length];
    const from = dateToEpochDay(startDate) * MIN_PER_DAY - tz;
    const to = (dateToEpochDay(endDate) + 1) * MIN_PER_DAY - tz;
    return [lowerBound(plays, from), lowerBound(plays, to)];
  }

  /* -- aggregation ------------------------------------------------------- */

  /** Rank artists or tracks over [lo, hi). Memoised; both metrics returned. */
  function aggregate(opts) {
    const { lo, hi, by } = opts;
    const key = by + '|' + lo + '|' + hi;
    const cached = aggCache.get(key);
    if (cached) return cached;

    const plays = P.plays, tracks = P.tracks;
    const msBy = new Map(), cntBy = new Map();
    for (let i = lo; i < hi; i++) {
      const ms = plays[i][2];
      const ti = plays[i][1];
      const k = by === 'artist' ? tracks[ti][0] : ti;
      msBy.set(k, (msBy.get(k) || 0) + ms);
      cntBy.set(k, (cntBy.get(k) || 0) + 1);
    }

    const out = [];
    for (const [k, ms] of msBy) {
      out.push({
        key: k,
        label: by === 'artist' ? P.artists[k] : tracks[k][1],
        sub: by === 'artist' ? null : P.artists[tracks[k][0]],
        album: by === 'artist' ? null : albumOf(k),
        ms: ms,
        plays: cntBy.get(k)
      });
    }
    aggCache.set(key, out);
    if (aggCache.size > 60) aggCache.delete(aggCache.keys().next().value);
    return out;
  }

  function sortBy(list, metric) {
    return list.slice().sort((a, b) =>
      b[metric] - a[metric] || b.plays - a.plays || a.label.localeCompare(b.label));
  }

  /** Minutes played per local hour (0-23) over [lo, hi). */
  function hourHistogram(lo, hi) {
    const out = new Array(24).fill(0);
    const plays = P.plays;
    for (let i = lo; i < hi; i++) {
      out[Math.floor(localMinutes(plays[i][0]) / 60)] += plays[i][2];
    }
    return out;
  }

  /** Minutes played per weekday, Monday-first. */
  function weekdayHistogram(lo, hi) {
    const out = new Array(7).fill(0);
    const plays = P.plays;
    for (let i = lo; i < hi; i++) {
      const dow = (Math.floor((plays[i][0] + tz) / MIN_PER_DAY) + 4) % 7; // 1970-01-01 = Thu
      out[(dow + 6) % 7] += plays[i][2];
    }
    return out;
  }

  /* -- lookups ----------------------------------------------------------- */

  function albumOf(trackIdx) {
    const a = P.tracks[trackIdx][2];
    return a === null || a === undefined ? null : P.albums[a];
  }

  function trackInfo(trackIdx) {
    const t = P.tracks[trackIdx];
    return { title: t[1], artist: P.artists[t[0]], artistIdx: t[0], album: albumOf(trackIdx) };
  }

  function episodeInfo(epIdx) {
    const e = P.podcast.episodes[epIdx];
    return { title: e[1], show: P.podcast.shows[e[0]], showIdx: e[0] };
  }

  /** Lowercase "track artist album" per track index. Built on first use. */
  function searchIndex() {
    if (searchIdx) return searchIdx;
    const n = P.tracks.length;
    searchIdx = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = P.tracks[i];
      const album = t[2] === null || t[2] === undefined ? '' : ' ' + P.albums[t[2]];
      searchIdx[i] = (t[1] + ' ' + P.artists[t[0]] + album).toLowerCase();
    }
    return searchIdx;
  }

  function warmSearchIndex() {
    const run = () => { try { searchIndex(); } catch (e) { /* built on demand instead */ } };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 0);
  }

  /* -- lifecycle --------------------------------------------------------- */

  function load(payload) {
    P = payload;
    tz = payload.meta.tzDefault;
    searchIdx = null;
    aggCache.clear();
    adopt(payload.days, false);
    adopt(payload.podcast.days, true);
  }

  /** Forget the loaded export. Nothing of it stays reachable from here. */
  function clear() {
    P = null;
    searchIdx = null;
    aggCache.clear();
    adopt([], false);
    adopt([], true);
  }

  /** Rebuild day indices for a new timezone. One linear pass, ~26k rows. */
  function reindex(offset) {
    if (offset === tz) return;
    tz = offset;
    aggCache.clear();
    adopt(indexDays(P.plays, offset), false);
    adopt(indexDays(P.podcast.plays, offset), true);
  }

  function stats() {
    const c = P.meta.counts;
    return {
      ms: c.ms, plays: c.plays, artists: c.artists, tracks: c.tracks,
      albums: c.albums, podcastPlays: c.podcastPlays, shows: c.shows,
      rangeStart: dayList.length ? dayList[0][0] : P.meta.rangeStart,
      rangeEnd: dayList.length ? dayList[dayList.length - 1][0] : P.meta.rangeEnd,
      activeDays: dayList.length
    };
  }

  return {
    load, clear, reindex, warmSearchIndex, searchIndex, stats,
    get loaded() { return P !== null; },
    get raw() { return P; },
    get tz() { return tz; },
    get meta() { return P.meta; },
    get extras() { return P.extras; },
    days: () => dayList,
    podcastDays: () => pdayList,
    dayRow: (d) => dayMap.get(d) || null,
    podcastDayRow: (d) => pdayMap.get(d) || null,
    playsInDay: (d) => { const r = dayMap.get(d); return r ? P.plays.slice(r[1], r[2]) : []; },
    podcastInDay: (d) => { const r = pdayMap.get(d); return r ? P.podcast.plays.slice(r[1], r[2]) : []; },
    rangeFor, lowerBound, aggregate, sortBy, hourHistogram, weekdayHistogram,
    trackInfo, episodeInfo, albumOf,
    artistName: (i) => P.artists[i],
    localDate, localMinutes, dateToEpochDay, epochDayToDate, shiftDate
  };
})();


/* ---- ui.js ---- */
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


/* ---- zip.js ---- */
/* Minimal zip reader: enough of the format to pull named JSON entries out of a
   Spotify export, and nothing more. Inflation uses the platform's own
   DecompressionStream, so there is no dependency and no bundled inflater.

   Only entries whose basename passes `wanted` are extracted, which also means
   a crafted archive cannot smuggle in paths we would otherwise walk. */

const Zip = (function () {
  const EOCD_SIG = 0x06054b50;
  const EOCD64_LOCATOR_SIG = 0x07064b50;
  const CEN_SIG = 0x02014b50;

  const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

  /** Offset of the End Of Central Directory record, or -1. It sits at the end,
      after a comment of up to 65535 bytes. */
  function findEocd(view, length) {
    const floor = Math.max(0, length - 65557);
    for (let i = length - 22; i >= floor; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) return i;
    }
    return -1;
  }

  function basename(name) {
    const clean = String(name).replace(/\\/g, '/');
    return clean.slice(clean.lastIndexOf('/') + 1);
  }

  /** Inflate, counting real output and aborting if it exceeds what is allowed.
      The archive's declared uncompressedSize is attacker-controlled, so it is
      a hint for skipping obvious junk early, never the limit that protects
      us: a small declared size can still expand into a huge real stream, and
      nothing checks that until bytes actually come out of
      DecompressionStream. `budget` is the real, running total still
      available across the whole archive. */
  async function inflate(bytes, method, budget) {
    const cap = Math.min(MAX_ENTRY_BYTES, budget);
    if (method === 0) return bytes.length > cap ? null : bytes;
    if (method !== 8) return null;

    const reader = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.length;
      if (size > cap) { await reader.cancel(); return null; }
      chunks.push(step.value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /** Read `blob` and return [{name, text}] for every entry `wanted` accepts. */
  async function read(blob, wanted) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error(
        'This browser cannot open zip files here. Unzip it and drop the folder instead.');
    }

    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);

    const eocd = findEocd(view, bytes.length);
    if (eocd === -1) throw new Error('That file is not a zip archive.');

    if (eocd >= 20 && view.getUint32(eocd - 20, true) === EOCD64_LOCATOR_SIG) {
      throw new Error(
        'That zip uses the zip64 format, which this page cannot read. ' +
        'Unzip it and drop the folder instead.');
    }

    // A 0xffff entry count is also a zip64 sentinel (too many entries to fit
    // a 16-bit field), but it's moot here: any real zip64 archive already
    // trips the locator or offset checks above/below, which cover every
    // archive we'd otherwise mis-read.
    let count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (offset === 0xffffffff) {
      throw new Error(
        'That zip uses the zip64 format, which this page cannot read. ' +
        'Unzip it and drop the folder instead.');
    }

    const decoder = new TextDecoder('utf-8');
    const out = [];
    let total = 0;

    for (let i = 0; i < count && offset + 46 <= bytes.length; i++) {
      if (view.getUint32(offset, true) !== CEN_SIG) break;

      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

      offset += 46 + nameLen + extraLen + commentLen;

      const base = basename(name);
      if (!base || name.endsWith('/')) continue;
      if (!wanted(base)) continue;
      // Declared sizes come straight from the archive and are
      // attacker-controlled: this is a cheap pre-filter for obviously junk
      // entries, not the defence. The real caps are enforced inside
      // inflate(), which counts actual decompressed bytes as they stream out.
      if (uncompressedSize > MAX_ENTRY_BYTES) continue;
      if (total + uncompressedSize > MAX_TOTAL_BYTES) break;

      // The central directory's name and extra lengths need not match the local
      // header's, so re-read them there before slicing the data.
      if (localOffset + 30 > bytes.length) continue;
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compressedSize);

      // A corrupt or crafted entry can make DecompressionStream reject (bad
      // deflate data, or a localOffset that lands in-bounds but not on a real
      // local header). One bad entry should not sink the whole archive, nor
      // surface a useless stack trace to a visitor: skip it and keep going.
      let inflated;
      try {
        inflated = await inflate(data, method, MAX_TOTAL_BYTES - total);
      } catch (err) {
        continue;
      }
      if (!inflated) continue;

      total += inflated.length;
      const text = decoder.decode(inflated);
      out.push({ name: base, text: function () { return Promise.resolve(text); } });
    }

    if (!out.length) {
      throw new Error('That zip holds no Spotify export files.');
    }
    return out;
  }

  return { read: read };
})();


/* ---- loader.js ---- */
const Loader = (function () {
  function parseTs(s) {
    // "2026-03-03 07:15" (UTC) -> whole minutes since epoch
    return Math.floor(Date.UTC(
      +s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10),
      +s.slice(11, 13), +s.slice(14, 16)) / 60000);
  }

  function intern(map, list, key) {
    let i = map.get(key);
    if (i === undefined) { i = list.length; map.set(key, i); list.push(key); }
    return i;
  }

  function dayRows(plays, tzOffset) {
    const rows = [];
    let cur = null, start = 0, ms = 0;
    for (let i = 0; i < plays.length; i++) {
      const day = new Date(Math.floor((plays[i][0] + tzOffset) / 1440) * 86400000)
        .toISOString().slice(0, 10);
      if (day !== cur) {
        if (cur !== null) rows.push([cur, start, i, ms, i - start]);
        cur = day; start = i; ms = 0;
      }
      ms += plays[i][2];
    }
    if (cur !== null) rows.push([cur, start, plays.length, ms, plays.length - start]);
    return rows;
  }

  function quantiles(values, buckets) {
    const v = values.filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
    if (!v.length) return [0, 0, 0, 0];
    const out = [];
    for (let i = 1; i < buckets; i++) {
      out.push(v[Math.min(v.length - 1, Math.floor(v.length * i / buckets))]);
    }
    return out;
  }

  // Matches Python's round(x, 4): round to 4 decimal places so meta.albumCoverage
  // agrees byte-for-byte with build.py's output, not merely to the displayed precision.
  function round4(x) {
    return Math.round((x + Number.EPSILON) * 10000) / 10000;
  }

  function baseOf(file) {
    return String(file.name).replace(/\\/g, '/').split('/').pop();
  }

  /** One file per basename, first occurrence wins. Dropping a zip together
      with its own unzipped folder must not count every play twice; fromFiles
      puts zip entries first, so the zip's copy is the one kept. */
  function uniqueByBase(files) {
    const seen = new Set();
    const out = [];
    for (const f of files) {
      const base = baseOf(f);
      if (seen.has(base)) continue;
      seen.add(base);
      out.push(f);
    }
    return out;
  }

  function pick(files, test) {
    const out = [];
    for (const f of files) if (test(baseOf(f))) out.push(f);
    return out.sort(function (a, b) { return baseOf(a).localeCompare(baseOf(b)); });
  }

  async function readJson(file) {
    try { return JSON.parse(await file.text()); } catch (e) { return null; }
  }

  async function readAll(files, test) {
    const out = [];
    for (const f of pick(files, test)) {
      const j = await readJson(f);
      if (Array.isArray(j)) out.push.apply(out, j);
      else if (j) out.push(j);
    }
    return out;
  }

  async function readOne(files, name, fallback) {
    const found = pick(files, function (n) { return n === name; })[0];
    if (!found) return fallback;
    const j = await readJson(found);
    return j === null ? fallback : j;
  }

  const EXPORT_FILES = [
    'Follow.json', 'Identity.json', 'Inferences.json', 'Marquee.json',
    'MessageData.json', 'Payments.json', 'Playlist1.json',
    'PodcastInteractivityComments.json', 'PodcastInteractivityReactions.json',
    'SearchQueries.json', 'UserAttributes.json', 'Wrapped2025.json',
    'YourLibrary.json', 'YourSoundCapsule.json'
  ];

  function isWanted(name) {
    return EXPORT_FILES.indexOf(name) !== -1 ||
      /^StreamingHistory_(music|podcast)_\d+\.json$/.test(name);
  }

  /* -- snapshots ----------------------------------------------------------

     A snapshot is an export reduced to its parsed contents:
       { music: [raw rows], podcast: [raw rows], other: { basename: json },
         present: [basenames], sources: [{ from, to, addedAt }] }
     It is what gets saved in the browser, and what two uploads merge on. */

  /** Parse the wanted files of one upload into a snapshot. */
  async function readSnapshot(input) {
    const files = uniqueByBase(input);
    const other = {};
    for (const name of EXPORT_FILES) {
      const found = await readOne(files, name, null);
      if (found !== null) other[name] = found;
    }
    const snap = {
      music: await readAll(files, function (n) {
        return /^StreamingHistory_music_\d+\.json$/.test(n);
      }),
      podcast: await readAll(files, function (n) {
        return /^StreamingHistory_podcast_\d+\.json$/.test(n);
      }),
      other: other,
      present: files.map(baseOf).filter(isWanted).sort()
    };
    const span = timeSpan(snap.music);
    snap.sources = span ? [{ from: span[0], to: span[1], addedAt: new Date().toISOString() }] : [];
    return snap;
  }

  function endOf(row) {
    return row && typeof row === 'object' ? String(row.endTime || '') : '';
  }

  /** [earliest, latest] endTime of a row list, or null when it has none. */
  function timeSpan(rows) {
    let lo = '', hi = '';
    for (const r of rows) {
      const t = endOf(r);
      if (!t) continue;
      if (!lo || t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return lo ? [lo, hi] : null;
  }

  /** Older rows up to where the newer export begins, then the newer rows.
      Overlapping stretches come from the newer export only, so a play that
      appears in both is counted once. */
  function stitch(older, newer) {
    const span = timeSpan(newer);
    if (!span) return older.slice();
    return older.filter(function (r) { return endOf(r) && endOf(r) < span[0]; }).concat(newer);
  }

  /** Combine a saved snapshot with a new upload. The export whose history
      reaches later is "newer": its plays win where the two overlap, and its
      other files (library, playlists, Wrapped...) replace the older ones.
      An upload with no music history counts as newer. */
  function mergeSnapshots(base, incoming) {
    const b = timeSpan(base.music), i = timeSpan(incoming.music);
    const incomingNewer = !i || !b || i[1] >= b[1];
    const older = incomingNewer ? base : incoming;
    const newer = incomingNewer ? incoming : base;
    const present = older.present.concat(newer.present).filter(function (n, k, all) {
      return all.indexOf(n) === k;
    }).sort();
    return {
      music: stitch(older.music, newer.music),
      podcast: stitch(older.podcast, newer.podcast),
      other: Object.assign({}, older.other, newer.other),
      present: present,
      sources: (base.sources || []).concat(incoming.sources || [])
    };
  }

  /** Build a payload with the same shape build.py emits. */
  async function buildPayload(input) {
    return buildFromSnapshot(await readSnapshot(input));
  }

  function buildFromSnapshot(snap) {
    function get(name, fallback) {
      return Object.prototype.hasOwnProperty.call(snap.other, name) ? snap.other[name] : fallback;
    }
    const musicRaw = snap.music;
    const podcastRaw = snap.podcast;

    // Mirrors build.py drop_short. Spotify counts a stream at 30 seconds.
    const MIN_PLAY_MS = 30000;
    const isPlay = function (r) { return r && typeof r === 'object' && (r.msPlayed || 0) >= MIN_PLAY_MS; };
    const music = musicRaw.filter(isPlay);
    const podcastRows = podcastRaw.filter(isPlay);
    if (!musicRaw.length) {
      throw new Error('No StreamingHistory_music_*.json found in that upload.');
    }
    if (!music.length) {
      throw new Error('That export has no plays longer than 30 seconds.');
    }
    const library = get('YourLibrary.json', {});
    const playlists = get('Playlist1.json', { playlists: [] });
    const identity = get('Identity.json', {});
    const attrs = get('UserAttributes.json', {});
    const payments = get('Payments.json', []);
    const follow = get('Follow.json', {});
    const messages = get('MessageData.json', {});
    const marquee = get('Marquee.json', []);
    const inferences = get('Inferences.json', {});
    const searches = get('SearchQueries.json', []);
    const wrapped = get('Wrapped2025.json', {});
    const capsule = get('YourSoundCapsule.json', {});
    const podComments = get('PodcastInteractivityComments.json', {});
    const podReactions = get('PodcastInteractivityReactions.json', {});

    // album lookup: playlists first, saved tracks win on conflict
    const albumByTrack = new Map();
    for (const pl of (playlists.playlists || [])) {
      for (const item of (pl.items || [])) {
        const tr = item.track;
        if (tr && tr.albumName) albumByTrack.set(tr.artistName + ' ' + tr.trackName, tr.albumName);
      }
    }
    for (const tr of (library.tracks || [])) {
      if (tr.album) albumByTrack.set(tr.artist + ' ' + tr.track, tr.album);
    }

    const aMap = new Map(), aList = [];
    const albMap = new Map(), albList = [];
    const tMap = new Map(), tList = [];
    const tracks = [], plays = [];

    for (const r of music) {
      const ai = intern(aMap, aList, r.artistName);
      const key = ai + ' ' + r.trackName;
      const before = tList.length;
      const ti = intern(tMap, tList, key);
      if (ti === before) {
        const album = albumByTrack.get(r.artistName + ' ' + r.trackName);
        tracks.push([ai, r.trackName, album ? intern(albMap, albList, album) : null]);
      }
      plays.push([parseTs(r.endTime), ti, r.msPlayed]);
    }
    plays.sort(function (a, b) { return a[0] - b[0]; });

    const sMap = new Map(), sList = [];
    const eMap = new Map(), eList = [];
    const episodes = [], podPlays = [];
    for (const r of podcastRows) {
      const si = intern(sMap, sList, r.podcastName);
      const key = si + ' ' + r.episodeName;
      const before = eList.length;
      const ei = intern(eMap, eList, key);
      if (ei === before) episodes.push([si, r.episodeName]);
      podPlays.push([parseTs(r.endTime), ei, r.msPlayed]);
    }
    podPlays.sort(function (a, b) { return a[0] - b[0]; });

    const tz = 420;
    const days = dayRows(plays, tz);
    const pdays = dayRows(podPlays, tz);
    let totalMs = 0, withAlbum = 0, albumMs = 0;
    for (const p of plays) {
      totalMs += p[2];
      if (tracks[p[1]][2] !== null) { withAlbum++; albumMs += p[2]; }
    }

    // Only the URIs Wrapped references, resolved from saved items and playlists.
    const uriNames = {};
    for (const tr of (library.tracks || [])) uriNames[tr.uri] = tr.track + ' - ' + tr.artist;
    for (const al of (library.albums || [])) uriNames[al.uri] = al.album + ' - ' + al.artist;
    for (const g of ['artists', 'shows', 'bannedArtists']) {
      for (const it of (library[g] || [])) uriNames[it.uri] = it.name;
    }
    for (const ep of (library.episodes || [])) uriNames[ep.uri] = ep.name;
    for (const pl of (playlists.playlists || [])) {
      for (const item of (pl.items || [])) {
        const tr = item.track;
        if (tr && tr.trackUri && !uriNames[tr.trackUri]) {
          uriNames[tr.trackUri] = tr.trackName + ' - ' + tr.artistName;
        }
      }
    }
    const wanted = new Set();
    (function walk(node) {
      if (typeof node === 'string') { if (node.indexOf('spotify:') === 0) wanted.add(node); }
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    })(wrapped);
    const trimmedUriNames = {};
    for (const u of wanted) if (uriNames[u]) trimmedUriNames[u] = uriNames[u];

    const present = snap.present.slice();

    return {
      meta: {
        generated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC (in browser)',
        tzDefault: tz,
        present: present,
        rangeStart: days.length ? days[0][0] : '',
        rangeEnd: days.length ? days[days.length - 1][0] : '',
        counts: {
          plays: plays.length, tracks: tracks.length, artists: aList.length,
          albums: albList.length, ms: totalMs, podcastPlays: podPlays.length,
          shows: sList.length, episodes: episodes.length
        },
        albumCoverage: {
          plays: plays.length ? round4(withAlbum / plays.length) : 0,
          ms: totalMs ? round4(albumMs / totalMs) : 0,
          tracks: tracks.length
            ? round4(tracks.filter(function (t) { return t[2] !== null; }).length / tracks.length) : 0
        },
        heatScale: quantiles(days.map(function (d) { return d[3]; }), 5)
      },
      artists: aList,
      albums: albList,
      tracks: tracks,
      plays: plays,
      days: days,
      podcast: { shows: sList, episodes: episodes, plays: podPlays, days: pdays },
      extras: {
        uriNames: trimmedUriNames,
        account: {
          displayName: identity.displayName, imageUrl: identity.largeImageUrl,
          username: attrs.username, email: attrs.email, country: attrs.country,
          birthdate: attrs.birthdate, gender: attrs.gender,
          creationTime: attrs.creationTime,
          payment: payments && payments[0] ? payments[0].payment_method : null
        },
        wrapped: wrapped,
        capsule: capsule,
        searches: (searches || []).map(function (q) {
          return [(q.searchTime || '').replace('[UTC]', ''), q.searchQuery || ''];
        }),
        playlists: (playlists.playlists || []).map(function (pl) {
          return {
            name: pl.name, description: pl.description,
            lastModifiedDate: pl.lastModifiedDate, followers: pl.numberOfFollowers || 0,
            items: (pl.items || []).filter(function (i) { return i.track; })
              .map(function (i) {
                return {
                  added: i.addedDate, track: i.track.trackName,
                  artist: i.track.artistName, album: i.track.albumName, uri: i.track.trackUri
                };
              })
          };
        }),
        library: {
          tracks: library.tracks || [], albums: library.albums || [],
          artists: library.artists || [], shows: library.shows || [],
          episodes: library.episodes || [], bannedArtists: library.bannedArtists || [],
          bannedTracks: library.bannedTracks || []
        },
        follows: {
          following: follow.userIsFollowing || [], followers: follow.userIsFollowedBy || [],
          blocking: follow.userIsBlocking || []
        },
        messages: Object.values(messages || {}).map(function (t) {
          return {
            members: t.members || [], groupName: t.group_name,
            messages: (t.messages || []).map(function (m) {
              return { time: m.time, from: m.from, message: m.message };
            })
          };
        }),
        marquee: (marquee || []).map(function (m) { return [m.artistName, m.segment]; }),
        inferences: (inferences || {}).inferences || [],
        podcastInteractions: {
          comments: (podComments || {}).comments || [],
          reactions: (podReactions || {}).reactions || []
        }
      }
    };
  }

  /** Accepts a FileList, an array of File, or a single .zip File.
      Returns { payload, present, missing }. */
  async function fromFiles(input, base) {
    let files = Array.prototype.slice.call(input || []);
    if (!files.length) throw new Error('Nothing to read.');

    const zips = files.filter(function (f) { return /\.zip$/i.test(f.name); });
    if (zips.length) {
      const nonZips = files.filter(function (f) { return !/\.zip$/i.test(f.name); });
      const extracted = [];
      for (const z of zips) {
        extracted.push.apply(extracted, await Zip.read(z, isWanted));
      }
      files = extracted.concat(nonZips);
    }

    const incoming = await readSnapshot(files);
    if (!incoming.present.length) {
      throw new Error('Nothing in that upload looks like a Spotify export.');
    }
    const snapshot = base ? mergeSnapshots(base, incoming) : incoming;
    const payload = buildFromSnapshot(snapshot);
    const present = payload.meta.present;
    const missing = EXPORT_FILES.filter(function (n) { return present.indexOf(n) === -1; });
    return { payload: payload, snapshot: snapshot, present: present, missing: missing };
  }

  return {
    buildPayload: buildPayload,
    buildFromSnapshot: buildFromSnapshot,
    mergeSnapshots: mergeSnapshots,
    fromFiles: fromFiles,
    isWanted: isWanted,
    EXPORT_FILES: EXPORT_FILES
  };
})();


/* ---- store.js ---- */
/* Store: keeps the loaded export in this browser's IndexedDB so it is there
   next visit. Nothing here touches the network; the data never leaves the
   device. Every call resolves (never rejects): storage can be blocked, full,
   or missing in a private window, and the page must work without it. */

const Store = (function () {
  const DB = 'spotify-history';
  const TABLE = 'exports';
  const KEY = 'current';

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') return reject(new Error('No IndexedDB'));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(TABLE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
    });
  }

  async function run(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise(function (resolve, reject) {
        const tx = db.transaction(TABLE, mode);
        const req = fn(tx.objectStore(TABLE));
        tx.oncomplete = function () { resolve(req ? req.result : undefined); };
        tx.onerror = tx.onabort = function () { reject(tx.error); };
      });
    } finally {
      db.close();
    }
  }

  /** The saved snapshot, or null. */
  async function load() {
    try { return (await run('readonly', function (s) { return s.get(KEY); })) || null; }
    catch (e) { return null; }
  }

  /** True when the snapshot was saved. */
  async function save(snapshot) {
    try { await run('readwrite', function (s) { return s.put(snapshot, KEY); }); return true; }
    catch (e) { return false; }
  }

  async function clear() {
    try { await run('readwrite', function (s) { return s.delete(KEY); }); return true; }
    catch (e) { return false; }
  }

  return { load: load, save: save, clear: clear };
})();


/* ---- timeline.js ---- */
/* Timeline: the home view. Hero stats, activity heatmap, and the full
   chronological list of everything played on one day. */

const Timeline = (function () {
  // 53 weeks at this pitch is 28 + 53 * 12 = 664px; the SVG then scales to
  // fill the content column.
  const CELL = 10, PITCH = 12, PAD_LEFT = 28, PAD_TOP = 18;
  const HEAT_COLORS = ['#0a3a1c', '#10592b', '#16803c', '#1ab04e', '#1ed760'];
  const HEAT_EMPTY = '#1c1c1c';

  let root = null;
  let selected = null;
  let heatEl = null;

  /* -- helpers ----------------------------------------------------------- */

  function bucket(ms) {
    if (!ms) return -1;
    const t = Data.meta.heatScale;
    let b = 0;
    for (let i = 0; i < t.length; i++) if (ms >= t[i]) b = i + 1;
    return Math.min(b, HEAT_COLORS.length - 1);
  }

  function mostRecentDay() {
    const days = Data.days();
    return days.length ? days[days.length - 1][0] : Data.meta.rangeEnd;
  }

  function nearestDayWithData(dateStr) {
    const days = Data.days();
    if (!days.length) return null;
    let best = days[0][0], bestGap = Infinity;
    const target = Data.dateToEpochDay(dateStr);
    for (const row of days) {
      const gap = Math.abs(Data.dateToEpochDay(row[0]) - target);
      if (gap < bestGap) { bestGap = gap; best = row[0]; }
    }
    return best;
  }

  function clampDate(dateStr) {
    const s = Data.stats();
    if (dateStr < s.rangeStart) return s.rangeStart;
    if (dateStr > s.rangeEnd) return s.rangeEnd;
    return dateStr;
  }

  /* -- hero -------------------------------------------------------------- */

  // Contract: unlike Extras.stat (a different function, same name), this one
  // owns escaping -- pass raw values, not pre-escaped HTML.
  function stat(label, value, sub, isText) {
    return '<div class="stat"><p class="stat-label">' + esc(label) + '</p>' +
      '<div class="stat-value' + (isText ? ' is-text' : '') + '" title="' + attr(value) + '">' +
      esc(value) + '</div>' +
      (sub ? '<div class="stat-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function renderStats() {
    const s = Data.stats();
    const [lo, hi] = Data.rangeFor(null, null, false);
    const top = Data.sortBy(
      Data.aggregate({ lo: lo, hi: hi, by: 'artist' }), 'ms')[0];
    const perDay = s.activeDays ? s.ms / s.activeDays : 0;

    root.querySelector('#tlStats').innerHTML = [
      stat('Listening time', fmtDuration(s.ms),
           fmtDuration(perDay) + ' on an average active day'),
      stat('Plays', fmtNumber(s.plays), fmtNumber(s.tracks) + ' unique tracks'),
      stat('Artists', fmtNumber(s.artists),
           App.hasFile('StreamingHistory_podcast_*')
             ? fmtNumber(s.podcastPlays) + ' podcast plays, ' + fmtNumber(s.shows) + ' shows'
             : ''),
      stat('Top artist', top ? top.label : '—',
           top ? fmtDuration(top.ms) + ' · ' + fmtNumber(top.plays) + ' plays' : '', true),
      stat('Covered', fmtDate(s.rangeStart), 'through ' + fmtDate(s.rangeEnd), true)
    ].join('');
  }

  /* -- heatmap ----------------------------------------------------------- */

  function renderHeat() {
    const s = Data.stats();
    const first = Data.dateToEpochDay(s.rangeStart);
    const last = Data.dateToEpochDay(s.rangeEnd);
    // Monday-align the first column so weekday rows stay consistent.
    const firstDow = (new Date(first * 86400000).getUTCDay() + 6) % 7;
    const gridStart = first - firstDow;
    const weeks = Math.ceil((last - gridStart + 1) / 7);

    const totals = new Map();
    for (const row of Data.days()) totals.set(row[0], row);

    const cells = [];
    const monthLabels = [];
    let lastMonth = -1;
    const w = PAD_LEFT + weeks * PITCH;
    const h = PAD_TOP + 7 * PITCH;

    for (let wk = 0; wk < weeks; wk++) {
      for (let dow = 0; dow < 7; dow++) {
        const epochDay = gridStart + wk * 7 + dow;
        if (epochDay < first || epochDay > last) continue;
        const date = Data.epochDayToDate(epochDay);
        const row = totals.get(date);
        const ms = row ? row[3] : 0;
        const b = bucket(ms);
        const p = dateParts(date);
        if (p.m !== lastMonth && dow <= 3) {
          lastMonth = p.m;
          // A month starting in the final column has no room for its label.
          const x = PAD_LEFT + wk * PITCH;
          if (x + 24 <= w) {
            monthLabels.push('<text x="' + x + '" y="10">' +
              MONTHS[p.m] + (p.m === 0 ? ' ' + p.y : '') + '</text>');
          }
        }
        cells.push('<rect data-date="' + date + '" x="' + (PAD_LEFT + wk * PITCH) +
          '" y="' + (PAD_TOP + dow * PITCH) + '" width="' + CELL + '" height="' + CELL +
          '" rx="2" fill="' + (b < 0 ? HEAT_EMPTY : HEAT_COLORS[b]) + '"' +
          (date === selected ? ' class="is-selected"' : '') + '><title>' +
          fmtDate(date) + ' - ' +
          (row ? fmtDuration(ms) + ', ' + row[4] + ' plays' : 'nothing played') +
          '</title></rect>');
      }
    }

    const dowLabels = [[0, 'Mon'], [2, 'Wed'], [4, 'Fri']].map(function (pair) {
      return '<text x="0" y="' + (PAD_TOP + pair[0] * PITCH + 9) + '">' + pair[1] + '</text>';
    }).join('');

    heatEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    heatEl.setAttribute('width', w);
    heatEl.setAttribute('height', h);
    // Scale to the column's width, up to 1.6x (a year fills 1024px), and
    // never below 80%: past that the wrapper scrolls instead.
    heatEl.style.maxWidth = Math.round(w * 1.6) + 'px';
    heatEl.style.minWidth = Math.round(w * 0.8) + 'px';
    heatEl.innerHTML = monthLabels.join('') + dowLabels + cells.join('');
  }

  function markHeatSelection() {
    const prev = heatEl.querySelector('.is-selected');
    if (prev) prev.removeAttribute('class');
    const next = heatEl.querySelector('[data-date="' + selected + '"]');
    if (next) {
      next.setAttribute('class', 'is-selected');
      next.parentNode.appendChild(next); // raise so the ring is not clipped
    }
  }

  /* -- day list ---------------------------------------------------------- */

  function dayEntries(date) {
    const mode = App.settings.mode;
    const out = [];
    if (mode !== 'podcast') {
      for (const p of Data.playsInDay(date)) {
        const info = Data.trackInfo(p[1]);
        out.push({ ts: p[0], ms: p[2], kind: 'music', title: info.title,
                   artist: info.artist, album: info.album });
      }
    }
    if (mode !== 'music') {
      for (const p of Data.podcastInDay(date)) {
        const info = Data.episodeInfo(p[1]);
        out.push({ ts: p[0], ms: p[2], kind: 'podcast', title: info.title,
                   artist: info.show, album: null });
      }
    }
    return out.sort(function (a, b) { return a.ts - b.ts; });
  }

  function renderDay() {
    const entries = dayEntries(selected);
    const head = root.querySelector('#tlDayHead');
    const body = root.querySelector('#tlDayBody');

    let totalMs = 0;
    const artistMs = new Map();
    const uniq = new Set();
    for (const e of entries) {
      totalMs += e.ms;
      uniq.add(e.title + ' ' + e.artist);
      artistMs.set(e.artist, (artistMs.get(e.artist) || 0) + e.ms);
    }
    let topArtist = null, topMs = -1;
    for (const pair of artistMs) if (pair[1] > topMs) { topMs = pair[1]; topArtist = pair[0]; }

    const s = Data.stats();
    const prevIcon = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M10.3 2.3 4.6 8l5.7 5.7 1.1-1.1L6.8 8l4.6-4.6-1.1-1.1Z"/></svg>';
    const nextIcon = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M5.7 2.3 4.6 3.4 9.2 8l-4.6 4.6 1.1 1.1L11.4 8 5.7 2.3Z"/></svg>';

    head.innerHTML =
      '<div><h2 class="day-title">' + fmtDate(selected, true) + '</h2>' +
      '<p class="day-meta">' + (entries.length
        ? fmtDuration(totalMs) + ' · ' + fmtNumber(entries.length) + ' plays · ' +
          fmtNumber(uniq.size) + ' unique tracks · ' + fmtNumber(artistMs.size) + ' artists' +
          (topArtist ? ' · most played <b style="color:var(--text)">' + esc(topArtist) + '</b>' : '')
        : 'Nothing played on this day') + '</p></div>' +
      '<div class="day-nav">' +
      '<button class="btn-circle" data-step="-1" type="button" aria-label="Previous day"' +
        (selected <= s.rangeStart ? ' disabled' : '') + '>' + prevIcon + '</button>' +
      '<input class="date-input" type="date" id="tlDate" value="' + selected +
        '" min="' + s.rangeStart + '" max="' + s.rangeEnd + '" aria-label="Pick a date">' +
      '<button class="btn-circle" data-step="1" type="button" aria-label="Next day"' +
        (selected >= s.rangeEnd ? ' disabled' : '') + '>' + nextIcon + '</button>' +
      '</div>';

    if (!entries.length) {
      const near = nearestDayWithData(selected);
      body.innerHTML = '<div class="empty"><p class="empty-title">A quiet day</p>' +
        '<p>No plays recorded for ' + fmtDate(selected) + '.' +
        (App.settings.mode !== 'both'
          ? ' You are currently showing <b>' + esc(App.settings.mode) + '</b> only.' : '') +
        '</p>' + (near ? '<p style="margin-top:14px"><button class="btn-outline" ' +
          'data-goto="' + near + '" type="button">Go to ' + fmtDate(near) + '</button></p>' : '') +
        '</div>';
      return;
    }

    const label = 'font-size:10px;letter-spacing:1.4px;text-transform:uppercase';
    body.innerHTML =
      '<div class="row" style="height:30px">' +
      '<div class="row-time" style="' + label + '">Ended</div>' +
      '<div class="row-sub" style="' + label + '">Track</div>' +
      '<div class="row-dur" style="' + label + '">Played</div></div>' +
      entries.map(function (e) {
        return '<div class="row" style="height:52px">' +
          '<div class="row-time">' + fmtTimeOfDay(Data.localMinutes(e.ts)) + '</div>' +
          '<div class="row-main"><div class="row-title">' + esc(e.title) + '</div>' +
          '<div class="row-sub">' +
          (e.kind === 'podcast'
            ? '<span class="badge badge--pod">Podcast</span><span>' + esc(e.artist) + '</span>'
            : '<button class="row-artist" data-artist="' + esc(e.artist) + '" type="button">' +
              esc(e.artist) + '</button>') +
          (e.album ? '<span class="row-extra">· ' + esc(e.album) + '</span>' : '') +
          '</div></div>' +
          '<div class="row-dur">' + fmtClockDuration(e.ms) + '</div></div>';
      }).join('');
  }

  /* -- selection --------------------------------------------------------- */

  function select(date, skipHash) {
    selected = clampDate(date);
    markHeatSelection();
    renderDay();
    if (!skipHash) history.replaceState(null, '', '#timeline/' + selected);
  }

  function step(delta) {
    select(Data.shiftDate(selected, delta));
    root.querySelector('#tlDayHead').scrollIntoView({ block: 'nearest' });
  }

  /* -- lifecycle --------------------------------------------------------- */

  function init(el) {
    root = el;
    el.innerHTML =
      '<div class="view-head"><h1 class="view-title">Timeline</h1></div>' +
      '<div class="stat-band" id="tlStats"></div>' +
      '<div class="section"><div class="section-head">' +
      '<h2 class="section-title">Activity</h2>' +
      '<span class="section-note">Click any square</span></div>' +
      '<div class="heat-wrap"><svg class="heat" id="tlHeat" role="img" ' +
      'aria-label="Daily listening activity"></svg></div>' +
      '<div class="heat-legend"><span>Less</span>' +
      '<i style="background:' + HEAT_EMPTY + '"></i>' +
      HEAT_COLORS.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join('') +
      '<span>More</span></div></div>' +
      '<div class="day-head" id="tlDayHead"></div>' +
      '<div class="rows" id="tlDayBody"></div>';

    heatEl = el.querySelector('#tlHeat');
    selected = mostRecentDay();
    renderStats();
    renderHeat();
    renderDay();

    heatEl.addEventListener('click', function (e) {
      const rect = e.target.closest('[data-date]');
      if (rect) select(rect.dataset.date);
    });

    el.addEventListener('click', function (e) {
      const stepBtn = e.target.closest('[data-step]');
      if (stepBtn) { step(+stepBtn.dataset.step); return; }
      const goto = e.target.closest('[data-goto]');
      if (goto) { select(goto.dataset.goto); return; }
      const artist = e.target.closest('[data-artist]');
      if (artist) History.openWithArtist(artist.dataset.artist);
    });

    el.addEventListener('change', function (e) {
      if (e.target.id === 'tlDate' && e.target.value) select(e.target.value);
    });

    App.onChange(function (what) {
      if (what === 'tz') {
        selected = clampDate(selected);
        renderStats(); renderHeat(); renderDay();
      } else if (what === 'mode') {
        renderDay();
      }
    });
  }

  function show(arg) {
    if (arg && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(arg) && arg !== selected) select(arg, true);
  }

  return {
    init: init, show: show, step: step, select: select,
    get selected() { return selected; }
  };
})();

App.registerView('timeline', { label: 'Timeline', init: Timeline.init, show: Timeline.show });


/* ---- charts.js ---- */
/* Charts: top artists and tracks over a chosen period, plus listening
   distributions. Both metrics are always shown; the toggle only reorders. */

const Charts = (function () {
  const PERIODS = [
    ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'],
    ['year', 'Year'], ['all', 'All time'], ['custom', 'Custom']
  ];
  const LIMIT_STEP = 50;

  let root = null;
  let by = 'artist';
  let metric = 'ms';
  let period = 'all';
  let offset = 0;     // 0 = most recent period, -1 = the one before it
  let limit = LIMIT_STEP;
  let customStart = null;
  let customEnd = null;

  /* -- period arithmetic ------------------------------------------------- */

  function ymd(y, m, d) {
    return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  }

  function mondayOf(dateStr) {
    const p = dateParts(dateStr);
    return Data.shiftDate(dateStr, -p.dow);
  }

  /** {start, end, label} for the period `offset` steps back from the latest. */
  function periodRange(type, off) {
    const s = Data.stats();
    if (type === 'all') {
      return { start: s.rangeStart, end: s.rangeEnd, label: 'All time', fixed: true };
    }
    if (type === 'custom') {
      return {
        start: customStart || s.rangeStart,
        end: customEnd || s.rangeEnd,
        label: fmtDate(customStart || s.rangeStart) + ' to ' + fmtDate(customEnd || s.rangeEnd),
        fixed: true
      };
    }
    const p = dateParts(s.rangeEnd);
    if (type === 'week') {
      const start = Data.shiftDate(mondayOf(s.rangeEnd), off * 7);
      const end = Data.shiftDate(start, 6);
      return { start: start, end: end, label: fmtDate(start) + ' – ' + fmtDate(end) };
    }
    if (type === 'month') {
      const d = new Date(Date.UTC(p.y, p.m + off, 1));
      const y = d.getUTCFullYear(), m = d.getUTCMonth();
      return {
        start: ymd(y, m, 1),
        end: ymd(y, m + 1, 0),
        label: ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'][m] + ' ' + y
      };
    }
    if (type === 'quarter') {
      const q = Math.floor(p.m / 3);
      const d = new Date(Date.UTC(p.y, (q + off) * 3, 1));
      const y = d.getUTCFullYear(), m = d.getUTCMonth();
      return {
        start: ymd(y, m, 1),
        end: ymd(y, m + 3, 0),
        label: 'Q' + (Math.floor(m / 3) + 1) + ' ' + y
      };
    }
    const y = p.y + off;
    return { start: ymd(y, 0, 1), end: ymd(y, 11, 31), label: String(y) };
  }

  /** True when the period sits at least partly inside the export range. */
  function hasData(range) {
    const s = Data.stats();
    return range.end >= s.rangeStart && range.start <= s.rangeEnd;
  }

  /* -- rendering --------------------------------------------------------- */

  function rankRows(list, prevRanks) {
    const max = list.length ? list[0][metric] : 1;
    return list.slice(0, limit).map(function (item, i) {
      const pct = max ? Math.max(1.5, (item[metric] / max) * 100) : 0;
      const prev = prevRanks ? prevRanks.get(item.key) : undefined;
      let delta = '';
      if (prevRanks) {
        if (prev === undefined) delta = '<span class="delta delta--new">NEW</span>';
        else if (prev > i) delta = '<span class="delta delta--up">&uarr;' + (prev - i) + '</span>';
        else if (prev < i) delta = '<span class="delta delta--down">&darr;' + (i - prev) + '</span>';
        else delta = '<span class="delta delta--same">&ndash;</span>';
      }
      const nameBtn = '<button class="rank-name" type="button" data-search="' +
        esc(by === 'artist' ? item.label : item.label + ' ' + item.sub) + '" ' +
        'data-artist="' + esc(by === 'artist' ? item.label : item.sub) + '" title="' +
        esc(item.label) + '">' + esc(item.label) + '</button>';

      return '<div class="rank' + (i === 0 ? ' rank--top' : '') + '">' +
        '<div class="rank-n">' + (i + 1) + '</div><div class="rank-body">' +
        '<div class="rank-line"><div style="min-width:0;display:flex;align-items:baseline">' +
        nameBtn + delta + '</div>' +
        '<div class="rank-metrics">' +
        (metric === 'ms'
          ? '<b>' + fmtDuration(item.ms) + '</b> · ' + fmtNumber(item.plays) + ' plays'
          : '<b>' + fmtNumber(item.plays) + ' plays</b> · ' + fmtDuration(item.ms)) +
        '</div></div>' +
        (by === 'track' && item.sub
          ? '<div class="row-sub" style="margin-top:2px">' + esc(item.sub) +
            (item.album ? '<span class="row-extra">· ' + esc(item.album) + '</span>' : '') +
            '</div>'
          : '') +
        '<div class="rank-bar"><i style="width:' + pct.toFixed(2) + '%"></i></div>' +
        '</div></div>';
    }).join('');
  }

  /** Bar chart. `labels` go under the bars (may be blank); `names` head each
      bar's tooltip, which also gives its listening time and share. */
  function columnChart(values, labels, names) {
    const max = Math.max.apply(null, values) || 1;
    const total = values.reduce(function (a, b) { return a + b; }, 0) || 1;
    const peak = values.indexOf(max);
    const edge = Math.floor(values.length / 3);
    return '<div class="cols">' + values.map(function (v, i) {
      const tip = names[i] + ' · ' + fmtDuration(v) + ' · ' +
        Math.round((v / total) * 100) + '%';
      // Tooltips on the outer third of bars anchor inward, so even on a phone,
      // where 24 bars are ~15px each, they stay inside the card.
      const side = i < edge ? ' is-start' : i >= values.length - edge ? ' is-end' : '';
      return '<div class="col' + (i === peak ? ' is-peak' : '') + side + '" tabindex="0" ' +
        'aria-label="' + attr(tip) + '">' +
        '<div class="col-bar"><i style="height:' + ((v / max) * 100).toFixed(1) + '%" ' +
        'data-tip="' + attr(tip) + '"></i></div>' +
        '<span>' + esc(labels[i]) + '</span></div>';
    }).join('') + '</div>';
  }

  function render() {
    const custom = root.querySelector('#chCustom');
    custom.hidden = period !== 'custom';
    if (period === 'custom') {
      const s = Data.stats();
      const from = root.querySelector('#chFrom');
      const to = root.querySelector('#chTo');
      from.min = to.min = s.rangeStart;
      from.max = to.max = s.rangeEnd;
      from.value = customStart || s.rangeStart;
      to.value = customEnd || s.rangeEnd;
    }

    const range = periodRange(period, offset);
    const prevRange = range.fixed ? null : periodRange(period, offset - 1);
    const [lo, hi] = Data.rangeFor(range.start, range.end, false);
    const list = Data.sortBy(
      Data.aggregate({ lo: lo, hi: hi, by: by }), metric);

    let prevRanks = null;
    if (prevRange && hasData(prevRange)) {
      const [plo, phi] = Data.rangeFor(prevRange.start, prevRange.end, false);
      const prevList = Data.sortBy(
        Data.aggregate({ lo: plo, hi: phi, by: by }), metric);
      prevRanks = new Map();
      prevList.forEach(function (item, i) { prevRanks.set(item.key, i); });
    }

    let totalMs = 0, totalPlays = 0;
    for (const item of list) { totalMs += item.ms; totalPlays += item.plays; }

    root.querySelector('#chPeriodLabel').textContent = range.label;
    root.querySelector('#chPrev').disabled = range.fixed ||
      !hasData(periodRange(period, offset - 1));
    root.querySelector('#chNext').disabled = range.fixed || offset >= 0;

    root.querySelector('#chSummary').innerHTML =
      list.length
        ? fmtNumber(list.length) + ' ' + (by === 'artist' ? 'artists' : 'tracks') +
          ' · ' + fmtDuration(totalMs) + ' · ' + fmtNumber(totalPlays) + ' plays'
        : '';

    const body = root.querySelector('#chRanks');
    if (!list.length) {
      body.innerHTML = '<div class="empty"><p class="empty-title">Nothing here</p>' +
        '<p>No plays in ' + esc(range.label) + '.</p></div>';
    } else {
      body.innerHTML = rankRows(list, prevRanks) +
        (list.length > limit
          ? '<p style="padding:12px"><button class="btn-outline" id="chMore" type="button">' +
            'Show ' + Math.min(LIMIT_STEP, list.length - limit) + ' more</button></p>'
          : '');
    }

    root.querySelector('#chAlbumNote').textContent = by === 'track' && list.length
      ? 'Album names come from your playlists and saved tracks, so some tracks have none.'
      : '';

    const hours = Data.hourHistogram(lo, hi);
    const weekdays = Data.weekdayHistogram(lo, hi);
    root.querySelector('#chHours').innerHTML = columnChart(
      hours,
      hours.map(function (_, i) { return i % 3 === 0 ? String(i) : ''; }),
      hours.map(function (_, i) {
        return String(i).padStart(2, '0') + ':00–' + String((i + 1) % 24).padStart(2, '0') + ':00';
      }));
    root.querySelector('#chWeekdays').innerHTML = columnChart(
      weekdays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], WEEKDAYS);
  }

  /* -- lifecycle --------------------------------------------------------- */

  function init(el) {
    root = el;
    // A fresh init means a new dataset: offsets and dates from the last one
    // may not exist in this one. The By/Metric toggles are drawn in their
    // default state below, so reset those to match.
    by = 'artist';
    metric = 'ms';
    offset = 0;
    limit = LIMIT_STEP;
    customStart = customEnd = null;
    el.innerHTML =
      '<div class="view-head"><h1 class="view-title">Charts</h1></div>' +

      '<div class="section"><div class="section-head">' +
      '<div class="seg" id="chBy" role="group" aria-label="Rank by">' +
      '<button type="button" data-by="artist" aria-pressed="true">Artists</button>' +
      '<button type="button" data-by="track" aria-pressed="false">Tracks</button></div>' +
      '<div class="seg" id="chMetric" role="group" aria-label="Metric">' +
      '<button type="button" data-metric="ms" aria-pressed="true">By time</button>' +
      '<button type="button" data-metric="plays" aria-pressed="false">By plays</button></div>' +
      '</div>' +

      '<div class="section-head" style="align-items:center">' +
      '<div class="seg" id="chPeriod" role="group" aria-label="Period">' +
      PERIODS.map(function (p) {
        return '<button type="button" data-period="' + p[0] + '" aria-pressed="' +
          (p[0] === period) + '">' + p[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="ch-custom" id="chCustom" hidden>' +
      '<label for="chFrom">From</label>' +
      '<input class="date-input" type="date" id="chFrom">' +
      '<label for="chTo">To</label>' +
      '<input class="date-input" type="date" id="chTo"></div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-left:auto">' +
      '<button class="btn-circle" id="chPrev" type="button" aria-label="Earlier period">' +
      '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M10.3 2.3 4.6 8l5.7 5.7 1.1-1.1L6.8 8l4.6-4.6-1.1-1.1Z"/></svg></button>' +
      '<strong id="chPeriodLabel" style="font-size:16px;min-width:9ch;text-align:center"></strong>' +
      '<button class="btn-circle" id="chNext" type="button" aria-label="Later period">' +
      '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M5.7 2.3 4.6 3.4 9.2 8l-4.6 4.6 1.1 1.1L11.4 8 5.7 2.3Z"/></svg></button>' +
      '</div></div>' +
      '<p class="section-note" id="chSummary" aria-live="polite" style="margin:0 0 8px"></p>' +
      '<div id="chRanks"></div>' +
      '<p class="section-note" id="chAlbumNote"></p></div>' +

      '<div class="section"><div class="section-head">' +
      '<h2 class="section-title">Peak listening hours</h2>' +
      '</div><div class="card" id="chHours"></div></div>' +

      '<div class="section"><div class="section-head">' +
      '<h2 class="section-title">Peak listening days</h2>' +
      '</div><div class="card" id="chWeekdays"></div></div>';

    el.addEventListener('click', function (e) {
      const byBtn = e.target.closest('[data-by]');
      if (byBtn) {
        by = byBtn.dataset.by; limit = LIMIT_STEP;
        setPressed('#chBy', '[data-by]', 'by', by);
        return render();
      }
      const mBtn = e.target.closest('[data-metric]');
      if (mBtn) {
        metric = mBtn.dataset.metric;
        setPressed('#chMetric', '[data-metric]', 'metric', metric);
        return render();
      }
      const pBtn = e.target.closest('[data-period]');
      if (pBtn) {
        period = pBtn.dataset.period; offset = 0; limit = LIMIT_STEP;
        setPressed('#chPeriod', '[data-period]', 'period', period);
        return render();
      }
      if (e.target.closest('#chPrev')) { offset -= 1; limit = LIMIT_STEP; return render(); }
      if (e.target.closest('#chNext')) { offset += 1; limit = LIMIT_STEP; return render(); }
      if (e.target.closest('#chMore')) { limit += LIMIT_STEP; return render(); }
      const artist = e.target.closest('[data-artist]');
      if (artist) History.openWithArtist(artist.dataset.artist);
    });

    el.addEventListener('change', function (e) {
      if (e.target.id !== 'chFrom' && e.target.id !== 'chTo') return;
      const from = root.querySelector('#chFrom');
      const to = root.querySelector('#chTo');
      if (from.value && to.value && from.value > to.value) {
        const swap = from.value; from.value = to.value; to.value = swap;
      }
      customStart = from.value || null;
      customEnd = to.value || null;
      render();
    });

    function setPressed(scope, sel, key, value) {
      root.querySelectorAll(scope + ' ' + sel).forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset[key] === value));
      });
    }

    App.onChange(function (what) {
      if (what === 'tz') render();
    });

    render();
  }

  return { init: init };
})();

App.registerView('charts', { label: 'Charts', init: Charts.init });


/* ---- history.js ---- */
/* History: the full archive. Every play, virtualised, with debounced search
   and removable filter chips. */

const History = (function () {
  const ROW_H = 56;
  const DEBOUNCE_MS = 180;

  let root = null;
  let vlist = null;
  let items = [];
  let seq = 0;           // guards against a stale filter pass painting late
  let podSearch = null;

  const filters = { query: '', artist: null, order: 'desc' };

  /* -- filtering --------------------------------------------------------- */

  function podcastSearchIndex() {
    if (podSearch) return podSearch;
    const eps = Data.raw.podcast.episodes;
    const shows = Data.raw.podcast.shows;
    podSearch = eps.map(function (e) {
      return (e[1] + ' ' + shows[e[0]]).toLowerCase();
    });
    return podSearch;
  }

  function build() {
    const mode = App.settings.mode;
    const q = filters.query.trim().toLowerCase();
    const out = [];

    if (mode !== 'podcast') {
      const plays = Data.raw.plays;
      const tracks = Data.raw.tracks;
      const lo = 0, hi = plays.length;
      const idx = q ? Data.searchIndex() : null;
      const artistIdx = filters.artist === null ? -1 : Data.raw.artists.indexOf(filters.artist);
      if (filters.artist === null || artistIdx !== -1) {
        for (let i = lo; i < hi; i++) {
          const p = plays[i];
          const ti = p[1];
          if (artistIdx !== -1 && tracks[ti][0] !== artistIdx) continue;
          if (q && idx[ti].indexOf(q) === -1) continue;
          out.push([p[0], p[2], ti, 0]);
        }
      }
    }

    if (mode !== 'music' && filters.artist === null) {
      const plays = Data.raw.podcast.plays;
      const lo = 0, hi = plays.length;
      const idx = q ? podcastSearchIndex() : null;
      for (let i = lo; i < hi; i++) {
        const p = plays[i];
        if (q && idx[p[1]].indexOf(q) === -1) continue;
        out.push([p[0], p[2], p[1], 1]);
      }
    }

    out.sort(filters.order === 'desc'
      ? function (a, b) { return b[0] - a[0]; }
      : function (a, b) { return a[0] - b[0]; });
    return out;
  }

  /* -- rendering --------------------------------------------------------- */

  function renderRow(it) {
    const isPod = it[3] === 1;
    const info = isPod ? Data.episodeInfo(it[2]) : Data.trackInfo(it[2]);
    const date = Data.localDate(it[0]);
    return '<div class="row row--wide" style="height:' + ROW_H + 'px">' +
      '<div class="row-time"><button class="row-artist" data-day="' + date + '" type="button" ' +
      'title="Open this day">' + fmtDate(date) + '</button><br>' +
      fmtTimeOfDay(Data.localMinutes(it[0])) + '</div>' +
      '<div class="row-main"><div class="row-title">' + esc(info.title) + '</div>' +
      '<div class="row-sub">' +
      (isPod
        ? '<span class="badge badge--pod">Podcast</span><span>' + esc(info.show) + '</span>'
        : '<button class="row-artist" data-artist="' + esc(info.artist) + '" type="button">' +
          esc(info.artist) + '</button>') +
      (!isPod && info.album ? '<span class="row-extra">· ' + esc(info.album) + '</span>' : '') +
      '</div></div>' +
      '<div class="row-dur">' + fmtClockDuration(it[1]) + '</div></div>';
  }

  function renderChips() {
    const chips = [];
    if (filters.query) chips.push(chip('Search', filters.query, 'query'));
    if (filters.artist) chips.push(chip('Artist', filters.artist, 'artist'));
    if (App.settings.mode !== 'both') chips.push(chip('Showing', App.settings.mode, 'mode'));
    const el = root.querySelector('#hiChips');
    el.innerHTML = chips.join('');
    el.hidden = !chips.length;
  }

  function chip(label, value, key) {
    return '<span class="chip"><b>' + label + '</b><span>' + esc(value) + '</span>' +
      '<button class="chip-x" data-clear="' + key + '" type="button" ' +
      'aria-label="Remove ' + label + ' filter">&times;</button></span>';
  }

  function apply(keepScroll) {
    const mySeq = ++seq;
    const next = build();
    requestAnimationFrame(function () {
      if (mySeq !== seq) return;   // a newer keystroke already won
      items = next;
      let ms = 0;
      for (const it of items) ms += it[1];
      root.querySelector('#hiCount').textContent =
        fmtNumber(items.length) + ' ' + (items.length === 1 ? 'play' : 'plays') +
        ' · ' + fmtDuration(ms);
      renderChips();
      const empty = root.querySelector('#hiEmpty');
      empty.hidden = items.length > 0;
      if (!items.length) {
        empty.innerHTML = '<div class="empty"><p class="empty-title">No plays match</p>' +
          '<p>Try clearing a filter.</p></div>';
      }
      vlist.setItems(items, keepScroll);
    });
  }

  const applyDebounced = debounce(function () { apply(false); }, DEBOUNCE_MS);

  /* -- public entry points ----------------------------------------------- */

  function openWithArtist(name) {
    App.navigate('#history');
    filters.artist = name;
    filters.query = '';
    const input = root.querySelector('#hiSearch');
    if (input) input.value = '';
    applyDebounced.cancel();
    apply(false);
    App.toast('Filtered to ' + name);
  }

  function openWithQuery(q) {
    App.navigate('#history');
    filters.query = q;
    filters.artist = null;
    const input = root.querySelector('#hiSearch');
    if (input) input.value = q;
    applyDebounced();
  }

  /* -- lifecycle --------------------------------------------------------- */

  function init(el) {
    root = el;
    // A fresh init means a new dataset: nothing from the last one applies.
    podSearch = null;
    filters.query = '';
    filters.artist = null;
    el.classList.add('view--fixed');
    el.innerHTML =
      '<div class="view-head"><h1 class="view-title">History</h1></div>' +
      '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px">' +
      '<div class="search-wrap" style="max-width:340px">' +
      '<svg class="search-icon" viewBox="0 0 16 16"><path fill="currentColor" d="M7 1a6 6 0 1 0 3.66 10.75l3.29 3.3 1.06-1.07-3.29-3.29A6 6 0 0 0 7 1Zm0 1.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z"/></svg>' +
      '<input class="search-input" id="hiSearch" type="search" autocomplete="off" ' +
      'placeholder="Filter this list…" aria-label="Filter history"></div>' +
      '<div class="seg" id="hiOrder" role="group" aria-label="Order">' +
      '<button type="button" data-order="desc" aria-pressed="true">Newest</button>' +
      '<button type="button" data-order="asc" aria-pressed="false">Oldest</button></div>' +
      '</div>' +
      '<div class="chips" id="hiChips" style="margin-bottom:8px"></div>' +
      '<p class="section-note" id="hiCount" role="status" aria-live="polite" ' +
      'style="margin:0 0 8px"></p>' +
      '<div id="hiEmpty" hidden></div>' +
      '<div id="hiList"></div>';

    vlist = new VirtualList(el.querySelector('#hiList'), {
      rowHeight: ROW_H, renderRow: renderRow, overscan: 10
    });

    el.querySelector('#hiSearch').addEventListener('input', function (e) {
      filters.query = e.target.value;
      applyDebounced();
    });

    el.addEventListener('click', function (e) {
      const ordBtn = e.target.closest('[data-order]');
      if (ordBtn) {
        filters.order = ordBtn.dataset.order;
        press('#hiOrder', '[data-order]', 'order', filters.order);
        return apply(false);
      }
      const clear = e.target.closest('[data-clear]');
      if (clear) {
        const key = clear.dataset.clear;
        if (key === 'query') { filters.query = ''; el.querySelector('#hiSearch').value = ''; }
        else if (key === 'artist') filters.artist = null;
        else if (key === 'mode') { App.settings.mode = 'both'; App.saveSettings(); App.emitChange('mode'); }
        return apply(false);
      }
      const artist = e.target.closest('[data-artist]');
      if (artist) return openWithArtist(artist.dataset.artist);
      const day = e.target.closest('[data-day]');
      if (day) return App.navigate('#timeline/' + day.dataset.day);
    });

    function press(scope, sel, key, value) {
      root.querySelectorAll(scope + ' ' + sel).forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset[key] === value));
      });
    }

    App.onChange(function (what) {
      if (what === 'tz' || what === 'mode') apply(false);
    });

    apply(false);
  }

  return { init: init, openWithArtist: openWithArtist, openWithQuery: openWithQuery };
})();

App.registerView('history', { label: 'History', init: History.init });


/* ---- library.js ---- */
/* Library: everything you saved — tracks, albums, artists, playlists, shows,
   episodes — cross-linked back into the play history. */

const Library = (function () {
  let root = null;
  let tab = 'tracks';

  function spotifyLink(uri) {
    const href = safeSpotifyUrl(uri);
    if (!href) return '';
    return '<a class="link" style="font-size:11px" target="_blank" rel="noopener" href="' +
      attr(href) + '">Open</a>';
  }

  function row(title, subHtml, right) {
    return '<div class="row row--flat" style="height:56px">' +
      '<div class="row-main"><div class="row-title">' + title + '</div>' +
      '<div class="row-sub">' + subHtml + '</div></div>' +
      '<div class="row-dur">' + (right || '') + '</div></div>';
  }

  function trackButton(name) {
    return '<button class="row-title" style="background:none;border:0;padding:0;' +
      'font:inherit;color:inherit;cursor:pointer;text-align:left;max-width:100%" ' +
      'data-track="' + esc(name) + '">' + esc(name) + '</button>';
  }

  function artistButton(name) {
    return '<button class="row-artist" data-artist="' + esc(name) + '" type="button">' +
      esc(name) + '</button>';
  }

  const TABS = [
    ['tracks', 'Tracks'], ['albums', 'Albums'], ['artists', 'Artists'],
    ['playlists', 'Playlists'], ['shows', 'Shows'], ['episodes', 'Episodes'],
    ['banned', 'Hidden']
  ];

  /** Playlists come from Playlist1.json, every other tab from YourLibrary.json. */
  function tabs() {
    const hasLib = App.hasFile('YourLibrary.json');
    const hasPl = App.hasFile('Playlist1.json');
    return TABS.filter(function (t) { return t[0] === 'playlists' ? hasPl : hasLib; });
  }

  function available() {
    return App.hasFile('YourLibrary.json') || App.hasFile('Playlist1.json');
  }

  function render() {
    const lib = Data.extras.library;
    const body = root.querySelector('#lbBody');
    const note = root.querySelector('#lbNote');
    let html = '', count = 0, subtitle = '';

    if (tab === 'tracks') {
      count = lib.tracks.length;
      subtitle = 'Click a title to find it in your history.';
      html = lib.tracks.map(function (t) {
        return row(trackButton(t.track),
          artistButton(t.artist) + (t.album ? '<span class="row-extra">· ' +
            esc(t.album) + '</span>' : ''), spotifyLink(t.uri));
      }).join('');
    } else if (tab === 'albums') {
      count = lib.albums.length;
      html = lib.albums.map(function (a) {
        return row(esc(a.album), artistButton(a.artist), spotifyLink(a.uri));
      }).join('');
    } else if (tab === 'artists') {
      count = lib.artists.length;
      subtitle = 'Click a name to see its plays.';
      html = lib.artists.map(function (a) {
        return row(artistButton(a.name), '', spotifyLink(a.uri));
      }).join('');
    } else if (tab === 'playlists') {
      const pls = Data.extras.playlists;
      count = pls.length;
      subtitle = fmtNumber(pls.reduce(function (n, p) { return n + p.items.length; }, 0)) +
        ' tracks across ' + pls.length + ' playlists. Click one to expand.';
      html = pls.slice().sort(function (a, b) {
        return (b.lastModifiedDate || '').localeCompare(a.lastModifiedDate || '');
      }).map(function (p) {
        return '<details class="card" style="margin-bottom:8px;padding:12px 16px">' +
          '<summary style="cursor:pointer;font-size:14px;font-weight:700">' +
          esc(p.name) + ' <span style="color:var(--text-2);font-weight:400">· ' +
          p.items.length + ' tracks' +
          (p.lastModifiedDate ? ' · updated ' + fmtDate(p.lastModifiedDate) : '') +
          (p.followers ? ' · ' + num(p.followers) + ' followers' : '') + '</span></summary>' +
          (p.description ? '<p class="field-help" style="margin:8px 0 0">' +
            esc(p.description) + '</p>' : '') +
          '<div style="margin-top:8px">' + p.items.map(function (it) {
            return row(trackButton(it.track || ''),
              artistButton(it.artist || '') +
              (it.album ? '<span class="row-extra">· ' + esc(it.album) + '</span>' : ''),
              (it.added ? '<span style="font-size:11px">' + fmtDate(it.added) + '</span>' : ''));
          }).join('') + '</div></details>';
      }).join('');
    } else if (tab === 'shows') {
      count = lib.shows.length;
      html = lib.shows.map(function (s) {
        return row(esc(s.name), esc(s.publisher || ''), spotifyLink(s.uri));
      }).join('');
    } else if (tab === 'episodes') {
      count = lib.episodes.length;
      html = lib.episodes.map(function (e) {
        return row(esc(e.name), esc(e.show || ''), spotifyLink(e.uri));
      }).join('');
    } else {
      const artists = lib.bannedArtists || [];
      const tracks = lib.bannedTracks || [];
      count = artists.length + tracks.length;
      html = artists.map(function (a) { return row(esc(a.name), 'Hidden artist', spotifyLink(a.uri)); })
        .join('') +
        tracks.map(function (t) { return row(esc(t.track || t.name), 'Hidden track', ''); }).join('');
    }

    note.textContent = fmtNumber(count) + (count === 1 ? ' item' : ' items') +
      (subtitle ? ' · ' + subtitle : '');
    body.innerHTML = html || '<div class="empty"><p class="empty-title">Nothing saved here</p></div>';
  }

  function init(el) {
    root = el;
    const shown = tabs();
    if (!shown.some(function (t) { return t[0] === tab; })) tab = shown[0][0];
    el.innerHTML =
      '<div class="view-head"><h1 class="view-title">Library</h1></div>' +
      '<div class="seg" id="lbTabs" role="group" aria-label="Library section" ' +
      'style="margin-bottom:12px">' +
      shown.map(function (t) {
        return '<button type="button" data-tab="' + t[0] + '" aria-pressed="' +
          (t[0] === tab) + '">' + t[1] + '</button>';
      }).join('') + '</div>' +
      '<p class="section-note" id="lbNote" style="margin:0 0 12px"></p>' +
      '<div id="lbBody"></div>';

    el.addEventListener('click', function (e) {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        tab = tabBtn.dataset.tab;
        el.querySelectorAll('#lbTabs [data-tab]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
        });
        el.scrollTop = 0;
        return render();
      }
      const artist = e.target.closest('[data-artist]');
      if (artist) return History.openWithArtist(artist.dataset.artist);
      const track = e.target.closest('[data-track]');
      if (track) return History.openWithQuery(track.dataset.track);
    });

    render();
  }

  return { init: init, available: available };
})();

App.registerView('library', {
  label: 'Library', init: Library.init, available: Library.available
});


/* ---- extras.js ---- */
/* Extras: everything else in the export. An index of cards, one per dataset
   the upload actually contains, each opening its own sub-page. Every render
   is fresh, and nothing is built until it is opened. */

const Extras = (function () {
  let root = null;
  let searchVList = null;

  /* -- shared bits ------------------------------------------------------- */

  /** Arrays from the export, or [] when a field is missing or the wrong type. */
  function list(v) {
    return Array.isArray(v) ? v : [];
  }

  /** String fields that may be missing, null, or a number in a crafted file. */
  function str(v) {
    return v == null ? '' : String(v);
  }

  /** toFixed for export-derived values: a string where a number belonged
      would otherwise throw, since String has no toFixed. */
  function fixed(v, digits) {
    const n = Number(v);
    return (Number.isFinite(n) ? n : 0).toFixed(digits);
  }

  function uriLabel(uri) {
    const names = Data.extras.uriNames || {};
    const href = safeSpotifyUrl(uri);
    // hasOwnProperty guard: `names` is a plain {} keyed by attacker-controlled
    // URI strings. Without it, a uri of e.g. "toString" or "constructor"
    // would resolve through the prototype chain to a function, pass the
    // truthiness check below, and render escaped function source.
    const label = Object.prototype.hasOwnProperty.call(names, uri) ? names[uri] : undefined;
    if (!label) return '';                     // unresolved: counted, not shown
    return href
      ? '<a class="link" target="_blank" rel="noopener" href="' + attr(href) + '">' +
        esc(label) + '</a>'
      : esc(label);
  }

  /** Labels for the URIs the export can name, and how many it cannot. */
  function resolvedList(uris) {
    const labels = list(uris).map(uriLabel).filter(Boolean);
    return { labels: labels, missing: list(uris).length - labels.length };
  }

  function missingNote(n) {
    return n ? '<p class="xmuted">+' + num(n) + ' not named in your export</p>' : '';
  }

  // Contract: unlike Timeline.stat, this stat() does NOT escape its
  // arguments -- it inserts label/value/sub into innerHTML as-is. Every
  // caller is responsible for passing values that are already safe: a
  // hardcoded literal, a formatter's output (fmtNumber/fmtDuration/...), or
  // an explicit esc()/num()/attr() wrap. Do not pass a raw export field here.
  function stat(label, value, sub) {
    return '<div class="stat"><p class="stat-label">' + label + '</p>' +
      '<div class="stat-value is-text">' + value + '</div>' +
      (sub ? '<div class="stat-sub">' + sub + '</div>' : '') + '</div>';
  }

  // Contract: same as stat() above -- title/note/body are inserted into
  // innerHTML unescaped. Callers must pre-escape anything export-derived.
  function section(title, note, body) {
    return '<div class="section"><div class="section-head">' +
      '<h2 class="section-title">' + title + '</h2>' +
      (note ? '<span class="section-note">' + note + '</span>' : '') + '</div>' +
      body + '</div>';
  }

  // Contract: title is inserted unescaped; `uris` are raw export values and
  // go through uriLabel(), which escapes.
  function listCard(title, uris) {
    const r = resolvedList(uris);
    return '<div class="card"><p class="stat-label">' + title + '</p>' +
      '<ol class="xlist">' + (r.labels.length
        ? r.labels.map(function (h) { return '<li>' + h + '</li>'; }).join('')
        : '<li class="xmuted">none named</li>') + '</ol>' +
      missingNote(r.missing) + '</div>';
  }

  function titleCase(s) {
    return esc(str(s).replace(/_/g, ' ').toLowerCase()
      .replace(/^./, function (c) { return c.toUpperCase(); }));
  }

  function fmtSeconds(sec) {
    return fmtDuration((Number(sec) || 0) * 1000);
  }

  /** A day link when `date` is YYYY-MM-DD, plain escaped text otherwise. */
  function dayLink(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? '<button class="row-artist" data-day="' + attr(date) + '" type="button">' +
        fmtDate(date) + '</button>'
      : esc(date);
  }

  /* -- Wrapped ----------------------------------------------------------- */

  function renderWrapped(el) {
    const w = Data.extras.wrapped || {};
    const ta = w.topArtists || {}, tt = w.topTracks || {}, tal = w.topAlbums || {};
    const tg = w.topGenres || {}, cl = w.clubs || {}, la = w.listeningAge || {};
    const fan = w.topFanLeaderboard || {};

    const cards = [
      stat('Listened in 2025', fmtDuration(Number((w.yearlyMetrics || {}).totalMsListened) || 0)),
      stat('Unique artists', fmtNumber(ta.numUniqueArtists || 0),
        fmtNumber(tt.numUniqueTracks || 0) + ' unique tracks'),
      ta.topNPercentileFan
        ? stat('Top fan', 'Top ' + fixed(ta.topNPercentileFan * 100, 3) + '%',
          'of listeners for your top artist')
        : '',
      la.listeningAge
        ? stat('Listening age', num(la.listeningAge) + ' years',
          la.windowStartYear ? esc(la.decadePhase || '') + ' ' + num(la.windowStartYear) + 's' : '')
        : '',
      stat('Genres', fmtNumber(tg.totalNumGenres || 0)),
      stat('Albums finished', fmtNumber(tal.numCompletedAlbums || 0)),
      cl.userClub
        ? stat('Club', titleCase(cl.userClub), cl.role
          ? titleCase(cl.role) + ' · top ' + fixed((Number(cl.percentInClub) || 0) * 100, 1) + '%'
          : '')
        : ''
    ].join('');

    let unnamedTracks = 0;
    const topTracks = list(tt.topTracks).map(function (t) {
      const label = uriLabel((t || {}).trackUri);
      if (!label) { unnamedTracks++; return null; }
      return { label: label, ms: Number(t.msPlayed) || 0, count: t.count };
    }).filter(Boolean).map(function (t, i) {
      return '<div class="rank' + (i === 0 ? ' rank--top' : '') + '">' +
        '<div class="rank-n">' + (i + 1) + '</div><div class="rank-body">' +
        '<div class="rank-line"><div class="rank-name">' + t.label + '</div>' +
        '<div class="rank-metrics"><b>' + fmtDuration(t.ms) + '</b> · ' +
        fmtNumber(t.count) + ' plays</div></div></div></div>';
    }).join('');

    const lists =
      '<div class="grid-cards">' +
      listCard('Top artists', ta.topArtistUris) +
      listCard('Top albums', tal.topAlbums) +
      (list(cl.artists).length ? listCard('Club artists', cl.artists) : '') +
      '</div>';

    // Monthly rank race for the tracked artists that the export can name.
    const race = list((w.topArtistRace || {}).topArtists);
    const namedRace = race.filter(function (a) { return uriLabel((a || {}).artistUri); });
    let raceHtml = '';
    if (namedRace.length) {
      const months = list(namedRace[0].monthsStats).map(function (m) {
        return str((m || {}).month).slice(0, 3);
      });
      raceHtml =
        '<div class="xtable-wrap"><table class="xtable">' +
        '<thead><tr><th>Artist</th>' +
        months.map(function (m) { return '<th>' + esc(m) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        namedRace.map(function (a) {
          return '<tr><td class="xtable-name">' + uriLabel(a.artistUri) + '</td>' +
            list(a.monthsStats).map(function (m) {
              const rank = (m || {}).rank;
              return '<td' + (Number(rank) === 1 ? ' class="is-top"' : '') + '>' +
                num(rank) + '</td>';
            }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>' +
        missingNote(race.length - namedRace.length);
    }

    let fanHtml = '';
    const own = fan.ownUserStats;
    if (own) {
      const artist = uriLabel(fan.artistUri);
      const others = list(fan.otherUserStats).slice().sort(function (a, b) {
        return (Number(a.topXLeaderboard) || 0) - (Number(b.topXLeaderboard) || 0);
      });
      fanHtml = '<div class="card"><p class="xpara">' +
        'For ' + (artist || 'your top artist') + ' you streamed <b>' +
        fmtNumber(own.minutesStreamed) + ' minutes</b>, placing you at rank <b>' +
        fmtNumber(own.topXLeaderboard) + '</b>' +
        (own.countryCode ? ' in ' + esc(own.countryCode) : '') + '.</p>' +
        (others.length
          ? '<p class="field-help">Nearby listeners: ' +
            others.slice(0, 6).map(function (o) {
              return '#' + fmtNumber(o.topXLeaderboard) + ' (' +
                fmtNumber(o.minutesStreamed) + ' min)';
            }).join(' · ') + '</p>'
          : '') + '</div>';
    }

    const reports = list((w.archiveReports || {}).archiveReports);
    const reportHtml = reports.map(function (r) {
      r = r || {};
      const q = str(r.columnQualifier);
      const date = q.length === 8 ? q.slice(0, 4) + '-' + q.slice(4, 6) + '-' + q.slice(6, 8) : q;
      return '<div class="card xitem">' +
        '<div class="xitem-head"><strong>' + esc(r.title) + '</strong>' +
        '<span class="section-note">' + dayLink(date) +
        (r.reason ? ' · ' + titleCase(r.reason) : '') + '</span></div>' +
        '<p class="xpara xpara--muted">' + esc(r.description) + '</p></div>';
    }).join('');

    const s = Data.stats();
    el.innerHTML =
      '<p class="xlead">Wrapped covers Spotify’s own 2025 window, not this export’s ' +
      fmtDate(s.rangeStart) + ' to ' + fmtDate(s.rangeEnd) + '.</p>' +
      '<div class="stat-band">' + cards + '</div>' +
      (topTracks || unnamedTracks
        ? section('Top tracks', null, topTracks + missingNote(unnamedTracks))
        : '') +
      section('Top of everything else', null, lists) +
      (raceHtml ? section('Monthly artist race', 'Rank per month, 1 is best', raceHtml) : '') +
      (fanHtml ? section('Top fan leaderboard', null, fanHtml) : '') +
      (reportHtml ? section('Archive reports', null, reportHtml) : '');
  }

  /* -- Sound Capsule ----------------------------------------------------- */

  function highlightSentence(h) {
    const t = h.highlightType;
    const d = h[Object.keys(h).find(function (k) { return k.endsWith('Highlight'); })] || {};
    const e = '<b>' + esc(d.entity || d.firstEntity || '') + '</b>';
    if (t === 'ON_REPEAT') return 'You played ' + e + ' ' + num(d.streamCount) + ' times.';
    if (t === 'TOP_LISTENER') return 'You were in the top ' +
      fixed((Number(d.topPercentile) || 0) * 100, 4) + '% of listeners for ' + e + '.';
    if (t === 'FIRST_TO_DISCOVER') return 'You were listener #' + fmtNumber(d.position) +
      ' to find ' + e + ' in ' + esc(d.country) + '.';
    if (t === 'UNLIKE_COMBINATION') return 'An unlikely pairing: ' + e + ' and <b>' +
      esc(d.secondEntity) + '</b>.';
    if (t === 'YOU_STAND_OUT') return 'You played ' + e + ' for ' +
      fmtSeconds(d.secondsPlayed) + ', where the average listener in ' + esc(d.country) +
      ' managed ' + fmtSeconds(Math.round(Number(d.marketAvgSecondsPlayed) || 0)) + '.';
    if (t === 'STREAKS') return 'You played ' + e + ' ' + num(d.dayStreaks) + ' days running.';
    if (t === 'MILESTONE') return 'You passed ' + fmtSeconds(d.milestoneListeningSeconds) +
      ' with ' + e + '.';
    if (t === 'PROPORTION_LISTENING_ENTITY') return e + ' was ' +
      fixed(d.listeningPercentage, 1) + '% of everything you played.';
    if (t === 'ON_THIS_PERIOD') return 'You came back to ' + e + ' after ' +
      num(d.nostalgiaUnitsAgo) + ' ' + esc(str(d.nostalgiaPeriod).toLowerCase()) + '.';
    if (t === 'FANS_LIKE_YOU') return 'Among ' + fmtNumber(d.numberOfListeners) +
      ' listeners of ' + e + ' you ranked #' + num(d.position) +
      (d.previousPosition ? ' (was #' + num(d.previousPosition) + ')' : '') + '.';
    return e;
  }

  function renderCapsule(el) {
    const c = Data.extras.capsule || {};
    const stats = list(c.stats).filter(Boolean);
    const highlights = list(c.highlights).filter(Boolean);

    function top(arr) {
      return list(arr).slice(0, 5).map(function (x) {
        x = x || {};
        return '<li>' + esc(x.name) + ' <span class="xmuted-inline">' +
          (x.streamCount ? num(x.streamCount) + ' plays · ' : '') +
          fmtSeconds(x.secondsPlayed) + '</span></li>';
      }).join('') || '<li class="xmuted">none</li>';
    }

    const periods = stats.map(function (s) {
      const date = str(s.date);
      const label = /^\d{4}-\d{2}-\d{2}$/.test(date) ? 'Week of ' + fmtDate(date)
        : /^\d{4}-\d{2}$/.test(date) ? fmtDate(date + '-01').slice(-8)
        : esc(date);
      return '<details class="card xitem">' +
        '<summary class="xsummary">' + label +
        ' <span class="xmuted-inline">· ' + fmtSeconds(s.secondsPlayed) + '</span></summary>' +
        '<div class="grid-cards xsummary-body">' +
        '<div><p class="stat-label">Top tracks</p><ol class="xlist">' + top(s.topTracks) + '</ol></div>' +
        '<div><p class="stat-label">Top artists</p><ol class="xlist">' + top(s.topArtists) + '</ol></div>' +
        '<div><p class="stat-label">Top genres</p><ol class="xlist">' + top(s.topGenres) + '</ol></div>' +
        '</div></details>';
    }).join('');

    const cards = highlights.slice().sort(function (a, b) {
      return str(b.date).localeCompare(str(a.date));
    }).map(function (h) {
      return '<div class="card xitem">' +
        '<div class="xitem-head"><span class="badge">' + titleCase(h.highlightType) + '</span>' +
        '<span class="section-note">' + dayLink(str(h.date)) + '</span></div>' +
        '<p class="xpara xpara--muted">' + highlightSentence(h) + '</p></div>';
    }).join('');

    el.innerHTML =
      (cards ? section('Highlights', fmtNumber(highlights.length), cards) : '') +
      (periods ? section('Weekly and monthly capsules', fmtNumber(stats.length), periods) : '');
  }

  /* -- Podcasts ---------------------------------------------------------- */

  function renderPodcasts(el) {
    const pod = Data.raw.podcast;
    const msByShow = new Map(), cntByShow = new Map();
    const msByEp = new Map(), cntByEp = new Map();
    for (const p of pod.plays) {
      const show = pod.episodes[p[1]][0];
      msByShow.set(show, (msByShow.get(show) || 0) + p[2]);
      cntByShow.set(show, (cntByShow.get(show) || 0) + 1);
      msByEp.set(p[1], (msByEp.get(p[1]) || 0) + p[2]);
      cntByEp.set(p[1], (cntByEp.get(p[1]) || 0) + 1);
    }

    function ranked(msMap, cntMap, labelFn) {
      const arr = [...msMap.entries()].sort(function (a, b) { return b[1] - a[1]; });
      const max = arr.length ? arr[0][1] : 1;
      return arr.map(function (pair, i) {
        return '<div class="rank' + (i === 0 ? ' rank--top' : '') + '">' +
          '<div class="rank-n">' + (i + 1) + '</div><div class="rank-body">' +
          '<div class="rank-line"><span class="rank-name">' + esc(labelFn(pair[0])) + '</span>' +
          '<div class="rank-metrics"><b>' + fmtDuration(pair[1]) + '</b> · ' +
          fmtNumber(cntMap.get(pair[0])) + ' plays</div></div>' +
          '<div class="rank-bar"><i style="width:' +
          Math.max(1.5, (pair[1] / max) * 100).toFixed(2) + '%"></i></div></div></div>';
      }).join('');
    }

    const inter = Data.extras.podcastInteractions || {};
    const comments = list(inter.comments).filter(Boolean).map(function (c) {
      const on = uriLabel(c.entity);
      return '<div class="card xitem">' +
        '<p class="xpara">' + esc(c.comment) + '</p>' +
        '<p class="field-help">' + esc(str(c.createdAt).slice(0, 10)) +
        (on ? ' · ' + on : '') + '</p></div>';
    }).join('');

    const reactions = list(inter.reactions).filter(Boolean).map(function (r) {
      const on = uriLabel(r.parentEntity);
      return '<li>' + titleCase(r.reaction) + (on ? ' · ' + on : '') +
        ' <span class="xmuted-inline">' + esc(str(r.createdAt).slice(0, 10)) + '</span></li>';
    }).join('');

    const totalMs = [...msByShow.values()].reduce(function (a, b) { return a + b; }, 0);
    el.innerHTML =
      '<div class="stat-band">' +
      stat('Podcast time', fmtDuration(totalMs), fmtNumber(pod.plays.length) + ' plays') +
      stat('Shows', fmtNumber(pod.shows.length), fmtNumber(pod.episodes.length) + ' episodes') +
      '</div>' +
      section('Shows by listening time', null,
        ranked(msByShow, cntByShow, function (i) { return pod.shows[i]; })) +
      section('Episodes by listening time', null,
        ranked(msByEp, cntByEp, function (i) { return pod.episodes[i][1]; })) +
      (comments ? section('Your comments', null, comments) : '') +
      (reactions ? section('Your reactions', null,
        '<ul class="list-plain xsmall">' + reactions + '</ul>') : '');
  }

  /* -- Searches ---------------------------------------------------------- */

  function renderSearches(el) {
    const all = list(Data.extras.searches).slice().reverse();
    el.innerHTML =
      '<div class="search-wrap xfilter">' +
      '<svg class="search-icon" viewBox="0 0 16 16"><path fill="currentColor" d="M7 1a6 6 0 1 0 3.66 10.75l3.29 3.3 1.06-1.07-3.29-3.29A6 6 0 0 0 7 1Zm0 1.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z"/></svg>' +
      '<input class="search-input" id="exSearchFilter" type="search" ' +
      'placeholder="Filter searches…" aria-label="Filter searches"></div>' +
      '<p class="section-note xcount" id="exSearchCount" role="status" aria-live="polite"></p>' +
      '<div id="exSearchList" class="xsearch-list"></div>';

    if (searchVList) searchVList.destroy();
    searchVList = new VirtualList(el.querySelector('#exSearchList'), {
      rowHeight: 48,
      renderRow: function (q) {
        const when = str(q[0]);
        return '<div class="row xsearch-row">' +
          '<div class="row-time">' + esc(when.slice(0, 10)) + ' ' + esc(when.slice(11, 16)) + '</div>' +
          '<div class="row-main"><div class="row-title">' + esc(q[1] || '(empty)') + '</div></div>' +
          '<button class="btn-pill" data-search-history="' + attr(q[1] || '') +
          '" type="button">Find</button></div>';
      }
    });

    function apply(rows) {
      el.querySelector('#exSearchCount').textContent =
        fmtNumber(rows.length) + ' of ' + fmtNumber(all.length) + ' searches · times in UTC';
      searchVList.setItems(rows);
    }

    const filter = debounce(function (term) {
      const t = term.trim().toLowerCase();
      apply(t ? all.filter(function (q) { return str(q[1]).toLowerCase().indexOf(t) !== -1; }) : all);
    }, 180);

    el.querySelector('#exSearchFilter').addEventListener('input', function (e) {
      filter(e.target.value);
    });

    apply(all);
  }

  /* -- Social ------------------------------------------------------------ */

  /** A message body: a named link for a URI the export can name, a plain
      "Shared track" link for one it cannot, escaped text otherwise. */
  function messageBody(text) {
    const s = str(text);
    if (s.indexOf('spotify:') !== 0) return esc(s);
    const named = uriLabel(s);
    if (named) return named;
    const href = safeSpotifyUrl(s);
    return href
      ? '<a class="link" target="_blank" rel="noopener" href="' + attr(href) + '">Shared ' +
        esc(s.split(':')[1]) + '</a>'
      : esc(s);
  }

  function renderSocial(el) {
    const f = Data.extras.follows || {};
    const threads = list(Data.extras.messages).filter(Boolean);
    const me = (Data.extras.account || {}).displayName;
    const following = list(f.following), followers = list(f.followers), blocking = list(f.blocking);

    function nameList(names) {
      return names.length
        ? '<div class="chips">' + names.map(function (n) {
            return '<span class="chip"><span>' + esc(n) + '</span></span>';
          }).join('') + '</div>'
        : '<p class="field-help">None.</p>';
    }

    function lastTime(t) {
      const msgs = list(t.messages);
      return msgs.length ? str((msgs[msgs.length - 1] || {}).time) : '';
    }

    const chats = threads.slice().sort(function (a, b) {
      return lastTime(b).localeCompare(lastTime(a));
    }).map(function (t) {
      const msgs = list(t.messages).filter(Boolean);
      const other = t.groupName ||
        list(t.members).filter(function (m) { return m !== me; }).join(', ') || 'Chat';
      const last = lastTime(t).slice(0, 10);
      return '<details class="card xitem">' +
        '<summary class="xsummary">' + esc(other) +
        ' <span class="xmuted-inline">· ' + fmtNumber(msgs.length) + ' messages' +
        (/^\d{4}-\d{2}-\d{2}$/.test(last) ? ' · last ' + fmtDate(last) : '') +
        '</span></summary>' +
        '<div class="xsummary-body">' +
        msgs.map(function (m) {
          return '<div class="msg' + (m.from === me ? ' msg--mine' : '') + '">' +
            '<span class="msg-who">' + esc(m.from) + '</span>' +
            '<span class="msg-body">' + messageBody(m.message) + '</span>' +
            '<span class="msg-when">' + esc(str(m.time).slice(0, 10)) + '</span>' +
            '</div>';
        }).join('') + '</div></details>';
    }).join('');

    el.innerHTML =
      '<div class="stat-band">' +
      stat('Following', fmtNumber(following.length)) +
      stat('Followers', fmtNumber(followers.length)) +
      (blocking.length ? stat('Blocked', fmtNumber(blocking.length)) : '') +
      (threads.length ? stat('Chats', fmtNumber(threads.length),
        fmtNumber(threads.reduce(function (n, t) { return n + list(t.messages).length; }, 0)) +
        ' messages') : '') +
      '</div>' +
      (App.hasFile('Follow.json')
        ? section('Following', null, nameList(following)) +
          section('Followers', null, nameList(followers)) +
          (blocking.length ? section('Blocked', null, nameList(blocking)) : '')
        : '') +
      (chats ? section('Messages', null, chats) : '');
  }

  /* -- Ads --------------------------------------------------------------- */

  function renderAds(el) {
    const marquee = list(Data.extras.marquee).filter(Array.isArray);
    const inferences = list(Data.extras.inferences);
    const bySegment = new Map();
    for (const m of marquee) {
      const seg = str(m[1]) || 'Unknown';
      if (!bySegment.has(seg)) bySegment.set(seg, []);
      bySegment.get(seg).push(m[0]);
    }

    const segs = [...bySegment.entries()]
      .sort(function (a, b) { return b[1].length - a[1].length; })
      .map(function (pair) {
        return '<details class="xgroup"><summary>' + esc(pair[0]) +
          '<span class="xgroup-n">' + num(pair[1].length) + '</span></summary>' +
          '<ul class="xnames">' + pair[1].map(function (n) {
            return '<li>' + esc(n) + '</li>';
          }).join('') + '</ul></details>';
      }).join('');

    el.innerHTML =
      (segs
        ? section('Marquee segments', fmtNumber(marquee.length) + ' artists in ' +
            fmtNumber(bySegment.size) + (bySegment.size === 1 ? ' segment' : ' segments'),
            '<div class="card xcard-flush">' + segs + '</div>')
        : '') +
      (inferences.length
        ? section('Ad inferences', fmtNumber(inferences.length),
            '<div class="card"><ul class="xnames">' + inferences.map(function (i) {
              return '<li>' + esc(i) + '</li>';
            }).join('') + '</ul></div>')
        : '');
  }

  /* -- Your export ------------------------------------------------------- */

  function renderExport(el) {
    const a = Data.extras.account || {};
    const m = Data.meta;
    const rows = [
      ['Display name', a.displayName], ['Username', a.username], ['Email', a.email],
      ['Country', a.country], ['Birthdate', a.birthdate], ['Gender', a.gender],
      ['Account created', a.creationTime]
    ].filter(function (r) { return r[1]; });

    const present = list(m.present);
    const missing = Loader.EXPORT_FILES.filter(function (n) {
      return present.indexOf(n) === -1;
    });
    if (!App.hasFile('StreamingHistory_podcast_*')) missing.push('StreamingHistory_podcast_*.json');

    el.innerHTML =
      (rows.length
        ? section('From your account', null, '<div class="card"><dl class="kv">' +
            rows.map(function (r) {
              return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
            }).join('') + '</dl></div>')
        : '') +
      section('Coverage', null, '<div class="card"><dl class="kv">' +
        '<dt>Range</dt><dd>' + fmtDate(m.rangeStart) + ' to ' + fmtDate(m.rangeEnd) + '</dd>' +
        '<dt>Plays</dt><dd>' + fmtNumber(m.counts.plays) + '</dd>' +
        '<dt>Tracks</dt><dd>' + fmtNumber(m.counts.tracks) + '</dd>' +
        '<dt>Artists</dt><dd>' + fmtNumber(m.counts.artists) + '</dd>' +
        '<dt>Album names</dt><dd>' + fixed((m.albumCoverage || {}).ms * 100, 0) +
          '% of listening time, joined from playlists and saved tracks</dd>' +
        '</dl></div>') +
      section('Files read', fmtNumber(present.length),
        '<div class="card"><ul class="xnames">' +
        present.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
        '</ul>' + (missing.length
          ? '<p class="xmuted">Not in your upload: ' + missing.map(esc).join(', ') + '</p>'
          : '') + '</div>');
  }

  /* -- index ------------------------------------------------------------- */

  /* Each section appears only when its file was uploaded and holds something.
     headline() returns safe HTML: formatter output only. */
  const SECTIONS = [
    { key: 'wrapped', title: 'Wrapped 2025', blurb: 'Spotify’s own year in review',
      has: function () {
        const w = Data.extras.wrapped || {};
        return App.hasFile('Wrapped2025.json') && !!(w.yearlyMetrics || w.topArtists);
      },
      headline: function () {
        const ms = Number(((Data.extras.wrapped || {}).yearlyMetrics || {}).totalMsListened);
        return ms ? fmtDuration(ms) + ' listened' : '';
      },
      render: renderWrapped },
    { key: 'capsule', title: 'Sound Capsule', blurb: 'Weekly and monthly recaps',
      has: function () {
        const c = Data.extras.capsule || {};
        return App.hasFile('YourSoundCapsule.json') &&
          (list(c.highlights).length + list(c.stats).length) > 0;
      },
      headline: function () {
        const n = list((Data.extras.capsule || {}).highlights).length;
        return n ? fmtNumber(n) + ' highlights' : '';
      },
      render: renderCapsule },
    { key: 'podcasts', title: 'Podcasts', blurb: 'Shows and episodes you played',
      has: function () {
        return App.hasFile('StreamingHistory_podcast_*') && Data.raw.podcast.plays.length > 0;
      },
      headline: function () { return fmtNumber(Data.raw.podcast.plays.length) + ' plays'; },
      render: renderPodcasts },
    { key: 'searches', title: 'Searches', blurb: 'What you looked for',
      has: function () {
        return App.hasFile('SearchQueries.json') && list(Data.extras.searches).length > 0;
      },
      headline: function () { return fmtNumber(list(Data.extras.searches).length) + ' searches'; },
      render: renderSearches },
    { key: 'social', title: 'Social', blurb: 'Follows and messages',
      has: function () {
        const f = Data.extras.follows || {};
        return (App.hasFile('Follow.json') &&
            list(f.following).length + list(f.followers).length + list(f.blocking).length > 0) ||
          (App.hasFile('MessageData.json') && list(Data.extras.messages).length > 0);
      },
      headline: function () {
        const n = list(Data.extras.messages).length;
        const following = list((Data.extras.follows || {}).following).length;
        return n ? fmtNumber(n) + (n === 1 ? ' chat' : ' chats')
          : fmtNumber(following) + ' following';
      },
      render: renderSocial },
    { key: 'ads', title: 'Ads and inferences', blurb: 'What advertisers were told',
      has: function () {
        return (App.hasFile('Inferences.json') && list(Data.extras.inferences).length > 0) ||
          (App.hasFile('Marquee.json') && list(Data.extras.marquee).length > 0);
      },
      headline: function () {
        const n = list(Data.extras.inferences).length;
        return n ? fmtNumber(n) + ' inferences'
          : fmtNumber(list(Data.extras.marquee).length) + ' marquee records';
      },
      render: renderAds },
    { key: 'export', title: 'Your export', blurb: 'What this upload contained',
      has: function () { return true; },
      headline: function () {
        const n = list(Data.meta.present).length;
        return fmtNumber(n) + (n === 1 ? ' file' : ' files');
      },
      render: renderExport }
  ];

  function available() {
    return SECTIONS.filter(function (s) { return s.has(); });
  }

  function renderIndex(el) {
    const cards = available().map(function (s) {
      const headline = s.headline();
      return '<button class="xcard" type="button" data-xopen="' + attr(s.key) + '">' +
        '<span class="xcard-title">' + esc(s.title) + '</span>' +
        '<span class="xcard-blurb">' + esc(s.blurb) + '</span>' +
        (headline ? '<span class="xcard-count">' + headline + '</span>' : '') +
        '</button>';
    }).join('');
    el.innerHTML =
      '<div class="view-head"><h1 class="view-title">Extras</h1></div>' +
      '<div class="xgrid">' + cards + '</div>';
  }

  function renderSection(el, s) {
    el.innerHTML =
      '<div class="view-head">' +
      '<button class="xback" type="button" data-xback>&larr; Extras</button>' +
      '<h1 class="view-title">' + esc(s.title) + '</h1></div>' +
      '<div id="xBody"></div>';
    s.render(el.querySelector('#xBody'));
  }

  /* -- lifecycle --------------------------------------------------------- */

  function init(el) {
    root = el;
    el.addEventListener('click', function (e) {
      const open = e.target.closest('[data-xopen]');
      if (open) return App.navigate('#extras/' + open.dataset.xopen);
      if (e.target.closest('[data-xback]')) return App.navigate('#extras');
      const day = e.target.closest('[data-day]');
      if (day) return App.navigate('#timeline/' + day.dataset.day);
      const q = e.target.closest('[data-search-history]');
      if (q) return History.openWithQuery(q.dataset.searchHistory);
    });
  }

  function show(arg) {
    const s = arg && available().find(function (x) { return x.key === arg; });
    if (s) renderSection(root, s);
    else {
      renderIndex(root);
      if (arg) history.replaceState(null, '', '#extras');
    }
    root.scrollTop = 0;
  }

  return { init: init, show: show };
})();

App.registerView('extras', { label: 'Extras', init: Extras.init, show: Extras.show });


/* ---- settings.js ---- */
/* Settings: a view, not a dialog. Time zone, content type, and the controls
   for replacing or clearing the loaded export. */

const Settings = (function () {
  let root = null;

  function field(label, control, help) {
    return '<div class="field"><span class="field-label">' + esc(label) + '</span>' +
      control + (help ? '<p class="field-help">' + help + '</p>' : '') + '</div>';
  }

  /** The preset zones, plus the active one if it is not among them (a saved
      offset from elsewhere must still show as selected). */
  function tzChoices() {
    const tz = App.settings.tzOffset;
    if (TZ_CHOICES.some(function (c) { return c[0] === tz; })) return TZ_CHOICES;
    const sign = tz < 0 ? '-' : '+';
    const abs = Math.abs(tz);
    const label = 'UTC' + sign + Math.floor(abs / 60) +
      (abs % 60 ? ':' + String(abs % 60).padStart(2, '0') : '');
    return TZ_CHOICES.concat([[tz, label]]).sort(function (a, b) { return a[0] - b[0]; });
  }

  /** One line on what is loaded and where it lives. */
  function dataSummary() {
    const s = Data.stats();
    const w = Welcome.info();
    const span = 'Plays from ' + fmtDate(s.rangeStart) + ' to ' + fmtDate(s.rangeEnd) +
      (w.uploads > 1 ? ', combined from ' + w.uploads + ' uploads' : '') + '. ';
    if (!w.uploaded) return span + 'Built into this page.';
    return span + (w.saved
      ? 'Saved in this browser only, so it is here next time. It never leaves this device.'
      : 'This browser would not save it, so it is gone when you close the tab.');
  }

  function init(el) {
    root = el;
    const hasPodcasts = App.hasFile('StreamingHistory_podcast_*');
    el.innerHTML =
      '<div class="view-head"><h1 class="view-title">Settings</h1></div>' +

      field('Time zone',
        '<select class="select" id="stTz">' + tzChoices().map(function (c) {
          return '<option value="' + attr(c[0]) + '"' +
            (c[0] === App.settings.tzOffset ? ' selected' : '') + '>' +
            esc(c[1]) + '</option>';
        }).join('') + '</select>',
        'Spotify records every play in UTC. Pick your zone so days line up.') +

      (hasPodcasts
        ? field('Include',
          '<div class="seg" id="stMode" role="group" aria-label="Content type">' +
          MODES.map(function (m) {
            return '<button type="button" data-mode="' + attr(m[0]) + '" aria-pressed="' +
              (App.settings.mode === m[0]) + '">' + esc(m[1]) + '</button>';
          }).join('') + '</div>', '')
        : '') +

      field('Your data',
        '<div class="btn-row">' +
        '<button class="btn-outline" id="stReplace" type="button">Add or replace export</button>' +
        '<button class="btn-outline" id="stClear" type="button">Clear</button></div>',
        esc(dataSummary()));

    el.querySelector('#stTz').addEventListener('change', function (e) {
      App.settings.tzOffset = +e.target.value;
      Data.reindex(App.settings.tzOffset);
      App.saveSettings();
      App.emitChange('tz');
    });

    if (hasPodcasts) {
      el.querySelector('#stMode').addEventListener('click', function (e) {
        const btn = e.target.closest('[data-mode]');
        if (!btn) return;
        App.settings.mode = btn.dataset.mode;
        el.querySelectorAll('#stMode [data-mode]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b.dataset.mode === App.settings.mode));
        });
        App.saveSettings();
        App.emitChange('mode');
      });
    }

    el.querySelector('#stReplace').addEventListener('click', function () {
      Welcome.open();
    });

    el.querySelector('#stClear').addEventListener('click', function () {
      if (confirm('Remove your listening history from this browser? You can upload it again any time.')) {
        Welcome.clear();
      }
    });
  }

  return { init: init };
})();

App.registerView('settings', { label: 'Settings', init: Settings.init });


/* ---- welcome.js ---- */
/* Landing: what a visitor sees before there is any data, and the path back
   here from Settings to add or replace an export. Files are read in this
   browser and kept only in its own storage (see store.js); nothing is sent. */

const Welcome = (function () {
  const PRIVACY_URL = 'https://www.spotify.com/id-id/account/privacy/';

  let el = null;
  let statusEl = null;
  let busy = false;
  let snapshot = null;   // what is loaded, in the form that is saved and merged
  let saved = false;     // whether that snapshot made it into browser storage
  let mode = 'add';      // what an upload does when data is already loaded

  function template() {
    const canUnzip = typeof DecompressionStream === 'function';
    return '<div class="landing-inner">' +
      '<button class="xback" id="wzBack" type="button" hidden>&larr; Back to your data</button>' +
      '<h1 class="landing-title">Spotify Stats Visualizer</h1>' +
      '<p class="landing-lead">Visualizes your Spotify listening history from the ' +
      'official account data export.</p>' +

      '<p class="landing-privacy">Your files are read here, in this browser, and kept ' +
      'only in this browser’s storage so they are here next time. Nothing is uploaded ' +
      'or sent anywhere. Clear it from Settings whenever you like.</p>' +

      '<div class="landing-mode" id="wzModeWrap" hidden>' +
      '<span class="field-label">This upload</span>' +
      '<div class="seg" id="wzMode" role="group" aria-label="What this upload does">' +
      '<button type="button" data-wzmode="add" aria-pressed="true">Add to what’s loaded</button>' +
      '<button type="button" data-wzmode="replace" aria-pressed="false">Replace it</button>' +
      '</div>' +
      '<p class="field-help" id="wzModeHelp"></p></div>' +

      '<label class="dropzone dropzone--lg" id="wzDrop" tabindex="0">' +
      '<input type="file" id="wzFolder" webkitdirectory directory multiple hidden>' +
      '<input type="file" id="wzZip" accept=".zip,application/zip" hidden>' +
      '<span class="dropzone-text"><b>Drop your export ' +
      (canUnzip ? 'folder or .zip' : 'folder') + ' here</b>' +
      '<span class="dropzone-sub">' + (canUnzip
        ? 'or choose one below'
        : 'This browser cannot open zip files here. Unzip it first, then drop the folder.') +
      '</span></span>' +
      '</label>' +
      '<div class="btn-row">' +
      '<button class="btn-outline" id="wzPickFolder" type="button">Choose folder</button>' +
      (canUnzip
        ? '<button class="btn-outline" id="wzPickZip" type="button">Choose .zip</button>'
        : '') +
      '</div>' +
      '<p class="landing-status" id="wzStatus" role="status" aria-live="polite"></p>' +

      '<div class="landing-steps"><h2 class="landing-h2">No export yet?</h2>' +
      '<ol><li>Open <a class="link" target="_blank" rel="noopener" href="' +
      PRIVACY_URL + '">your Spotify privacy settings</a>.</li>' +
      '<li>Request <b>Account data</b>. Spotify emails it within a few days.</li>' +
      '<li>Come back and drop the zip in, unopened.</li></ol>' +
      '<p class="landing-note">Only the streaming history is required. ' +
      'You can add a newer account data export to update your history in ' +
      'this browser.</p></div>' +
      '</div>';
  }

  const MODE_HELP = {
    add: 'Plays are combined by date. Where two exports overlap, the newer one ' +
      'is kept, and its library, playlists and Wrapped replace the older ones.',
    replace: 'Everything loaded now is swapped for this upload.'
  };

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', !!isError);
  }

  function setMode(next) {
    mode = next;
    el.querySelectorAll('[data-wzmode]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.wzmode === mode));
    });
    el.querySelector('#wzModeHelp').textContent = MODE_HELP[mode];
  }

  /** Show `payload` and remember `snap` as what is loaded. */
  function adopt(payload, snap) {
    snapshot = snap;
    App.useDataset(payload);
    close();
    setStatus('', false);
  }

  async function ingest(files) {
    const list = Array.prototype.slice.call(files || []);
    if (!list.length || busy) return;
    busy = true;
    const base = Data.loaded && snapshot && mode === 'add' ? snapshot : null;
    setStatus('Reading ' + list.length + (list.length === 1 ? ' file…' : ' files…'), false);
    try {
      const result = await Loader.fromFiles(list, base);
      adopt(result.payload, result.snapshot);
      saved = await Store.save(result.snapshot);
      App.navigate('#timeline');
      App.toast((base ? 'Added. ' : '') + fmtNumber(result.payload.meta.counts.plays) +
        ' plays loaded' + (saved ? '' : ', but this browser would not save them'));
    } catch (err) {
      setStatus(err && err.message ? err.message : 'Could not read that.', true);
    } finally {
      busy = false;
      // Let the same folder or zip be chosen again after a failure.
      el.querySelectorAll('input[type="file"]').forEach(function (i) { i.value = ''; });
    }
  }

  /** Reopen what was saved last visit. Resolves true when something loaded. */
  async function restore() {
    busy = true;
    setStatus('Opening your saved listening history…', false);
    try {
      const snap = await Store.load();
      if (!snap) return false;
      adopt(Loader.buildFromSnapshot(snap), snap);
      saved = true;
      return true;
    } catch (err) {
      // Saved by an incompatible version, or damaged: start over cleanly.
      await Store.clear();
      return false;
    } finally {
      busy = false;
      if (!Data.loaded) setStatus('', false);
    }
  }

  /** Every File under the dropped items, walking into folders. */
  async function droppedFiles(dataTransfer) {
    const items = dataTransfer.items;
    const roots = [];
    if (items) {
      for (const item of items) {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry) roots.push(entry);
      }
    }
    if (!roots.length) return Array.prototype.slice.call(dataTransfer.files || []);

    const files = [];
    async function walk(entry) {
      if (entry.isFile) {
        files.push(await new Promise(function (res, rej) { entry.file(res, rej); }));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        // readEntries returns at most ~100 entries per call: keep reading
        // until it comes back empty.
        for (;;) {
          const batch = await new Promise(function (res, rej) { reader.readEntries(res, rej); });
          if (!batch.length) break;
          for (const child of batch) await walk(child);
        }
      }
    }
    for (const r of roots) await walk(r);
    return files;
  }

  function wire() {
    const drop = el.querySelector('#wzDrop');
    const folder = el.querySelector('#wzFolder');
    const zipIn = el.querySelector('#wzZip');
    const pickZip = el.querySelector('#wzPickZip');
    statusEl = el.querySelector('#wzStatus');

    el.querySelector('#wzBack').addEventListener('click', function () {
      close();
      App.navigate('#settings');
    });
    el.querySelector('#wzMode').addEventListener('click', function (e) {
      const b = e.target.closest('[data-wzmode]');
      if (b) setMode(b.dataset.wzmode);
    });
    el.querySelector('#wzPickFolder').addEventListener('click', function () { folder.click(); });
    if (pickZip) pickZip.addEventListener('click', function () { zipIn.click(); });
    folder.addEventListener('change', function (e) { ingest(e.target.files); });
    zipIn.addEventListener('change', function (e) { ingest(e.target.files); });

    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); folder.click(); }
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      drop.addEventListener(type, function (e) {
        e.preventDefault(); drop.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      drop.addEventListener(type, function (e) {
        e.preventDefault(); drop.classList.remove('is-over');
      });
    });

    drop.addEventListener('drop', async function (e) {
      try {
        ingest(await droppedFiles(e.dataTransfer));
      } catch (err) {
        setStatus('Could not read what was dropped. Try choosing it instead.', true);
      }
    });
  }

  function mount() {
    el = document.getElementById('landing');
    el.innerHTML = template();
    wire();
    open();
  }

  function open() {
    if (!el) return mount();
    const loaded = Data.loaded;
    el.querySelector('#wzBack').hidden = !loaded;
    // Adding needs the loaded export's snapshot; an export baked into the
    // page has none, so there the only choice is to replace it.
    el.querySelector('#wzModeWrap').hidden = !(loaded && snapshot);
    setMode('add');
    el.hidden = false;
    el.scrollTop = 0;
    document.querySelector('.main').hidden = true;
    document.getElementById('sidebar').hidden = true;
    document.getElementById('bottombar').hidden = true;
  }

  function close() {
    el.hidden = true;
    document.querySelector('.main').hidden = false;
    document.getElementById('sidebar').hidden = false;
    document.getElementById('bottombar').hidden = false;
  }

  /** Forget the loaded export, here and in browser storage. */
  async function clear() {
    App.clearDataset();
    snapshot = null;
    saved = false;
    await Store.clear();
    setStatus('', false);
    open();
    history.replaceState(null, '', location.pathname + location.search);
  }

  function isOpen() { return !!el && !el.hidden; }

  /** What Settings shows about the loaded data. */
  function info() {
    return {
      uploaded: !!snapshot,
      saved: saved,
      uploads: snapshot ? (snapshot.sources || []).length : 0
    };
  }

  return {
    mount: mount, open: open, close: close, clear: clear, ingest: ingest,
    restore: restore, isOpen: isOpen, info: info
  };
})();


/* ---- boot.js ---- */
/* Bootstrap: wire the shell and keyboard, then open on the embedded export
   if this build carries one, else on what this browser saved last visit,
   else on the landing view. */

(function boot() {
  const node = document.getElementById('payload');
  const payload = node ? JSON.parse(node.textContent) : null;

  App.loadSettings();

  /* -- global search ---------------------------------------------------- */

  const globalSearch = document.getElementById('globalSearch');
  const runSearch = debounce(function (value) {
    if (!Data.loaded) return;
    if (value.trim()) History.openWithQuery(value);
    else if (App.current === 'history') History.openWithQuery('');
  }, 200);

  globalSearch.addEventListener('input', function (e) { runSearch(e.target.value); });
  globalSearch.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { runSearch.flush(e.target.value); }
  });

  /* -- keyboard --------------------------------------------------------- */

  document.addEventListener('keydown', function (e) {
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);

    if (e.key === 'Escape') {
      if (inField) { e.target.value = ''; e.target.blur(); runSearch(''); }
      return;
    }
    // The landing view has no search and no views to switch between.
    if (Welcome.isOpen()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === '/' && !inField) {
      e.preventDefault();
      globalSearch.focus();
      globalSearch.select();
      return;
    }
    if (inField) return;

    if (e.key === 'ArrowLeft' && App.current === 'timeline') { e.preventDefault(); Timeline.step(-1); }
    else if (e.key === 'ArrowRight' && App.current === 'timeline') { e.preventDefault(); Timeline.step(1); }
    else if (e.key >= '1' && e.key <= '9') {
      // Numbers follow the nav as shown, so a hidden view never takes a key.
      const target = App.visibleViews()[+e.key - 1];
      if (target) App.navigate('#' + target.id);
    }
  });

  window.addEventListener('hashchange', function () {
    if (Data.loaded && !Welcome.isOpen()) App.navigate(location.hash);
  });

  /* -- start ------------------------------------------------------------ */

  if (!payload) {
    Welcome.mount();
    Welcome.restore().then(function (restored) {
      if (restored) App.navigate(location.hash || '#timeline');
    });
    return;
  }
  App.useDataset(payload);
  App.navigate(location.hash || '#timeline');
})();
