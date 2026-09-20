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
