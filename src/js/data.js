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
