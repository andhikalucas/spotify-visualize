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
