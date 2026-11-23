/* A simple four-function calculator in a floating panel. */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};
  const h = Sim.dom.h;

  // Kept apart from the panel so it can be tested.
  function machine() {
    let shown = '0';
    let stored = null;
    let op = null;
    let fresh = true;

    function compute(a, b, sign) {
      if (sign === '+') return a + b;
      if (sign === '−') return a - b;
      if (sign === '×') return a * b;
      return b === 0 ? NaN : a / b;
    }
    function show(n) {
      shown = Number.isFinite(n) ? String(Number(n.toPrecision(12))) : 'Error';
    }
    function press(k) {
      if (k === 'C' || shown === 'Error') {
        shown = '0';
        stored = null;
        op = null;
        fresh = true;
        if (k === 'C') return shown;
      }
      if (/^\d$/.test(k)) {
        shown = fresh || shown === '0' ? k : shown + k;
        fresh = false;
      } else if (k === '.') {
        if (fresh) shown = '0.';
        else if (shown.indexOf('.') < 0) shown += '.';
        fresh = false;
      } else if (k === '±') {
        show(-Number(shown));
      } else if (k === '⌫') {
        shown = fresh || shown.length < 2 ? '0' : shown.slice(0, -1);
      } else {
        if (op && !fresh) show(compute(stored, Number(shown), op));
        stored = shown === 'Error' ? null : Number(shown);
        op = k === '=' || shown === 'Error' ? null : k;
        fresh = true;
      }
      return shown;
    }
    return { press: press };
  }

  let panel = null;

  function toggle() {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    const calc = machine();
    const out = h('output', { class: 'calc-out', text: '0' });
    const keys = ['C', '⌫', '±', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '0', '.', '='];
    panel = h('section', { class: 'calc', 'aria-label': 'Calculator' },
      h('div', { class: 'calc-head' }, h('span', { text: 'Calculator' }),
        h('button', { type: 'button', class: 'dlg-x', 'aria-label': 'Close calculator', text: '✕', onclick: toggle })),
      out,
      h('div', { class: 'calc-keys' }, keys.map(function (k) {
        return h('button', {
          type: 'button',
          class: 'calc-key' + (k === '=' ? ' equals' : ''),
          text: k,
          onclick: function () { out.textContent = calc.press(k); }
        });
      })));
    document.body.append(panel);
  }

  function close() {
    if (panel) toggle();
  }

  Sim.calculator = { toggle: toggle, close: close, machine: machine };
})();
