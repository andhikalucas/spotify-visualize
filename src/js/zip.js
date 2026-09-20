/* Minimal zip reader: enough of the format to pull named JSON entries out of a
   Spotify export, and nothing more. Inflation uses the platform's own
   DecompressionStream, so there is no dependency and no bundled inflater.

   Only entries whose basename passes `wanted` are extracted, which also means
   a crafted archive cannot smuggle in paths we would otherwise walk. */

const Zip = (function () {
  const EOCD_SIG = 0x06054b50;
  const EOCD64_LOCATOR_SIG = 0x07064b50;
  const CEN_SIG = 0x02014b50;

  const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

  /** Offset of the End Of Central Directory record, or -1. It sits at the end,
      after a comment of up to 65535 bytes. */
  function findEocd(view, length) {
    const floor = Math.max(0, length - 65557);
    for (let i = length - 22; i >= floor; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) return i;
    }
    return -1;
  }

  function basename(name) {
    const clean = String(name).replace(/\\/g, '/');
    return clean.slice(clean.lastIndexOf('/') + 1);
  }

  /** Inflate, counting real output and aborting if it exceeds what is allowed.
      The archive's declared uncompressedSize is attacker-controlled, so it is
      a hint for skipping obvious junk early, never the limit that protects
      us: a small declared size can still expand into a huge real stream, and
      nothing checks that until bytes actually come out of
      DecompressionStream. `budget` is the real, running total still
      available across the whole archive. */
  async function inflate(bytes, method, budget) {
    const cap = Math.min(MAX_ENTRY_BYTES, budget);
    if (method === 0) return bytes.length > cap ? null : bytes;
    if (method !== 8) return null;

    const reader = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.length;
      if (size > cap) { await reader.cancel(); return null; }
      chunks.push(step.value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /** Read `blob` and return [{name, text}] for every entry `wanted` accepts. */
  async function read(blob, wanted) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error(
        'This browser cannot open zip files here. Unzip it and drop the folder instead.');
    }

    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);

    const eocd = findEocd(view, bytes.length);
    if (eocd === -1) throw new Error('That file is not a zip archive.');

    if (eocd >= 20 && view.getUint32(eocd - 20, true) === EOCD64_LOCATOR_SIG) {
      throw new Error(
        'That zip uses the zip64 format, which this page cannot read. ' +
        'Unzip it and drop the folder instead.');
    }

    // A 0xffff entry count is also a zip64 sentinel (too many entries to fit
    // a 16-bit field), but it's moot here: any real zip64 archive already
    // trips the locator or offset checks above/below, which cover every
    // archive we'd otherwise mis-read.
    let count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (offset === 0xffffffff) {
      throw new Error(
        'That zip uses the zip64 format, which this page cannot read. ' +
        'Unzip it and drop the folder instead.');
    }

    const decoder = new TextDecoder('utf-8');
    const out = [];
    let total = 0;

    for (let i = 0; i < count && offset + 46 <= bytes.length; i++) {
      if (view.getUint32(offset, true) !== CEN_SIG) break;

      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

      offset += 46 + nameLen + extraLen + commentLen;

      const base = basename(name);
      if (!base || name.endsWith('/')) continue;
      if (!wanted(base)) continue;
      // Declared sizes come straight from the archive and are
      // attacker-controlled: this is a cheap pre-filter for obviously junk
      // entries, not the defence. The real caps are enforced inside
      // inflate(), which counts actual decompressed bytes as they stream out.
      if (uncompressedSize > MAX_ENTRY_BYTES) continue;
      if (total + uncompressedSize > MAX_TOTAL_BYTES) break;

      // The central directory's name and extra lengths need not match the local
      // header's, so re-read them there before slicing the data.
      if (localOffset + 30 > bytes.length) continue;
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compressedSize);

      // A corrupt or crafted entry can make DecompressionStream reject (bad
      // deflate data, or a localOffset that lands in-bounds but not on a real
      // local header). One bad entry should not sink the whole archive, nor
      // surface a useless stack trace to a visitor: skip it and keep going.
      let inflated;
      try {
        inflated = await inflate(data, method, MAX_TOTAL_BYTES - total);
      } catch (err) {
        continue;
      }
      if (!inflated) continue;

      total += inflated.length;
      const text = decoder.decode(inflated);
      out.push({ name: base, text: function () { return Promise.resolve(text); } });
    }

    if (!out.length) {
      throw new Error('That zip holds no Spotify export files.');
    }
    return out;
  }

  return { read: read };
})();
