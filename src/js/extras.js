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
