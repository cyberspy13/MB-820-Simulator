/*
 * Reads a PDF into blocks for the parser: rebuilds lines and paragraphs from text positions,
 * drops watermarks, page headers and page numbers, and cuts out the pictures.
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const VENDOR = 'vendor/pdfjs/';
  const SPACE_EM = 0.278; // width of a space in common sans fonts, used to turn x offsets into indents

  let loading = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Loading the worker as a plain script makes pdf.js run it in the page, because browsers
  // refuse to start a worker when the app is opened straight from disk (file://).
  function loadPdfJs() {
    if (!loading) {
      loading = loadScript(VENDOR + 'pdf.worker.min.js').then(function () {
        return loadScript(VENDOR + 'pdf.min.js');
      }).then(function () {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.js';
        return window.pdfjsLib;
      });
      loading.catch(function () { loading = null; });
    }
    return loading;
  }

  function multiply(a, b) {
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5]
    ];
  }

  /* ---------- text ---------- */

  // Keeps upright text only: rotated text in these files is always a watermark.
  function uprightItems(textItems, viewportTransform) {
    const out = [];
    for (const it of textItems) {
      if (typeof it.str !== 'string' || !it.str.trim()) continue;
      const m = multiply(viewportTransform, it.transform);
      const size = Math.hypot(m[2], m[3]);
      if (!size || m[0] <= 0 || Math.abs(m[1]) > size * 0.05 || Math.abs(m[2]) > size * 0.6) continue;
      const lead = it.str.length - it.str.trimStart().length;
      const shift = Math.min(lead * size * SPACE_EM, Math.max(0, it.width - size * 0.2));
      out.push({ str: it.str.trim(), x: m[4] + shift, right: m[4] + it.width, y: m[5], size: size });
    }
    return out;
  }

  // Groups items that share a baseline, then splits each line where there is a wide gap.
  function buildLines(items) {
    const sorted = items.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    const rows = [];
    for (const it of sorted) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(it.y - last.y) <= Math.max(it.size, last.size) * 0.35) {
        last.items.push(it);
        last.size = Math.max(last.size, it.size);
      } else {
        rows.push({ y: it.y, size: it.size, items: [it] });
      }
    }
    return rows.map(function (r) {
      r.items.sort(function (a, b) { return a.x - b.x; });
      const chunks = [];
      for (const it of r.items) {
        const c = chunks[chunks.length - 1];
        const gap = c ? it.x - c.right : Infinity;
        // A wide gap starts a new column; a change of size means a header or watermark on the same line.
        if (!c || gap > it.size * 2.5 || Math.abs(it.size - c.size) > c.size * 0.15) {
          chunks.push({ text: it.str, x: it.x, right: it.right, size: it.size });
        } else {
          c.text += (gap > it.size * 0.15 ? ' ' : '') + it.str;
          c.right = Math.max(c.right, it.right);
        }
      }
      return { y: r.y, size: r.size, chunks: chunks };
    });
  }

  function pageSize(p) {
    return Math.round(p.width) + 'x' + Math.round(p.height);
  }

  const RE_HEADING = /^[A-Z]{2,3}-\d{3}\b/;

  // Small print in the same place on many pages. Removed before lines are built, because a watermark
  // can lie across a line of the question. Returns the text that was removed.
  function dropSmallPrint(pages) {
    const alike = new Map();
    const count = new Map();
    const key = function (p, it) { return pageSize(p) + '|' + it.str + '|' + Math.round(it.x / 6) + '|' + Math.round(it.y / 6); };
    pages.forEach(function (p) {
      alike.set(pageSize(p), (alike.get(pageSize(p)) || 0) + 1);
      new Set(p.items.map(function (it) { return key(p, it); })).forEach(function (k) { count.set(k, (count.get(k) || 0) + 1); });
    });
    const removed = new Set();
    pages.forEach(function (p) {
      const sizes = p.items.map(function (it) { return it.size; }).sort(function (a, b) { return a - b; });
      const body = sizes[Math.floor(sizes.length / 2)];
      const limit = Math.max(3, alike.get(pageSize(p)) * 0.3);
      p.items = p.items.filter(function (it) {
        const drop = it.str.length >= 6 && it.size < body * 0.85 && count.get(key(p, it)) >= limit;
        if (drop) removed.add(it.str);
        return !drop;
      });
    });
    return Array.from(removed);
  }

  // Text that sits in the same place on many pages is a header, footer or watermark.
  function dropRepeated(pages) {
    const sizes = new Map();
    pages.forEach(function (p) { sizes.set(pageSize(p), (sizes.get(pageSize(p)) || 0) + 1); });
    const key = function (p, c, y) { return pageSize(p) + '|' + c.text + '|' + Math.round(c.x / 8) + '|' + Math.round(y / 8); };
    const count = new Map();
    pages.forEach(function (p) {
      const here = new Set();
      p.lines.forEach(function (l) { l.chunks.forEach(function (c) { here.add(key(p, c, l.y)); }); });
      here.forEach(function (k) { count.set(k, (count.get(k) || 0) + 1); });
    });
    const headings = new Map();
    pages.forEach(function (p) {
      p.lines.forEach(function (l) {
        const edge = l.y < p.height * 0.1 || l.y > p.height * 0.9;
        const alike = sizes.get(pageSize(p));
        const limit = edge ? Math.max(3, alike * 0.3) : Math.max(6, alike * 0.6);
        l.chunks = l.chunks.filter(function (c) {
          if (count.get(key(p, c, l.y)) >= limit && !/^(?:question|correct|answer|explanation|note)\b/i.test(c.text)) {
            headings.set(c.text, (headings.get(c.text) || 0) + 1);
            return false;
          }
          return !(edge && /^(?:Page\s+)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(c.text));
        });
      });
      p.lines = p.lines.filter(function (l) { return l.chunks.length; });
      p.lines.forEach(function (l) {
        l.x = l.chunks[0].x;
        l.right = l.chunks[l.chunks.length - 1].right;
        l.text = l.chunks.map(function (c) { return c.text; }).join('  ');
        l.firstWord = (l.right - l.x) * (l.text.split(' ')[0].length / Math.max(1, l.text.length));
      });
    });
    return Array.from(headings.keys()).find(function (t) { return RE_HEADING.test(t); }) || '';
  }

  function startsNew(text) {
    return /^[^\w"'(<\[{]{0,3}\s*[A-J]\s*[.)](?:\s|$)/.test(text) ||
      /^[-*•·▪●○�#>]\s/.test(text) ||
      /^(?:NEW\s+)?QUESTION\s*[:#]?\s*\d+/i.test(text) ||
      /^(?:Correct\s+)?Answers?\s*:/i.test(text) ||
      /^(?:Explanation|References?)\b\s*:?/.test(text) && text.length < 40 ||
      /^(?:Available choices|Learn more|NOTE)\s*:/i.test(text) ||
      /^\d{1,2}\.\s+(?:—|--)\s/.test(text) ||
      /^[{}]/.test(text);
  }

  // Two columns on one line, unless the first is only a bullet.
  function isTableRow(line) {
    return line.chunks.length > 1 && line.chunks[0].text.length > 2;
  }

  // Lines of code end where they end, and a line indented further is never a continuation.
  function codeBreak(prev, l, samePage) {
    if (/[;{}]$/.test(prev.text)) return true;
    return samePage && l.x > prev.x + l.size * 0.5 && !startsNew(prev.text);
  }

  function joinWrapped(a, b) {
    const tail = a.split(/\s/).pop();
    // A web address broken across two lines goes back together without a space.
    if (/https?:\/\//.test(tail) && !/\)$/.test(tail)) return a + b;
    return a + ' ' + b;
  }

  // Joins lines that were wrapped by the page width, leaving real line breaks alone.
  function buildParagraphs(pages) {
    // The right margin is shared by pages of one size.
    const rights = new Map();
    pages.forEach(function (p) {
      const list = rights.get(pageSize(p)) || [];
      p.lines.forEach(function (l) { list.push(l.right); });
      rights.set(pageSize(p), list);
    });
    rights.forEach(function (list, size) {
      list.sort(function (a, b) { return a - b; });
      rights.set(size, list[Math.floor(list.length * 0.98)]);
    });

    // Line spacing differs between pages. Wrapped lines have the tightest spacing on their page.
    pages.forEach(function (p) {
      p.maxRight = rights.get(pageSize(p));
      let wrapped = Infinity;
      let any = Infinity;
      for (let i = 1; i < p.lines.length; i++) {
        const a = p.lines[i - 1];
        const b = p.lines[i];
        const gap = (b.y - a.y) / b.size;
        if (gap < 1 || Math.abs(a.size - b.size) > b.size * 0.12 || isTableRow(a) || isTableRow(b)) continue;
        any = Math.min(any, gap);
        if (a.right + b.firstWord > p.maxRight && !startsNew(b.text)) wrapped = Math.min(wrapped, gap);
      }
      p.wrapGap = wrapped < Infinity ? wrapped : any < Infinity ? any : 1.25;
    });

    let prev = null;
    let para = null;
    let inAnswer = false;
    pages.forEach(function (p) {
      p.paras = [];
      p.lines.forEach(function (l, i) {
        const samePage = i > 0;
        let joins = false;
        if (para && !isTableRow(prev) && !isTableRow(l) && !startsNew(l.text) && Math.abs(l.size - prev.size) < prev.size * 0.12 && !codeBreak(prev, l, samePage)) {
          // After a full stop, a capital may start a new paragraph, so the word must really not have fitted.
          // An open bracket means the text, probably code, goes on.
          const open = para.text.split('(').length > para.text.split(')').length;
          const sentence = !open && /[.?:!]$/.test(prev.text) && /^["“'A-Z0-9]/.test(l.text);
          const full = prev.right + l.firstWord > prev.maxRight - (sentence ? 0 : l.size * 1.5);
          const gap = (l.y - prev.y) / l.size;
          // Inside an answer, each sentence that starts a line is its own step or row.
          if (inAnswer && sentence) joins = false;
          else if (samePage) joins = full && gap <= p.wrapGap * 1.09;
          else joins = full && (!/[.?:;!)}]$/.test(prev.text) || /^[a-z]/.test(l.text));
        }
        if (joins) {
          para.text = joinWrapped(para.text, l.text);
        } else {
          para = { k: 'p', text: l.text, x: l.x, y: l.y, size: l.size, page: p.index };
          p.paras.push(para);
        }
        if (/^(?:Correct\s+)?Answers?\s*:/i.test(l.text)) inAnswer = true;
        else if (/^(?:Explanation\b|Question\s*:?\s*\d)/i.test(l.text)) inAnswer = false;
        prev = l;
        prev.maxRight = p.maxRight;
      });
    });
  }

  // Where a picture belongs in reading order. One standing to the right of "Answer:" on the same
  // baseline comes after it, even though its top edge is higher up the page.
  function imagePosition(rect, paras) {
    const bottom = rect.y + rect.h;
    const label = paras.find(function (b) {
      return /^(?:Correct\s+)?Answers?\s*:$/i.test(b.text) && rect.x >= b.x + b.size * 4 &&
        b.y > rect.y && b.y < bottom + b.size * 0.6;
    });
    return label ? label.y + 0.5 : rect.y + 1;
  }

  // Indents are measured from the left edge of the nearest question, answer or explanation.
  function setIndents(blocks) {
    let run = [];
    function flush() {
      const xs = run.map(function (b) { return b.x; });
      const left = xs.length ? Math.min.apply(null, xs) : 0;
      run.forEach(function (b) { b.indent = Math.max(0, Math.round((b.x - left) / (b.size * SPACE_EM))); });
      run = [];
    }
    let page = -1;
    blocks.forEach(function (b) {
      if (b.k !== 'p') return;
      if (b.page !== page || /^(?:Question\s*:?\s*\d+|QUESTION\s+\d+|(?:Correct\s+)?Answers?\s*:|Explanation\b)/.test(b.text)) flush();
      page = b.page;
      run.push(b);
    });
    flush();
  }

  /* ---------- pictures ---------- */

  function imageRects(ops, OPS, viewport) {
    const rects = [];
    const stack = [];
    let m = [1, 0, 0, 1, 0, 0];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === OPS.save) {
        stack.push(m);
      } else if (fn === OPS.restore) {
        m = stack.pop() || m;
      } else if (fn === OPS.transform) {
        m = multiply(m, args);
      } else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(m);
        if (args && Array.isArray(args[0])) m = multiply(m, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) {
        m = stack.pop() || m;
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
        const full = multiply(viewport.transform, m);
        const xs = [];
        const ys = [];
        [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (c) {
          xs.push(full[0] * c[0] + full[2] * c[1] + full[4]);
          ys.push(full[1] * c[0] + full[3] * c[1] + full[5]);
        });
        const x = Math.max(0, Math.min.apply(null, xs));
        const y = Math.max(0, Math.min.apply(null, ys));
        const w = Math.min(viewport.width, Math.max.apply(null, xs)) - x;
        const h = Math.min(viewport.height, Math.max.apply(null, ys)) - y;
        const pixels = fn === OPS.paintImageXObject ? args[1] : (args[0] && args[0].width);
        if (w < 20 || h < 8 || w * h < 400) continue;
        if (w > viewport.width * 0.9 && h > viewport.height * 0.9) continue;
        rects.push({ x: x, y: y, w: w, h: h, pixels: pixels || w, sig: (pixels || 0) + ':' + Math.round(w) + 'x' + Math.round(h) });
      }
    }
    // Some files slice one picture into strips. Put the strips back together.
    rects.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    const merged = [];
    rects.forEach(function (r) {
      const p = merged[merged.length - 1];
      if (p && Math.abs(p.x - r.x) < 1 && Math.abs(p.w - r.w) < 1 && Math.abs(p.y + p.h - r.y) < 1.5) p.h = r.y + r.h - p.y;
      else merged.push(r);
    });
    return merged;
  }

  function dropRepeatedImages(pages) {
    const key = function (r) { return [r.x, r.y, r.w, r.h].map(function (n) { return Math.round(n / 4); }).join(','); };
    const count = new Map();
    pages.forEach(function (p) {
      new Set(p.rects.map(key)).forEach(function (k) { count.set(k, (count.get(k) || 0) + 1); });
    });
    const limit = Math.max(3, pages.length * 0.3);
    pages.forEach(function (p) {
      p.rects = p.rects.filter(function (r) { return count.get(key(r)) < limit; });
    });
  }

  function hash(text) {
    let a = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
    return (a >>> 0).toString(36) + text.length.toString(36);
  }

  async function cutImages(doc, page, images) {
    const pdfPage = await doc.getPage(page.index + 1);
    const ratio = Math.max.apply(null, page.rects.map(function (r) { return r.pixels / r.w; }));
    const scale = Math.min(3, Math.max(1.5, ratio));
    const viewport = pdfPage.getViewport({ scale: scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvasContext: ctx, viewport: viewport }).promise;
    page.rects.forEach(function (r) {
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(r.w * scale));
      out.height = Math.max(1, Math.round(r.h * scale));
      out.getContext('2d').drawImage(canvas, Math.round(r.x * scale), Math.round(r.y * scale), out.width, out.height, 0, 0, out.width, out.height);
      let url = out.toDataURL('image/png');
      if (url.length > 600000) {
        const smaller = out.toDataURL('image/webp', 0.92);
        if (smaller.length < url.length) url = smaller;
      }
      r.ref = 'img-' + hash(url);
      images[r.ref] = { url: url, w: Math.round(r.w) };
    });
    pdfPage.cleanup();
  }

  function pause() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  /* ---------- entry point ---------- */

  async function read(data, onProgress) {
    const lib = await loadPdfJs();
    let doc;
    try {
      // isEvalSupported is off so a crafted font in an uploaded PDF cannot run code.
      doc = await lib.getDocument({ data: new Uint8Array(data), isEvalSupported: false, verbosity: 0 }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') throw new Error('This PDF needs a password to open. Save a copy without one and upload that.');
      throw new Error('This file could not be opened as a PDF.');
    }
    const pages = [];
    const images = {};
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        const text = await page.getTextContent();
        const ops = await page.getOperatorList();
        pages.push({
          index: n - 1,
          width: viewport.width,
          height: viewport.height,
          items: uprightItems(text.items, viewport.transform),
          rects: imageRects(ops, lib.OPS, viewport)
        });
        page.cleanup();
        onProgress(n / doc.numPages * 0.7, 'Reading page ' + n + ' of ' + doc.numPages);
        if (n % 4 === 0) await pause();
      }
      const small = dropSmallPrint(pages);
      pages.forEach(function (p) {
        p.lines = buildLines(p.items);
        p.items = null;
      });
      const heading = dropRepeated(pages) || small.find(function (t) { return RE_HEADING.test(t); }) || '';
      dropRepeatedImages(pages);
      if (!pages.some(function (p) { return p.lines.length; })) {
        throw new Error('This PDF has no readable text. It is probably a scan.');
      }
      buildParagraphs(pages);

      const withImages = pages.filter(function (p) { return p.rects.length; });
      for (let i = 0; i < withImages.length; i++) {
        await cutImages(doc, withImages[i], images);
        onProgress(0.7 + (i + 1) / withImages.length * 0.3, 'Saving pictures');
        await pause();
      }

      const blocks = [];
      pages.forEach(function (p) {
        const marks = p.paras.map(function (b) { return { y: b.y, block: b }; });
        p.rects.forEach(function (r) { marks.push({ y: imagePosition(r, p.paras), block: { k: 'img', ref: r.ref, sig: r.sig } }); });
        marks.sort(function (a, b) { return a.y - b.y; });
        marks.forEach(function (m) { blocks.push(m.block); });
      });
      setIndents(blocks);
      return { blocks: blocks, images: images, heading: heading, pages: doc.numPages };
    } finally {
      doc.destroy();
    }
  }

  Sim.pdf = { read: read, uprightItems: uprightItems, buildLines: buildLines, dropRepeated: dropRepeated, buildParagraphs: buildParagraphs, setIndents: setIndents, imagePosition: imagePosition, dropSmallPrint: dropSmallPrint };
})();
