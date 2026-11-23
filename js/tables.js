/*
 * Questions laid out in rows: Excel and OpenDocument sheets, CSV files, and tables inside documents.
 * Works out which column is which, and lets the upload window change that. No DOM.
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const ROLES = [
    ['', 'Ignore'], ['number', 'Question number'], ['question', 'Question'], ['option', 'Answer choice'],
    ['options', 'All answer choices in one cell'], ['correct', 'Correct answer'], ['flag', 'Is this choice correct?'],
    ['explanation', 'Explanation'], ['section', 'Section or topic'], ['type', 'Question type']
  ];
  const RE_YES = /^(?:true|yes|y|x|1|correct|right|✓|✔|√|☑|☒)$/i;
  const RE_NO = /^(?:false|no|n|0|incorrect|wrong|☐|-|)$/i;

  /* ---------- CSV ---------- */

  function splitCsv(text, sep) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const push = function () {
      row.push(cell);
      cell = '';
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell === '') quoted = true;
      else if (c === sep) push();
      else if (c === '\n') {
        push();
        rows.push(row);
        row = [];
      } else if (c !== '\r') cell += c;
    }
    if (cell || row.length) {
      push();
      rows.push(row);
    }
    return rows;
  }

  function csv(text, forced) {
    let body = text.replace(/^﻿/, '');
    const declared = /^sep=(.)\r?\n/i.exec(body);
    if (declared) body = body.slice(declared[0].length);
    let best = null;
    (forced ? [forced] : declared ? [declared[1]] : [',', ';', '\t', '|']).forEach(function (sep) {
      const rows = splitCsv(body, sep).filter(function (r) { return r.some(function (c) { return c.trim(); }); });
      const widths = rows.slice(0, 40).map(function (r) { return r.length; });
      const usual = widths.slice().sort(function (a, b) { return a - b; })[Math.floor(widths.length / 2)] || 0;
      const steady = widths.filter(function (w) { return w === usual; }).length / Math.max(1, widths.length);
      const score = usual > 1 ? usual * steady : 0;
      if (!best || score > best.score) best = { rows: rows, score: score };
    });
    const width = best.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    return best.rows.map(function (r) {
      const out = [];
      for (let i = 0; i < width; i++) out.push({ text: (r[i] || '').replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, ''), imgs: [], bold: false, highlight: false });
      return out;
    });
  }

  /* ---------- columns ---------- */

  function tidy(header) {
    return header.toLowerCase().replace(/\(s\)/g, 's').split(/\s+[-–—:]\s+|\n/)[0].replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9#?]+/g, ' ').trim();
  }

  function roleOf(header) {
    const h = tidy(header);
    if (!h || h.length > 45) return '';
    if (/^(?:question|questions|q|stem|prompt|problem|item|question (?:text|title|stem|body|statement|content|description))$/.test(h)) return 'question';
    if (/^(?:#|no|nr|num|number|id|sn|s no|sr|sr no|sl no|row|(?:q|question) ?(?:#|no|nr|number|id))$/.test(h)) return 'number';
    if (/^(?:type|kind|format|(?:q|question) type)$/.test(h)) return 'type';
    if (/^(?:is ?(?:it )?(?:correct|right)\??|correct\?|right\?)$/.test(h)) return 'flag';
    if (/^(?:wrong|incorrect|false) (?:answer|option|choice|response)s?(?: ?\d+)?$/.test(h)) return 'option';
    if (/^(?:the )?(?:correct|right) ?(?:answer|ans|option|choice|response|key)?s?(?: (?:key|letter|option|index|number|no))?$/.test(h)) return 'correct';
    if (/^(?:answer|answers|ans|answer key|key|solution|answer letter)$/.test(h)) return 'correct';
    if (/^(?:answer |possible )?(?:option|choice|answer|alternative|response|opt|ans|distractor)s? ?(?:[a-j]|\d{1,2}|one|two|three|four|five|six)$/.test(h)) return 'option';
    if (/^[a-j]$/.test(h)) return 'option';
    if (/^(?:answer |possible )?(?:options|choices|alternatives|responses)$|^possible answers$/.test(h)) return 'options';
    if (/^(?:option|choice|answer option|answer choice|alternative|answer text|option text)$/.test(h)) return 'options';
    if (/^(?:explanations?|rationale|(?:general |answer )?feedback|reason(?:ing)?|comments?|notes?|references?|justification|(?:answer )?explanation(?: reference)?|learn more|source|hint)$/.test(h)) return 'explanation';
    if (/^(?:section|topic|category|domain|chapter|module|area|subject|tags?|skills?|skill area|objective|unit|theme|group)$/.test(h)) return 'section';
    return '';
  }

  function complete(roles) {
    const has = function (r) { return roles.indexOf(r) >= 0; };
    const options = roles.filter(function (r) { return r === 'option'; }).length;
    return has('question') && (has('correct') || has('flag') || has('options') || options >= 2);
  }

  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length - 1, 15); i++) {
      const roles = rows[i].map(function (c) { return roleOf(c.text); });
      // Only one column can hold the question; a second match is something else.
      const first = roles.indexOf('question');
      const clean = roles.map(function (r, n) { return r === 'question' && n !== first ? '' : r; });
      if (complete(clean)) return { index: i, roles: clean };
    }
    return null;
  }

  function looksLikeQuestions(rows) {
    return rows.length >= 2 && !!findHeader(rows);
  }

  // No usable headings: judge the columns by what is in them.
  function guess(rows) {
    const filled = rows.filter(function (r) { return r.some(function (c) { return c.text; }); });
    if (filled.length < 2 || filled[0].length < 3) return null;
    const cols = filled[0].map(function (_, n) {
      const texts = filled.map(function (r) { return r[n].text.trim(); });
      const used = texts.filter(Boolean);
      return {
        share: used.length / filled.length,
        length: used.reduce(function (s, t) { return s + t.length; }, 0) / Math.max(1, used.length),
        letters: used.filter(function (t) { return Sim.parser.parseLetters(t); }).length / Math.max(1, used.length),
        numbers: used.filter(function (t) { return /^\d{1,4}\.?$/.test(t); }).length / Math.max(1, used.length)
      };
    });
    const answer = cols.findIndex(function (c) { return c.share > 0.6 && c.letters > 0.7; });
    let question = -1;
    cols.forEach(function (c, n) {
      if (n !== answer && c.share > 0.6 && c.length >= 12 && (question < 0 || c.length > cols[question].length * 1.5)) question = question < 0 ? n : question;
    });
    if (answer < 0 || question < 0) return null;
    const roles = cols.map(function (c, n) {
      if (n === question) return 'question';
      if (n === answer) return 'correct';
      if (n < question && c.numbers > 0.8) return 'number';
      if (n > question && n < answer) return 'option';
      if (answer < question && n > question) return 'option';
      if (n > answer && n > question && c.length > 15) return 'explanation';
      return '';
    });
    return complete(roles) && roles.filter(function (r) { return r === 'option'; }).length >= 2 ? { index: -1, roles: roles } : null;
  }

  // { index: header row or -1, roles: one per column } or null
  function plan(rows) {
    return findHeader(rows) || guess(rows);
  }

  /* ---------- rows to questions ---------- */

  function splitOptions(text) {
    let parts = text.split('\n');
    if (parts.length < 2) {
      const inline = text.split(/\s+(?=\(?[A-J][.)]\s)/);
      if (inline.length >= 2 && /^\(?A[.)]/.test(inline[0].trim())) parts = inline;
      else if (text.indexOf('|') >= 0) parts = text.split('|');
      else if (text.indexOf(';') >= 0) parts = text.split(';');
    }
    return parts.map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function unlabel(text, n) {
    const m = /^\(?([A-Ja-j])[.):\]]\s+([\s\S]+)$/.exec(text);
    return m && m[1].toUpperCase() === String.fromCharCode(65 + n) ? m[2] : text;
  }

  function option(text, cell) {
    const made = Sim.parser.readMark(text);
    return { text: made.text, mark: made.marked, highlight: !!cell.highlight, bold: !!cell.bold, imgs: cell.imgs || [] };
  }

  // key: answers by question number, from a separate answer sheet.
  function toQuestions(table, how, key) {
    const at = function (role) { return how.roles.indexOf(role); };
    const column = {};
    ['number', 'question', 'options', 'correct', 'flag', 'explanation', 'section', 'type'].forEach(function (r) { column[r] = at(r); });
    const choices = [];
    how.roles.forEach(function (r, n) { if (r === 'option') choices.push(n); });
    const rows = table.rows.slice(how.index + 1);
    const cell = function (row, role) { return column[role] >= 0 ? row[column[role]] : { text: '', imgs: [] }; };

    // One choice per row, with the question written once above or repeated.
    const flag = column.flag >= 0 ? column.flag : column.correct;
    const single = column.options >= 0 ? column.options : choices.length === 1 ? choices[0] : -1;
    const values = flag >= 0 ? rows.map(function (r) { return r[flag].text.trim(); }) : [];
    const long = single >= 0 && flag >= 0 && values.length > 2 &&
      values.every(function (v) { return RE_YES.test(v) || RE_NO.test(v); }) && values.some(function (v) { return RE_YES.test(v); }) &&
      rows.some(function (r, i) { const q = cell(r, 'question').text; return i > 0 && r[single].text && (!q || q === cell(rows[i - 1], 'question').text); });

    const items = [];
    let section = '';
    let current = null;
    rows.forEach(function (row) {
      const q = cell(row, 'question');
      const used = row.filter(function (c) { return c.text || c.imgs.length; });
      if (!used.length) return;
      if (cell(row, 'section').text) section = cell(row, 'section').text.trim();
      if (long) {
        if (q.text && (!current || current.question !== q.text || (column.number >= 0 && cell(row, 'number').text && cell(row, 'number').text !== current.numberText))) {
          current = { question: q.text, numberText: cell(row, 'number').text, number: cell(row, 'number').text, imgs: q.imgs.slice(), options: [], correct: '', explanation: '', section: section, type: cell(row, 'type').text };
          items.push(current);
        }
        if (!current) return;
        const c = row[single];
        if (c.text || c.imgs.length) {
          const o = option(c.text, c);
          o.mark = RE_YES.test(row[flag].text.trim());
          current.options.push(o);
        }
        if (cell(row, 'explanation').text) current.explanation += (current.explanation ? '\n' : '') + cell(row, 'explanation').text;
        current.longRow = true;
        return;
      }
      if (!q.text.trim()) {
        // A row holding only a picture, or a continuation, belongs to the question above.
        if (current) row.forEach(function (c) { c.imgs.forEach(function (ref) { current.imgs.push(ref); }); });
        return;
      }
      const options = [];
      choices.forEach(function (n) { if (row[n].text.trim() || row[n].imgs.length) options.push(option(row[n].text.trim(), row[n])); });
      if (!options.length && column.options >= 0) {
        splitOptions(row[column.options].text).forEach(function (t) { options.push(option(t, {})); });
      }
      options.forEach(function (o, n) { o.text = unlabel(o.text, n); });
      const correct = cell(row, 'correct').text.trim();
      const lone = used.length === 1 && used[0] === q;
      if (lone && rows.length > 2 && q.text.length < 60 && !/[?:]$/.test(q.text.trim()) && (choices.length || column.correct >= 0)) {
        section = q.text.trim();
        return;
      }
      const placed = new Set(choices);
      const imgs = [];
      row.forEach(function (c, n) { if (!placed.has(n)) c.imgs.forEach(function (ref) { imgs.push(ref); }); });
      current = {
        question: q.text, number: cell(row, 'number').text, imgs: imgs, options: options, correct: correct,
        explanation: cell(row, 'explanation').text, section: section, type: cell(row, 'type').text
      };
      items.push(current);
    });
    return items.map(function (item, n) {
      const found = /(\d{1,5})/.exec(item.number || '');
      const num = found ? Number(found[1]) : n + 1;
      if (!item.correct && !item.longRow && key && key.has(num)) item.correct = key.get(num);
      return Sim.parser.fromRow(item, num);
    });
  }

  // Sheets that are not a table of questions: read them like a page of text.
  function toBlocks(rows) {
    return Sim.office.tableBlocks(rows.map(function (row) {
      return row.map(function (c) {
        if (c.blocks) return c;
        const lines = c.text.split('\n').map(function (t) { return { k: 'p', text: t.trim(), indent: 0, bold: c.bold, highlight: c.highlight }; });
        return Object.assign({}, c, { blocks: lines.concat(c.imgs.map(function (ref) { return { k: 'img', ref: ref }; })) });
      });
    }));
  }

  Sim.tables = { ROLES: ROLES, csv: csv, plan: plan, complete: complete, findHeader: findHeader, looksLikeQuestions: looksLikeQuestions, toQuestions: toQuestions, toBlocks: toBlocks, roleOf: roleOf };
})();
