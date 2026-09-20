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
