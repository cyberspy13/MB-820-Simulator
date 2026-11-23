/*
 * Draws one question. ctx:
 *   resp      the current answer (or undefined)
 *   set(resp) called when the candidate changes it
 *   locked    answers cannot be changed
 *   reveal    show the right answer and the explanation
 *   accepted  the candidate counted this answer as correct
 *   onAccept  called for "Count as correct" on questions with several valid orders
 *   onReveal  called when a check-it-yourself question is opened
 *   pool      order in which the steps of an ordering question are listed
 *   images    pictures by reference
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};
  const E = Sim.engine;
  const h = Sim.dom.h;
  const renderBlocks = Sim.dom.renderBlocks;

  function hint(q) {
    if (q.type === 'choice') return q.answer.length > 1 ? 'Select ' + q.answer.length + ' answers.' : '';
    if (q.type === 'match') return 'Choose one value for each row.';
    if (q.type === 'blanks') return 'Choose a value for each gap in the code.';
    if (q.type === 'order') return 'Click the steps to add them in the right order. The file lists only the steps that belong in the answer.';
    return 'This answer cannot be scored automatically. Work it out, show the answer, then mark yourself.';
  }

  function drawChoice(q, ctx) {
    const multi = q.answer.length > 1;
    let chosen = (ctx.resp || []).slice();
    const box = h('div', { class: 'options', role: multi ? 'group' : 'radiogroup', 'aria-label': 'Answers' });
    q.options.forEach(function (o) {
      const input = h('input', {
        type: multi ? 'checkbox' : 'radio',
        name: 'answer-' + q.id,
        'data-key': o.key,
        checked: chosen.indexOf(o.key) >= 0,
        disabled: !!ctx.locked,
        onchange: function () {
          if (!multi) chosen = [o.key];
          else if (input.checked) chosen = chosen.concat(o.key).sort();
          else chosen = chosen.filter(function (k) { return k !== o.key; });
          ctx.set(chosen.slice());
        }
      });
      const right = q.answer.indexOf(o.key) >= 0;
      let cls = 'option';
      if (ctx.reveal && right) cls += ' right';
      else if (ctx.reveal && chosen.indexOf(o.key) >= 0) cls += ' wrong';
      box.append(h('label', { class: cls },
        input,
        h('span', { class: 'key', text: o.key + '.' }),
        h('span', { class: 'option-text' },
          o.text,
          o.imgs.map(function (ref) { return Sim.dom.picture(ref, ctx.images); })),
        ctx.reveal && right ? h('span', { class: 'tag', text: 'Correct' }) : null));
    });
    return box;
  }

  function valueSelect(q, ctx, values, n) {
    const r = q.rows[n];
    const sel = h('select', {
      'aria-label': r.prompt,
      disabled: !!ctx.locked,
      onchange: function () {
        values[n] = sel.value || null;
        sel.title = sel.value;
        ctx.set(values.slice());
      }
    }, h('option', { value: '', text: 'Select…' }), r.options.map(function (o) { return h('option', { value: o, text: o }); }));
    sel.value = values[n] || '';
    sel.title = sel.value;
    if (ctx.reveal) sel.className = values[n] === r.answer ? 'right' : 'wrong';
    return sel;
  }

  function startValues(q, ctx) {
    return q.rows.map(function (_, i) { return (ctx.resp && ctx.resp[i]) || null; });
  }

  function drawMatch(q, ctx) {
    const values = startValues(q, ctx);
    const body = h('tbody', {});
    q.rows.forEach(function (r, n) {
      body.append(h('tr', {},
        h('td', { text: r.prompt }),
        h('td', {},
          valueSelect(q, ctx, values, n),
          ctx.reveal && values[n] !== r.answer ? h('div', { class: 'fix', text: 'Correct: ' + r.answer }) : null)));
    });
    return h('table', { class: 'match' }, body);
  }

  function drawBlanks(q, ctx) {
    const values = startValues(q, ctx);
    const pre = h('pre', { class: 'code gaps' });
    let n = 0;
    q.code.split(/(_{4,})/).forEach(function (part) {
      if (/^_{4,}$/.test(part) && n < q.rows.length) {
        pre.append(h('span', { class: 'gap' },
          h('sup', { text: String(n + 1) }),
          valueSelect(q, ctx, values, n)));
        n++;
      } else {
        pre.append(part);
      }
    });
    return pre;
  }

  function drawOrder(q, ctx) {
    const box = h('div', { class: 'order' });
    let picked = (ctx.resp || []).slice();
    const pool = ctx.pool || q.items.map(function (_, i) { return i; });

    function change(list) {
      picked = list;
      ctx.set(picked.slice());
      draw();
    }
    function move(i, by) {
      const list = picked.slice();
      const t = list[i];
      list[i] = list[i + by];
      list[i + by] = t;
      change(list);
    }
    function draw() {
      const left = h('div', { class: 'order-col' }, h('h4', { text: 'Steps' }));
      pool.forEach(function (n) {
        const used = picked.indexOf(n) >= 0;
        left.append(h('button', {
          type: 'button',
          class: 'step',
          disabled: !!ctx.locked || used,
          text: q.items[n],
          onclick: function () { change(picked.concat(n)); }
        }));
      });
      const list = h('ol', {});
      picked.forEach(function (n, i) {
        let cls = 'placed';
        if (ctx.reveal) cls += q.items[n] === q.items[i] ? ' right' : ' wrong';
        list.append(h('li', { class: cls },
          h('span', { class: 'placed-text', text: q.items[n] }),
          ctx.locked ? null : h('span', { class: 'placed-tools' },
            h('button', { type: 'button', class: 'mini', 'aria-label': 'Move up', title: 'Move up', text: '↑', disabled: i === 0, onclick: function () { move(i, -1); } }),
            h('button', { type: 'button', class: 'mini', 'aria-label': 'Move down', title: 'Move down', text: '↓', disabled: i === picked.length - 1, onclick: function () { move(i, 1); } }),
            h('button', { type: 'button', class: 'mini', 'aria-label': 'Remove', title: 'Remove', text: '✕', onclick: function () { change(picked.filter(function (x) { return x !== n; })); } }))));
      });
      const right = h('div', { class: 'order-col' }, h('h4', { text: 'Your order' }),
        picked.length ? list : h('p', { class: 'muted', text: 'Nothing added yet.' }));
      box.replaceChildren(left, right);
    }
    draw();
    return box;
  }

  function drawSelf(q, ctx) {
    const resp = Object.assign({ note: '', mark: '' }, ctx.resp);
    const note = h('textarea', {
      rows: 4,
      placeholder: 'Your answer (optional)',
      'aria-label': 'Your answer',
      readOnly: !!ctx.locked,
      oninput: function () {
        resp.note = note.value;
        ctx.set(Object.assign({}, resp));
      }
    });
    note.value = resp.note;
    const box = h('div', { class: 'self' }, note);
    if (!ctx.reveal) {
      box.append(h('button', { type: 'button', class: 'btn', text: 'Show the answer and mark myself', onclick: ctx.onReveal }));
      return box;
    }
    box.append(h('h4', { text: 'Answer from the file' }));
    if (q.solution && q.solution.length) box.append(renderBlocks(q.solution, ctx.images));
    else box.append(h('p', { class: 'muted', text: 'The file has no separate answer for this question. Check the pictures above.' }));
    const bar = h('div', { class: 'self-marks' });
    function drawMarks() {
      bar.replaceChildren.apply(bar, [['right', 'I got it right'], ['wrong', 'I got it wrong']].map(function (m) {
        return h('button', {
          type: 'button',
          class: 'btn' + (resp.mark === m[0] ? ' chosen' : ''),
          'aria-pressed': resp.mark === m[0] ? 'true' : 'false',
          text: m[1],
          onclick: function () {
            resp.mark = m[0];
            ctx.set(Object.assign({}, resp));
            drawMarks();
          }
        });
      }));
    }
    drawMarks();
    box.append(bar);
    return box;
  }

  const DRAW = { choice: drawChoice, match: drawMatch, blanks: drawBlanks, order: drawOrder, self: drawSelf };
  const VERDICT = { correct: 'Correct', partial: 'Partly correct', wrong: 'Not correct', unanswered: 'Not answered' };

  function answerPanel(q, ctx) {
    const result = E.outcome(q, ctx.resp, ctx.accepted);
    const panel = h('section', { class: 'answer-panel ' + result, 'aria-label': 'Answer' });
    if (q.type !== 'self') {
      panel.append(h('p', { class: 'verdict', text: VERDICT[result] }), h('h4', { text: 'Correct answer' }));
      const lines = E.answerLines(q);
      panel.append(h('ul', { class: 'plain' }, lines.map(function (line) { return h('li', { text: line }); })));
      if (q.anyOrder && (result === 'wrong' || result === 'partial') && ctx.onAccept) {
        panel.append(
          h('p', { class: 'muted', text: 'This question says more than one order is correct, but the file gives only one of them.' }),
          h('button', { type: 'button', class: 'btn', text: 'Count my order as correct', onclick: ctx.onAccept }));
      }
    }
    if (q.explanation && q.explanation.length) {
      panel.append(h('h4', { text: 'Explanation' }), renderBlocks(q.explanation, ctx.images));
    }
    return panel;
  }

  function draw(q, ctx) {
    const box = h('div', { class: 'question' });
    box.append(renderBlocks(q.stem, ctx.images));
    const note = hint(q);
    if (note) box.append(h('p', { class: 'hint', text: note }));
    box.append(DRAW[q.type](q, ctx));
    if (ctx.reveal) box.append(answerPanel(q, ctx));
    return box;
  }

  Sim.question = { draw: draw, VERDICT: VERDICT };
})();
