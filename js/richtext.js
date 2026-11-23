/* Reads web pages (also the ones Word and Excel save) and RTF into the same blocks as office.js. */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};
  const O = Sim.office;

  /* ---------- text files ---------- */

  function decodeText(buffer) {
    const bytes = new Uint8Array(buffer);
    if ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF)) return Sim.zip.decode(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      return new TextDecoder('windows-1252').decode(bytes); // older Windows programs
    }
  }

  /* ---------- web pages ---------- */

  const BLOCK = /^(?:P|DIV|H[1-6]|UL|OL|LI|TABLE|SECTION|ARTICLE|HEADER|FOOTER|MAIN|BLOCKQUOTE|PRE|BODY|FORM|FIELDSET|DL|DT|DD|FIGURE|HR|CENTER)$/;
  const SKIP = /^(?:SCRIPT|STYLE|HEAD|TITLE|NOSCRIPT|TEMPLATE|IFRAME|OBJECT|SVG|META|LINK)$/;

  function html(text) {
    // A parsed document runs no scripts and loads nothing.
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const images = {};
    let count = 0;

    function styleOf(el, style) {
      const css = el.style || {};
      const color = /rgb\((\d+), ?(\d+), ?(\d+)\)/.exec(css.color || '');
      const back = css.backgroundColor || css.background || '';
      const hex = color ? color.slice(1).map(function (n) { return Number(n).toString(16).padStart(2, '0'); }).join('') : '';
      return {
        bold: style.bold || /^(?:B|STRONG)$/.test(el.tagName) || /bold|[6-9]00/.test(css.fontWeight || ''),
        underline: style.underline || /^(?:U|INS)$/.test(el.tagName),
        highlight: style.highlight || el.tagName === 'MARK' || (back !== '' && !/white|255, ?255, ?255|transparent|inherit|initial|none/.test(back)) || O.greenish(hex),
        code: style.code || /^(?:CODE|PRE|KBD|SAMP|TT)$/.test(el.tagName) || /consol|courier|mono/i.test(css.fontFamily || '')
      };
    }

    function inline(node, out, style, pre) {
      node.childNodes.forEach(function (c) {
        if (c.nodeType === 3) out.add(pre ? c.nodeValue : c.nodeValue.replace(/[ \t\r\n]+/g, ' '), style);
        else if (c.nodeType !== 1 || SKIP.test(c.tagName.toUpperCase())) return;
        else if (c.tagName === 'BR') out.add('\n', style);
        else if (c.tagName === 'IMG') {
          const src = c.getAttribute('src') || '';
          if (!/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/.test(src)) return;
          const ref = 'img-h' + (count++);
          images[ref] = { url: src, w: Math.round((Number(c.getAttribute('width')) || 480) * 0.75) };
          out.image(ref);
        } else if (c.tagName === 'INPUT' && /checkbox|radio/i.test(c.type)) out.add(c.hasAttribute('checked') ? '☑ ' : '☐ ', style);
        else inline(c, out, styleOf(c, style), pre);
      });
    }

    function hasBlocks(el) {
      return Array.from(el.children).some(function (c) { return BLOCK.test(c.tagName) || hasBlocks(c); });
    }

    function walk(el, style, label) {
      const out = [];
      let buffer = null;
      let pending = label || '';
      const flush = function () {
        if (!buffer) return;
        const made = buffer.blocks(pending).filter(function (b) { return b.k !== 'p' || b.text; });
        if (made.length) pending = '';
        out.push.apply(out, made);
        buffer = null;
      };
      el.childNodes.forEach(function (c) {
        if (c.nodeType === 1 && SKIP.test(c.tagName.toUpperCase())) return;
        if (c.nodeType === 1 && (BLOCK.test(c.tagName) || hasBlocks(c))) {
          flush();
          const s = styleOf(c, style);
          if (c.tagName === 'TABLE') out.push.apply(out, table(c, s));
          else if (c.tagName === 'OL' || c.tagName === 'UL') out.push.apply(out, list(c, s));
          else if (c.tagName === 'PRE') {
            const text = O.collector();
            inline(c, text, s, true);
            out.push.apply(out, text.blocks(''));
          } else {
            const made = walk(c, s, pending);
            if (made.length) pending = '';
            if (/^H[1-6]$/.test(c.tagName)) made.forEach(function (b) { b.heading = true; });
            out.push.apply(out, made);
          }
        } else {
          buffer = buffer || O.collector();
          const holder = { childNodes: [c] };
          inline(holder, buffer, style, false);
        }
      });
      flush();
      return out;
    }

    function list(el, style) {
      const out = [];
      const type = el.getAttribute('type') || ({ 'upper-alpha': 'A', 'upper-latin': 'A', 'lower-alpha': 'a', 'lower-latin': 'a', 'upper-roman': 'I', 'lower-roman': 'i' })[el.style.listStyleType] || '1';
      let n = Number(el.getAttribute('start') || 1);
      Array.from(el.children).forEach(function (li) {
        if (li.tagName !== 'LI') {
          out.push.apply(out, walk(li, styleOf(li, style), ''));
          return;
        }
        if (li.getAttribute('value')) n = Number(li.getAttribute('value'));
        const label = el.tagName === 'UL' || el.style.listStyleType === 'none' ? (el.tagName === 'UL' ? '•' : '') : O.formatNumber(n, type) + '.';
        n++;
        out.push.apply(out, walk(li, styleOf(li, style), label));
      });
      return out;
    }

    function rowsOf(el, style) {
      const rows = [];
      Array.from(el.rows).forEach(function (tr) {
        rows.push(Array.from(tr.cells).map(function (td) {
          const s = styleOf(td, styleOf(tr, style));
          const cell = O.cellOf(walk(td, s, ''));
          if (td.bgColor && O.filled(td.bgColor.replace('#', ''))) cell.highlight = true;
          return cell;
        }));
      });
      return rows;
    }

    function table(el, style) {
      return O.tableBlocks(O.square(rowsOf(el, style)).map(function (row) {
        return row.map(function (c) { return c.blocks ? c : Object.assign(c, { blocks: [] }); });
      }));
    }

    const blocks = walk(doc.body, {}, '');
    return { blocks: blocks, images: images };
  }

  /* ---------- RTF ---------- */

  const DROP = /^(?:fonttbl|colortbl|stylesheet|info|header\w*|footer\w*|footnote|generator|themedata|colorschememapping|datastore|latentstyles|listtable|listoverridetable|rsidtbl|xmlnstbl|fldinst|pntext|bkmkstart|bkmkend|nonshppict|shpinst|mmathPr|wgrffmtfilter|pgdsctbl|filetbl|revtbl|background)$/;
  const SYMBOLS = { bullet: '•', emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', tab: '\t', line: '\n', emspace: ' ', enspace: ' ' };

  async function rtf(text) {
    const images = {};
    const blocks = [];
    let count = 0;
    const codepage = /\\ansicpg(\d+)/.exec(text);
    let decoder;
    try {
      decoder = new TextDecoder('windows-' + (codepage ? codepage[1] : '1252'));
    } catch (err) {
      decoder = new TextDecoder('windows-1252');
    }
    const monoFonts = new Set();
    const fonts = /\{\\fonttbl([\s\S]*?)\}\s*\}/.exec(text);
    if (fonts) {
      for (const m of fonts[1].matchAll(/\\f(\d+)[^;{}]*?\s([^;{}\\]+);/g)) if (/consol|courier|mono/i.test(m[2])) monoFonts.add(m[1]);
    }
    const colors = [];
    const table = /\{\\colortbl\s*([^}]*)\}/.exec(text);
    if (table) {
      table[1].split(';').forEach(function (c) {
        const part = function (n) { const m = new RegExp('\\\\' + n + '(\\d+)').exec(c); return m ? Number(m[1]).toString(16).padStart(2, '0') : '00'; };
        colors.push(c.trim() ? part('red') + part('green') + part('blue') : '');
      });
    }

    let state = { bold: false, underline: false, highlight: false, code: false, skip: false, pict: null, uc: 1 };
    const stack = [];
    let out = O.collector();
    let bytes = [];
    let jump = 0;
    let row = null;
    let cell = [];
    const pending = [];
    const rows = [];

    function flushBytes() {
      if (!bytes.length) return;
      out.add(decoder.decode(new Uint8Array(bytes)), state);
      bytes = [];
    }
    function add(t) {
      flushBytes();
      if (!state.skip && !state.pict) out.add(t, state);
    }
    function takeParagraph() {
      flushBytes();
      const made = out.blocks('');
      out = O.collector();
      return made;
    }
    function endTable() {
      if (!rows.length) return;
      blocks.push.apply(blocks, O.tableBlocks(O.square(rows.splice(0)).map(function (r) {
        return r.map(function (c) { return c.blocks ? c : Object.assign(c, { blocks: [] }); });
      })));
    }
    function endPicture(pict) {
      const hex = pict.hex;
      if (!pict.type || hex.length < 20) return;
      const data = new Uint8Array(hex.length >> 1);
      for (let i = 0; i < data.length; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16);
      const ref = 'img-r' + (count++);
      out.image(ref);
      pending.push(O.dataUrl(data, pict.type).then(function (url) {
        images[ref] = { url: url, w: pict.width ? Math.round(pict.width / 20) : 360 };
      }));
    }

    const re = /\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|([^\\{}]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[5] === '{') {
        flushBytes();
        stack.push(state);
        state = Object.assign({}, state);
        state.fresh = true;
        continue;
      }
      if (m[5] === '}') {
        flushBytes();
        const done = state;
        state = stack.pop() || state;
        if (done.pict && done.pict !== state.pict) endPicture(done.pict);
        continue;
      }
      if (m[6] !== undefined) {
        let t = m[6].replace(/[\r\n]+/g, '');
        if (state.pict) {
          state.pict.hex += t.replace(/[^0-9a-fA-F]/g, '');
          continue;
        }
        if (jump) {
          const n = Math.min(jump, t.length);
          t = t.slice(n);
          jump -= n;
        }
        if (t) add(t);
        state.fresh = false;
        continue;
      }
      if (m[3] !== undefined) {
        if (jump) jump--;
        else if (!state.skip && !state.pict) bytes.push(parseInt(m[3], 16));
        continue;
      }
      if (m[4] !== undefined) {
        if (m[4] === '*') state.star = true;
        else if (m[4] === '~') add(' ');
        else if (m[4] === '_') add('-');
        else if (m[4] === '\n' || m[4] === '\r') blocks.push.apply(blocks, takeParagraph());
        else if (/[\\{}]/.test(m[4])) add(m[4]);
        continue;
      }
      const word = m[1];
      const value = m[2] === undefined ? null : Number(m[2]);
      if (state.star && state.fresh && !/^(?:shppict|blipuid)$/.test(word)) state.skip = true;
      if (state.fresh && DROP.test(word)) state.skip = true;
      if (state.fresh && word === 'listtext') state.label = true;
      state.fresh = false;
      state.star = false;
      if (word === 'bin') {
        re.lastIndex += value || 0;
        continue;
      }
      if (word === 'pict') state.pict = { hex: '', type: '', width: 0 };
      else if (state.pict) {
        if (word === 'pngblip') state.pict.type = 'image/png';
        else if (word === 'jpegblip') state.pict.type = 'image/jpeg';
        else if (word === 'picwgoal') state.pict.width = value;
      } else if (state.skip) continue;
      else if (word === 'u' && value !== null) {
        add(String.fromCharCode(value < 0 ? value + 65536 : value));
        jump = state.uc;
      } else if (word === 'uc') state.uc = value;
      else if (SYMBOLS[word] !== undefined) add(SYMBOLS[word]);
      else if (word === 'par' || word === 'sect' || word === 'page') {
        if (row) cell.push.apply(cell, takeParagraph());
        else {
          endTable();
          blocks.push.apply(blocks, takeParagraph());
        }
      } else if (word === 'trowd') row = row || [];
      else if (word === 'cell') {
        cell.push.apply(cell, takeParagraph());
        (row = row || []).push(O.cellOf(cell));
        cell = [];
      } else if (word === 'row') {
        if (row) rows.push(row);
        row = null;
      } else if (word === 'pard') {
        if (row && !row.length && !cell.length) row = null;
      } else if (word === 'intbl') row = row || [];
      else if (word === 'plain') Object.assign(state, { bold: false, underline: false, highlight: false, code: false });
      else if (word === 'b') { flushBytes(); state.bold = value !== 0; }
      else if (word === 'ul') { flushBytes(); state.underline = value !== 0; }
      else if (word === 'ulnone') state.underline = false;
      else if (word === 'highlight' || word === 'cb' || word === 'chcbpat') { flushBytes(); state.highlight = !!value && O.filled(colors[value] || ''); }
      else if (word === 'cf') { flushBytes(); if (O.greenish(colors[value] || '')) state.highlight = true; }
      else if (word === 'f') { flushBytes(); state.code = monoFonts.has(String(value)); }
    }
    endTable();
    blocks.push.apply(blocks, takeParagraph());
    await Promise.all(pending);
    return { blocks: blocks, images: images };
  }

  Sim.richtext = { decodeText: decodeText, html: html, rtf: rtf };
})();
