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
