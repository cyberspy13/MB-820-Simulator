/*
 * Finds where each question starts, whatever style the author used, and marks it:
 *   { k: 'q', num, text }   a question begins (text = its first line, if on the same line)
 *   { k: 's', text, sticky } a section or topic name
 *   { k: 'key', answers }   an answer key, as a Map from question number to answer text
 * Everything else passes through. No DOM.
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const RE_DIAGRAM = /^Question\s+\d+\s+diagram$/i;
  const RE_ANSWER = /^(?:Correct\s+)?Answers?\s*:\s*(.*)$/i;
  const RE_ANSWER_LOOSE = [
    /^(?:the\s+)?(?:correct|right)\s+(?:answers?|options?|choices?|responses?)(?:\s+(?:is|are))?\s*[:=\-–—]?\s*(.*)$/i,
    /^(?:answers?|ans\.?|answer\s+key)\s*(?:[:=]|\s[-–—]\s|\s(?:is|are)\s)\s*(.*)$/i,
    /^(?:correct|right)\s*[:=]\s*(.*)$/i,
    /^(?:answers?|ans\.?)\s+(\(?[A-Ja-j]\)?(?:\s*[,;&]\s*\(?[A-Ja-j]\)?)*\.?)$/i,
    /^(?:key)\s*[:=]\s*([A-Ja-j](?:\s*[,;&]\s*[A-Ja-j])*)$/i,
    /^(?:answers?)()$/i
  ];
  const RE_EXPLAINS = /^(?:Explanations?|Rationale|Feedback|Justification|Reasoning)(?:\s*\/\s*References?)?\s*(?:[:\-–—]\s*(.*))?$/i;
  const RE_REFERENCE = /^References?\s*:/i;
  const RE_SECTION = /^(?:Section|Topic|Category|Domain|Chapter|Module|Objective|Skill(?:\s+area)?)\s*\d*\s*[:\-–—]\s*(\S.{0,78})$/i;
  const RE_LABELLED = /^[^\w"'<\[{(]{0,4}\(?([A-Ja-j])\s*(?:[.):\]]\)?|\s[-–—])(?:\s+|$)(.*)$/;
  const RE_CHECKBOX = /^(?:[-*•]\s*)?(?:(☐|☑|☒|✓|✔|✅|○|●|◯|◉)|\[\s*([xX✓✔*]?)\s*\]|\(\s*([xX✓✔*]?)\s*\))\s+(\S.*)$/;
  const RE_KEY_TITLE = /^(?:(?:the\s+)?(?:correct\s+)?answers?(?:\s+key|\s+sheet)?|answer\s+key|key|solutions?)\s*:?$/i;
  const RE_KEY_ITEM = /(?:Q(?:uestion)?\s*\.?\s*)?(\d{1,4})\s*(?:[.):\-–—=]|\s)\s*((?:[A-J](?:\s*[,&+\/]\s*[A-J]|[A-J])*)|True|False)(?=\s|,|;|$)[,;]?\s*/gi;

  function isText(b) {
    return b.k === 'p';
  }

  /* ---------- single lines ---------- */

  // The text after "Answer:", '' when the answer follows on the next line, or null.
  function answerOf(text) {
    const m = RE_ANSWER.exec(text);
    if (m) return m[1].trim();
    for (const re of RE_ANSWER_LOOSE) {
      const x = re.exec(text);
      if (x) return (x[1] || '').trim();
    }
    return null;
  }

  function explanationOf(text) {
    const m = RE_EXPLAINS.exec(text);
    if (!m) return null;
    if (m[1] === undefined && text.length > 40) return null;
    return (m[1] || '').trim();
  }

  function isLabelled(text, letter) {
    const m = RE_LABELLED.exec(text);
    return !!m && (!letter || m[1].toUpperCase() === letter);
  }

  // Takes "correct" marks such as *, ✓ or (correct) off a choice.
  function readMark(text) {
    let t = text.trim();
    let marked = false;
    const before = /^(?:\*+|✓|✔|✅|√|☑|☒|\[\s*[xX✓✔*]\s*\]|\(\s*[xX✓✔*]\s*\)|=(?=[A-Z]))\s*(?=\S)/.exec(t);
    if (before) {
      marked = true;
      t = t.slice(before[0].length);
    } else {
      t = t.replace(/^(?:☐|\[\s*\]|\(\s*\))\s+/, '');
    }
    const after = /\s*(?:\*+|✓|✔|✅|√|☑|\((?:the )?(?:correct|right|correct answer|right answer|answer|true)\)|\[(?:correct|right|correct answer|answer|x)\]|\s[-–—]+\s*(?:correct|right)(?: answer)?|(?:<-+|←)\s*(?:correct|right|answer)?.*)$/i.exec(t);
    if (after && after.index > 0) {
      marked = true;
      t = t.slice(0, after.index);
    }
    return { text: t.trim(), marked: marked };
  }

  /* ---------- question headers ---------- */

  function asWord(text) {
    if (RE_DIAGRAM.test(text)) return null;
    const m = /^(?:NEW\s+)?QUESTION\s*(?:NO\.?\s*|NUMBER\s*)?[:#]?\s*(\d{1,4})\s*([:.)\]]?)\s*(.*)$/i.exec(text);
    if (!m) return null;
    let rest = m[3].trim();
    let sure = !!m[2];
    const of = /^(?:of|\/)\s*\d+\b\s*([:.)\-–—]?)\s*(.*)$/i.exec(rest);
    if (of) {
      rest = of[2];
      sure = sure || !rest || !!of[1];
    }
    if (/^[(\[]/.test(rest)) {
      const close = /^[(\[][^)\]]*[)\]]\s*[:.\-–—]?\s*(.*)$/.exec(rest);
      rest = close ? close[1] : '';
      sure = true;
    } else if (/^[-–—]/.test(rest)) {
      rest = rest.replace(/^[-–—]+\s*/, '');
      if (/^(?:[(\[]|topic\b|section\b|exam\b)/i.test(rest)) rest = '';
      sure = true;
    }
    if (rest && !sure && !(/^[A-Z“"]/.test(rest) && rest.split(/\s+/).length >= 4)) return null;
    return { num: Number(m[1]), text: rest };
  }

  function asQ(text) {
    const m = /^Q\s*\.?\s*#?(\d{1,4})\s*([.:)\]\-–—]?)\s*(.*)$/.exec(text);
    if (!m) return null;
    const rest = m[3].trim();
    if (rest && !m[2] && !(/^[A-Z“"]/.test(rest) && rest.split(/\s+/).length >= 4)) return null;
    return { num: Number(m[1]), text: rest };
  }

  function asLabel(text) {
    const m = /^(?:Question|Q)\s*:\s*(?!\d+\s*$)(.*)$/i.exec(text);
    return m ? { num: 0, text: m[1].trim() } : null;
  }

  function asNumber(text) {
    const m = /^(?:\(?(\d{1,4})[.)\]:]|#(\d{1,4})[.:)]?)(?:\s+(\S.*))?$/.exec(text);
    return m ? { num: Number(m[1] || m[2]), text: (m[3] || '').trim() } : null;
  }

  function scan(blocks, read) {
    const found = new Map();
    blocks.forEach(function (b, i) {
      const h = isText(b) && b.text ? read(b.text) : null;
      if (h) found.set(i, h);
    });
    return found;
  }

  // Where the choices and the answer of each question are, whatever comes before them.
  function findCores(blocks) {
    const cores = [];
    let cur = null;
    const value = function (i) { return blocks[i] && isText(blocks[i]) ? blocks[i].text : ''; };
    const followedByB = function (i) {
      for (let j = i + 1; j < Math.min(blocks.length, i + 15); j++) if (isLabelled(value(j), 'B')) return true;
      return false;
    };
    blocks.forEach(function (b, i) {
      if (!isText(b) || !b.text) return;
      const box = RE_CHECKBOX.test(b.text);
      if ((isLabelled(b.text, 'A') && followedByB(i)) || (box && !(cur && cur.end === i - 1 && cur.box))) {
        cur = { start: i, end: i, answered: false, box: box };
        cores.push(cur);
      } else if (answerOf(b.text) !== null) {
        if (!cur || cur.answered) {
          cur = { start: i, end: i, box: false };
          cores.push(cur);
        }
        cur.answered = true;
        cur.end = i;
      } else if (cur && !cur.answered && (isLabelled(b.text) || box)) cur.end = i;
    });
    return cores;
  }

  /*
   * "1." may start a question or a list. Each question has its choices or answer after it, so look at the
   * numbered lines between one question's end and the next one's choices, and pick the one that fits.
   */
  function scanNumbers(blocks) {
    const found = new Map();
    let last = 0;
    let from = 0;
    findCores(blocks).forEach(function (core) {
      const near = [];
      let list = 0;
      for (let i = from; i < core.start; i++) {
        const h = isText(blocks[i]) && blocks[i].text ? asNumber(blocks[i].text) : null;
        if (!h) continue;
        // A list that begins at 1 inside this stretch: its later numbers are not questions.
        const item = list > 0 && h.num === list + 1;
        if (item || (h.num === 1 && last > 0)) list = h.num;
        near.push({ i: i, h: h, item: item });
      }
      const want = last + 1;
      const exact = near.filter(function (n) { return n.h.num === want; });
      const pick = exact.find(function (n) { return !n.item; }) || exact[exact.length - 1] ||
        near.find(function (n) { return !n.item && n.h.num > last && (last === 0 || n.h.num <= last + 5); }) ||
        near.find(function (n) { return n.h.num === 1; });
      if (pick) {
        found.set(pick.i, pick.h);
        last = pick.h.num;
      }
      from = core.end + 1;
    });
    return found;
  }

  // No numbers at all: a question is whatever stands between one answer and the next.
  function scanUnnumbered(blocks) {
    const starts = new Map();
    const blank = function (i) { return isText(blocks[i]) && !blocks[i].text; };
    const value = function (i) { return isText(blocks[i]) ? blocks[i].text : ''; };
    const answers = [];
    const runs = [];
    blocks.forEach(function (b, i) {
      if (!isText(b)) return;
      if (answerOf(b.text) !== null) answers.push(i);
      else if (isLabelled(b.text, 'A') || (RE_CHECKBOX.test(b.text) && !(i > 0 && RE_CHECKBOX.test(value(i - 1))))) {
        for (let j = i + 1; j < Math.min(blocks.length, i + 15); j++) {
          if (isLabelled(value(j), 'B') || RE_CHECKBOX.test(value(j))) {
            runs.push(i);
            break;
          }
        }
      }
    });

    function begin(from, to) {
      for (let j = from; j < to; j++) {
        if (blocks[j].k === 'img' || (value(j) && !(blocks[j].heading && j + 1 < to && blocks[j + 1].text))) {
          starts.set(j, { num: starts.size + 1, text: null });
          return;
        }
      }
    }
    function afterAnswer(at, to) {
      let j = at + 1;
      let spaced = false;
      for (let k = j; k < to; k++) if (blank(k)) spaced = true;
      if (!answerOf(value(at))) while (j < to && (blank(j) || (value(j) && !spaced && j === at + 1))) j++;
      if (spaced) while (j < to && !blank(j)) j++;
      for (;;) {
        while (j < to && blank(j)) j++;
        if (j >= to) break;
        const e = explanationOf(value(j));
        if (e === null && !RE_REFERENCE.test(value(j))) break;
        j++;
        if (spaced) while (j < to && !blank(j)) j++;
        else if (e === '' && j < to) j++;
      }
      return j;
    }

    if (answers.length) {
      answers.forEach(function (at, n) { begin(n ? afterAnswer(answers[n - 1], at) : 0, at); });
    } else {
      runs.forEach(function (at, n) {
        let from = 0;
        if (n) {
          from = runs[n - 1] + 1;
          while (from < at && (isLabelled(value(from)) || RE_CHECKBOX.test(value(from)))) from++;
          for (;;) {
            const e = from < at ? explanationOf(value(from)) : null;
            if (blank(from) && from < at) from++;
            else if (e !== null) {
              from++;
              while (from < at && !blank(from)) from++;
            } else break;
          }
        }
        begin(from, at);
      });
    }
    return starts;
  }

  /* ---------- whole documents ---------- */

  function tidy(blocks) {
    const out = [];
    blocks.forEach(function (b) {
      if (!isText(b)) {
        out.push(b);
        return;
      }
      const text = b.text.replace(/ /g, ' ').trim();
      // Choices written side by side: "A. one    B. two    C. three"
      const parts = text.split(/\s{2,}(?=\(?[B-J][.)]\s)/);
      const inOrder = parts.length >= 2 && parts.every(function (p, n) { return isLabelled(p, String.fromCharCode(65 + n)); });
      if (inOrder) parts.forEach(function (p) { out.push(Object.assign({}, b, { text: p.trim() })); });
      else out.push(text === b.text ? b : Object.assign({}, b, { text: text }));
    });
    return out;
  }

  function findKey(blocks) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (!isText(blocks[i]) || !RE_KEY_TITLE.test(blocks[i].text)) continue;
      const answers = new Map();
      let end = i + 1;
      for (; end < blocks.length; end++) {
        if (!isText(blocks[end])) break;
        const t = blocks[end].text;
        if (!t) continue;
        if (t.replace(RE_KEY_ITEM, '').trim()) break;
        for (const m of t.matchAll(RE_KEY_ITEM)) answers.set(Number(m[1]), m[2]);
      }
      if (answers.size >= 2) return { from: i, to: end, answers: answers };
    }
    return null;
  }

  function prepare(input) {
    let blocks = tidy(input);
    const key = findKey(blocks);
    if (key) blocks = blocks.slice(0, key.from).concat([{ k: 'key', answers: key.answers }], blocks.slice(key.to));

    const styles = [scan(blocks, asWord), scan(blocks, asQ), scan(blocks, asLabel), scanNumbers(blocks)];
    let heads = styles.reduce(function (best, s) { return s.size > best.size ? s : best; });
    if (!heads.size) heads = scanUnnumbered(blocks);

    const nextIsHead = function (i) {
      for (let j = i + 1; j < blocks.length; j++) {
        if (heads.has(j)) return true;
        if (!isText(blocks[j]) || blocks[j].text) return false;
      }
      return false;
    };
    const out = [];
    let auto = 0;
    blocks.forEach(function (b, i) {
      const h = heads.get(i);
      if (h) {
        auto++;
        out.push(Object.assign({}, b, { k: 'q', num: h.num || auto, text: h.text || '', indent: 0 }));
        if (h.text === null) out.push(b);
        return;
      }
      if (isText(b) && b.text) {
        const s = RE_SECTION.exec(b.text);
        const head = nextIsHead(i);
        if (s && (head || (out.length && /^Section/i.test(b.text)))) {
          if (!/^\(?none\)?$/i.test(s[1].trim())) out.push({ k: 's', text: s[1].trim(), sticky: head });
          return;
        }
        if (b.heading && head) {
          out.push({ k: 's', text: b.text, sticky: true });
          return;
        }
      }
      out.push(b);
    });
    return out;
  }

  Sim.layout = {
    prepare: prepare,
    answerOf: answerOf,
    explanationOf: explanationOf,
    readMark: readMark,
    RE_LABELLED: RE_LABELLED,
    RE_CHECKBOX: RE_CHECKBOX,
    RE_DIAGRAM: RE_DIAGRAM,
    RE_REFERENCE: RE_REFERENCE
  };
})();
