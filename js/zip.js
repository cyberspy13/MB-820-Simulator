/*
 * Reads the zip container that Word, Excel, PowerPoint and OpenDocument files use, with limits so a
 * malicious file cannot fill the memory. Also writes plain zips for the downloadable templates.
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const MAX_BYTES = 400 * 1024 * 1024;
  const MAX_ENTRIES = 20000;
  const DAMAGED = 'This file is damaged and cannot be opened.';

  function findEnd(view) {
    const last = view.byteLength - 22;
    for (let i = last; i >= 0 && i > last - 65536; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    throw new Error(DAMAGED);
  }

  async function inflate(data, limit) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser is too old to open Office files. Update it, or save the file as PDF or text.');
    }
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.length;
      if (total > limit) {
        reader.cancel();
        throw new Error('This file is too large to open.');
      }
      parts.push(step.value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    parts.forEach(function (p) {
      out.set(p, at);
      at += p.length;
    });
    return out;
  }

  function decode(bytes) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function parseXml(text) {
    // Office files never need a DOCTYPE; one is only useful for attacks.
    if (/<!(?:DOCTYPE|ENTITY)/i.test(text.slice(0, 4000))) throw new Error(DAMAGED);
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error(DAMAGED);
    return doc;
  }

  function open(buffer) {
    const view = new DataView(buffer);
    const entries = new Map();
    let used = 0;
    try {
      const end = findEnd(view);
      const count = view.getUint16(end + 10, true);
      let at = view.getUint32(end + 16, true);
      if (count > MAX_ENTRIES) throw new Error(DAMAGED);
      for (let n = 0; n < count; n++) {
        if (view.getUint32(at, true) !== 0x02014b50) throw new Error(DAMAGED);
        const nameLength = view.getUint16(at + 28, true);
        const name = new TextDecoder().decode(new Uint8Array(buffer, at + 46, nameLength)).replace(/\\/g, '/');
        entries.set(name, {
          locked: (view.getUint16(at + 8, true) & 1) === 1,
          method: view.getUint16(at + 10, true),
          size: view.getUint32(at + 20, true),
          offset: view.getUint32(at + 42, true)
        });
        at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      }
    } catch (err) {
      throw new Error(DAMAGED);
    }

    async function bytes(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.locked) throw new Error('This file is protected with a password. Save a copy without one and upload that.');
      let data;
      try {
        const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
        data = new Uint8Array(buffer, start, e.size);
      } catch (err) {
        throw new Error(DAMAGED);
      }
      let out;
      if (e.method === 0) out = data;
      else if (e.method === 8) out = await inflate(data, MAX_BYTES - used);
      else throw new Error(DAMAGED);
      used += out.length;
      return out;
    }
    async function text(name) {
      const b = await bytes(name);
      return b ? decode(b) : null;
    }
    async function xml(name) {
      const t = await text(name);
      return t === null ? null : parseXml(t);
    }
    return { names: Array.from(entries.keys()), has: function (n) { return entries.has(n); }, bytes: bytes, text: text, xml: xml };
  }

  /* ---------- writing ---------- */

  let table = null;

  function crc32(data) {
    if (!table) {
      table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // files: { 'name': 'text' }. Nothing is compressed; templates are tiny.
  function write(files) {
    const local = [];
    const central = [];
    let offset = 0;
    Object.keys(files).forEach(function (path) {
      const name = new TextEncoder().encode(path);
      const data = new TextEncoder().encode(files[path]);
      const head = function (signature, extra) {
        const b = new DataView(new ArrayBuffer(extra ? 46 : 30));
        let at = 0;
        const u16 = function (v) { b.setUint16(at, v, true); at += 2; };
        const u32 = function (v) { b.setUint32(at, v, true); at += 4; };
        u32(signature);
        if (extra) u16(20);
        u16(20);
        u16(0x0800);
        u16(0);
        u16(0);
        u16(0x5A21);
        u32(crc32(data));
        u32(data.length);
        u32(data.length);
        u16(name.length);
        u16(0);
        if (extra) {
          u16(0);
          u16(0);
          u16(0);
          u32(0);
          u32(offset);
        }
        return new Uint8Array(b.buffer);
      };
      local.push(head(0x04034b50, false), name, data);
      central.push(head(0x02014b50, true), name);
      offset += 30 + name.length + data.length;
    });
    const size = central.reduce(function (sum, p) { return sum + p.length; }, 0);
    const end = new DataView(new ArrayBuffer(22));
    const count = Object.keys(files).length;
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, count, true);
    end.setUint16(10, count, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob(local.concat(central, [new Uint8Array(end.buffer)]));
  }

  Sim.zip = { open: open, write: write, parseXml: parseXml, decode: decode };
})();
