/*
 * Turns a flat list of blocks, in reading order, into questions.
 * A block is { k: 'p', text, indent } or { k: 'img', ref }.
 * Nothing here touches the page or the PDF library, so tests/tests.html can exercise it directly.
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const RE_LETTER_TEXT = /^\(?([A-Ja-j])\s*(?:[.):\]]\)?|\s[-–—])\s+\S/;
  const RE_PAIR = /^(.*\S)\s+(?:—|--|->|=>|→)\s+(\S.*)$/;
  const RE_OPTION = /^[^\w"'(<\[{]{0,3}\s*([A-J])\s*[.)](?:\s+|(?=[A-Z0-9"'\[<])|$)(.*)$/;
  const RE_KIND = /^(?:DRAG\s*(?:AND\s*)?DROP|HOT\s*SPOT|SIMULATION)\s*[-–—]?$/i;
  const RE_BULLET = /^[-*•·▪●○�]\s+(.*)$/;
  const RE_BLANK = /_{4,}/;
  const RE_CODE_HEAD = /^(?:codeunit|page\w*|table\w*|xmlport|query|report\w*|enum\w*|interface|permissionset\w*|profile|schema|group|view|requestpage|layout|area|repeater|field|actions?|dataset|dataitem|column|local|internal|procedure|trigger|controladdin)\b/i;
  const RE_ORDERING = /\bsequence\b|\barrange\b|\b(?:in|what|which) (?:the )?(?:correct |right |proper )?order\b|\bcorrect order\b/i;

  // Case study text must be at least this long, and this much of the shorter question.
  const CASE_MIN_CHARS = 1200;
  const CASE_MIN_SHARE = 0.6;

  const GENERAL = 'General questions';

  function alnum(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // Same wording, ignoring typographic quotes, dashes and spacing. Punctuation still counts.
  function plain(s) {
    return s.replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  }

  function isText(b) {
    return b.k === 'p';
  }

  function isImage(b) {
    return b.k === 'img';
  }

  function unique(list) {
    const seen = new Set();
    return list.filter(function (x) {
      const key = plain(x);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function isProse(text) {
    return text.split(/\s+/).length >= 6 && /[.?:!]$/.test(text) && !/[;{}]/.test(text);
  }

  /* ---------- splitting the file into questions ---------- */

  function parseLetters(text) {
    const t = text.trim().replace(/\band\b/gi, ',').replace(/[.\s,;&]+/g, '');
    if (!/^[A-J]{1,10}$/.test(t)) return null;
    const letters = Array.from(new Set(t.split('')));
    return letters.length === t.length ? letters.sort() : null;
  }

  function splitQuestions(blocks) {
    const L = Sim.layout;
    const out = [];
    let cur = null;
    let part = 'stem';
    let section = '';
    let key = null;
    for (const b of L.prepare(blocks)) {
      if (b.k === 'q') {
        cur = { num: b.num, stem: [], answer: [], expl: [], section: section };
        out.push(cur);
        part = 'stem';
        if (b.text) cur.stem.push(Object.assign({}, b, { k: 'p', heading: false }));
        continue;
      }
      if (b.k === 's') {
        if (b.sticky) section = b.text;
        else if (cur) cur.section = b.text;
        continue;
      }
      if (b.k === 'key') {
        key = b.answers;
        continue;
      }
      if (!cur || b.k === 'table') continue;
      if (isText(b)) {
        const text = b.text.trim();
        if (!text || L.RE_DIAGRAM.test(text)) continue;
        const ans = part === 'stem' || (part === 'expl' && !cur.answer.length) ? L.answerOf(text) : null;
        if (ans !== null) {
          part = 'answer';
          if (ans) cur.answer.push(Object.assign({}, b, { text: ans }));
          continue;
        }
        const ex = part !== 'stem' || (/:/.test(text) && findOptions(cur.stem)) ? L.explanationOf(text) : null;
        if (ex !== null) {
          part = 'expl';
          if (ex) cur.expl.push(Object.assign({}, b, { text: ex }));
          continue;
        }
        if (part === 'answer' && L.RE_REFERENCE.test(text)) part = 'expl';
      }
      // Once a letter answer such as "B, D" has been read, whatever follows explains it.
      if (part === 'answer' && cur.answer.length && isText(cur.answer[0])) {
        const first = cur.answer[0].text;
        if (cur.answer.length === 1 && parseLetters(first)) part = 'expl';
        else if (RE_LETTER_TEXT.test(first) && !(isText(b) && RE_LETTER_TEXT.test(b.text))) part = 'expl';
      }
      cur[part].push(b);
    }
    for (const q of out) {
      q.stem = q.stem.filter(function (b) { return isImage(b) || !RE_KIND.test(b.text.trim()); });
      const last = q.stem[q.stem.length - 1];
      // "Correct Answer:" split over two lines leaves its first word behind.
      if (last && isText(last) && last.text.trim() === 'Correct') q.stem.pop();
      if (key && !q.answer.length && key.has(q.num)) q.answer.push({ k: 'p', text: key.get(q.num), indent: 0 });
    }
    return out;
  }

  /* ---------- case studies ---------- */

  function commonPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }

  function median(list) {
    const s = list.slice().sort(function (a, b) { return a - b; });
    return s[Math.floor((s.length - 1) / 2)];
  }

  function caseTitle(blocks, index) {
    const texts = blocks.filter(isText).map(function (b) { return b.text.trim(); });
    const first = (texts[0] || '').replace(/^#+\s*/, '');
    if (first && first.length <= 80 && !/^case study/i.test(first) && !/[.?:]$/.test(first) && !/ -$/.test(first)) return first;
    const company = /\b([A-Z][A-Za-z&]+(?: [A-Z][A-Za-z&]+)*,? (?:Ltd|Inc|Corp|Corporation|Company|Pharmaceuticals)\b\.?)/.exec(texts.join(' '));
    const named = /([A-Z][\w&' ]{2,40}?) is an? [^.]{0,60}company/.exec(texts.join(' '));
    return company ? company[1] : named ? named[1] : 'Case study ' + index;
  }

  // Questions from one case study repeat the same long introduction. Find it and move it to a shared case.
  function extractCases(raws) {
    const cases = [];
    const keys = raws.map(function (r) {
      return r.stem.filter(isText).map(function (b) { return alnum(b.text); }).join('');
    });
    const taken = new Set();
    for (let i = 0; i < raws.length; i++) {
      if (taken.has(i) || keys[i].length < CASE_MIN_CHARS) continue;
      const group = [i];
      for (let j = i + 1; j < raws.length; j++) {
        if (taken.has(j)) continue;
        const shorter = Math.min(keys[i].length, keys[j].length);
        const shared = commonPrefix(keys[i], keys[j]);
        if (shared >= CASE_MIN_CHARS && shared >= shorter * CASE_MIN_SHARE) group.push(j);
      }
      if (group.length < 2) continue;

      const pairs = [];
      for (let a = 0; a < group.length; a++) {
        for (let b = a + 1; b < group.length; b++) pairs.push(commonPrefix(keys[group[a]], keys[group[b]]));
      }
      const limit = median(pairs);
      const id = 'case' + (cases.length + 1);
      const members = [];
      // Compare against a typical copy, not one that was read badly.
      const base = group.find(function (n) {
        const others = group.filter(function (x) { return x !== n; });
        return median(others.map(function (x) { return commonPrefix(keys[n], keys[x]); })) >= limit * 0.97;
      });
      if (base === undefined) continue;
      for (const n of group) {
        const shared = n === base ? limit : commonPrefix(keys[base], keys[n]);
        // A copy that differs early on keeps its full text, so nothing is ever lost.
        if (shared < limit * 0.97) continue;
        const cut = cutIndex(raws[n].stem, Math.min(limit, shared));
        if (!cut) continue;
        taken.add(n);
        members.push({ raw: raws[n], story: raws[n].stem.slice(0, cut) });
        raws[n].stem = raws[n].stem.slice(cut);
        raws[n].caseId = id;
      }
      if (members.length) {
        const story = members[0].story.concat(sharedPictures(members));
        const title = caseTitle(story, cases.length + 1);
        const blocks = toBlocks(story);
        if (blocks.length && blocks[0].text === title) blocks.shift(); // shown as the heading already
        cases.push({ id: id, title: title, blocks: blocks });
      }
    }
    return cases;
  }

  // Exhibits repeated under most questions of a case belong to the case itself.
  function sharedPictures(members) {
    if (members.length < 3) return [];
    const bySig = new Map();
    members.forEach(function (m) {
      const here = new Set();
      m.raw.stem.filter(isImage).forEach(function (b) {
        if (!b.sig || here.has(b.sig)) return;
        here.add(b.sig);
        if (!bySig.has(b.sig)) bySig.set(b.sig, { block: b, count: 0 });
        bySig.get(b.sig).count++;
      });
    });
    const shared = Array.from(bySig.values()).filter(function (x) { return x.count >= members.length * 0.7; });
    const sigs = new Set(shared.map(function (x) { return x.block.sig; }));
    members.forEach(function (m) {
      m.raw.stem = m.raw.stem.filter(function (b) { return isText(b) || !sigs.has(b.sig); });
    });
    return shared.map(function (x) { return x.block; });
  }

  // How many leading blocks lie completely inside the first `limit` characters.
  function cutIndex(stem, limit) {
    let used = 0;
    let cut = 0;
    for (let i = 0; i < stem.length; i++) {
      if (isText(stem[i])) {
        used += alnum(stem[i].text).length;
        if (used > limit) break;
        cut = i + 1;
      }
    }
    return cut;
  }

  /* ---------- display blocks ---------- */

  function toBlocks(all) {
    // A line of nothing but gaps is an empty answer area.
    const paras = all.filter(function (p) { return isImage(p) || !/^_{4,}(?:\s+_{4,})*$/.test(p.text.trim()) || (p.indent || 0) >= 3; });
    const out = [];
    let fence = false;
    let openCode = null;

    function codeLine(line) {
      if (!openCode) {
        openCode = { t: 'code', text: line };
        out.push(openCode);
      } else {
        openCode.text += '\n' + line;
      }
    }
    function codeish(p) {
      if (!p || !isText(p)) return false;
      if (p.code) return true;
      const text = p.text.trim();
      if (RE_BULLET.test(text) || /^#/.test(text)) return false;
      if (/^[{}]/.test(text)) return true;
      const looks = /[;{}()=<>|:"'[\]_]/.test(text) || text.split(/\s+/).length <= 2;
      return (p.indent || 0) >= 3 && looks && !isProse(text);
    }

    paras.forEach(function (p, i) {
      if (isImage(p)) {
        openCode = null;
        out.push({ t: 'img', ref: p.ref });
        return;
      }
      const text = p.text.trim();
      if (!text) return;
      if (/^`{2,3}\w*$/.test(text)) {
        fence = !fence;
        openCode = null;
        return;
      }
      const pad = ' '.repeat(Math.min(40, p.indent || 0));
      const bullet = RE_BULLET.exec(text);
      const heading = /^#{1,6}\s+(.*)$/.exec(text) || /^([A-Z][^.?!]{1,60}?)\s+-$/.exec(text);
      if (fence || codeish(p) || (!isProse(text) && !bullet && !heading && codeish(paras[i + 1]) && (paras[i + 1].indent || 0) >= (p.indent || 0))) {
        codeLine(pad + text);
        return;
      }
      openCode = null;
      if (heading) out.push({ t: 'h', text: heading[1] });
      else if (bullet) out.push({ t: 'li', text: bullet[1] });
      else out.push({ t: 'p', text: text.replace(/^>\s+/, '') });
    });
    return out;
  }

  /* ---------- question types ---------- */

  function findOptions(stem) {
    const marks = [];
    stem.forEach(function (b, i) {
      const m = isText(b) ? RE_OPTION.exec(b.text.trim()) : null;
      if (m) marks.push({ i: i, key: m[1], text: m[2].trim() });
    });
    // The answer list is the last run of A, B, ... in the question.
    for (let s = marks.length - 1; s >= 0; s--) {
      if (marks[s].key !== 'A') continue;
      const run = [marks[s]];
      for (let k = s + 1; k < marks.length; k++) {
        if (marks[k].key === String.fromCharCode(65 + run.length)) run.push(marks[k]);
      }
      if (run.length >= 2) return run;
    }
    return null;
  }

  // Choices in other styles: a) b) c), tick boxes, or lines numbered 1. 2. 3.
  function otherOptions(stem) {
    const run = [];
    stem.forEach(function (b, i) {
      const m = isText(b) ? Sim.layout.RE_LABELLED.exec(b.text.trim()) : null;
      if (!m) return;
      const key = m[1].toUpperCase();
      if (key === 'A') run.length = 0;
      if (key === String.fromCharCode(65 + run.length)) run.push({ i: i, key: key, text: m[2].trim() });
    });
    if (run.length >= 2) return run;
    const boxes = [];
    stem.forEach(function (b, i) {
      const m = isText(b) ? Sim.layout.RE_CHECKBOX.exec(b.text.trim()) : null;
      if (m) boxes.push({ i: i, key: String.fromCharCode(65 + boxes.length), text: m[4].trim(), marked: /[☑☒✓✔✅●◉]/.test(m[1] || '') || !!(m[2] || m[3]) });
    });
    return boxes.length >= 2 && boxes.length <= 10 ? boxes : null;
  }

  function numberedOptions(stem) {
    const run = [];
    stem.forEach(function (b, i) {
      const m = isText(b) ? /^\(?(\d{1,2})[.)]\s+(\S.*)$/.exec(b.text.trim()) : null;
      if (!m) return;
      if (m[1] === '1') run.length = 0;
      if (Number(m[1]) === run.length + 1) run.push({ i: i, key: String.fromCharCode(64 + Number(m[1])), text: m[2].trim() });
    });
    return run.length >= 2 && run.length <= 10 ? run : null;
  }

  // Unlabelled choices: bullets, or the plain lines after the question, when the answer is one of them.
  function plainOptions(stem, answers) {
    let from = 0;
    stem.forEach(function (b, i) { if (isText(b) && /[?:]$/.test(b.text.trim())) from = i + 1; });
    const lines = [];
    for (let i = from; i < stem.length; i++) {
      if (!isText(stem[i])) continue;
      const m = RE_BULLET.exec(stem[i].text.trim());
      lines.push({ i: i, text: m ? m[1].trim() : stem[i].text.trim() });
    }
    if (lines.length < 2 || lines.length > 10 || answers.length >= lines.length) return null;
    const same = function (a, b) { return plain(a).toLowerCase() === plain(b).toLowerCase(); };
    const letters = [];
    for (const a of answers) {
      const n = lines.findIndex(function (l) { return same(l.text, a.replace(RE_BULLET, '$1')); });
      if (n < 0) return null;
      letters.push(String.fromCharCode(65 + n));
    }
    return { letters: Array.from(new Set(letters)).sort(), run: lines.map(function (l, n) { return { i: l.i, key: String.fromCharCode(65 + n), text: l.text }; }) };
  }

  /*
   * Which choices an answer such as "b", "B. Table extension", "Table extension" or "Option B" means.
   * Returns { letters, used } where used is how many answer lines it took, or null.
   */
  function readAnswer(answers, run) {
    const keys = run.map(function (r) { return r.key; });
    const known = function (list) { return list && list.length && list.every(function (k) { return keys.indexOf(k) >= 0; }) ? list : null; };
    const first = answers[0];
    const same = function (a, b) { return plain(a).toLowerCase() === plain(b).toLowerCase(); };
    const byText = function (t) {
      const bare = t.replace(/^["“]|["”]$/g, '');
      return run.find(function (r) { return r.text && (same(r.text, t) || same(r.text, bare) || same(r.text.replace(/[.;]$/, ''), t.replace(/[.;]$/, ''))); });
    };
    const whole = byText(first);
    if (whole) {
      const letters = [whole.key];
      let used = 1;
      while (used < answers.length && byText(answers[used])) letters.push(byText(answers[used++]).key);
      return { letters: Array.from(new Set(letters)).sort(), used: used };
    }
    const bare = first.replace(/[()]/g, '').replace(/\b(?:options?|choices?|answers?)\b/gi, '').trim();
    if (bare.length <= 20 && /^[a-j](?:\s*(?:,|;|&|\/|and|\s)\s*[a-j])*\.?$/i.test(bare)) {
      const list = known(parseLetters(bare.toUpperCase().replace(/\bAND\b/g, ',').replace(/[\/\s]+/g, ',')));
      if (list) return { letters: list, used: 1 };
    }
    const letters = [];
    let used = 0;
    while (used < answers.length) {
      const m = RE_LETTER_TEXT.exec(answers[used]) || /^(?:option|choice)?\s*\(?([A-J])\)?\s+(?:is|because|as|since)\b/.exec(answers[used]) || /^(?:option|choice)\s+([A-J])\b/i.exec(answers[used]);
      if (!m || keys.indexOf(m[1].toUpperCase()) < 0) break;
      letters.push(m[1].toUpperCase());
      used++;
    }
    if (letters.length) return { letters: Array.from(new Set(letters)).sort(), used: used };
    for (const sep of [/\s*[;|]\s*/, /\s*,\s*/]) {
      const parts = first.split(sep).filter(Boolean);
      if (parts.length < 2) continue;
      const hits = parts.map(byText);
      if (hits.every(Boolean)) return { letters: Array.from(new Set(hits.map(function (h) { return h.key; }))).sort(), used: 1 };
      const inside = parts.map(function (p) { const m = RE_LETTER_TEXT.exec(p); return m ? m[1].toUpperCase() : /^[A-Ja-j]$/.test(p) ? p.toUpperCase() : ''; });
      if (inside.every(Boolean) && known(inside)) return { letters: Array.from(new Set(inside)).sort(), used: 1 };
    }
    return null;
  }

  // The choices that stand out: ticked, highlighted, bold or underlined, but never all of them.
  function standOut(list) {
    for (const look of ['mark', 'highlight', 'bold', 'underline']) {
      const hits = list.filter(function (o) { return o[look]; });
      if (hits.length && hits.length < list.length) return hits.map(function (o) { return o.key; });
    }
    return null;
  }

  function markedOptions(stem, run) {
    return standOut(run.map(function (r) {
      const b = stem[r.i];
      const before = b.text.trim().slice(0, Math.max(0, b.text.trim().indexOf(r.text)));
      const mark = r.marked || /[*✓✔✅√☑☒]/.test(before) || Sim.layout.readMark(r.text).marked;
      return { key: r.key, mark: mark, highlight: b.highlight, bold: b.bold, underline: b.underline };
    }));
  }

  /*
   * Some files give every option as a picture: the wrong ones in the question, and the right ones under
   * the answer. Put each picture next to its letter so the question can be answered.
   */
  function tiePictures(raw, options, letters, before) {
    if (options.some(function (o) { return o.text || o.imgs.length; })) return;
    const firstText = raw.expl.findIndex(isText);
    const shown = (firstText < 0 ? raw.expl : raw.expl.slice(0, firstText)).filter(isImage);
    const asked = before.filter(isImage);
    const others = options.filter(function (o) { return letters.indexOf(o.key) < 0; });
    if (shown.length !== letters.length || asked.length < others.length) return;
    others.forEach(function (o, n) { o.imgs = [asked[n].ref]; });
    letters.forEach(function (key, n) {
      options.find(function (o) { return o.key === key; }).imgs = [shown[n].ref];
    });
    asked.slice(0, others.length).forEach(function (img) { before.splice(before.indexOf(img), 1); });
    raw.expl = raw.expl.filter(function (b) { return shown.indexOf(b) < 0; });
  }

  function buildChoice(raw, letters, given, unmark) {
    const stem = raw.stem;
    const run = given || findOptions(stem);
    if (!run) {
      const top = Math.max(3, letters[letters.length - 1].charCodeAt(0) - 65);
      const options = [];
      for (let k = 0; k <= top; k++) options.push({ key: String.fromCharCode(65 + k), text: '', imgs: [] });
      return { type: 'choice', stem: toBlocks(stem), options: options, answer: letters, note: 'options-missing' };
    }
    const options = run.map(function (mark, n) {
      const end = n + 1 < run.length ? run[n + 1].i : stem.length;
      const inner = stem.slice(mark.i + 1, end);
      const lines = [unmark ? Sim.layout.readMark(mark.text).text : mark.text];
      inner.filter(isText).forEach(function (b) {
        lines.push(' '.repeat(Math.min(40, b.indent || 0)) + b.text.trim());
      });
      return { key: mark.key, text: lines.filter(Boolean).join('\n'), imgs: inner.filter(isImage).map(function (b) { return b.ref; }) };
    });
    const before = stem.slice(0, run[0].i);
    const last = options[options.length - 1];
    const interleaved = options.slice(0, -1).some(function (o) { return o.imgs.length; });
    if (!interleaved && last.imgs.length) {
      // Pictures listed after all the options belong to the question as a whole.
      last.imgs.forEach(function (ref) { before.push({ k: 'img', ref: ref }); });
      last.imgs = [];
    }
    tiePictures(raw, options, letters, before);
    const missing = options.filter(function (o) { return !o.text && !o.imgs.length; }).length;
    letters.forEach(function (key) {
      if (!options.some(function (o) { return o.key === key; })) options.push({ key: key, text: '', imgs: [] });
    });
    return {
      type: 'choice',
      stem: toBlocks(before),
      options: options,
      answer: letters,
      note: missing ? 'options-in-picture' : undefined
    };
  }

  function parsePairs(lines) {
    // Two statements read as one line come apart after the first Yes or No.
    const texts = [];
    lines.forEach(function (t) {
      // A value that wrapped onto its own line goes back to its prompt.
      if (/^(?:—|--)\s/.test(t) && texts.length) {
        texts[texts.length - 1] += ' ' + t;
        return;
      }
      texts.push.apply(texts, t.split(/(?<=\s(?:—|--)\s+(?:Yes|No))\s+(?=["A-Z(])/));
    });
    const whole = texts.filter(function (t) { return RE_PAIR.test(t); }).length;
    if (!whole || whole < texts.length / 2) return null;
    const pairs = [];
    let buf = '';
    texts.forEach(function (t) {
      buf = buf ? buf + ' ' + t : t;
      const m = RE_PAIR.exec(buf);
      if (m) {
        pairs.push([m[1].trim(), m[2].trim()]);
        buf = '';
      }
    });
    if (buf) pairs[pairs.length - 1][1] += ' ' + buf;
    return pairs;
  }

  function withAnswer(options, answer) {
    const list = unique(options);
    const hit = list.find(function (o) { return plain(o) === plain(answer); });
    if (hit === undefined) list.push(answer);
    return { options: list, answer: hit === undefined ? answer : hit };
  }

  function row(prompt, options, answer) {
    const fixed = withAnswer(options, answer);
    return { prompt: prompt, options: fixed.options, answer: fixed.answer };
  }

  // Find the block (or run of wrapped blocks) whose words equal `target`, searching backwards from `before`.
  function findPrompt(stem, target, before) {
    const want = alnum(target);
    for (let i = before - 1; i >= 0; i--) {
      if (!isText(stem[i])) continue;
      let acc = alnum(stem[i].text);
      if (acc === want) return { start: i, end: i };
      if (acc.length < 8 || !want.startsWith(acc)) continue;
      for (let j = i + 1; j < before && isText(stem[j]) && acc.length < want.length; j++) {
        acc += alnum(stem[j].text);
        if (acc === want) return { start: i, end: j };
      }
    }
    return null;
  }

  function lastIndex(stem, re, before) {
    for (let i = (before === undefined ? stem.length : before) - 1; i >= 0; i--) {
      if (isText(stem[i]) && re.test(stem[i].text.trim())) return i;
    }
    return -1;
  }

  function buildMatch(raw, pairs) {
    const stem = raw.stem;
    const images = function (from) { return stem.slice(from).filter(isImage); };
    const anyOrder = stem.some(function (b) { return isText(b) && /more than one order/i.test(b.text); });
    const finish = function (cut, rows) {
      return { type: 'match', stem: toBlocks(stem.slice(0, cut).concat(images(cut))), rows: rows, anyOrder: anyOrder };
    };

    if (pairs.every(function (p) { return /^(yes|no|true|false)$/i.test(p[1]); })) {
      const ask = lastIndex(stem, /select\s+(?:yes|no)\b/i);
      let cut = -1;
      for (let i = Math.max(0, ask); i < stem.length && cut < 0; i++) {
        if (isText(stem[i]) && /^(?:Statements?(?:\s+(?:Opti\w*|Yes\s.*))?|Opti(?:ons)?)$/i.test(stem[i].text.trim())) cut = i;
      }
      if (cut < 0) {
        const first = alnum(pairs[0][0]).slice(0, 30);
        for (let i = stem.length - 1; i >= 0; i--) {
          if (isText(stem[i]) && alnum(stem[i].text).startsWith(first)) cut = i;
        }
      }
      const truth = /^(?:true|false)$/i.test(pairs[0][1]) ? ['True', 'False'] : ['Yes', 'No'];
      return finish(cut < 0 ? stem.length : cut, pairs.map(function (p) {
        const value = p[1].charAt(0).toUpperCase() + p[1].slice(1).toLowerCase();
        return row(p[0], truth, value);
      }));
    }

    const at = lastIndex(stem, /^Available choices\s*:/i);
    if (at >= 0) {
      const listText = stem.slice(at).filter(isText).map(function (b) { return b.text.trim(); }).join(' ');
      const pool = listText.replace(/^Available choices\s*:\s*/i, '').split(/\s*\|\s*/).filter(Boolean);
      const label = lastIndex(stem, /^Match each item\b/i, at);
      const first = findPrompt(stem, pairs[0][0], at);
      const cut = label >= 0 ? label : first ? first.start : at;
      return finish(cut, pairs.map(function (p) { return row(p[0], pool, p[1]); }));
    }

    // Each prompt is followed by its own list of choices.
    const spots = [];
    let before = stem.length;
    for (let n = pairs.length - 1; n >= 0; n--) {
      const spot = findPrompt(stem, pairs[n][0], before);
      if (!spot) break;
      spots.unshift(spot);
      before = spot.start;
    }
    if (spots.length === pairs.length) {
      return finish(spots[0].start, pairs.map(function (p, n) {
        const stop = n + 1 < spots.length ? spots[n + 1].start : stem.length;
        const own = stem.slice(spots[n].end + 1, stop).filter(isText).map(function (b) { return b.text.trim(); });
        return row(p[0], own.length ? own : pairs.map(function (x) { return x[1]; }), p[1]);
      }));
    }
    const everyAnswer = pairs.map(function (p) { return p[1]; });
    return finish(stem.length, pairs.map(function (p) { return row(p[0], everyAnswer, p[1]); }));
  }

  /*
   * Fill-in-the-code questions list the choices for every gap one after another, with nothing between
   * the lists. Split them so each list holds its own answer, has no repeats, and looks alike inside.
   */
  function groupOptions(options, answers) {
    const n = options.length;
    const k = answers.length;
    const keys = options.map(plain);
    const want = answers.map(plain);
    if (k === 1) return [options.slice()];

    function shape(s) {
      return /^[a-z]/i.test(s) ? 'word' : /^\d/.test(s) ? 'number' : s.charAt(0);
    }
    function joinCost(a, b) {
      let c = 0;
      if (a.toLowerCase() > b.toLowerCase()) c += 0.6;
      if (shape(a) !== shape(b)) c += 1;
      if (commonPrefix(a.toLowerCase(), b.toLowerCase()) >= 4) c -= 1;
      return c;
    }
    function cost(i, j, g) {
      const seen = new Set();
      let has = false;
      let c = 0;
      for (let x = i; x < j; x++) {
        if (seen.has(keys[x])) return Infinity;
        seen.add(keys[x]);
        if (keys[x] === want[g]) has = true;
        if (x > i) c += joinCost(keys[x - 1], keys[x]);
      }
      if (!has) return Infinity;
      const d = (j - i) - n / k;
      return c + d * d * 0.6 + (j - i === 1 ? 3 : 0);
    }

    const best = [];
    const from = [];
    for (let g = 0; g <= k; g++) {
      best.push(new Array(n + 1).fill(Infinity));
      from.push(new Array(n + 1).fill(-1));
    }
    best[0][0] = 0;
    for (let g = 1; g <= k; g++) {
      for (let j = g; j <= n; j++) {
        for (let i = g - 1; i < j; i++) {
          if (best[g - 1][i] === Infinity) continue;
          const c = best[g - 1][i] + cost(i, j, g - 1);
          if (c < best[g][j]) {
            best[g][j] = c;
            from[g][j] = i;
          }
        }
      }
    }
    if (best[k][n] === Infinity) {
      return answers.map(function () { return unique(options); });
    }
    const groups = [];
    let j = n;
    for (let g = k; g > 0; g--) {
      const i = from[g][j];
      groups.unshift(options.slice(i, j));
      j = i;
    }
    return groups;
  }

  function buildBlanks(raw, answers) {
    const paras = raw.stem.filter(isText);
    const images = raw.stem.filter(isImage);
    const firstBlank = paras.findIndex(function (p) { return RE_BLANK.test(p.text); });
    if (firstBlank < 0) return null;
    const gaps = paras.reduce(function (sum, p) { return sum + (p.text.match(/_{4,}/g) || []).length; }, 0);
    if (gaps !== answers.length) return null;

    let prose = -1;
    for (let i = 0; i < firstBlank; i++) {
      const text = paras[i].text.trim();
      const request = /^[A-Z][^;{}()=]*[.?:]$/.test(text) && text.split(/\s+/).length >= 4;
      if ((isProse(text) || request) && !RE_OPTION.test(text)) prose = i;
    }
    // Every answer has to appear, in order, among the choices.
    let pos = prose;
    for (const answer of answers) {
      let hit = -1;
      for (let i = pos + 1; i < firstBlank && hit < 0; i++) {
        if (plain(paras[i].text) === plain(answer)) hit = i;
      }
      if (hit < 0) return null;
      pos = hit;
    }

    let start = firstBlank;
    for (let i = pos + 1; i < firstBlank; i++) {
      const text = paras[i].text.trim();
      const next = paras[i + 1];
      const nextText = next.text.trim();
      const opens = /^(?:\{|\.{3}|-{4})/.test(text) || /^(?:local\s+)?(?:procedure|trigger)\b[^)]*$/i.test(text);
      const leads = (next.indent || 0) >= (paras[i].indent || 0) + 2 ||
        /^(?:var|begin)$/i.test(nextText) ||
        (/^\{/.test(nextText) && RE_CODE_HEAD.test(text)) ||
        (/^\|/.test(nextText) && RE_BLANK.test(nextText));
      if (opens || leads) {
        start = i;
        break;
      }
    }
    const options = paras.slice(prose + 1, start).map(function (p) { return p.text.trim(); });
    if (options.length < answers.length) return null;
    const groups = groupOptions(options, answers);
    const code = paras.slice(start).map(function (p) {
      return ' '.repeat(Math.min(40, p.indent || 0)) + p.text.trim();
    }).join('\n');
    return {
      type: 'blanks',
      stem: toBlocks(paras.slice(0, prose + 1).concat(images)),
      code: code,
      rows: answers.map(function (a, n) { return row('Gap ' + (n + 1), groups[n], a); })
    };
  }

  // The gaps are there but their choices are not listed: offer the set of answers for every gap.
  function buildLooseBlanks(raw, answers) {
    const paras = raw.stem.filter(isText);
    const gaps = paras.reduce(function (sum, p) { return sum + (p.text.match(/_{4,}/g) || []).length; }, 0);
    if (!gaps || gaps !== answers.length) return null;
    const first = paras.findIndex(function (p) { return RE_BLANK.test(p.text); });
    return {
      type: 'blanks',
      stem: toBlocks(paras.slice(0, first).concat(raw.stem.filter(isImage))),
      code: paras.slice(first).map(function (p) { return ' '.repeat(Math.min(40, p.indent || 0)) + p.text.trim(); }).join('\n'),
      rows: answers.map(function (a, n) { return row('Gap ' + (n + 1), answers, a); })
    };
  }

  function buildQuestion(raw) {
    const answerTexts = raw.answer.filter(isText).map(function (b) { return b.text.trim(); }).filter(Boolean);
    const answerHasImage = raw.answer.some(isImage);
    const stemText = raw.stem.filter(isText).map(function (b) { return b.text; }).join(' ');
    const run = findOptions(raw.stem) || otherOptions(raw.stem);
    let letters = answerTexts.length === 1 ? parseLetters(answerTexts[0]) : null;
    let q = null;

    if (!letters && run && answerTexts.length && !answerHasImage) {
      const read = readAnswer(answerTexts, run);
      if (read) {
        letters = read.letters;
        raw = Object.assign({}, raw, { expl: raw.answer.filter(isText).slice(read.used).concat(raw.expl) });
      }
    }
    const truth = !run && answerTexts.length && /^(true|false|yes|no)\b[.!]?$/i.exec(answerTexts[0]);
    const shortTruth = !run && letters && answerTexts[0] === 'F' && /true\s*(?:\/|or)\s*false/i.test(stemText);
    if (truth || shortTruth || (!run && answerTexts.length === 1 && answerTexts[0] === 'T')) {
      const said = truth ? truth[1].toLowerCase() : answerTexts[0] === 'T' ? 'true' : 'false';
      const pair = /^(?:yes|no)$/.test(said) ? ['Yes', 'No'] : ['True', 'False'];
      q = {
        type: 'choice',
        stem: toBlocks(raw.stem),
        options: pair.map(function (t, n) { return { key: 'AB'[n], text: t, imgs: [] }; }),
        answer: [said === pair[0].toLowerCase() ? 'A' : 'B']
      };
      raw = Object.assign({}, raw, { expl: raw.answer.filter(isText).slice(1).concat(raw.expl) });
    } else if (letters) {
      q = buildChoice(raw, letters, run);
    } else if (!answerTexts.length && !answerHasImage && run) {
      const found = markedOptions(raw.stem, run);
      if (found) q = buildChoice(raw, found, run, true);
    } else if (answerTexts.length && !answerHasImage) {
      let pairs = parsePairs(answerTexts);
      // Programs that save plain text turn the long dash into a short one.
      if (!pairs && /Available choices\s*:/i.test(stemText)) pairs = parsePairs(answerTexts.map(function (t) { return t.replace(/\s+-\s+(?=\S+(?:\s\S+){0,6}$)/, ' -- '); }));
      if (pairs) q = buildMatch(raw, pairs);
      if (!q) q = buildBlanks(raw, answerTexts);
      if (!q && /^\d{1,2}(?:\s*[,;&]\s*\d{1,2})*\.?$/.test(answerTexts[0])) {
        const numbered = numberedOptions(raw.stem);
        const picks = answerTexts[0].match(/\d+/g).map(function (n) { return String.fromCharCode(64 + Number(n)); });
        if (numbered && picks.every(function (k) { return numbered.some(function (r) { return r.key === k; }); })) {
          q = buildChoice(raw, picks.sort(), numbered);
          raw = Object.assign({}, raw, { expl: raw.answer.filter(isText).slice(1).concat(raw.expl) });
        }
      }
      if (!q && !RE_ORDERING.test(stemText)) {
        const unlabelled = plainOptions(raw.stem, answerTexts);
        if (unlabelled) q = buildChoice(raw, unlabelled.letters, unlabelled.run);
      }
      if (!q && answerTexts.length >= 2 && RE_ORDERING.test(stemText)) {
        q = {
          type: 'order',
          stem: toBlocks(raw.stem),
          items: answerTexts,
          anyOrder: /more than one order/i.test(stemText)
        };
      }
      if (!q) q = buildLooseBlanks(raw, answerTexts);
    }
    if (!q) {
      q = {
        type: 'self',
        stem: toBlocks(raw.stem),
        solution: toBlocks(raw.answer),
        note: raw.answer.length ? undefined : 'no-answer'
      };
    }
    q.num = raw.num;
    q.explanation = toBlocks(raw.expl);
    if (raw.caseId) q.caseId = raw.caseId;
    return q;
  }

  /* ---------- questions from table rows ---------- */

  function linesToParas(text) {
    return (text || '').split('\n').map(function (line) {
      const expanded = line.replace(/\t/g, '    ');
      return { k: 'p', text: expanded.trim(), indent: expanded.length - expanded.trimStart().length };
    }).filter(function (p) { return p.text; });
  }

  // The answer cell of a row: letters, numbers, or the text of one or more choices.
  function resolveCorrect(value, options) {
    const v = value.trim();
    if (!v) return null;
    const run = options.map(function (o) { return { key: o.key, text: o.text }; });
    const read = readAnswer(v.split('\n').map(function (t) { return t.trim(); }).filter(Boolean), run);
    if (read) return read.letters;
    const nums = /^(?:option|choice|answer)?\s*\d{1,2}(?:\s*(?:[,;&\/]|and|\s)\s*(?:option|choice|answer)?\s*\d{1,2})*\.?$/i.test(v) ? v.match(/\d+/g).map(Number) : null;
    if (nums && nums.every(function (n) { return n >= 1 && n <= options.length; })) {
      return Array.from(new Set(nums.map(function (n) { return options[n - 1].key; }))).sort();
    }
    const upper = parseLetters(v.toUpperCase());
    return upper && upper.every(function (k) { return options.some(function (o) { return o.key === k; }); }) ? upper : null;
  }

  function fromRow(item, num) {
    const stem = linesToParas(item.question).concat(item.imgs.map(function (ref) { return { k: 'img', ref: ref }; }));
    const ordering = /order|sequence|arrange|sort/i.test(item.type || '') || RE_ORDERING.test(item.question);
    const options = item.options.slice(0, 26).map(function (o, n) {
      return { key: String.fromCharCode(65 + n), text: o.text, imgs: o.imgs || [], mark: o.mark, highlight: o.highlight, bold: o.bold };
    });
    const clean = options.map(function (o) { return { key: o.key, text: o.text, imgs: o.imgs }; });
    let q = null;
    if (options.length >= 2) {
      const steps = ordering ? (item.correct.toUpperCase().match(/\b[A-J]\b/g) || (/^[A-J]{2,10}$/i.test(item.correct.trim()) ? item.correct.trim().toUpperCase().split('') : [])) : [];
      const inOrder = steps.length >= 2 && steps.every(function (k) { return clean.some(function (o) { return o.key === k; }); }) && new Set(steps).size === steps.length;
      const answer = item.longRow ? options.filter(function (o) { return o.mark; }).map(function (o) { return o.key; })
        : resolveCorrect(item.correct, clean) || (item.correct.trim() ? null : standOut(options));
      if (inOrder) {
        q = { type: 'order', stem: toBlocks(stem), items: steps.map(function (k) { return clean.find(function (o) { return o.key === k; }).text; }), anyOrder: false };
      } else if (answer && answer.length) {
        q = { type: 'choice', stem: toBlocks(stem), options: clean, answer: answer };
      } else {
        q = {
          type: 'self',
          stem: toBlocks(stem).concat(clean.map(function (o) { return { t: 'li', text: o.key + '. ' + o.text }; })),
          solution: toBlocks(linesToParas(item.correct)),
          note: item.correct.trim() ? undefined : 'no-answer'
        };
      }
      q.explanation = toBlocks(linesToParas(item.explanation));
    } else {
      let answer = item.correct;
      if (answer.indexOf('\n') < 0 && (/(?:—|--|->|=>|→)/.test(answer) || ordering)) answer = answer.split(ordering && !/(?:--|->|=>|→)/.test(answer) ? /\s*[;|>]\s*/ : /\s*[;|]\s*/).join('\n');
      const raw = { num: num, stem: stem, answer: linesToParas(answer), expl: linesToParas(item.explanation) };
      if (ordering && raw.answer.length >= 2 && !parsePairs(raw.answer.map(function (p) { return p.text; }))) {
        q = { type: 'order', stem: toBlocks(stem), items: raw.answer.map(function (p) { return p.text; }), anyOrder: false, explanation: toBlocks(raw.expl) };
      } else {
        q = buildQuestion(raw);
      }
    }
    q.num = num;
    q.section = item.section || GENERAL;
    return q;
  }

  /* ---------- entry points ---------- */

  function parse(blocks) {
    const raws = splitQuestions(blocks);
    const cases = extractCases(raws);
    const titles = new Map(cases.map(function (c) { return [c.id, c.title]; }));
    const questions = raws
      .filter(function (r) { return r.stem.length; })
      .map(function (r) {
        const q = buildQuestion(r);
        q.section = q.caseId ? titles.get(q.caseId) : r.section || GENERAL;
        return q;
      });
    return { questions: questions, cases: cases, report: makeReport(questions) };
  }

  function makeReport(questions) {
    const report = { total: questions.length, types: {}, missing: [], repeated: [], self: [], noAnswer: [], pictureOptions: [] };
    const seen = new Set();
    questions.forEach(function (q) {
      report.types[q.type] = (report.types[q.type] || 0) + 1;
      if (seen.has(q.num)) report.repeated.push(q.num);
      seen.add(q.num);
      if (q.note === 'no-answer') report.noAnswer.push(q.num);
      else if (q.type === 'self') report.self.push(q.num);
      if (q.note === 'options-in-picture' || q.note === 'options-missing') report.pictureOptions.push(q.num);
    });
    if (seen.size) {
      const nums = Array.from(seen);
      const max = Math.max.apply(null, nums);
      for (let n = Math.min.apply(null, nums); n <= max; n++) if (!seen.has(n)) report.missing.push(n);
    }
    return report;
  }

  function textToBlocks(text) {
    return text.replace(/^﻿/, '').split(/\r?\n/).map(function (line) {
      const expanded = line.replace(/\t/g, '    ');
      return { k: 'p', text: expanded.trim(), indent: expanded.length - expanded.trimStart().length };
    });
  }

  Sim.parser = {
    GENERAL: GENERAL,
    parse: parse,
    textToBlocks: textToBlocks,
    groupOptions: groupOptions,
    parseLetters: parseLetters,
    makeReport: makeReport,
    fromRow: fromRow,
    readMark: function (t) { return Sim.layout.readMark(t); },
    plain: plain
  };
})();
