import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

/** Evaluate a browser-global module file and pull named values out of it. */
function load(files, names) {
  const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}

const ui = load(['src/js/ui.js'], ['esc', 'attr', 'num', 'safeSpotifyUrl', 'fmtNumber']);

test('esc neutralises tag delimiters', () => {
  assert.equal(ui.esc('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
});

test('esc neutralises both quote characters', () => {
  assert.equal(ui.esc(`a"b'c`), 'a&quot;b&#39;c');
});

test('esc escapes ampersands first so entities are not doubled', () => {
  assert.equal(ui.esc('&lt;'), '&amp;lt;');
});

test('esc renders null and undefined as empty', () => {
  assert.equal(ui.esc(null), '');
  assert.equal(ui.esc(undefined), '');
});

test('num coerces to a finite number or zero', () => {
  assert.equal(ui.num(42), '42');
  assert.equal(ui.num('7'), '7');
  assert.equal(ui.num('<img src=x>'), '0');
  assert.equal(ui.num(NaN), '0');
  assert.equal(ui.num(Infinity), '0');
});

test('fmtNumber formats real numbers with thousands separators', () => {
  assert.equal(ui.fmtNumber(1198), '1,198');
  assert.equal(ui.fmtNumber(4232), '4,232');
});

test('fmtNumber neutralises hostile non-numeric input', () => {
  assert.equal(ui.fmtNumber('<img src=x>'), '0');
  assert.equal(ui.fmtNumber(NaN), '0');
  assert.equal(ui.fmtNumber(Infinity), '0');
  assert.equal(ui.fmtNumber(null), '0');
});

test('safeSpotifyUrl accepts a well formed uri', () => {
  assert.equal(ui.safeSpotifyUrl('spotify:track:4cOdK2wGLETKBW3PvgPWqT'),
    'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
});

test('safeSpotifyUrl rejects anything else', () => {
  assert.equal(ui.safeSpotifyUrl('javascript:alert(1)'), null);
  assert.equal(ui.safeSpotifyUrl('spotify:track:abc" onload="x'), null);
  assert.equal(ui.safeSpotifyUrl('spotify:track:../../evil'), null);
  assert.equal(ui.safeSpotifyUrl(''), null);
  assert.equal(ui.safeSpotifyUrl(null), null);
});

const zip = load(['src/js/zip.js'], ['Zip']);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Write a standard (non-zip64) archive in memory, so the fixtures need no
    external `zip` binary. `entries` maps a path to its content; a path ending
    in '/' is written as a directory entry. Deflated unless `store` is set. */
function writeZip(entries, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(body);
    const isDir = name.endsWith('/');
    const method = store || isDir ? 0 : 8;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(isDir ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Flat archive: `{ 'File.json': body }`. Pass ['-0'] to store rather than
    deflate, mirroring `zip -0`. */
function makeZip(entries, extraArgs = []) {
  return writeZip(Object.entries(entries), { store: extraArgs.includes('-0') });
}

/** Archive with real subdirectories, so directory pseudo entries and
    multi-level paths appear in it the way `zip -r` writes them. `entries`
    keys are paths like 'sub/dir/File.json'. */
function makeNestedZip(entries) {
  const list = [];
  const dirs = new Set();
  for (const [relPath, body] of Object.entries(entries)) {
    const parts = relPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/') + '/';
      if (!dirs.has(dir)) { dirs.add(dir); list.push([dir, '']); }
    }
    list.push([relPath, body]);
  }
  return writeZip(list);
}

/** A DataView over a Node Buffer, respecting its offset/length within the
    underlying (possibly pooled) ArrayBuffer. */
function viewOf(buf) {
  return new DataView(buf.buffer, buf.byteOffset, buf.length);
}

/** Byte offset of the EOCD record in a zip built without a comment. */
function findEocd(buf) {
  const view = viewOf(buf);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error('EOCD not found in test fixture');
}

/** Corrupt one entry's compressed bytes in place (XOR every byte), leaving
    every other entry intact. */
function corruptEntry(buf, filename) {
  const out = Buffer.from(buf);
  const nameIdx = out.indexOf(Buffer.from(filename));
  const localHeaderStart = nameIdx - 30;
  const compressedSize = out.readUInt32LE(localHeaderStart + 18);
  const nameLen = out.readUInt16LE(localHeaderStart + 26);
  const extraLen = out.readUInt16LE(localHeaderStart + 28);
  const dataStart = localHeaderStart + 30 + nameLen + extraLen;
  for (let i = 0; i < compressedSize; i++) {
    out[dataStart + i] ^= 0xff;
  }
  return out;
}

/** Hand-build a single-entry zip so the declared uncompressedSize can be
    falsified independently of the real compressed data — the only way to
    test that Zip.read enforces the real inflated size rather than trusting
    the archive's own claim. */
function buildFakeZip(name, compressedBytes, declaredUncompressedSize, method = 8) {
  const nameBuf = Buffer.from(name);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(compressedBytes.length, 18);
  localHeader.writeUInt32LE(declaredUncompressedSize, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const localEntry = Buffer.concat([localHeader, nameBuf, compressedBytes]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(method, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(compressedBytes.length, 20);
  centralHeader.writeUInt32LE(declaredUncompressedSize, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  const centralEntry = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

/** Load Zip with the size caps overridden to small values, so the bomb-cap
    test doesn't need a multi-megabyte fixture to exercise the real limit. */
function loadZipWithCaps(maxEntryBytes, maxTotalBytes) {
  const src = readFileSync('src/js/zip.js', 'utf8')
    .replace('const MAX_ENTRY_BYTES = 64 * 1024 * 1024;', `const MAX_ENTRY_BYTES = ${maxEntryBytes};`)
    .replace('const MAX_TOTAL_BYTES = 256 * 1024 * 1024;', `const MAX_TOTAL_BYTES = ${maxTotalBytes};`);
  return new Function(`${src}\nreturn { Zip };`)();
}

test('Zip.read extracts a deflated entry', async () => {
  const body = JSON.stringify([{ trackName: 'x'.repeat(2000) }]);
  const buf = makeZip({ 'StreamingHistory_music_0.json': body });
  const out = await zip.Zip.read(new Blob([buf]), () => true);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'StreamingHistory_music_0.json');
  assert.equal(await out[0].text(), body);
});

test('Zip.read extracts a stored entry', async () => {
  const body = '[]';
  const buf = makeZip({ 'YourLibrary.json': body }, ['-0']);
  const out = await zip.Zip.read(new Blob([buf]), () => true);
  assert.equal(await out[0].text(), body);
});

test('Zip.read flattens nested paths to basenames', async () => {
  const buf = makeNestedZip({ 'Spotify Account Data/Identity.json': '{}' });
  const out = await zip.Zip.read(new Blob([buf]), () => true);
  assert.deepEqual(out.map((e) => e.name), ['Identity.json']);
});

test('Zip.read applies the wanted predicate', async () => {
  const buf = makeZip({ 'Identity.json': '{}', 'Ignored.txt': 'no' });
  const out = await zip.Zip.read(new Blob([buf]), (n) => n.endsWith('.json'));
  assert.deepEqual(out.map((e) => e.name), ['Identity.json']);
});

test('Zip.read rejects a file that is not a zip', async () => {
  await assert.rejects(
    () => zip.Zip.read(new Blob([Buffer.from('not a zip at all')]), () => true),
    /not a zip/i
  );
});

test('Zip.read skips directory entries', async () => {
  const buf = makeNestedZip({ 'sub/a.json': '{}', 'sub/nested/b.json': '{}' });
  const out = await zip.Zip.read(new Blob([buf]), () => true);
  assert.deepEqual(out.map((e) => e.name).sort(), ['a.json', 'b.json']);
});

test('Zip.read rejects a zip64 archive carrying an EOCD64 locator', async () => {
  const buf = Buffer.from(makeZip({ 'Identity.json': '{}' }));
  const eocd = findEocd(buf);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  const patched = Buffer.concat([buf.subarray(0, eocd), locator, buf.subarray(eocd)]);
  await assert.rejects(
    () => zip.Zip.read(new Blob([patched]), () => true),
    /zip64/i
  );
});

test('Zip.read rejects a zip64 archive via the 0xffffffff offset sentinel', async () => {
  const buf = Buffer.from(makeZip({ 'Identity.json': '{}' }));
  const eocd = findEocd(buf);
  viewOf(buf).setUint32(eocd + 16, 0xffffffff, true);
  await assert.rejects(
    () => zip.Zip.read(new Blob([buf]), () => true),
    /zip64/i
  );
});

test('Zip.read skips a corrupt entry but keeps the others', async () => {
  const good = JSON.stringify({ ok: true });
  const bad = 'z'.repeat(5000);
  const buf = makeZip({ 'Identity.json': good, 'Broken.json': bad });
  const corrupted = corruptEntry(buf, 'Broken.json');
  const out = await zip.Zip.read(new Blob([corrupted]), () => true);
  assert.deepEqual(out.map((e) => e.name), ['Identity.json']);
  assert.equal(await out[0].text(), good);
});

test('Zip.read enforces the real inflated size, not the declared one', async () => {
  const capped = loadZipWithCaps(1000, 2000);
  // Declares 10 bytes but really inflates to 5000 — a decompression-bomb
  // shape. The lowered cap (1000) must still catch it.
  const realPayload = Buffer.alloc(5000, 0x41);
  const compressed = zlib.deflateRawSync(realPayload);
  const buf = buildFakeZip('Big.json', compressed, 10);
  await assert.rejects(
    () => capped.Zip.read(new Blob([buf]), () => true),
    /no Spotify export files/i
  );
});

/* -- Loader --------------------------------------------------------------- */

// zip.js and loader.js are evaluated together so fromFiles can reach Zip.read,
// exactly as they run in the browser (both are plain scripts, no imports).
const { Loader } = load(['src/js/zip.js', 'src/js/loader.js'], ['Loader']);

/** A minimal File-like object: a name plus an async text() reader, matching
    what loader.js's readAll/readOne/pick expect. `content` is JSON-stringified
    unless it's already a string. */
function fileOf(name, content) {
  return { name, text: async () => (typeof content === 'string' ? content : JSON.stringify(content)) };
}

/** A zip-shaped fixture: a real Blob (so Zip.read's blob.arrayBuffer() works)
    with a `.name` tacked on, mirroring a browser File's own Blob-ness. */
function zipFileOf(name, buf) {
  const blob = new Blob([buf]);
  blob.name = name;
  return blob;
}

function musicRow(artist, track, minute, msPlayed) {
  return {
    artistName: artist, trackName: track,
    endTime: `2026-01-01 00:${String(minute).padStart(2, '0')}`,
    msPlayed
  };
}

test('Loader.isWanted accepts every known export basename and both streaming-history patterns', () => {
  for (const n of Loader.EXPORT_FILES) assert.equal(Loader.isWanted(n), true, n);
  assert.equal(Loader.isWanted('StreamingHistory_music_0.json'), true);
  assert.equal(Loader.isWanted('StreamingHistory_music_12.json'), true);
  assert.equal(Loader.isWanted('StreamingHistory_podcast_0.json'), true);
  assert.equal(Loader.isWanted('StreamingHistory_podcast_7.json'), true);
});

test('Loader.isWanted rejects anything not in the known set or pattern', () => {
  assert.equal(Loader.isWanted('Random.json'), false);
  assert.equal(Loader.isWanted('StreamingHistory_music_abc.json'), false);
  assert.equal(Loader.isWanted('StreamingHistory_video_0.json'), false);
  assert.equal(Loader.isWanted('identity.json'), false); // case-sensitive
  assert.equal(Loader.isWanted(''), false);
});

test('Loader buildPayload drops plays under the 30s threshold, keeps 30000 and above', async () => {
  const rows = [
    musicRow('A', 'Short', 0, 29999),
    musicRow('A', 'Exact', 1, 30000),
    musicRow('A', 'Long', 2, 30001)
  ];
  const files = [fileOf('StreamingHistory_music_0.json', rows)];
  const payload = await Loader.buildPayload(files);
  assert.equal(payload.meta.counts.plays, 2);
  assert.equal(payload.meta.counts.tracks, 2);
  assert.deepEqual(payload.tracks.map((t) => t[1]), ['Exact', 'Long']);
});

test('Loader buildPayload distinguishes "no music file" from "all plays too short"', async () => {
  await assert.rejects(
    () => Loader.buildPayload([fileOf('Identity.json', {})]),
    /No StreamingHistory_music_\*\.json found in that upload/
  );
  const allShort = [musicRow('A', 'T1', 0, 100), musicRow('A', 'T2', 1, 29999)];
  await assert.rejects(
    () => Loader.buildPayload([fileOf('StreamingHistory_music_0.json', allShort)]),
    /That export has no plays longer than 30 seconds/
  );
});

test('Loader buildPayload present is sorted and deduplicated; missing lists exactly what is absent', async () => {
  const rows = [musicRow('A', 'T', 0, 40000)];
  const files = [
    fileOf('StreamingHistory_music_0.json', rows),
    fileOf('Identity.json', {}),
    fileOf('some/nested/path/Identity.json', {}), // same basename, different path: must dedupe
    fileOf('Follow.json', {}),
    fileOf('Unrelated.json', {}) // not in EXPORT_FILES, not a streaming-history file: excluded
  ];
  const payload = await Loader.buildPayload(files);
  assert.deepEqual(payload.meta.present,
    ['Follow.json', 'Identity.json', 'StreamingHistory_music_0.json']);

  const missing = Loader.EXPORT_FILES.filter((n) => payload.meta.present.indexOf(n) === -1);
  assert.ok(missing.includes('Wrapped2025.json'));
  assert.ok(missing.includes('Payments.json'));
  assert.ok(!missing.includes('Identity.json'));
  assert.ok(!missing.includes('Follow.json'));
});

test('Loader.fromFiles reads loose JSON files and reports matching meta.counts and missing', async () => {
  const rows = [
    musicRow('Artist A', 'Song 1', 0, 45000),
    musicRow('Artist B', 'Song 2', 5, 60000)
  ];
  const files = [
    fileOf('StreamingHistory_music_0.json', rows),
    fileOf('Identity.json', { displayName: 'Test' })
  ];
  const { payload, present, missing } = await Loader.fromFiles(files);
  assert.equal(payload.meta.counts.plays, 2);
  assert.equal(payload.meta.counts.tracks, 2);
  assert.equal(payload.meta.counts.artists, 2);
  assert.deepEqual(present, ['Identity.json', 'StreamingHistory_music_0.json']);
  assert.ok(missing.includes('Follow.json'));
  assert.ok(!missing.includes('Identity.json'));
  assert.ok(!missing.includes('StreamingHistory_music_0.json'));
});

test('Loader.fromFiles extracts a zip mixed with loose files instead of dropping it', async () => {
  const rows = [musicRow('Artist A', 'Song 1', 0, 45000)];
  const zipBuf = makeZip({ 'StreamingHistory_music_0.json': JSON.stringify(rows) });
  const files = [
    zipFileOf('export.zip', zipBuf),
    fileOf('Identity.json', { displayName: 'Loose file' })
  ];
  const { payload, present, missing } = await Loader.fromFiles(files);
  assert.equal(payload.meta.counts.plays, 1);
  assert.deepEqual(present, ['Identity.json', 'StreamingHistory_music_0.json']);
  assert.ok(!missing.includes('Identity.json'));
});

test('Loader.fromFiles counts a zip dropped with its own unzipped folder once, keeping the zip copy', async () => {
  const zipped = [musicRow('Artist A', 'Song 1', 0, 45000), musicRow('Artist A', 'Song 2', 1, 45000)];
  const loose = [musicRow('Artist B', 'Other', 0, 45000)];
  const zipBuf = makeZip({
    'StreamingHistory_music_0.json': JSON.stringify(zipped),
    'Identity.json': JSON.stringify({ displayName: 'From zip' })
  });
  const files = [
    fileOf('StreamingHistory_music_0.json', loose),
    fileOf('Identity.json', { displayName: 'From folder' }),
    zipFileOf('export.zip', zipBuf)
  ];
  const { payload, present } = await Loader.fromFiles(files);
  assert.equal(payload.meta.counts.plays, 2);
  assert.deepEqual(payload.artists, ['Artist A']);
  assert.equal(payload.extras.account.displayName, 'From zip');
  assert.deepEqual(present, ['Identity.json', 'StreamingHistory_music_0.json']);
});

/* -- Appending exports ------------------------------------------------------ */

function dayRow(day, track, msPlayed = 60000) {
  return { artistName: 'A', trackName: track, endTime: `2026-01-${String(day).padStart(2, '0')} 12:00`, msPlayed };
}

/** Days 1-10 in the older export, 6-15 in the newer: they overlap on 6-10. */
function overlappingExports() {
  const older = [];
  const newer = [];
  for (let d = 1; d <= 10; d++) older.push(dayRow(d, `T${d}`));
  for (let d = 6; d <= 15; d++) newer.push(dayRow(d, `T${d}`));
  return {
    older: [fileOf('StreamingHistory_music_0.json', older), fileOf('Identity.json', { displayName: 'Old name' }),
      fileOf('Follow.json', { userIsFollowing: ['only-in-old'] })],
    newer: [fileOf('StreamingHistory_music_0.json', newer), fileOf('Identity.json', { displayName: 'New name' })]
  };
}

test('Appending an overlapping newer export counts each play once', async () => {
  const x = overlappingExports();
  const first = await Loader.fromFiles(x.older);
  const merged = await Loader.fromFiles(x.newer, first.snapshot);
  assert.equal(merged.payload.meta.counts.plays, 15);
  assert.equal(merged.payload.meta.rangeStart, '2026-01-01');
  assert.equal(merged.payload.meta.rangeEnd, '2026-01-15');
});

test('Appending is order-independent: an older export fills history without overriding', async () => {
  const x = overlappingExports();
  const newerFirst = await Loader.fromFiles(x.newer);
  const merged = await Loader.fromFiles(x.older, newerFirst.snapshot);
  assert.equal(merged.payload.meta.counts.plays, 15);
  // The newer export's other files win even though it was uploaded first...
  assert.equal(merged.payload.extras.account.displayName, 'New name');
  // ...and a file only the older export has is kept.
  assert.deepEqual(merged.payload.extras.follows.following, ['only-in-old']);
  assert.deepEqual(merged.present, ['Follow.json', 'Identity.json', 'StreamingHistory_music_0.json']);
});

test('Where exports overlap, the newer export is the one counted', async () => {
  const older = [dayRow(1, 'Kept'), dayRow(5, 'Dropped')];
  const newer = [dayRow(5, 'Replacement'), dayRow(6, 'New')];
  const first = await Loader.fromFiles([fileOf('StreamingHistory_music_0.json', older)]);
  const merged = await Loader.fromFiles([fileOf('StreamingHistory_music_0.json', newer)], first.snapshot);
  assert.deepEqual(merged.payload.tracks.map((t) => t[1]).sort(), ['Kept', 'New', 'Replacement']);
});

test('Re-adding the same export changes nothing', async () => {
  const x = overlappingExports();
  const once = await Loader.fromFiles(x.older);
  const twice = await Loader.fromFiles(x.older, once.snapshot);
  assert.equal(twice.payload.meta.counts.plays, once.payload.meta.counts.plays);
  assert.equal(twice.snapshot.sources.length, 2);
});

test('A saved snapshot rebuilds the same payload', async () => {
  const x = overlappingExports();
  const r = await Loader.fromFiles(x.older);
  const again = Loader.buildFromSnapshot(JSON.parse(JSON.stringify(r.snapshot)));
  delete again.meta.generated;
  delete r.payload.meta.generated;
  assert.deepEqual(again, r.payload);
});

test('Loader.fromFiles rejects an upload with nothing from an export in it', async () => {
  const base = (await Loader.fromFiles(overlappingExports().older)).snapshot;
  await assert.rejects(() => Loader.fromFiles([fileOf('notes.txt', 'hi')], base),
    /Nothing in that upload looks like a Spotify export/);
});
