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
