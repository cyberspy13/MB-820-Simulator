/*
 * Turns a flat list of blocks, in reading order, into questions.
 * A block is { k: 'p', text, indent } or { k: 'img', ref }.
 * Nothing here touches the page or the PDF library, so tests/tests.html can exercise it directly.
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const RE_DIAGRAM = /^Question\s+\d+\s+diagram$/i;
  const RE_QUESTION = /^(?:NEW\s+)?QUESTION\s*(?:NO\.?\s*)?[:#]?\s*(\d{1,4})\s*[:.)]?\s*(.*)$/i;
  const RE_ANSWER = /^(?:Correct\s+)?Answers?\s*:\s*(.*)$/i;
  const RE_EXPLANATION = /^Explanation(?:\s*\/\s*References?)?\s*(?::\s*(.*))?$/i;
  const RE_REFERENCE = /^References?\s*:/i;
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

  function questionHeader(text) {
    if (RE_DIAGRAM.test(text)) return null;
    const m = RE_QUESTION.exec(text);
    if (!m) return null;
    const rest = m[2].trim();
    if (rest && !/^[(\[\-–—]/.test(rest)) return null;
    return { num: Number(m[1]), rest: rest };
  }

  function parseLetters(text) {
    const t = text.trim().replace(/\band\b/gi, ',').replace(/[.\s,;&]+/g, '');
    if (!/^[A-J]{1,10}$/.test(t)) return null;
    const letters = Array.from(new Set(t.split('')));
    return letters.length === t.length ? letters.sort() : null;
  }

  function splitQuestions(blocks) {
    const out = [];
    let cur = null;
    let part = 'stem';
    for (const b of blocks) {
      if (isText(b)) {
        const text = b.text.trim();
        const head = questionHeader(text);
        if (head) {
          cur = { num: head.num, stem: [], answer: [], expl: [] };
          out.push(cur);
          part = 'stem';
          continue;
        }
        if (!cur || !text || RE_DIAGRAM.test(text)) continue;
        const ans = RE_ANSWER.exec(text);
        if (ans && part === 'stem') {
          part = 'answer';
          if (ans[1].trim()) cur.answer.push(Object.assign({}, b, { text: ans[1].trim() }));
          continue;
        }
        const ex = part === 'stem' ? null : RE_EXPLANATION.exec(text);
        if (ex) {
          part = 'expl';
          if (ex[1] && ex[1].trim()) cur.expl.push(Object.assign({}, b, { text: ex[1].trim() }));
          continue;
        }
        if (part === 'answer' && RE_REFERENCE.test(text)) part = 'expl';
      } else if (!cur) {
        continue;
      }
      // Once a letter answer such as "B, D" has been read, whatever follows explains it.
      if (part === 'answer' && cur.answer.length === 1 && isText(cur.answer[0]) && parseLetters(cur.answer[0].text)) {
        part = 'expl';
      }
      cur[part].push(b);
    }
    for (const q of out) {
      q.stem = q.stem.filter(function (b) { return isImage(b) || !RE_KIND.test(b.text.trim()); });
      const last = q.stem[q.stem.length - 1];
      // "Correct Answer:" split over two lines leaves its first word behind.
      if (last && isText(last) && last.text.trim() === 'Correct') q.stem.pop();
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

  function buildChoice(raw, letters) {
    const stem = raw.stem;
    const run = findOptions(stem);
    if (!run) {
      const top = Math.max(3, letters[letters.length - 1].charCodeAt(0) - 65);
      const options = [];
      for (let k = 0; k <= top; k++) options.push({ key: String.fromCharCode(65 + k), text: '', imgs: [] });
      return { type: 'choice', stem: toBlocks(stem), options: options, answer: letters, note: 'options-missing' };
    }
    const options = run.map(function (mark, n) {
      const end = n + 1 < run.length ? run[n + 1].i : stem.length;
      const inner = stem.slice(mark.i + 1, end);
      const lines = [mark.text];
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
    const letters = answerTexts.length === 1 ? parseLetters(answerTexts[0]) : null;
    let q = null;

    if (letters) {
      q = buildChoice(raw, letters);
    } else if (answerTexts.length && !answerHasImage) {
      const pairs = parsePairs(answerTexts);
      if (pairs) q = buildMatch(raw, pairs);
      if (!q) q = buildBlanks(raw, answerTexts);
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

  /* ---------- entry points ---------- */

  function parse(blocks) {
    const raws = splitQuestions(blocks);
    const cases = extractCases(raws);
    const titles = new Map(cases.map(function (c) { return [c.id, c.title]; }));
    const questions = raws
      .filter(function (r) { return r.stem.length; })
      .map(function (r) {
        const q = buildQuestion(r);
        q.section = q.caseId ? titles.get(q.caseId) : GENERAL;
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
    plain: plain
  };
})();
