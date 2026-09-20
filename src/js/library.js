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
