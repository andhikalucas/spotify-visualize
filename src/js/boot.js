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
