/*
 * Reads Word, PowerPoint and OpenDocument text into blocks, and Excel and OpenDocument sheets into rows.
 * A block is { k: 'p', text, indent, bold, highlight, underline, code, heading } or { k: 'img', ref } or
 * { k: 'table', rows }. A row is a list of cells { text, imgs, bold, highlight }.
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const PICTURES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  const RE_MONO = /consol|courier|mono|cascadia|lucida console|menlo/i;
  const EMU_PER_POINT = 12700;

  /* ---------- XML helpers: prefixes differ between programs, so only local names are used ---------- */

  function kids(el, name) {
    if (!el) return [];
    return Array.from(el.children).filter(function (c) { return !name || c.localName === name; });
  }

  function kid(el, name) {
    return kids(el, name)[0] || null;
  }

  function all(el, name) {
    return el ? Array.from(el.getElementsByTagNameNS('*', name)) : [];
  }

  function attr(el, name) {
    if (!el) return null;
    for (const a of el.attributes) if (a.localName === name) return a.value;
    return null;
  }

  function on(el) {
    if (!el) return false;
    const v = attr(el, 'val');
    return v === null || !/^(?:0|false|off|none)$/i.test(v);
  }

  function resolve(part, target) {
    if (target.charAt(0) === '/') return target.slice(1);
    const path = part.split('/').slice(0, -1);
    target.split('/').forEach(function (p) {
      if (p === '..') path.pop();
      else if (p !== '.') path.push(p);
    });
    return path.join('/');
  }

  async function relations(zip, part) {
    const at = part.lastIndexOf('/');
    const doc = await zip.xml(part.slice(0, at + 1) + '_rels/' + part.slice(at + 1) + '.rels');
    const map = new Map();
    all(doc, 'Relationship').forEach(function (r) {
      if (attr(r, 'TargetMode') === 'External') return;
      map.set(attr(r, 'Id'), { type: (attr(r, 'Type') || '').split('/').pop(), target: resolve(part, attr(r, 'Target') || '') });
    });
    return map;
  }

  async function mainPart(zip, fallback) {
    const rels = await relations(zip, '');
    for (const r of rels.values()) if (r.type === 'officeDocument') return r.target;
    return fallback;
  }

  /* ---------- pictures ---------- */

  function pictures(zip) {
    const images = {};
    const known = new Map();
    const bag = { images: images, unsupported: 0 };
    bag.add = async function (path, width) {
      if (!known.has(path)) {
        const ext = path.split('.').pop().toLowerCase();
        const data = PICTURES[ext] ? await zip.bytes(path) : null;
        if (!data) {
          if (zip.has(path)) bag.unsupported++;
          known.set(path, null);
        } else {
          const ref = 'img-' + known.size + '-' + data.length.toString(36);
          images[ref] = { url: await dataUrl(data, PICTURES[ext]), w: width || 0 };
          known.set(path, ref);
        }
      }
      const ref = known.get(path);
      if (ref && width && !images[ref].w) images[ref].w = width;
      return ref;
    };
    return bag;
  }

  function dataUrl(data, type) {
    return new Promise(function (resolvePromise, reject) {
      const r = new FileReader();
      r.onload = function () { resolvePromise(r.result); };
      r.onerror = function () { reject(new Error('A picture in this file could not be read.')); };
      r.readAsDataURL(new Blob([data], { type: type }));
    });
  }

  function finishImages(bag) {
    Object.keys(bag.images).forEach(function (ref) { if (!bag.images[ref].w) bag.images[ref].w = 360; });
    return bag.images;
  }

  /* ---------- list numbers ---------- */

  function roman(n) {
    const steps = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let out = '';
    steps.forEach(function (s) {
      while (n >= s[0]) {
        out += s[1];
        n -= s[0];
      }
    });
    return out;
  }

  function letters(n) {
    const c = String.fromCharCode(97 + (n - 1) % 26);
    return c.repeat(Math.floor((n - 1) / 26) + 1);
  }

  function formatNumber(n, format) {
    if (/^(?:upperLetter|A|alphaUc)/.test(format)) return letters(n).toUpperCase();
    if (/^(?:lowerLetter|a|alphaLc)/.test(format)) return letters(n);
    if (/^(?:upperRoman|I|romanUc)/.test(format)) return roman(n).toUpperCase();
    if (/^(?:lowerRoman|i|romanLc)/.test(format)) return roman(n);
    if (format === 'decimalZero' && n < 10) return '0' + n;
    return String(n);
  }

  /* ---------- paragraphs ---------- */

  // Collects text and pictures in order and turns them into blocks, one per line.
  function collector() {
    const parts = [];
    let text = '';
    const runs = [];
    return {
      add: function (t, style) {
        text += t;
        const label = (style && style.label) || (!runs.length && /^\s*(?:\(?[A-Za-z]|\(?\d{1,3})[.)]\s*$|^\s*[•·o§]\s*$/.test(t));
        if (t.trim() && !label) runs.push(style || {});
      },
      image: function (ref) {
        if (text) parts.push(text);
        text = '';
        if (ref) parts.push({ ref: ref });
      },
      blocks: function (label, extra) {
        if (text || !parts.length) parts.push(text);
        const every = function (key) { return runs.length > 0 && runs.every(function (r) { return r[key]; }); };
        const look = Object.assign({
          bold: every('bold'), highlight: every('highlight'), underline: every('underline'), code: every('code')
        }, extra);
        const out = [];
        let first = true;
        parts.forEach(function (p) {
          if (typeof p !== 'string') {
            out.push({ k: 'img', ref: p.ref });
            return;
          }
          p.split('\n').forEach(function (line) {
            const clean = line.replace(/[​‌‍﻿­]/g, '').replace(/ /g, ' ').replace(/\t/g, '    ');
            let body = clean.trim();
            if (first && label) body = (label + ' ' + body).trim();
            first = false;
            out.push(Object.assign({ k: 'p', text: body, indent: label ? 0 : clean.length - clean.trimStart().length }, look));
          });
        });
        return out;
      }
    };
  }

  function greenish(hex) {
    if (!/^[0-9a-f]{6}$/i.test(hex || '')) return false;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return g > 90 && g > r * 1.35 && g > b * 1.35;
  }

  function filled(hex) {
    return /^[0-9a-f]{6}$/i.test(hex || '') && !/^(?:ffffff|f[0-9a-f]f[0-9a-f]f[0-9a-f])$/i.test(hex);
  }

  function cellOf(blocks) {
    const texts = blocks.filter(function (b) { return b.k === 'p'; });
    const solid = texts.filter(function (b) { return b.text; });
    const every = function (key) { return solid.length > 0 && solid.every(function (b) { return b[key]; }); };
    return {
      text: texts.map(function (b) { return ' '.repeat(Math.min(40, b.indent || 0)) + b.text; }).join('\n').replace(/^\n+|\s+$/g, ''),
      imgs: blocks.filter(function (b) { return b.k === 'img'; }).map(function (b) { return b.ref; }),
      bold: every('bold'),
      highlight: every('highlight'),
      blocks: blocks
    };
  }

  // A table of questions is kept as a table. Any other table is read row by row, as a person would.
  function tableBlocks(rows) {
    if (Sim.tables.looksLikeQuestions(rows)) return [{ k: 'table', rows: rows }];
    const out = [];
    rows.forEach(function (row) {
      const full = row.filter(function (c) { return c.text || c.imgs.length; });
      if (!full.length) return;
      const head = full[0].text.trim();
      const rest = full.slice(1);
      if (full.length > 1 && /^\(?[A-Ja-j]\)?[.):]?$/.test(head)) {
        out.push({ k: 'p', text: head.replace(/[^A-Za-z]/g, '').toUpperCase() + '. ' + rest.map(function (c) { return c.text.replace(/\n/g, ' '); }).join('  '), bold: rest[0].bold, highlight: rest[0].highlight || full[0].highlight });
        rest.forEach(function (c) { c.imgs.forEach(function (ref) { out.push({ k: 'img', ref: ref }); }); });
      } else if (full.length === 2 && /^(?:question|q|(?:correct |right )?answers?|explanation|rationale|feedback|reference|section|topic|category|stem)\s*(?:no\.?|#)?\s*\d*\s*:?$/i.test(head)) {
        out.push({ k: 'p', text: head.replace(/\s*:?$/, '') + ':' });
        rest[0].blocks.forEach(function (b) { out.push(b); });
      } else if (full.length === 1 || full.some(function (c) { return c.imgs.length || c.text.indexOf('\n') >= 0; })) {
        full.forEach(function (c) { c.blocks.forEach(function (b) { out.push(b); }); });
      } else {
        out.push({ k: 'p', text: full.map(function (c) { return c.text.trim(); }).join('  ') });
      }
    });
    return out;
  }

  /* ---------- Word ---------- */

  async function wordStyles(zip) {
    const map = new Map();
    all(await zip.xml('word/styles.xml'), 'style').forEach(function (s) {
      const pPr = kid(s, 'pPr');
      const rPr = kid(s, 'rPr');
      const numPr = kid(pPr, 'numPr');
      const fonts = kid(rPr, 'rFonts');
      map.set(attr(s, 'styleId'), {
        name: attr(kid(s, 'name'), 'val') || '',
        base: attr(kid(s, 'basedOn'), 'val'),
        num: numPr ? { id: attr(kid(numPr, 'numId'), 'val'), level: attr(kid(numPr, 'ilvl'), 'val') } : null,
        mono: RE_MONO.test(attr(fonts, 'ascii') || '')
      });
    });
    map.look = function (id, key) {
      for (let n = 0; id && n < 12; n++) {
        const s = map.get(id);
        if (!s) return null;
        if (s[key]) return s[key];
        id = s.base;
      }
      return null;
    };
    return map;
  }

  async function wordNumbering(zip) {
    const doc = await zip.xml('word/numbering.xml');
    const abstracts = new Map();
    const nums = new Map();
    const readLevels = function (el) {
      const levels = new Map();
      kids(el, 'lvl').forEach(function (l) {
        levels.set(Number(attr(l, 'ilvl')), {
          start: Number(attr(kid(l, 'start'), 'val') || 1),
          format: attr(kid(l, 'numFmt'), 'val') || 'decimal',
          text: attr(kid(l, 'lvlText'), 'val') || ''
        });
      });
      return levels;
    };
    all(doc, 'abstractNum').forEach(function (a) { abstracts.set(attr(a, 'abstractNumId'), readLevels(a)); });
    all(doc, 'num').forEach(function (n) {
      const starts = new Map();
      const own = new Map();
      kids(n, 'lvlOverride').forEach(function (o) {
        const level = Number(attr(o, 'ilvl'));
        const s = kid(o, 'startOverride');
        if (s) starts.set(level, Number(attr(s, 'val')));
        readLevels(o).forEach(function (v, k) { own.set(k, v); });
      });
      nums.set(attr(n, 'numId'), { abstract: attr(kid(n, 'abstractNumId'), 'val'), starts: starts, own: own });
    });

    const counters = new Map();
    const begun = new Set();
    // Word keeps one counter per list definition; a list with its own start value begins again.
    return function label(numId, level) {
      const num = nums.get(numId);
      const levels = num && abstracts.get(num.abstract);
      if (!levels) return '';
      const at = function (n) { return num.own.get(n) || levels.get(n); };
      const def = at(level);
      if (!def) return '';
      if (!counters.has(num.abstract)) counters.set(num.abstract, []);
      const count = counters.get(num.abstract);
      if (!begun.has(numId)) {
        begun.add(numId);
        num.starts.forEach(function (v, n) { count[n] = v - 1; });
      }
      if (count[level] === undefined) count[level] = def.start - 1;
      count[level]++;
      count.length = level + 1;
      if (def.format === 'bullet') return '•';
      if (def.format === 'none') return '';
      return def.text.replace(/%(\d)/g, function (_, d) {
        const n = Number(d) - 1;
        const other = at(n);
        const value = count[n] === undefined ? (other ? other.start : 1) : count[n];
        return formatNumber(value, other ? other.format : 'decimal');
      }).trim();
    };
  }

  async function docx(buffer) {
    const zip = Sim.zip.open(buffer);
    const part = await mainPart(zip, 'word/document.xml');
    const doc = await zip.xml(part);
    if (!doc) throw new Error('This file is not a Word document.');
    const rels = await relations(zip, part);
    const styles = await wordStyles(zip);
    const label = await wordNumbering(zip);
    const bag = pictures(zip);

    function runStyle(r) {
      const p = kid(r, 'rPr');
      const shade = attr(kid(p, 'shd'), 'fill');
      const mark = kid(p, 'highlight');
      const color = attr(kid(p, 'color'), 'val');
      const under = kid(p, 'u');
      const fonts = kid(p, 'rFonts');
      const styleId = attr(kid(p, 'rStyle'), 'val');
      return {
        bold: on(kid(p, 'b')),
        highlight: (mark && on(mark) && !/^white$/i.test(attr(mark, 'val') || '')) || filled(shade) || greenish(color),
        underline: !!under && on(under),
        code: RE_MONO.test(attr(fonts, 'ascii') || attr(fonts, 'hAnsi') || '') || !!styles.look(styleId, 'mono')
      };
    }

    async function drawing(el, out, boxes) {
      const extent = all(el, 'extent')[0];
      const width = extent ? Math.round(Number(attr(extent, 'cx')) / EMU_PER_POINT) : 0;
      for (const b of all(el, 'blip').concat(all(el, 'imagedata'))) {
        const rel = rels.get(attr(b, 'embed') || attr(b, 'id'));
        if (rel) out.image(await bag.add(rel.target, width));
      }
      all(el, 'txbxContent').forEach(function (t) { boxes.push(t); });
    }

    async function inline(el, out, boxes, style) {
      for (const c of el.children) {
        const n = c.localName;
        if (n === 'r') await inline(c, out, boxes, runStyle(c));
        else if (n === 't') out.add(c.textContent, style);
        else if (n === 'tab') out.add('\t', style);
        else if (n === 'br') {
          if (!/^(?:page|column)$/.test(attr(c, 'type') || '')) out.add('\n', style);
        } else if (n === 'cr') out.add('\n', style);
        else if (n === 'noBreakHyphen') out.add('-', style);
        else if (n === 'sym') {
          const code = (attr(c, 'char') || '').toUpperCase();
          out.add(/FE$|FC$|52$|53$|FD$/.test(code) ? '☑' : /A8$|6F$|2A$|A3$/.test(code) ? '☐' : '•', style);
        } else if (n === 'drawing' || n === 'pict' || n === 'object') await drawing(c, out, boxes);
        else if (n === 'AlternateContent') await inline(kid(c, 'Choice') || c, out, boxes, style);
        else if (n === 'oMath' || n === 'oMathPara') out.add(all(c, 't').map(function (t) { return t.textContent; }).join(''), style);
        else if (/^(?:hyperlink|ins|smartTag|sdt|sdtContent|fldSimple|customXml|moveTo|dir|bdo)$/.test(n)) await inline(c, out, boxes, style);
      }
    }

    async function paragraph(p) {
      const pPr = kid(p, 'pPr');
      const styleId = attr(kid(pPr, 'pStyle'), 'val');
      const direct = kid(pPr, 'numPr');
      const inherited = styles.look(styleId, 'num');
      let numId = direct ? attr(kid(direct, 'numId'), 'val') : null;
      let level = direct ? attr(kid(direct, 'ilvl'), 'val') : null;
      if (numId === null && inherited) {
        numId = inherited.id;
        if (level === null) level = inherited.level;
      }
      const out = collector();
      const boxes = [];
      await inline(p, out, boxes, {});
      const name = (styles.get(styleId) || {}).name || '';
      const blocks = out.blocks(numId && numId !== '0' ? label(numId, Number(level || 0)) : '', {
        heading: /^(?:heading|title|überschrift)/i.test(name)
      });
      if (styles.look(styleId, 'mono')) blocks.forEach(function (b) { b.code = true; });
      if (filled(attr(kid(pPr, 'shd'), 'fill'))) blocks.forEach(function (b) { b.highlight = true; });
      for (const t of boxes) blocks.push.apply(blocks, await walk(t));
      return blocks;
    }

    async function tableRows(tbl) {
      const rows = [];
      for (const tr of kids(tbl).filter(function (c) { return c.localName === 'tr' || c.localName === 'sdt'; })) {
        for (const row of tr.localName === 'tr' ? [tr] : all(tr, 'tr')) {
          const cells = [];
          for (const tc of kids(row).filter(function (c) { return c.localName === 'tc' || c.localName === 'sdt'; })) {
            for (const cell of tc.localName === 'tc' ? [tc] : all(tc, 'tc')) {
              const made = cellOf(await walk(cell));
              if (filled(attr(kid(kid(cell, 'tcPr'), 'shd'), 'fill'))) made.highlight = true;
              cells.push(made);
            }
          }
          rows.push(cells);
        }
      }
      return rows;
    }

    async function walk(container) {
      const out = [];
      for (const c of container.children) {
        const n = c.localName;
        if (n === 'p') out.push.apply(out, await paragraph(c));
        else if (n === 'tbl') out.push.apply(out, tableBlocks(await tableRows(c)));
        else if (n === 'sdt') out.push.apply(out, await walk(kid(c, 'sdtContent') || c));
        else if (n === 'AlternateContent') out.push.apply(out, await walk(kid(c, 'Choice') || c));
        else if (/^(?:ins|smartTag|customXml|moveTo)$/.test(n)) out.push.apply(out, await walk(c));
      }
      return out;
    }

    const body = all(doc, 'body')[0];
    if (!body) throw new Error('This file is not a Word document.');
    const blocks = await walk(body);
    return { blocks: blocks, images: finishImages(bag), unsupported: bag.unsupported };
  }

  /* ---------- Excel ---------- */

  function columnIndex(ref) {
    let n = 0;
    for (const c of ref) n = n * 26 + c.charCodeAt(0) - 64;
    return n - 1;
  }

  async function excelStyles(zip, part) {
    const doc = await zip.xml(resolve(part, 'styles.xml'));
    const formats = new Map();
    all(doc, 'numFmt').forEach(function (f) { formats.set(attr(f, 'numFmtId'), attr(f, 'formatCode') || ''); });
    const fonts = kids(all(doc, 'fonts')[0], 'font').map(function (f) {
      return { bold: on(kid(f, 'b')), green: greenish((attr(kid(f, 'color'), 'rgb') || '').slice(-6)) };
    });
    const fills = kids(all(doc, 'fills')[0], 'fill').map(function (f) {
      const p = kid(f, 'patternFill');
      if (!p || attr(p, 'patternType') !== 'solid') return false;
      const fg = kid(p, 'fgColor');
      return attr(fg, 'rgb') ? filled(attr(fg, 'rgb').slice(-6)) : attr(fg, 'theme') !== null && attr(fg, 'theme') !== '0';
    });
    return kids(all(doc, 'cellXfs')[0], 'xf').map(function (x) {
      const id = attr(x, 'numFmtId') || '0';
      const code = formats.get(id) || '';
      const font = fonts[Number(attr(x, 'fontId') || 0)] || {};
      const n = Number(id);
      const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
      return {
        bold: !!font.bold,
        highlight: !!fills[Number(attr(x, 'fillId') || 0)] || !!font.green,
        percent: n === 9 || n === 10 || /%/.test(bare),
        date: (n >= 14 && n <= 22) || /[yd]/i.test(bare) && !/[#0]/.test(bare)
      };
    });
  }

  function showNumber(raw, style) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    if (style && style.percent) return Number((n * 100).toPrecision(12)) + '%';
    if (style && style.date && n > 0) return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
    return String(Number(n.toPrecision(15)));
  }

  function richText(el) {
    return all(el, 't').filter(function (t) { return t.parentNode.localName !== 'rPh'; }).map(function (t) { return t.textContent; }).join('');
  }

  // Pictures placed inside cells (Excel 365). Returns a function from a cell's "vm" number to a file.
  async function cellPictures(zip) {
    try {
      const meta = await zip.xml('xl/metadata.xml');
      const values = await zip.xml('xl/richData/rdrichvalue.xml');
      const shapes = await zip.xml('xl/richData/rdrichvaluestructure.xml');
      const list = await zip.xml('xl/richData/richValueRel.xml');
      if (!meta || !values || !shapes || !list) return null;
      const rels = await relations(zip, 'xl/richData/richValueRel.xml');
      const targets = all(list, 'rel').map(function (r) { return rels.get(attr(r, 'id')); });
      const keys = all(shapes, 's').map(function (s) { return kids(s, 'k').map(function (k) { return attr(k, 'n'); }); });
      const rich = all(values, 'rv').map(function (rv) {
        const at = (keys[Number(attr(rv, 's'))] || []).indexOf('_rvRel:LocalImageIdentifier');
        const v = at >= 0 ? kids(rv, 'v')[at] : null;
        return v ? targets[Number(v.textContent)] : null;
      });
      const future = kids(all(meta, 'futureMetadata')[0], 'bk').map(function (bk) { return Number(attr(all(bk, 'rvb')[0], 'i')); });
      const cells = kids(all(meta, 'valueMetadata')[0], 'bk').map(function (bk) { return Number(attr(kid(bk, 'rc'), 'v')); });
      return function (vm) {
        const found = rich[future[cells[vm - 1]]];
        return found ? found.target : null;
      };
    } catch (err) {
      return null; // such pictures are optional; the text still imports
    }
  }

  async function xlsx(buffer) {
    const zip = Sim.zip.open(buffer);
    const part = await mainPart(zip, 'xl/workbook.xml');
    const book = await zip.xml(part);
    if (!book || !all(book, 'sheet').length) throw new Error('This file is not an Excel workbook.');
    const rels = await relations(zip, part);
    const shared = all(await zip.xml(resolve(part, 'sharedStrings.xml')), 'si').map(richText);
    const styles = await excelStyles(zip, part);
    const inCell = await cellPictures(zip);
    const bag = pictures(zip);
    const tables = [];

    for (const s of all(book, 'sheet')) {
      if (/hidden/i.test(attr(s, 'state') || '')) continue;
      const rel = rels.get(attr(s, 'id'));
      const doc = rel ? await zip.xml(rel.target) : null;
      if (!doc || rel.type !== 'worksheet') continue;
      const rows = [];
      let rowAt = -1;
      for (const r of all(all(doc, 'sheetData')[0], 'row')) {
        rowAt = attr(r, 'r') ? Number(attr(r, 'r')) - 1 : rowAt + 1;
        if (rowAt > 50000) break;
        const row = [];
        let colAt = -1;
        for (const c of kids(r, 'c')) {
          const ref = /^([A-Z]+)/.exec(attr(c, 'r') || '');
          colAt = ref ? columnIndex(ref[1]) : colAt + 1;
          if (colAt > 200) break;
          const type = attr(c, 't');
          const style = styles[Number(attr(c, 's') || 0)];
          const v = kid(c, 'v');
          let text = '';
          if (type === 's') text = shared[Number(v && v.textContent)] || '';
          else if (type === 'inlineStr') text = richText(kid(c, 'is'));
          else if (type === 'b') text = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'e') text = '';
          else if (type === 'str' || type === 'd') text = v ? v.textContent : '';
          else if (v) text = showNumber(v.textContent, style);
          const cell = { text: text.replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/^\n+|\s+$/g, ''), imgs: [], bold: !!(style && style.bold), highlight: !!(style && style.highlight) };
          if (attr(c, 'vm') && inCell) {
            const path = inCell(Number(attr(c, 'vm')));
            const ref2 = path ? await bag.add(path, 0) : null;
            if (ref2) cell.imgs.push(ref2);
          }
          row[colAt] = cell;
        }
        rows[rowAt] = row;
      }
      await placePictures(zip, rel.target, rows, bag);
      const name = attr(s, 'name') || '';
      tables.push({ name: name, rows: square(rows) });
    }
    return { tables: tables, images: finishImages(bag), unsupported: bag.unsupported };
  }

  // Floating pictures belong to the row they start in.
  async function placePictures(zip, sheet, rows, bag) {
    const rels = await relations(zip, sheet);
    for (const r of rels.values()) {
      if (r.type !== 'drawing') continue;
      const doc = await zip.xml(r.target);
      const inner = await relations(zip, r.target);
      for (const anchor of all(doc, 'twoCellAnchor').concat(all(doc, 'oneCellAnchor'))) {
        const from = kid(anchor, 'from');
        const blip = all(anchor, 'blip')[0];
        const rel = blip ? inner.get(attr(blip, 'embed')) : null;
        if (!from || !rel) continue;
        const ext = all(anchor, 'ext').find(function (e) { return attr(e, 'cx'); });
        const ref = await bag.add(rel.target, ext ? Math.round(Number(attr(ext, 'cx')) / EMU_PER_POINT) : 0);
        if (!ref) continue;
        const row = Number(kid(from, 'row').textContent);
        const col = Number(kid(from, 'col').textContent);
        rows[row] = rows[row] || [];
        rows[row][col] = rows[row][col] || emptyCell();
        rows[row][col].imgs.push(ref);
      }
    }
  }

  function emptyCell() {
    return { text: '', imgs: [], bold: false, highlight: false };
  }

  // Fills the holes so every row has every column.
  function square(rows) {
    const width = rows.reduce(function (m, r) { return Math.max(m, r ? r.length : 0); }, 0);
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = [];
      for (let c = 0; c < width; c++) row.push((rows[i] && rows[i][c]) || emptyCell());
      out.push(row);
    }
    return out;
  }

  /* ---------- PowerPoint ---------- */

  async function pptx(buffer) {
    const zip = Sim.zip.open(buffer);
    const part = await mainPart(zip, 'ppt/presentation.xml');
    const deck = await zip.xml(part);
    if (!deck) throw new Error('This file is not a PowerPoint presentation.');
    const rels = await relations(zip, part);
    const bag = pictures(zip);
    const blocks = [];

    function paragraphs(body) {
      const out = [];
      const counts = [];
      kids(body, 'p').forEach(function (p) {
        const pPr = kid(p, 'pPr');
        const level = Number(attr(pPr, 'lvl') || 0);
        const auto = kid(pPr, 'buAutoNum');
        const text = collector();
        kids(p).forEach(function (c) {
          if (c.localName === 'br') text.add('\n');
          else if (c.localName === 'r' || c.localName === 'fld') {
            const rPr = kid(c, 'rPr');
            const solid = all(kid(rPr, 'solidFill'), 'srgbClr')[0];
            text.add((kid(c, 't') || { textContent: '' }).textContent, {
              bold: attr(rPr, 'b') === '1',
              underline: !!attr(rPr, 'u') && attr(rPr, 'u') !== 'none',
              highlight: !!kid(rPr, 'highlight') || greenish(attr(solid, 'val')),
              code: RE_MONO.test(attr(kid(rPr, 'latin'), 'typeface') || '')
            });
          }
        });
        let label = '';
        if (auto) {
          counts[level] = counts[level] === undefined ? Number(attr(auto, 'startAt') || 1) : counts[level] + 1;
          counts.length = level + 1;
          label = formatNumber(counts[level], attr(auto, 'type') || 'arabic') + '.';
        } else {
          counts.length = level;
        }
        out.push.apply(out, text.blocks(label));
      });
      return out;
    }

    async function shapes(tree, inner) {
      const out = [];
      for (const c of kids(tree)) {
        if (c.localName === 'sp') out.push.apply(out, paragraphs(kid(c, 'txBody')));
        else if (c.localName === 'grpSp') out.push.apply(out, await shapes(c, inner));
        else if (c.localName === 'AlternateContent') out.push.apply(out, await shapes(kid(c, 'Choice') || c, inner));
        else if (c.localName === 'pic') {
          const rel = inner.get(attr(all(c, 'blip')[0], 'embed'));
          const ext = all(kid(c, 'spPr'), 'ext')[0];
          const ref = rel ? await bag.add(rel.target, ext ? Math.round(Number(attr(ext, 'cx')) / EMU_PER_POINT) : 0) : null;
          if (ref) out.push({ k: 'img', ref: ref });
        } else if (c.localName === 'graphicFrame') {
          const tbl = all(c, 'tbl')[0];
          if (tbl) {
            out.push.apply(out, tableBlocks(kids(tbl, 'tr').map(function (tr) {
              return kids(tr, 'tc').map(function (tc) { return cellOf(paragraphs(kid(tc, 'txBody'))); });
            })));
          }
        }
      }
      return out;
    }

    for (const id of all(deck, 'sldId')) {
      const rel = rels.get(Array.from(id.attributes).filter(function (a) { return a.localName === 'id' && a.prefix; }).map(function (a) { return a.value; })[0]);
      const slide = rel ? await zip.xml(rel.target) : null;
      if (!slide) continue;
      const inner = await relations(zip, rel.target);
      blocks.push.apply(blocks, await shapes(all(slide, 'spTree')[0], inner));
      for (const r of inner.values()) {
        if (r.type !== 'notesSlide') continue;
        const notes = await zip.xml(r.target);
        all(notes, 'sp').forEach(function (sp) {
          if (attr(all(sp, 'ph')[0], 'type') === 'body') blocks.push.apply(blocks, paragraphs(kid(sp, 'txBody')));
        });
      }
      blocks.push({ k: 'p', text: '', indent: 0 });
    }
    return { blocks: blocks, images: finishImages(bag), unsupported: bag.unsupported };
  }

  /* ---------- OpenDocument ---------- */

  async function openDocument(buffer) {
    const zip = Sim.zip.open(buffer);
    const doc = await zip.xml('content.xml');
    if (!doc) throw new Error('This file is not an OpenDocument file.');
    const bag = pictures(zip);
    const looks = new Map();
    const lists = new Map();
    [doc, await zip.xml('styles.xml')].forEach(function (d) {
      all(d, 'style').forEach(function (s) {
        const t = kid(s, 'text-properties');
        const p = kid(s, 'paragraph-properties');
        const c = kid(s, 'table-cell-properties');
        const back = (attr(t, 'background-color') || attr(p, 'background-color') || attr(c, 'background-color') || '').replace('#', '');
        looks.set(attr(s, 'name'), {
          bold: /^(?:bold|[6-9]00)$/.test(attr(t, 'font-weight') || ''),
          highlight: filled(back) || greenish((attr(t, 'color') || '').replace('#', '')),
          underline: !!attr(t, 'text-underline-style') && attr(t, 'text-underline-style') !== 'none',
          code: RE_MONO.test(attr(t, 'font-name') || attr(t, 'font-family') || ''),
          list: attr(s, 'list-style-name')
        });
      });
      all(d, 'list-style').forEach(function (l) {
        lists.set(attr(l, 'name'), kids(l).map(function (x) {
          return { bullet: x.localName !== 'list-level-style-number', format: attr(x, 'num-format') || '', suffix: attr(x, 'num-suffix') || '', prefix: attr(x, 'num-prefix') || '', start: Number(attr(x, 'start-value') || 1) };
        }));
      });
    });

    async function inline(el, out, style, boxes) {
      for (const c of el.childNodes) {
        if (c.nodeType === 3) out.add(c.nodeValue.replace(/\s+/g, ' '), style);
        else if (c.nodeType !== 1) continue;
        else if (c.localName === 's') out.add(' '.repeat(Math.min(200, Number(attr(c, 'c') || 1))), style);
        else if (c.localName === 'tab') out.add('\t', style);
        else if (c.localName === 'line-break') out.add('\n', style);
        else if (c.localName === 'span' || c.localName === 'a') await inline(c, out, Object.assign({}, style, trueOnly(looks.get(attr(c, 'style-name')))), boxes);
        else if (c.localName === 'frame') {
          const img = kid(c, 'image');
          const box = kid(c, 'text-box');
          if (box) boxes.push(box);
          else if (img) out.image(await bag.add((attr(img, 'href') || '').replace(/^\.\//, ''), points(attr(c, 'width'))));
        } else if (!/^(?:note|annotation|annotation-end|tracked-changes|bookmark)/.test(c.localName)) await inline(c, out, style, boxes);
      }
    }
    function trueOnly(look) {
      const out = {};
      Object.keys(look || {}).forEach(function (k) { if (look[k]) out[k] = look[k]; });
      return out;
    }
    function points(size) {
      const m = /^([\d.]+)(cm|mm|in|pt|px)$/.exec(size || '');
      return m ? Math.round(Number(m[1]) * { cm: 28.35, mm: 2.835, in: 72, pt: 1, px: 0.75 }[m[2]]) : 0;
    }
    async function paragraph(p, label) {
      const out = collector();
      const boxes = [];
      const look = looks.get(attr(p, 'style-name'));
      await inline(p, out, trueOnly(look), boxes);
      const blocks = out.blocks(label, { heading: p.localName === 'h' });
      for (const b of boxes) blocks.push.apply(blocks, await walk(b, null, 0));
      return blocks;
    }

    const counters = new Map();
    async function list(el, styleName, level) {
      const name = attr(el, 'style-name') || styleName;
      const goesOn = attr(el, 'continue-numbering') === 'true' || attr(el, 'continue-list');
      const key = name + '/' + level;
      const def = (lists.get(name) || [])[level];
      if (!goesOn || !counters.has(key)) counters.set(key, def ? def.start - 1 : 0);
      const out = [];
      for (const item of kids(el)) {
        let label = '';
        if (item.localName === 'list-item') {
          const start = attr(item, 'start-value');
          counters.set(key, start ? Number(start) : counters.get(key) + 1);
          const wraps = kids(item)[0] && kids(item)[0].localName === 'list';
          if (!wraps) for (let deeper = level + 1; deeper < 10; deeper++) counters.delete(name + '/' + deeper);
          if (def && def.bullet) label = '•';
          else if (def && def.format) label = def.prefix + formatNumber(counters.get(key), def.format) + (def.suffix || '.');
        }
        let first = true;
        for (const c of kids(item)) {
          if (c.localName === 'list') {
            // Programs wrap deeper levels in empty items, which must not count.
            if (first) counters.set(key, counters.get(key) - 1);
            out.push.apply(out, await list(c, name, level + 1));
          } else if (c.localName === 'p' || c.localName === 'h') {
            out.push.apply(out, await paragraph(c, first ? label : ''));
          }
          first = false;
        }
      }
      return out;
    }
    async function tableRows(t) {
      const rows = [];
      for (const r of all(t, 'table-row').filter(function (x) { return closest(x, 'table') === t; })) {
        const cells = [];
        for (const c of kids(r).filter(function (x) { return /table-cell$/.test(x.localName); })) {
          const made = cellOf(await walk(c, null, 0));
          const look = looks.get(attr(c, 'style-name'));
          if (look && look.highlight) made.highlight = true;
          if (look && look.bold) made.bold = true;
          const times = made.text || made.imgs.length ? Math.min(60, Number(attr(c, 'number-columns-repeated') || 1)) : Math.min(20, Number(attr(c, 'number-columns-repeated') || 1));
          for (let i = 0; i < times; i++) cells.push(made);
        }
        while (cells.length && !cells[cells.length - 1].text && !cells[cells.length - 1].imgs.length) cells.pop();
        const times = cells.length ? Math.min(200, Number(attr(r, 'number-rows-repeated') || 1)) : 1;
        for (let i = 0; i < times; i++) rows.push(cells);
      }
      return rows;
    }
    function closest(el, name) {
      for (let p = el.parentNode; p; p = p.parentNode) if (p.localName === name) return p;
      return null;
    }
    async function walk(container, styleName, level) {
      const out = [];
      for (const c of kids(container)) {
        if (c.localName === 'p' || c.localName === 'h') out.push.apply(out, await paragraph(c, ''));
        else if (c.localName === 'list') out.push.apply(out, await list(c, styleName, level));
        else if (c.localName === 'table') out.push.apply(out, tableBlocks(square(await tableRows(c)).map(function (row) {
          return row.map(function (cell) { return cell.blocks ? cell : Object.assign(cell, { blocks: [] }); });
        })));
        else if (/^(?:section|text-box|frame|index-body)$/.test(c.localName)) out.push.apply(out, await walk(c, styleName, level));
      }
      return out;
    }

    const sheets = all(doc, 'spreadsheet')[0];
    if (sheets) {
      const tables = [];
      for (const t of kids(sheets, 'table')) tables.push({ name: attr(t, 'name') || '', rows: square(await tableRows(t)) });
      return { tables: tables, images: finishImages(bag), unsupported: bag.unsupported };
    }
    const body = all(doc, 'text')[0] || all(doc, 'presentation')[0];
    if (!body) throw new Error('This OpenDocument file holds neither text nor a spreadsheet.');
    const blocks = [];
    if (body.localName === 'presentation') {
      for (const pageEl of kids(body, 'page')) {
        for (const frame of kids(pageEl, 'frame')) blocks.push.apply(blocks, await walk(frame, null, 0));
        blocks.push({ k: 'p', text: '', indent: 0 });
      }
    } else {
      blocks.push.apply(blocks, await walk(body, null, 0));
    }
    return { blocks: blocks, images: finishImages(bag), unsupported: bag.unsupported };
  }

  // Which Office format a zip holds, whatever the file is called.
  async function open(buffer) {
    const zip = Sim.zip.open(buffer);
    const names = zip.names;
    const has = function (prefix) { return names.some(function (n) { return n.indexOf(prefix) === 0; }); };
    if (has('word/')) return docx(buffer);
    if (has('xl/')) {
      if (names.indexOf('xl/workbook.bin') >= 0) throw new Error('This is a binary Excel file (.xlsb). In Excel choose Save As, pick .xlsx, and upload that.');
      return xlsx(buffer);
    }
    if (has('ppt/')) return pptx(buffer);
    if (names.indexOf('content.xml') >= 0) return openDocument(buffer);
    throw new Error('This file type is not supported.');
  }

  Sim.office = { open: open, tableBlocks: tableBlocks, cellOf: cellOf, collector: collector, formatNumber: formatNumber, dataUrl: dataUrl, square: square, greenish: greenish, filled: filled };
})();
