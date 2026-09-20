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
