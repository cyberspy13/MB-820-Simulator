/* Reads the text of the old binary Excel (.xls, 97 to 2003) and Word (.doc, 97 to 2003) formats. */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const DAMAGED = 'This file is damaged and cannot be opened.';
  const LOCKED = 'This file is protected with a password. Open it, remove the password, and upload it again.';
  const END = 0xFFFFFFFA; // sector numbers from here up are markers, not sectors

  /* ---------- the container both formats use ---------- */

  function container(buffer) {
    const view = new DataView(buffer);
    const size = 1 << view.getUint16(30, true);
    const miniSize = 1 << view.getUint16(32, true);
    const miniLimit = view.getUint32(56, true);
    const perSector = size / 4;
    const total = Math.ceil(buffer.byteLength / size);
    const at = function (sector) { return (sector + 1) * size; };

    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
      const s = view.getUint32(76 + i * 4, true);
      if (s < END) fatSectors.push(s);
    }
    let more = view.getUint32(68, true);
    for (let guard = 0; more < END && guard < total; guard++) {
      for (let i = 0; i < perSector - 1; i++) {
        const s = view.getUint32(at(more) + i * 4, true);
        if (s < END) fatSectors.push(s);
      }
      more = view.getUint32(at(more) + (perSector - 1) * 4, true);
    }
    const next = function (sector) {
      const f = fatSectors[Math.floor(sector / perSector)];
      return f === undefined ? END : view.getUint32(at(f) + (sector % perSector) * 4, true);
    };
    const chain = function (start) {
      const parts = [];
      for (let s = start, guard = 0; s < END && guard <= total; s = next(s), guard++) {
        parts.push(new Uint8Array(buffer, at(s), Math.min(size, Math.max(0, buffer.byteLength - at(s)))));
      }
      return join(parts);
    };
    const join = function (parts) {
      const out = new Uint8Array(parts.reduce(function (n, p) { return n + p.length; }, 0));
      let pos = 0;
      parts.forEach(function (p) {
        out.set(p, pos);
        pos += p.length;
      });
      return out;
    };

    const directory = chain(view.getUint32(48, true));
    const dir = new DataView(directory.buffer);
    const entries = new Map();
    let root = null;
    for (let p = 0; p + 128 <= directory.length; p += 128) {
      const length = dir.getUint16(p + 64, true);
      if (!length) continue;
      const name = new TextDecoder('utf-16le').decode(directory.subarray(p, p + Math.max(0, Math.min(64, length) - 2)));
      const e = { type: directory[p + 66], start: dir.getUint32(p + 116, true), size: dir.getUint32(p + 120, true) };
      if (e.type === 5) root = e;
      else if (!entries.has(name)) entries.set(name, e);
    }
    const mini = root ? chain(root.start) : new Uint8Array(0);
    const miniFat = chain(view.getUint32(60, true));
    const miniView = new DataView(miniFat.buffer);

    return {
      has: function (name) { return entries.has(name); },
      stream: function (name) {
        const e = entries.get(name);
        if (!e) return null;
        if (e.size >= miniLimit) return chain(e.start).slice(0, e.size);
        const parts = [];
        for (let s = e.start, guard = 0; s < END && guard * miniSize <= e.size + miniSize; guard++) {
          parts.push(mini.subarray(s * miniSize, (s + 1) * miniSize));
          s = s * 4 + 4 <= miniFat.length ? miniView.getUint32(s * 4, true) : END;
        }
        return join(parts).slice(0, e.size);
      }
    };
  }

  /* ---------- Excel ---------- */

  // Reads text that may run over into "continue" records.
  function segments(list) {
    let n = 0;
    let p = 0;
    const roll = function () {
      while (n < list.length && p >= list[n].length) {
        n++;
        p = 0;
      }
    };
    const byte = function () {
      roll();
      if (n >= list.length) throw new Error(DAMAGED);
      return list[n][p++];
    };
    const u16 = function () { const a = byte(); return a | (byte() << 8); };
    const u32 = function () { const a = u16(); return (a | (u16() << 16)) >>> 0; };
    return {
      done: function () {
        roll();
        return n >= list.length;
      },
      u32: u32,
      text: function () {
        let left = u16();
        const flags = byte();
        let wide = flags & 1;
        const runs = flags & 8 ? u16() : 0;
        const extra = flags & 4 ? u32() : 0;
        let out = '';
        while (left > 0) {
          if (p >= list[n].length) {
            roll();
            if (n >= list.length) throw new Error(DAMAGED);
            wide = list[n][p++] & 1; // each continued part says again how wide its letters are
          }
          out += String.fromCharCode(wide ? list[n][p] | (list[n][p + 1] << 8) : list[n][p]);
          p += wide ? 2 : 1;
          left--;
        }
        for (let i = 0; i < runs * 4 + extra; i++) byte();
        return out;
      }
    };
  }

  function rkNumber(rk) {
    let n;
    if (rk & 2) {
      n = rk >> 2;
    } else {
      const b = new DataView(new ArrayBuffer(8));
      b.setUint32(4, rk & 0xFFFFFFFC, true);
      n = b.getFloat64(0, true);
    }
    return rk & 1 ? n / 100 : n;
  }

  function shortText(data, at, wideLength) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const length = wideLength ? view.getUint16(at, true) : data[at];
    const p = at + (wideLength ? 2 : 1);
    const wide = data[p] & 1;
    return new TextDecoder(wide ? 'utf-16le' : 'windows-1252').decode(data.subarray(p + 1, p + 1 + length * (wide ? 2 : 1)));
  }

  function xls(file) {
    const stream = file.stream('Workbook');
    if (!stream) throw new Error('This Excel file is from before 1997. Open it in Excel, save it as .xlsx, and upload that.');
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    const records = [];
    const positions = new Map();
    for (let p = 0; p + 4 <= stream.length;) {
      const type = view.getUint16(p, true);
      const length = view.getUint16(p + 2, true);
      positions.set(p, records.length);
      records.push({ type: type, data: stream.subarray(p + 4, p + 4 + length) });
      p += 4 + length;
    }
    if (records.some(function (r) { return r.type === 0x2F; })) throw new Error(LOCKED);

    let shared = [];
    const sheets = [];
    const formats = new Map();
    const styles = [];
    records.forEach(function (r, i) {
      const v = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      if (r.type === 0x85) sheets.push({ at: v.getUint32(0, true), hidden: r.data[4] & 3, kind: r.data[5], name: shortText(r.data, 6, false) });
      else if (r.type === 0x41E) formats.set(v.getUint16(0, true), shortText(r.data, 2, true));
      else if (r.type === 0xE0) styles.push(v.getUint16(2, true));
      else if (r.type === 0xFC) {
        const list = [r.data];
        for (let j = i + 1; j < records.length && records[j].type === 0x3C; j++) list.push(records[j].data);
        const s = segments(list);
        s.u32();
        const count = s.u32();
        for (let n = 0; n < count && !s.done(); n++) shared.push(s.text());
      }
    });

    function number(n, style) {
      const id = styles[style] || 0;
      const code = (formats.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
      if (id === 9 || id === 10 || /%/.test(code)) return Number((n * 100).toPrecision(12)) + '%';
      if (((id >= 14 && id <= 22) || (/[yd]/i.test(code) && !/[#0]/.test(code))) && n > 0) return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
      return String(Number(n.toPrecision(15)));
    }

    const tables = [];
    sheets.filter(function (s) { return !s.hidden && s.kind === 0; }).forEach(function (s) {
      const rows = [];
      const put = function (row, col, text) {
        if (row > 50000 || col > 200) return;
        rows[row] = rows[row] || [];
        rows[row][col] = { text: text.replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/^\n+|\s+$/g, ''), imgs: [], bold: false, highlight: false };
      };
      let waiting = null;
      for (let i = positions.get(s.at) + 1; i < records.length && records[i].type !== 0x0A; i++) {
        const r = records[i];
        if (r.data.length < 6 && r.type !== 0x207) continue;
        const v = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        const row = r.data.length >= 4 ? v.getUint16(0, true) : 0;
        const col = r.data.length >= 4 ? v.getUint16(2, true) : 0;
        if (r.type === 0xFD) put(row, col, shared[v.getUint32(6, true)] || '');
        else if (r.type === 0x204 || r.type === 0xD6) put(row, col, shortText(r.data, 6, true));
        else if (r.type === 0x203) put(row, col, number(v.getFloat64(6, true), v.getUint16(4, true)));
        else if (r.type === 0x27E) put(row, col, number(rkNumber(v.getInt32(6, true)), v.getUint16(4, true)));
        else if (r.type === 0xBD) {
          for (let n = 0; 4 + n * 6 + 6 <= r.data.length - 2; n++) put(row, col + n, number(rkNumber(v.getInt32(6 + n * 6, true)), v.getUint16(4 + n * 6, true)));
        } else if (r.type === 0x205) {
          if (!r.data[7]) put(row, col, r.data[6] ? 'TRUE' : 'FALSE');
        } else if (r.type === 0x06) {
          if (r.data[12] === 0xFF && r.data[13] === 0xFF) {
            if (r.data[6] === 0) waiting = [row, col];
            else if (r.data[6] === 1) put(row, col, r.data[8] ? 'TRUE' : 'FALSE');
          } else put(row, col, number(v.getFloat64(6, true), v.getUint16(4, true)));
        } else if (r.type === 0x207 && waiting) {
          put(waiting[0], waiting[1], shortText(r.data, 0, true));
          waiting = null;
        }
      }
      tables.push({ name: s.name, rows: Sim.office.square(rows) });
    });
    return { tables: tables, images: {}, unsupported: 0 };
  }

  /* ---------- Word ---------- */

  function doc(file) {
    const main = file.stream('WordDocument');
    const view = new DataView(main.buffer, main.byteOffset, main.byteLength);
    if (view.getUint16(0, true) !== 0xA5EC || view.getUint16(2, true) < 0x00C1) throw new Error('This Word file is from before 1997. Open it in Word, save it as .docx, and upload that.');
    const flags = view.getUint16(10, true);
    if (flags & 0x0100) throw new Error(LOCKED);
    const table = file.stream(flags & 0x0200 ? '1Table' : '0Table');
    if (!table) throw new Error(DAMAGED);
    const t = new DataView(table.buffer, table.byteOffset, table.byteLength);
    let p = view.getUint32(0x01A2, true);
    const end = p + view.getUint32(0x01A6, true);
    const bodyLength = view.getUint32(0x4C, true);
    let text = '';
    while (p < end && table[p] === 1) p += 3 + t.getUint16(p + 1, true);
    if (table[p] !== 2) throw new Error(DAMAGED);
    const bytes = t.getUint32(p + 1, true);
    const count = (bytes - 4) / 12;
    const start = p + 5;
    for (let n = 0; n < count; n++) {
      const from = t.getUint32(start + n * 4, true);
      const length = t.getUint32(start + n * 4 + 4, true) - from;
      const fc = t.getUint32(start + (count + 1) * 4 + n * 8 + 2, true);
      const narrow = (fc & 0x40000000) !== 0;
      const at = fc & 0x3FFFFFFF;
      text += narrow ? new TextDecoder('windows-1252').decode(main.subarray(at / 2, at / 2 + length)) : new TextDecoder('utf-16le').decode(main.subarray(at, at + length * 2));
    }
    text = text.slice(0, bodyLength);

    // Field codes sit between marks 13 and 14; what they show sits between 14 and 15.
    let clean = '';
    let hidden = 0;
    let pictures = 0;
    for (const c of text) {
      const code = c.charCodeAt(0);
      if (code === 0x13) hidden++;
      else if (code === 0x14 || code === 0x15) hidden = Math.max(0, hidden - (code === 0x14 || hidden ? 1 : 0));
      else if (hidden) continue;
      else if (code === 0x01 || code === 0x08) pictures++;
      else if (code === 0x0B) clean += '\n';
      else if (code === 0x1E) clean += '-';
      else if (code === 0x1F || code === 0x0C) continue;
      else clean += c;
    }

    const blocks = [];
    const para = function (t2) {
      return t2.split('\n').map(function (line) {
        const body = line.replace(/\t/g, '    ').replace(/ /g, ' ').replace(/[\u0000-\u0008\u000E-\u001F]/g, '');
        return { k: 'p', text: body.trim(), indent: body.length - body.trimStart().length };
      });
    };
    let rows = [];
    let row = [];
    const endTable = function () {
      if (rows.length) blocks.push.apply(blocks, Sim.office.tableBlocks(Sim.office.square(rows).map(function (r) {
        return r.map(function (c) { return c.blocks ? c : Object.assign(c, { blocks: [] }); });
      })));
      rows = [];
    };
    // A cell ends with mark 7, and so does each row, which leaves an empty cell at the end.
    clean.split('\r').forEach(function (chunk) {
      const cells = chunk.split('\u0007');
      const lastPart = cells.pop();
      cells.forEach(function (c) {
        if (c === '' && row.length) {
          rows.push(row);
          row = [];
        } else {
          const made = (row.open || []).concat(para(c));
          row.open = [];
          row.push(Sim.office.cellOf(made));
        }
      });
      if (row.length) {
        row.open = (row.open || []).concat(para(lastPart));
      } else {
        endTable();
        blocks.push.apply(blocks, para(lastPart));
      }
    });
    endTable();
    return { blocks: blocks, images: {}, unsupported: pictures };
  }

  function open(buffer) {
    let file;
    try {
      file = container(buffer);
    } catch (err) {
      throw new Error(DAMAGED);
    }
    if (file.has('EncryptedPackage')) throw new Error(LOCKED);
    try {
      if (file.has('Workbook') || file.has('Book')) return xls(file);
      if (file.has('WordDocument')) return doc(file);
    } catch (err) {
      throw /^This /.test(err.message) ? err : new Error(DAMAGED);
    }
    if (file.has('PowerPoint Document')) throw new Error('This is the old PowerPoint format (.ppt). Save it as .pptx and upload that.');
    throw new Error('This file type is not supported.');
  }

  Sim.legacy = { open: open };
})();
