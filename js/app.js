/* The screens: library, exam setup, begin page, questions, review and score report. */
(function () {
  'use strict';
  const Sim = window.Sim;
  const E = Sim.engine;
  const S = Sim.store;
  const prefs = S.prefs;
  const h = Sim.dom.h;
  const root = document.getElementById('app');

  const SAVE_EVERY = 5000;
  const SLEEP_GAP = 120000; // a longer pause between ticks means the computer slept

  const st = {
    view: '',
    exam: null,
    content: null,
    byId: new Map(),
    session: null,
    nav: null,      // { label, list } while going through flagged or unanswered questions only
    reveal: false,
    tick: null,
    last: 0,
    unsaved: 0,
    ui: {}
  };

  /* ---------- small pieces ---------- */

  function show(view, el) {
    st.view = view;
    root.replaceChildren(el);
    window.scrollTo(0, 0);
  }

  function titleBar(text) {
    const parts = [h('span', { class: 'app-name', text: 'MB-820 Exam Simulator' })];
    if (text) parts.push(h('span', { class: 'app-sub', text: text }));
    return h('div', { class: 'titlebar' }, parts);
  }

  function button(label, onclick, props) {
    return h('button', Object.assign({ type: 'button', class: 'btn', text: label, onclick: onclick }, props || {}));
  }

  function zoomControl() {
    const out = h('output', { text: zoom() + '%' });
    const range = h('input', {
      type: 'range', min: 50, max: 200, step: 10, value: zoom(), 'aria-label': 'Text size',
      oninput: function () {
        prefs.set('zoom', Number(range.value));
        out.textContent = range.value + '%';
        applyZoom();
      }
    });
    return h('div', { class: 'zoom' }, out, range);
  }

  function zoom() {
    const z = Number(prefs.get('zoom', 100));
    return z >= 50 && z <= 200 ? z : 100;
  }

  function applyZoom() {
    document.documentElement.style.setProperty('--zoom', String(zoom() / 100));
  }

  function date(ms) {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function index() {
    st.byId = new Map(st.content.questions.map(function (q) { return [q.id, q]; }));
  }

  async function load(examId) {
    st.exam = await S.get('exams', examId);
    st.content = await S.get('content', examId);
    index();
  }

  async function loadStats(examId) {
    return (await S.get('stats', examId)) || { id: examId, q: {} };
  }

  function question() {
    return st.byId.get(st.session.order[st.session.idx]);
  }

  function modeLabel(cfg) {
    if (cfg.mode === 'exam') return cfg.exam;
    if (cfg.mode === 'sections') return cfg.sections.length === 1 ? cfg.sections[0] : cfg.sections.length + ' sections';
    if (cfg.mode === 'count') return cfg.count + ' questions';
    if (cfg.mode === 'range') return 'Questions ' + cfg.from + ' to ' + cfg.to;
    if (cfg.mode === 'wrong') return 'Answered incorrectly ' + cfg.wrong + '+ times';
    return cfg.label || 'Selected questions';
  }

  /* ---------- library ---------- */

  async function library(selectId) {
    stopClock();
    Sim.calculator.close();
    st.session = null;
    const exams = (await S.all('exams')).sort(function (a, b) { return b.created - a.created; });
    const sessions = new Set((await S.all('sessions')).map(function (s) { return s.id; }));
    let current = exams.find(function (x) { return x.id === (selectId || prefs.get('lastExam', '')); }) || exams[0] || null;

    const body = h('tbody', {});
    const actions = h('div', { class: 'side' });

    function drawActions() {
      const none = !current;
      const saved = current && sessions.has(current.id);
      actions.replaceChildren(
        button('Start exam', function () { setup(current); }, { class: 'btn primary', disabled: none }),
        button('Resume', function () { resume(current); }, { disabled: !saved }),
        button('Upload questions', function () { upload(); }),
        button('History', function () { history(current); }, { disabled: none }),
        button('Properties', function () { properties(current); }, { disabled: none }),
        button('Export', async function () {
          Sim.importer.exportPackage(current, await S.get('content', current.id));
        }, { disabled: none }),
        button('Remove', function () { removeExam(current); }, { class: 'btn danger', disabled: none })
      );
    }
    function pick(x) {
      current = x;
      prefs.set('lastExam', x.id);
      Array.from(body.children).forEach(function (tr) {
        const on = tr.dataset.id === x.id;
        tr.classList.toggle('selected', on);
        tr.querySelector('input').checked = on;
      });
      drawActions();
    }

    exams.forEach(function (x) {
      body.append(h('tr', { 'data-id': x.id, onclick: function () { pick(x); }, ondblclick: function () { setup(x); } },
        h('td', {}, h('label', { class: 'pick' },
          h('input', { type: 'radio', name: 'exam', onchange: function () { pick(x); } }),
          h('span', {}, h('strong', { text: x.title }), x.heading ? h('span', { class: 'muted block', text: x.heading }) : null))),
        h('td', { class: 'num', text: String(x.count) }),
        h('td', { class: 'num', text: String(x.exams.length) }),
        h('td', { text: x.last ? x.last.scaled + ' / 1000' + (x.last.passed ? ' (pass)' : ' (fail)') : '' }),
        h('td', { text: sessions.has(x.id) ? 'Saved session' : '' })));
    });

    const main = exams.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, ['Exam file', 'Questions', 'Exams', 'Last score', ''].map(function (t, i) {
            return h('th', { text: t, scope: 'col', class: i === 1 || i === 2 ? 'num' : '' });
          }))), body))
      : h('div', { class: 'empty' },
          h('h2', { text: 'No questions yet' }),
          h('p', { text: 'Upload a PDF or text file with questions, or try the built-in samples first.' }),
          h('div', { class: 'row' },
            button('Upload questions', function () { upload(); }, { class: 'btn primary' }),
            button('Load samples', async function () { library((await Sim.importer.addSamples()).id); })));

    const warning = S.persistent ? null
      : h('p', { class: 'warn', text: 'This browser is blocking storage, so questions and results will be lost when you close this window.' });

    show('library', h('div', { class: 'screen' }, titleBar(), warning, h('div', { class: 'library' }, main, exams.length ? actions : null)));
    if (current) pick(current);
  }

  async function upload(files) {
    const meta = await Sim.importer.open(files);
    if (meta) library(meta.id);
  }

  async function removeExam(x) {
    const yes = await Sim.dom.confirmBox('Remove exam file', ['Remove "' + x.title + '" with its history and saved session? This cannot be undone.'], 'Remove', true);
    if (!yes) return;
    const past = (await S.all('history')).filter(function (r) { return r.examId === x.id; });
    for (const r of past) await S.remove('history', r.id);
    for (const store of ['sessions', 'stats', 'content', 'exams']) await S.remove(store, x.id);
    library();
  }

  async function properties(x) {
    const title = h('input', { type: 'text', value: x.title });
    const heading = h('input', { type: 'text', value: x.heading });
    const passing = h('input', { type: 'number', min: 0, max: 1000, step: 10, value: x.passing });
    const minutes = h('input', { type: 'number', min: 1, max: 600, value: x.minutes });
    const field = function (label, el) { return h('label', { class: 'field' }, h('span', { text: label }), el); };
    const ok = await Sim.dom.dialog('Properties', [
      field('Name', title),
      field('Heading on the first page', heading),
      field('Passing score (out of 1000)', passing),
      field('Time limit (minutes)', minutes),
      h('h3', { text: 'Exams in this file' }),
      h('ul', {}, x.exams.map(function (e) { return h('li', { text: e.name + ': ' + e.count + ' questions from ' + e.source }); }))
    ], [{ label: 'Save', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (!ok) return;
    x.title = title.value.trim() || x.title;
    x.heading = heading.value.trim();
    x.passing = clamp(passing.value, 0, 1000, 700);
    x.minutes = clamp(minutes.value, 1, 600, 120);
    await S.put('exams', x);
    library(x.id);
  }

  function clamp(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || value === '') return fallback;
    return Math.min(max, Math.max(min, n));
  }

  async function history(x) {
    const past = (await S.all('history')).filter(function (r) { return r.examId === x.id; })
      .sort(function (a, b) { return b.date - a.date; });
    let chosen = null;
    let d = null;
    const rows = past.map(function (r) {
      return h('tr', {},
        h('td', { text: date(r.date) }),
        h('td', { text: r.candidate }),
        h('td', { text: modeLabel(r.cfg) + (r.training ? ' (training)' : '') }),
        h('td', { class: 'num', text: r.result.scaled + ' / 1000' }),
        h('td', { text: r.result.passed ? 'Pass' : 'Fail' }),
        h('td', {}, button('Open', function (e) {
          chosen = r;
          d = e.target.closest('dialog');
          d.close();
        }, { class: 'btn small' })));
    });
    await Sim.dom.dialog('History: ' + x.title, past.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, ['Date', 'Candidate', 'Questions', 'Score', 'Result', ''].map(function (t) { return h('th', { text: t, scope: 'col' }); }))),
          h('tbody', {}, rows)))
      : h('p', { text: 'No finished exams yet.' }),
    [{ label: 'Close', value: true, primary: true }], 'wide');
    if (chosen) {
      await load(x.id);
      report(chosen);
    }
  }

  /* ---------- exam setup ---------- */

  async function setup(x) {
    await load(x.id);
    const stats = await loadStats(x.id);
    const all = st.content.questions;
    const total = all.length;
    const prev = prefs.get('setup:' + x.id, {});
    const hasSections = x.sections.length > 1;
    const maxWrong = all.reduce(function (m, q) { return Math.max(m, E.wrongCount(stats, q.id)); }, 0);

    const name = h('input', { type: 'text', value: prefs.get('candidate', 'Candidate Name') });
    const modes = {};
    function mode(value, disabled) {
      const el = h('input', { type: 'radio', name: 'exam-mode', disabled: !!disabled, onchange: sync });
      el.dataset.mode = value;
      modes[value] = el;
      return el;
    }
    const number = function (min, max, value, label) {
      return h('input', { type: 'number', min: min, max: max, value: value, class: 'spin', 'aria-label': label, oninput: sync });
    };

    const examSelect = h('select', { 'aria-label': 'Exam', onchange: sync }, x.exams.map(function (e) {
      return h('option', { value: e.name, text: e.name + ' (' + e.count + ')' });
    }));
    if (x.exams.some(function (e) { return e.name === prev.exam; })) examSelect.value = prev.exam;

    const boxes = x.sections.map(function (s) {
      return h('input', { type: 'checkbox', 'data-name': s.name, checked: !prev.sections || prev.sections.indexOf(s.name) >= 0, onchange: sync });
    });
    const sectionList = h('div', { class: 'sections' }, hasSections
      ? x.sections.map(function (s, i) { return h('label', {}, boxes[i], s.name + ' (' + s.count + ')'); })
      : h('span', { class: 'muted', text: 'There are no sections in the exam.' }));
    const setAll = function (on) {
      return function () {
        boxes.forEach(function (b) { b.checked = on; });
        sync();
      };
    };
    const allBtn = button('Select All', setAll(true));
    const noneBtn = button('Deselect All', setAll(false));

    const count = number(1, total, clamp(prev.count, 1, total, total), 'Number of questions');
    const from = number(1, total, clamp(prev.from, 1, total, 1), 'First question');
    const to = number(1, total, clamp(prev.to, 1, total, total), 'Last question');
    const wrong = number(1, Math.max(1, maxWrong), clamp(prev.wrong, 1, Math.max(1, maxWrong), 1), 'Times answered incorrectly');
    const training = h('input', { type: 'checkbox', checked: !!prev.training });
    const mixed = h('input', { type: 'checkbox', checked: prev.shuffle !== false });
    const timerOn = h('input', { type: 'checkbox', checked: prev.timerOn !== false, onchange: sync });
    const minutes = number(1, 600, clamp(prev.minutes, 1, 600, x.minutes), 'Time limit in minutes');
    const summary = h('p', { class: 'setup-summary', 'aria-live': 'polite' });
    let okBtn = null;

    function config() {
      const chosen = Object.keys(modes).find(function (k) { return modes[k].checked; });
      const a = clamp(from.value, 1, total, 1);
      const b = clamp(to.value, 1, total, total);
      return {
        candidate: name.value.trim() || 'Candidate',
        mode: chosen,
        exam: examSelect.value,
        sections: boxes.filter(function (el) { return el.checked; }).map(function (el) { return el.dataset.name; }),
        count: clamp(count.value, 1, total, total),
        from: Math.min(a, b),
        to: Math.max(a, b),
        wrong: clamp(wrong.value, 1, Math.max(1, maxWrong), 1),
        training: training.checked,
        shuffle: mixed.checked,
        timerOn: timerOn.checked,
        minutes: clamp(minutes.value, 1, 600, x.minutes)
      };
    }
    function sync() {
      const cfg = config();
      examSelect.disabled = cfg.mode !== 'exam';
      const inSections = cfg.mode === 'sections';
      boxes.forEach(function (b) { b.disabled = !inSections; });
      allBtn.disabled = noneBtn.disabled = !inSections;
      sectionList.classList.toggle('off', !inSections);
      count.disabled = cfg.mode !== 'count';
      from.disabled = to.disabled = cfg.mode !== 'range';
      wrong.disabled = cfg.mode !== 'wrong';
      minutes.disabled = !timerOn.checked;
      const n = E.select(all, cfg, stats).length;
      summary.textContent = n === 1 ? '1 question selected' : n + ' questions selected';
      if (okBtn) okBtn.disabled = n === 0;
    }

    const line = function () {
      const kids = Array.from(arguments);
      return h('div', { class: 'mode' }, kids);
    };
    const body = [
      h('label', { class: 'field' }, h('span', { text: 'Candidate name:' }), name),
      h('fieldset', {}, h('legend', { text: 'Exam Mode' }),
        line(h('label', {}, mode('exam'), 'Take selected exam:'), examSelect),
        line(h('label', { class: hasSections ? '' : 'off' }, mode('sections', !hasSections), 'Take questions from selected sections only:')),
        h('div', { class: 'sections-box' }, sectionList, h('div', { class: 'row' }, allBtn, noneBtn)),
        line(h('label', {}, mode('count'), 'Take'), count, 'questions from entire exam file'),
        line(h('label', {}, mode('range'), 'Take question range from'), from, 'to', to),
        line(h('label', { class: maxWrong ? '' : 'off' }, mode('wrong', !maxWrong), 'Take questions that I have answered incorrectly'), wrong, 'or more times'),
        line(h('label', {}, training, 'Training mode'), h('span', { class: 'muted', text: 'checks each answer as you go' })),
        line(h('label', {}, mixed, 'Show questions in random order'))),
      h('fieldset', {}, h('legend', { text: 'Timer' }),
        line(h('label', {}, timerOn, 'Timer on'), h('span', { class: 'push', text: 'Time limit (minutes):' }), minutes)),
      summary
    ];
    const start = modes[prev.mode] && !modes[prev.mode].disabled ? prev.mode : 'exam';
    modes[start].checked = true;
    sync();

    const ok = await Sim.dom.dialog('Exam Mode for ' + x.title, body, [
      { label: 'OK', value: true, primary: true, bind: function (el) { okBtn = el; } },
      { label: 'Cancel', value: false }
    ], 'setup');
    if (!ok) return;
    const cfg = config();
    const ids = E.select(all, cfg, stats);
    if (!ids.length || !(await mayReplaceSession(x))) return;
    prefs.set('candidate', cfg.candidate);
    prefs.set('setup:' + x.id, cfg);
    begin(cfg, ids);
  }

  async function mayReplaceSession(x) {
    if (!(await S.get('sessions', x.id))) return true;
    return Sim.dom.confirmBox('Start a new exam', 'There is a saved session for this exam file. Starting again replaces it.', 'Start again');
  }

  /* ---------- begin page and session ---------- */

  function begin(cfg, ids) {
    st.session = E.newSession(st.exam.id, cfg, ids, st.byId, Date.now());
    st.nav = null;
    const s = st.session;
    const facts = [
      s.order.length === 1 ? '1 question' : s.order.length + ' questions',
      s.timer.on ? cfg.minutes + ' minutes' : 'No time limit',
      'Passing score ' + st.exam.passing + ' of 1000'
    ];
    if (s.training) facts.push('Training mode');
    show('begin', h('div', { class: 'screen exam' },
      titleBar(st.exam.title + ' - ' + modeLabel(cfg)),
      h('main', { class: 'paper zoomed' },
        h('p', { text: st.exam.heading || st.exam.title }),
        h('ul', { class: 'muted' }, facts.map(function (f) { return h('li', { text: f }); }))),
      h('div', { class: 'statusbar' }, h('span', { text: 'Click the Begin button to start the exam.' }), zoomControl()),
      h('div', { class: 'buttons' },
        button('Begin', function () {
          s.begun = true;
          run();
        }, { class: 'btn primary' }),
        button('Cancel', function () { library(); }))));
  }

  async function resume(x) {
    await load(x.id);
    const s = await S.get('sessions', x.id);
    if (!s || !s.order.every(function (id) { return st.byId.has(id); })) {
      await S.remove('sessions', x.id);
      await Sim.dom.alertBox('Resume', 'The saved session no longer matches this exam file, so it was cleared.');
      library(x.id);
      return;
    }
    st.session = s;
    st.nav = null;
    run();
  }

  function run() {
    startClock();
    save();
    examScreen();
  }

  function save() {
    st.unsaved = 0;
    if (!st.session || !st.session.begun) return;
    S.put('sessions', st.session).catch(function (err) { console.error(err); });
  }

  function startClock() {
    stopClock();
    st.last = Date.now();
    st.tick = setInterval(tick, 500);
  }

  function stopClock() {
    clearInterval(st.tick);
    st.tick = null;
  }

  function tick() {
    const now = Date.now();
    const d = now - st.last;
    st.last = now;
    const s = st.session;
    if (!s || d < 0 || d > SLEEP_GAP) return;
    s.elapsed += d;
    st.unsaved += d;
    if (s.timer.on) {
      s.timeLeft = Math.max(0, s.timeLeft - d);
      if (s.timeLeft === 0) {
        timeUp();
        return;
      }
    }
    drawClock();
    if (st.unsaved >= SAVE_EVERY) save();
  }

  function drawClock() {
    const s = st.session;
    if (!st.ui.clock) return;
    st.ui.clock.textContent = s.timer.on ? 'Time Remaining: ' + E.formatTime(s.timeLeft) : 'Time: ' + E.formatTime(s.elapsed);
    st.ui.clock.classList.toggle('low', s.timer.on && s.timeLeft < 5 * 60000);
  }

  async function timeUp() {
    document.querySelectorAll('dialog').forEach(function (d) { d.close(); });
    await finish();
    Sim.dom.alertBox('Time is up', 'Your time ran out, so the exam was ended and scored.');
  }

  /* ---------- question screen ---------- */

  function examScreen() {
    const s = st.session;
    st.reveal = false;
    const flag = h('input', {
      type: 'checkbox',
      onchange: function () {
        const id = question().id;
        if (flag.checked) s.flags[id] = true;
        else delete s.flags[id];
        save();
      }
    });
    const ui = st.ui = {
      flag: flag,
      clock: h('span', { class: 'clock', role: 'timer' }),
      item: h('span', { class: 'item' }),
      navNote: h('span', { class: 'nav-note' }),
      caseBtn: button('Case Study', toggleCase, { 'aria-pressed': 'true' }),
      answerBtn: button('Show Answer', toggleAnswer, { title: 'Alt+A' }),
      casePane: h('aside', { class: 'case-pane zoomed', 'aria-label': 'Case study' }),
      pane: h('main', { class: 'question-pane zoomed' }),
      state: h('span', { class: 'state' }),
      prev: button('Previous', function () { go(-1); }, { title: 'Alt+P' }),
      next: button('Next', next, { class: 'btn primary', title: 'Alt+N' }),
      skip: button('Skip', skip, { title: 'Alt+K' })
    };
    ui.split = h('div', { class: 'split' }, ui.casePane, ui.pane);
    show('exam', h('div', { class: 'screen exam' },
      titleBar(st.exam.title + ' - ' + modeLabel(s.cfg) + (s.training ? ' - Training' : '')),
      h('div', { class: 'strip' }, h('label', { class: 'mark', title: 'Alt+M' }, flag, 'Flag for review'), ui.navNote, ui.clock),
      h('div', { class: 'itembar' }, ui.item, h('span', { class: 'push' }), ui.caseBtn, ui.answerBtn, button('Calculator', Sim.calculator.toggle)),
      ui.split,
      h('div', { class: 'statusbar' }, ui.state, zoomControl()),
      h('div', { class: 'buttons' }, ui.prev, ui.next, ui.skip,
        button('Review', function () { reviewScreen(); }, { title: 'Alt+R' }),
        h('span', { class: 'push' }),
        button('Save and Exit', saveAndExit),
        button('End Exam', endExam, { class: 'btn danger' }))));
    showQuestion();
  }

  function showQuestion() {
    const s = st.session;
    const q = question();
    s.seen[q.id] = true;
    st.reveal = false;
    const ui = st.ui;
    ui.item.textContent = 'Item ' + (s.idx + 1) + ' of ' + s.order.length + '  (' + q.exam + ', Q' + q.num + ')';
    ui.flag.checked = !!s.flags[q.id];

    const c = q.caseId && st.content.cases.find(function (x) { return x.id === q.caseId; });
    ui.caseBtn.hidden = !c;
    if (!c) {
      ui.casePane.dataset.id = '';
      ui.casePane.replaceChildren();
    } else if (ui.casePane.dataset.id !== c.id) {
      ui.casePane.dataset.id = c.id;
      ui.casePane.replaceChildren(h('h2', { text: c.title }), Sim.dom.renderBlocks(c.blocks, st.content.images));
      ui.casePane.scrollTop = 0;
    }
    drawCase();
    drawQuestion();
    ui.pane.scrollTop = 0;
    drawClock();
    save();
  }

  function drawCase() {
    const on = !!st.ui.casePane.dataset.id && prefs.get('showCase', true);
    st.ui.split.classList.toggle('with-case', on);
    st.ui.casePane.hidden = !on;
    st.ui.caseBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    st.ui.caseBtn.textContent = on ? 'Hide Case Study' : 'Show Case Study';
  }

  function toggleCase() {
    prefs.set('showCase', !prefs.get('showCase', true));
    drawCase();
  }

  function drawQuestion() {
    const s = st.session;
    const q = question();
    const checked = !!s.checked[q.id];
    const reveal = st.reveal || checked;
    st.ui.pane.replaceChildren(Sim.question.draw(q, {
      resp: s.answers[q.id],
      images: st.content.images,
      pool: s.pools[q.id],
      locked: checked,
      reveal: reveal,
      accepted: s.accepted[q.id],
      set: function (resp) {
        s.answers[q.id] = resp;
        if (E.status(q, resp) !== 'none') delete s.skipped[q.id];
        delete s.accepted[q.id];
        // With the answer on show, redraw so the right and wrong marks follow the change.
        if (st.reveal && q.type !== 'self') drawQuestion();
        else drawState();
        save();
      },
      onReveal: function () { setReveal(true); },
      onAccept: function () {
        s.accepted[q.id] = true;
        drawQuestion();
        save();
      }
    }));
    st.ui.answerBtn.textContent = reveal ? 'Hide Answer' : 'Show Answer';
    st.ui.answerBtn.disabled = checked;
    drawState();
  }

  function navList() {
    return st.nav ? st.nav.list : st.session.order.map(function (_, i) { return i; });
  }

  function drawState() {
    const s = st.session;
    const q = question();
    const c = E.counts(s, st.byId);
    const status = E.status(q, s.answers[q.id]);
    const list = navList();
    const at = list.indexOf(s.idx);
    const ui = st.ui;
    ui.state.textContent = 'Answered ' + c.done + ' · Incomplete ' + c.partial + ' · Unanswered ' + c.none + ' · Flagged ' + c.flagged;
    ui.prev.disabled = at <= 0;
    ui.skip.disabled = status !== 'none';
    ui.navNote.textContent = st.nav ? 'Reviewing ' + st.nav.label + ': ' + (at + 1) + ' of ' + list.length : '';
    const toCheck = needsCheck();
    ui.next.textContent = toCheck ? 'Check Answer' : at >= list.length - 1 ? 'Review' : 'Next';
  }

  function needsCheck() {
    const s = st.session;
    const q = question();
    return s.training && q.type !== 'self' && !s.checked[q.id] && E.status(q, s.answers[q.id]) !== 'none';
  }

  function setReveal(on) {
    st.reveal = on;
    if (on) st.session.shown[question().id] = true;
    drawQuestion();
    if (on) scrollToAnswer();
    save();
  }

  function scrollToAnswer() {
    const el = st.ui.pane.querySelector('.self-marks') || st.ui.pane.querySelector('.answer-panel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function toggleAnswer() {
    setReveal(!st.reveal);
  }

  function next() {
    if (needsCheck()) {
      st.session.checked[question().id] = true;
      drawQuestion();
      save();
      scrollToAnswer();
      return;
    }
    go(1);
  }

  function skip() {
    const s = st.session;
    const q = question();
    if (E.status(q, s.answers[q.id]) !== 'none') return;
    s.skipped[q.id] = true;
    go(1);
  }

  function go(by) {
    const s = st.session;
    const list = navList();
    const at = list.indexOf(s.idx) + by;
    if (at < 0) return;
    if (at >= list.length) {
      reviewScreen();
      return;
    }
    s.idx = list[at];
    showQuestion();
  }

  async function saveAndExit() {
    stopClock();
    const id = st.session.id;
    await S.put('sessions', st.session);
    library(id);
  }

  async function endExam() {
    const c = E.counts(st.session, st.byId);
    const open = c.none + c.partial;
    const lines = [];
    if (open) lines.push(open + (open === 1 ? ' question is' : ' questions are') + ' not fully answered.');
    if (c.flagged) lines.push(c.flagged + (c.flagged === 1 ? ' question is' : ' questions are') + ' flagged for review.');
    lines.push('End the exam and see your score?');
    if (await Sim.dom.confirmBox('End exam', lines, 'End exam')) finish();
  }

  async function finish() {
    stopClock();
    Sim.calculator.close();
    const s = st.session;
    if (!s) return;
    st.session = null;
    const result = E.score(s, st.byId, st.exam.passing);
    const record = {
      id: 'h' + Date.now().toString(36),
      examId: s.id,
      date: Date.now(),
      candidate: s.candidate,
      cfg: s.cfg,
      training: s.training,
      passing: st.exam.passing,
      order: s.order,
      pools: s.pools,
      answers: s.answers,
      flags: s.flags,
      shown: s.shown,
      skipped: s.skipped,
      accepted: s.accepted,
      elapsed: s.elapsed,
      result: result
    };
    const stats = E.addToStats(await loadStats(s.id), result);
    st.exam.last = { scaled: result.scaled, passed: result.passed };
    await S.put('history', record);
    await S.put('stats', stats);
    await S.put('exams', st.exam);
    await S.remove('sessions', s.id);
    report(record);
  }

  /* ---------- review ---------- */

  const FILTERS = [
    ['all', 'All'],
    ['unanswered', 'Unanswered'],
    ['incomplete', 'Incomplete'],
    ['skipped', 'Skipped'],
    ['flagged', 'Flagged']
  ];

  function matches(filter, id) {
    const s = st.session;
    const status = E.status(st.byId.get(id), s.answers[id]);
    if (filter === 'unanswered') return status === 'none';
    if (filter === 'incomplete') return status === 'partial';
    if (filter === 'skipped') return !!s.skipped[id];
    if (filter === 'flagged') return !!s.flags[id];
    return true;
  }

  function firstWords(q) {
    const text = q.stem.filter(function (b) { return b.t === 'p'; }).map(function (b) { return b.text; }).join(' ');
    return text.length > 120 ? text.slice(0, 117) + '…' : text;
  }

  function statusText(id) {
    const s = st.session;
    const status = E.status(st.byId.get(id), s.answers[id]);
    if (status === 'done') return 'Answered';
    if (status === 'partial') return 'Incomplete';
    if (s.skipped[id]) return 'Skipped';
    return s.seen[id] ? 'Unanswered' : 'Not seen';
  }

  function reviewScreen() {
    const s = st.session;
    st.ui = {};
    let filter = 'all';
    const body = h('tbody', {});
    const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show' });
    const through = button('', function () {
      const list = indices(filter);
      if (!list.length) return;
      st.nav = filter === 'all' ? null : { label: filter, list: list };
      s.idx = list[0];
      examScreen();
    }, { class: 'btn primary' });

    function indices(f) {
      const out = [];
      s.order.forEach(function (id, i) { if (matches(f, id)) out.push(i); });
      return out;
    }
    function open(i) {
      st.nav = null;
      s.idx = i;
      examScreen();
    }
    function draw() {
      tabs.replaceChildren.apply(tabs, FILTERS.map(function (f) {
        return button(f[1] + ' (' + indices(f[0]).length + ')', function () {
          filter = f[0];
          draw();
        }, { class: 'btn tab' + (filter === f[0] ? ' chosen' : ''), 'aria-pressed': filter === f[0] ? 'true' : 'false' });
      }));
      const list = indices(filter);
      body.replaceChildren.apply(body, list.map(function (i) {
        const id = s.order[i];
        const q = st.byId.get(id);
        const flag = h('input', {
          type: 'checkbox',
          checked: !!s.flags[id],
          'aria-label': 'Flag item ' + (i + 1),
          onchange: function () {
            if (flag.checked) s.flags[id] = true;
            else delete s.flags[id];
            save();
            draw();
          }
        });
        return h('tr', {},
          h('td', {}, button('Item ' + (i + 1), function () { open(i); }, { class: 'btn small' })),
          h('td', { class: 'nowrap', text: q.exam + ', Q' + q.num }),
          h('td', { text: statusText(id), class: 'status-' + statusText(id).toLowerCase().replace(' ', '-') }),
          h('td', { class: 'center' }, flag),
          h('td', { class: 'preview', text: firstWords(q) }));
      }));
      if (!list.length) body.append(h('tr', {}, h('td', { colspan: 5, class: 'muted', text: 'No questions here.' })));
      through.textContent = filter === 'all' ? 'Go through all' : 'Go through ' + filter;
      through.disabled = !list.length;
    }

    st.ui.clock = h('span', { class: 'clock', role: 'timer' });
    show('review', h('div', { class: 'screen exam' },
      titleBar(st.exam.title + ' - Review'),
      h('div', { class: 'strip' }, h('strong', { text: 'Review your answers' }), st.ui.clock),
      tabs,
      h('div', { class: 'table-wrap grow' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, ['Item', 'Question', 'Status', 'Flag', ''].map(function (t) { return h('th', { text: t, scope: 'col' }); }))),
        body)),
      h('div', { class: 'buttons' },
        through,
        button('Back to question', function () {
          st.nav = null;
          examScreen();
        }),
        h('span', { class: 'push' }),
        button('Save and Exit', saveAndExit),
        button('End Exam', endExam, { class: 'btn danger' }))));
    draw();
    drawClock();
    save();
  }

  /* ---------- score report ---------- */

  function report(record) {
    const r = record.result;
    st.ui = {};
    let filter = 'all';
    const body = h('tbody', {});
    const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show' });
    const filters = [
      ['all', 'All'], ['correct', 'Correct'], ['partial', 'Partly correct'], ['wrong', 'Not correct'], ['unanswered', 'Not answered'], ['flagged', 'Flagged']
    ];
    const pick = function (f) {
      return r.items.filter(function (item) {
        return f === 'all' || (f === 'flagged' ? record.flags[item.id] : item.result === f);
      });
    };
    function draw() {
      tabs.replaceChildren.apply(tabs, filters.map(function (f) {
        return button(f[1] + ' (' + pick(f[0]).length + ')', function () {
          filter = f[0];
          draw();
        }, { class: 'btn tab' + (filter === f[0] ? ' chosen' : ''), 'aria-pressed': filter === f[0] ? 'true' : 'false' });
      }));
      body.replaceChildren.apply(body, pick(filter).map(function (item) {
        const q = st.byId.get(item.id);
        const n = record.order.indexOf(item.id) + 1;
        if (!q) return h('tr', {}, h('td', { text: 'Item ' + n }), h('td', { colspan: 3, class: 'muted', text: 'This question is no longer in the exam file.' }));
        return h('tr', {},
          h('td', {}, button('Item ' + n, function () { detail(record, item, n); }, { class: 'btn small' })),
          h('td', { class: 'nowrap', text: q.exam + ', Q' + q.num }),
          h('td', { class: 'result-' + item.result, text: Sim.question.VERDICT[item.result] + (record.shown[item.id] ? ' (answer shown)' : '') + (record.flags[item.id] ? ' ⚑' : '') }),
          h('td', { class: 'preview', text: firstWords(q) }));
      }));
    }

    const percent = r.total ? Math.round(r.points / r.total * 100) : 0;
    const again = function (label, ids) {
      return button(label + ' (' + ids.length + ')', function () { retake(record, label, ids); }, { disabled: !ids.length });
    };
    const idsOf = function (f) { return pick(f).map(function (i) { return i.id; }).filter(function (id) { return st.byId.has(id); }); };
    const missed = idsOf('wrong').concat(idsOf('partial'));

    show('report', h('div', { class: 'screen report' },
      titleBar(st.exam.title + ' - Score report'),
      h('div', { class: 'report-top ' + (r.passed ? 'pass' : 'fail') },
        h('div', { class: 'big' },
          h('span', { class: 'verdict', text: r.passed ? 'Pass' : 'Fail' }),
          h('span', { class: 'scaled', text: r.scaled + ' / 1000' }),
          h('span', { class: 'muted', text: 'Passing score: ' + record.passing })),
        h('div', { class: 'meter', role: 'img', 'aria-label': percent + ' percent' },
          h('div', { class: 'meter-fill', style: 'width:' + percent + '%' }),
          h('div', { class: 'meter-mark', style: 'left:' + record.passing / 10 + '%' })),
        h('dl', {}, [
          ['Candidate', record.candidate],
          ['Date', date(record.date)],
          ['Questions', modeLabel(record.cfg) + (record.training ? ', training mode' : '')],
          ['Time used', E.formatTime(record.elapsed)],
          ['Correct', r.correct + ' of ' + r.total],
          ['Partly correct', String(r.partial)],
          ['Not correct', String(r.wrong)],
          ['Not answered', String(r.unanswered)]
        ].map(function (p) { return h('div', {}, h('dt', { text: p[0] }), h('dd', { text: p[1] })); }))),
      r.sections.length > 1 ? h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Section', scope: 'col' }), h('th', { text: 'Points', scope: 'col', class: 'num' }), h('th', { text: 'Score', scope: 'col', class: 'num' }))),
        h('tbody', {}, r.sections.map(function (x) {
          return h('tr', {}, h('td', { text: x.name }),
            h('td', { class: 'num', text: Number(x.points.toFixed(1)) + ' of ' + x.total }),
            h('td', { class: 'num', text: Math.round(x.points / x.total * 100) + '%' }));
        })))) : null,
      tabs,
      h('div', { class: 'table-wrap' }, h('table', { class: 'list' }, body)),
      h('div', { class: 'buttons' },
        button('Back to library', function () { library(record.examId); }, { class: 'btn primary' }),
        again('Retake incorrect', missed),
        again('Retake unanswered', idsOf('unanswered')),
        again('Retake flagged', idsOf('flagged')),
        h('span', { class: 'push' }),
        button('Print', function () { window.print(); }))));
    draw();
  }

  async function detail(record, item, n) {
    const q = st.byId.get(item.id);
    const c = q.caseId && st.content.cases.find(function (x) { return x.id === q.caseId; });
    const box = h('div', { class: 'detail zoomed' });
    let changed = false;
    function draw() {
      box.replaceChildren();
      if (c) box.append(h('details', {}, h('summary', { text: 'Case study: ' + c.title }), Sim.dom.renderBlocks(c.blocks, st.content.images)));
      box.append(Sim.question.draw(q, {
        resp: record.answers[q.id],
        images: st.content.images,
        pool: record.pools[q.id],
        locked: true,
        reveal: true,
        accepted: record.accepted[q.id],
        set: function (resp) {
          record.answers[q.id] = resp;
          changed = true;
        },
        onAccept: function () {
          record.accepted[q.id] = true;
          changed = true;
          draw();
        }
      }));
    }
    draw();
    await Sim.dom.dialog('Item ' + n + '  (' + q.exam + ', Q' + q.num + ')', box, [{ label: 'Close', value: true, primary: true }], 'wide');
    if (changed) await rescore(record, q.id);
  }

  // Marking an answer from the report changes the score, so the record and statistics follow.
  async function rescore(record, id) {
    const find = function () { return record.result.items.find(function (i) { return i.id === id; }).result; };
    const before = find();
    const present = record.order.filter(function (x) { return st.byId.has(x); });
    if (present.length !== record.order.length) return;
    record.result = E.score(record, st.byId, record.passing);
    const after = find();
    const stats = await loadStats(record.examId);
    const s = stats.q[id] || { right: 0, wrong: 0 };
    const side = function (result) { return result === 'unanswered' ? null : result === 'correct' ? 'right' : 'wrong'; };
    if (side(before)) s[side(before)] = Math.max(0, s[side(before)] - 1);
    if (side(after)) s[side(after)]++;
    stats.q[id] = s;
    const newest = (await S.all('history')).filter(function (r) { return r.examId === record.examId; })
      .every(function (r) { return r.date <= record.date; });
    await S.put('stats', stats);
    await S.put('history', record);
    if (newest) {
      st.exam.last = { scaled: record.result.scaled, passed: record.result.passed };
      await S.put('exams', st.exam);
    }
    report(record);
  }

  async function retake(record, label, ids) {
    if (!(await mayReplaceSession(st.exam))) return;
    const cfg = Object.assign({}, record.cfg, { mode: 'ids', ids: ids, label: label });
    begin(cfg, E.select(st.content.questions, cfg, null));
  }

  /* ---------- keyboard, dropping files, start ---------- */

  document.addEventListener('keydown', function (e) {
    if (st.view !== 'exam' || document.querySelector('dialog[open]')) return;
    const tag = e.target.tagName;
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const key = e.key.toLowerCase();
      const act = {
        n: next,
        p: function () { go(-1); },
        k: skip,
        r: reviewScreen,
        a: function () { if (!st.ui.answerBtn.disabled) toggleAnswer(); },
        m: function () { st.ui.flag.click(); }
      }[key];
      if (act) {
        e.preventDefault();
        act();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && e.target.type === 'text')) return;
    if (/^[a-j]$/i.test(e.key)) {
      const input = st.ui.pane.querySelector('input[data-key="' + e.key.toUpperCase() + '"]');
      if (input && !input.disabled) input.click();
    }
  });

  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (st.view === 'library' && e.dataTransfer.files.length && !document.querySelector('dialog[open]')) upload(Array.from(e.dataTransfer.files));
  });

  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });

  applyZoom();
  library();
})();
