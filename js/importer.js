/* Uploading: reads files, shows what was found, and adds the questions to the library. */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};
  const S = Sim.store;
  const E = Sim.engine;
  const h = Sim.dom.h;

  const FORMAT = 'mb820-exam-simulator';
  const TYPES = ['choice', 'match', 'blanks', 'order', 'self'];
  const ACCEPT = '.pdf,.docx,.docm,.dotx,.doc,.xlsx,.xlsm,.xltx,.xls,.csv,.tsv,.pptx,.pptm,.odt,.ods,.odp,.rtf,.html,.htm,.txt,.md,.json';
  const MAX_FILE = 200 * 1024 * 1024;
  const NOTHING = 'No questions were found in this file. Download a template below to see layouts that work.';

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  function listNumbers(nums) {
    return nums.slice(0, 25).join(', ') + (nums.length > 25 ? ' and ' + (nums.length - 25) + ' more' : '');
  }

  /* ---------- what kind of file it is, judged by its contents ---------- */

  function kindOf(buffer, name) {
    const b = new Uint8Array(buffer.slice(0, 1024));
    const start = String.fromCharCode.apply(null, b);
    const ext = (/\.([a-z0-9]+)$/i.exec(name) || ['', ''])[1].toLowerCase();
    if (start.indexOf('%PDF') >= 0) return 'pdf';
    if (start.slice(0, 2) === 'PK') return 'office';
    if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) return 'legacy';
    if (/^\s*\{\\rtf/.test(start)) return 'rtf';
    if ((b[0] === 0x89 && start.slice(1, 4) === 'PNG') || (b[0] === 0xFF && b[1] === 0xD8) || start.slice(0, 3) === 'GIF') return 'picture';
    const text = start.replace(/^ï»¿|\u0000/g, '');
    if (ext === 'json') return 'json';
    if (ext === 'html' || ext === 'htm' || /^\s*<(?:!doctype html|html|head|body|table|meta)\b/i.test(text)) return 'html';
    if (ext === 'csv' || ext === 'tsv') return 'csv';
    if (/^(?:txt|md|text|tab|)$/.test(ext)) return 'text';
    // Plain text saved under another name.
    if (ext === 'pdf') return 'pdf';
    if (/^xls[xm]?$/.test(ext) && !/[\u0000-\u0008]/.test(start)) return 'csv';
    if (/^doc[xm]?$/.test(ext) && !/[\u0000-\u0008]/.test(start)) return 'text';
    return '';
  }

  /* ---------- reading files ---------- */

  async function readFile(file, onProgress) {
    try {
      return await readAny(file, onProgress);
    } catch (err) {
      // Anything but a message written for people means the file broke one of the readers.
      if (err.constructor === Error) throw err;
      console.error(err);
      throw new Error('This file is damaged and cannot be opened.');
    }
  }

  async function readAny(file, onProgress) {
    const name = file.name;
    if (file.size > MAX_FILE) throw new Error('This file is larger than 200 MB.');
    const buffer = await file.arrayBuffer();
    if (!buffer.byteLength) throw new Error('This file is empty.');
    const kind = kindOf(buffer, name);
    if (kind === 'json') return readPackage(name, Sim.richtext.decodeText(buffer));
    if (kind === 'picture') throw new Error('Pictures cannot be read. Put the questions in a document or spreadsheet.');
    let source;
    if (kind === 'pdf') source = await Sim.pdf.read(buffer, onProgress);
    else if (kind === 'office') source = await Sim.office.open(buffer);
    else if (kind === 'legacy') source = Sim.legacy.open(buffer);
    else if (kind === 'rtf') source = await Sim.richtext.rtf(Sim.richtext.decodeText(buffer));
    else if (kind === 'html') source = Sim.richtext.html(Sim.richtext.decodeText(buffer));
    else if (kind === 'csv') source = { tables: [{ name: '', rows: Sim.tables.csv(Sim.richtext.decodeText(buffer)) }] };
    else if (kind === 'text') source = readText(Sim.richtext.decodeText(buffer));
    else throw new Error('This file type is not supported. Use PDF, Word, Excel, CSV, PowerPoint, OpenDocument, RTF, HTML, text or JSON.');

    const f = { name: name, heading: source.heading || '', allImages: source.images || {}, unsupported: source.unsupported || 0 };
    f.blocks = (source.blocks || []).filter(function (b) { return b.k !== 'table'; });
    f.tables = (source.tables || []).concat((source.blocks || []).filter(function (b) { return b.k === 'table'; }).map(function (b) { return { name: '', rows: b.rows }; }));
    f.tables = f.tables.filter(function (t) { return t.rows.some(function (r) { return r.some(function (c) { return c.text || c.imgs.length; }); }); });
    f.tables.forEach(function (t) { t.plan = Sim.tables.plan(t.rows); });
    build(f);
    // Offering to choose columns only makes sense for a real table.
    const real = f.tables.some(function (t) { return t.rows.length > 1 && t.rows[0].length > 1; });
    if (!f.questions.length && !real) {
      throw new Error(NOTHING + (kind === 'legacy' ? ' If this old Word file uses automatic numbering, save it as .docx first.' : ''));
    }
    return f;
  }

  // A .txt file may be a spreadsheet saved as text.
  function readText(text) {
    if (text.indexOf('\t') >= 0) {
      const rows = Sim.tables.csv(text, '\t');
      if (Sim.tables.looksLikeQuestions(rows)) return { tables: [{ name: '', rows: rows }] };
    }
    return { blocks: Sim.parser.textToBlocks(text), images: {} };
  }

  // An answer sheet: question numbers and answers, without the questions.
  function answerKey(tables) {
    const key = new Map();
    tables.forEach(function (t) {
      if (t.plan) return;
      for (let i = 0; i < Math.min(5, t.rows.length); i++) {
        const roles = t.rows[i].map(function (c) { return Sim.tables.roleOf(c.text); });
        const n = roles.map(function (r) { return r === 'question' ? 'number' : r; }).indexOf('number');
        const a = roles.indexOf('correct');
        if (n < 0 || a < 0) continue;
        t.isKey = true;
        t.rows.slice(i + 1).forEach(function (r) {
          const num = /(\d{1,5})/.exec(r[n].text);
          if (num && r[a].text.trim()) key.set(Number(num[1]), r[a].text.trim());
        });
        return;
      }
    });
    return key;
  }

  // Turns everything read from a file into questions. Runs again when the columns are changed.
  function build(f) {
    const questions = [];
    const cases = [];
    let top = 0;
    let groups = 0;
    const take = function (part, sheet) {
      if (!part.questions.length) return;
      groups++;
      const prefix = 'g' + groups + '-';
      const clash = part.questions.some(function (q) { return questions.some(function (x) { return x.num === q.num; }); });
      const offset = clash ? top : 0;
      part.questions.forEach(function (q) {
        q.num += offset;
        top = Math.max(top, q.num);
        if (q.caseId) q.caseId = prefix + q.caseId;
        if (sheet && q.section === Sim.parser.GENERAL) q.sheet = sheet;
        questions.push(q);
      });
      part.cases.forEach(function (c) { cases.push({ id: prefix + c.id, title: c.title, blocks: c.blocks }); });
    };
    take(Sim.parser.parse(f.blocks), '');
    const key = answerKey(f.tables);
    f.tables.forEach(function (t) {
      if (t.isKey) return;
      if (t.plan && Sim.tables.complete(t.plan.roles)) take({ questions: Sim.tables.toQuestions(t, t.plan, key), cases: [] }, t.name);
      else if (!t.plan) take(Sim.parser.parse(Sim.tables.toBlocks(t.rows)), t.name);
    });
    // Sheet names are useful as sections only when there is more than one.
    const sheets = new Set(questions.map(function (q) { return q.sheet; }));
    questions.forEach(function (q) {
      if (q.sheet && sheets.size > 1) q.section = q.sheet;
      delete q.sheet;
    });
    f.questions = questions;
    f.cases = cases;
    f.images = keepUsed(f, f.allImages);
    f.report = Sim.parser.makeReport(questions);
  }

  function keepUsed(parsed, images) {
    const used = new Set();
    const look = function (blocks) {
      (blocks || []).forEach(function (b) { if (b.t === 'img') used.add(b.ref); });
    };
    parsed.cases.forEach(function (c) { look(c.blocks); });
    parsed.questions.forEach(function (q) {
      look(q.stem);
      look(q.explanation);
      look(q.solution);
      (q.options || []).forEach(function (o) { o.imgs.forEach(function (ref) { used.add(ref); }); });
    });
    const out = {};
    used.forEach(function (ref) { if (images[ref]) out[ref] = images[ref]; });
    return out;
  }

  // Files made with Export. Everything is checked because the file may have been edited by hand.
  function readPackage(name, text) {
    let data;
    try {
      data = JSON.parse(text.replace(/^﻿/, ''));
    } catch (err) {
      throw new Error('This is not a valid JSON file.');
    }
    if (!data || data.format !== FORMAT || !Array.isArray(data.questions)) {
      throw new Error('This JSON file was not exported from this simulator.');
    }
    data.questions.forEach(function (q, i) {
      const ok = q && TYPES.indexOf(q.type) >= 0 && Array.isArray(q.stem) && typeof q.num === 'number' &&
        (q.type !== 'choice' || (Array.isArray(q.options) && Array.isArray(q.answer) && q.answer.length)) &&
        (q.type !== 'order' || Array.isArray(q.items)) &&
        ((q.type !== 'match' && q.type !== 'blanks') || (Array.isArray(q.rows) && q.rows.length)) &&
        (q.type !== 'blanks' || typeof q.code === 'string');
      if (!ok) throw new Error('Question ' + (i + 1) + ' in this file is damaged.');
      (q.options || []).forEach(function (o) { o.imgs = o.imgs || []; });
      q.section = q.section || Sim.parser.GENERAL;
    });
    const images = {};
    Object.keys(data.images || {}).forEach(function (ref) {
      const img = data.images[ref];
      if (img && /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/.test(img.url)) images[ref] = { url: img.url, w: Number(img.w) || 400 };
    });
    return {
      name: name,
      packaged: true,
      title: typeof data.title === 'string' ? data.title : baseName(name),
      heading: typeof data.heading === 'string' ? data.heading : '',
      passing: Number(data.passing) || 700,
      minutes: Number(data.minutes) || 120,
      questions: data.questions,
      cases: Array.isArray(data.cases) ? data.cases : [],
      tables: [],
      images: images,
      unsupported: 0,
      report: Object.assign(Sim.parser.makeReport(data.questions), { missing: [], repeated: [], self: [], noAnswer: [], pictureOptions: [] })
    };
  }

  /* ---------- adding to the library ---------- */

  function letterFor(n) {
    return n < 26 ? String.fromCharCode(65 + n) : 'A' + (n - 25);
  }

  function summarise(meta, content) {
    const sections = new Map();
    content.questions.forEach(function (q) { sections.set(q.section, (sections.get(q.section) || 0) + 1); });
    meta.count = content.questions.length;
    meta.sections = Array.from(sections.entries()).map(function (e) { return { name: e[0], count: e[1] }; });
    meta.exams.forEach(function (x) {
      x.count = content.questions.filter(function (q) { return q.exam === x.name; }).length;
    });
  }

  async function addToLibrary(files, targetId, title) {
    let meta;
    let content;
    if (targetId) {
      meta = await S.get('exams', targetId);
      content = await S.get('content', targetId);
    } else {
      const id = 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
      const first = files[0];
      meta = { id: id, title: title, heading: first.heading || '', passing: first.passing || 700, minutes: first.minutes || 120, exams: [], created: Date.now() };
      content = { id: id, questions: [], cases: [], images: {} };
    }
    files.forEach(function (f) {
      // Picture names are only unique within one file.
      const refs = new Map();
      Object.keys(f.images).forEach(function (ref) {
        let name = ref;
        while (content.images[name] && content.images[name].url !== f.images[ref].url) name += 'x';
        refs.set(ref, name);
        content.images[name] = f.images[ref];
      });
      const rename = function (blocks) {
        (blocks || []).forEach(function (b) { if (b.t === 'img' && refs.has(b.ref)) b.ref = refs.get(b.ref); });
      };
      // A packaged file can hold several exams; keep them apart.
      const groups = new Map();
      f.questions.forEach(function (q) {
        const key = (f.packaged && q.exam) || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(q);
      });
      const caseIds = new Map();
      f.cases.forEach(function (c) {
        const id = 'c' + (content.cases.length + 1);
        caseIds.set(c.id, id);
        rename(c.blocks);
        content.cases.push({ id: id, title: c.title, blocks: c.blocks });
      });
      groups.forEach(function (list) {
        const letter = letterFor(meta.exams.length);
        const name = 'Exam ' + letter;
        const used = new Set();
        list.forEach(function (q) {
          let id = letter + '-' + q.num;
          while (used.has(id)) id += 'b';
          used.add(id);
          q.id = id;
          q.exam = name;
          if (q.caseId) q.caseId = caseIds.get(q.caseId);
          rename(q.stem);
          rename(q.explanation);
          rename(q.solution);
          (q.options || []).forEach(function (o) { o.imgs = o.imgs.map(function (ref) { return refs.get(ref) || ref; }); });
          content.questions.push(q);
        });
        meta.exams.push({ name: name, count: list.length, source: f.name });
      });
      if (!meta.heading && f.heading) meta.heading = f.heading;
    });
    summarise(meta, content);
    await S.put('content', content);
    await S.put('exams', meta);
    return meta;
  }

  function exportPackage(meta, content) {
    const data = {
      format: FORMAT,
      version: 1,
      title: meta.title,
      heading: meta.heading,
      passing: meta.passing,
      minutes: meta.minutes,
      questions: content.questions,
      cases: content.cases,
      images: content.images
    };
    Sim.dom.download(meta.title.replace(/[^\w\- ]+/g, '_') + '.json', JSON.stringify(data), 'application/json');
  }

  /* ---------- the upload dialog ---------- */

  function answerText(q) {
    if (q.type === 'self') return q.note === 'no-answer' ? 'No answer found' : 'You mark it yourself';
    if (q.type === 'choice') {
      return q.answer.map(function (k) {
        const o = q.options.find(function (x) { return x.key === k; });
        return k + (o && o.text ? '. ' + o.text.split('\n')[0] : '');
      }).join('; ');
    }
    return E.answerLines(q).join('; ');
  }

  function short(text, n) {
    return text.length > n ? text.slice(0, n - 1) + '…' : text;
  }

  // Filled only when opened, because files can hold hundreds of questions.
  function previewView(f) {
    const box = h('details', { class: 'preview-box' }, h('summary', { text: 'Check what was read' }));
    box.addEventListener('toggle', function () {
      if (!box.open || box.children.length > 1) return;
      box.append(h('div', { class: 'table-wrap preview-list' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, ['No.', 'Question', 'Type', 'Choices', 'Answer'].map(function (t) { return h('th', { text: t, scope: 'col' }); }))),
        h('tbody', {}, f.questions.map(function (q) {
          const text = q.stem.filter(function (b) { return b.text; }).map(function (b) { return b.text; }).join(' ');
          const n = q.options ? q.options.length : q.rows ? q.rows.length : q.items ? q.items.length : 0;
          return h('tr', {},
            h('td', { text: String(q.num) }),
            h('td', { text: short(text, 110) || '(picture)' }),
            h('td', { class: 'nowrap', text: E.TYPE_NAMES[q.type] }),
            h('td', { class: 'num', text: n ? String(n) : '' }),
            h('td', { text: short(answerText(q), 90) }));
        })))));
    });
    return box;
  }

  // One list per column, so a spreadsheet with unusual headings can still be read.
  function columnsView(t, redo) {
    const width = t.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    const plan = t.plan || { index: 0, roles: t.rows[0].map(function (c) { return Sim.tables.roleOf(c.text); }) };
    const heading = h('input', { type: 'number', min: 0, max: Math.min(50, t.rows.length - 1), value: plan.index + 1, class: 'spin', 'aria-label': 'Heading row' });
    const selects = [];
    const apply = function () {
      const row = Math.min(Math.max(0, Math.round(Number(heading.value)) || 0), t.rows.length - 1);
      t.plan = { index: row - 1, roles: selects.map(function (s) { return s.value; }) };
      redo();
    };
    const cols = h('div', { class: 'columns' });
    for (let c = 0; c < Math.min(width, 30); c++) {
      const sample = t.rows.slice(plan.index + 1).map(function (r) { return r[c].text; }).find(Boolean) || '';
      const name = plan.index >= 0 && t.rows[plan.index] ? t.rows[plan.index][c].text : '';
      const s = h('select', { 'aria-label': 'Column ' + (name || c + 1), onchange: apply, value: plan.roles[c] || '' },
        Sim.tables.ROLES.map(function (r) { return h('option', { value: r[0], text: r[1] }); }));
      selects.push(s);
      cols.append(h('label', { class: 'column' },
        h('strong', { text: short(name.replace(/\n/g, ' ') || 'Column ' + String.fromCharCode(65 + c % 26), 40) }),
        h('span', { class: 'muted', text: short(sample.replace(/\n/g, ' '), 46) }), s));
    }
    heading.addEventListener('change', apply);
    const ok = t.plan && Sim.tables.complete(t.plan.roles);
    return h('details', { class: 'columns-box', open: t.open || !ok },
      h('summary', { text: 'Columns' + (t.name ? ' of "' + t.name + '"' : '') + (ok ? '' : ': choose which is the question and which is the answer') }),
      h('label', { class: 'field' }, h('span', { text: 'Heading row (0 = none)' }), heading), cols);
  }

  function reportView(f, changed) {
    const box = h('div', {});
    function draw() {
      const r = f.report;
      const lines = [];
      const kinds = Object.keys(r.types).map(function (t) { return E.TYPE_NAMES[t] + ': ' + r.types[t]; }).join(' · ');
      if (r.missing.length) lines.push('Numbers missing from the file: ' + listNumbers(r.missing));
      if (r.repeated.length) lines.push('Numbers used more than once: ' + listNumbers(r.repeated));
      if (r.self.length) lines.push('You mark these yourself, because the answer is a picture or free text: ' + listNumbers(r.self));
      if (r.noAnswer.length) lines.push('No answer found, so you mark these yourself: ' + listNumbers(r.noAnswer));
      if (r.pictureOptions.length) lines.push('The answer choices are only in a picture: ' + listNumbers(r.pictureOptions));
      if (f.unsupported) lines.push(f.unsupported + (f.unsupported === 1 ? ' picture' : ' pictures') + ' could not be read and will be missing.');
      const tables = f.tables.filter(function (t) { return !t.isKey && t.rows[0].length > 1 && (t.plan || !f.questions.length); });
      box.className = f.questions.length ? 'import-ok' : 'import-bad';
      box.replaceChildren(h('p', {}, h('strong', { text: f.name }), ': ' + (r.total === 1 ? '1 question' : r.total + ' questions') +
        (f.cases.length ? ', ' + f.cases.length + (f.cases.length === 1 ? ' case study' : ' case studies') : '')));
      if (kinds) box.append(h('p', { class: 'muted', text: kinds }));
      if (!f.questions.length) box.append(h('p', { text: 'No questions were found yet. Check the columns below, or use a template.' }));
      if (lines.length) box.append(h('ul', {}, lines.map(function (t) { return h('li', { text: t }); })));
      tables.slice(0, 12).forEach(function (t) {
        box.append(columnsView(t, function () {
          t.open = true;
          build(f);
          draw();
          changed();
        }));
      });
      if (f.questions.length) box.append(previewView(f));
    }
    draw();
    return box;
  }

  // Resolves with the exam the questions went into, or null.
  async function open(startFiles) {
    const exams = await S.all('exams');
    const read = [];
    let busy = false;
    let addButton = null;

    const results = h('div', { class: 'import-results', 'aria-live': 'polite' });
    const bar = h('progress', { max: 1, hidden: true });
    const note = h('p', { class: 'muted' });
    const title = h('input', { type: 'text', value: '', 'aria-label': 'Name' });
    const target = h('select', { 'aria-label': 'Add to' },
      h('option', { value: '', text: 'A new exam file' }),
      exams.map(function (x) { return h('option', { value: x.id, text: x.title + ' (as another exam)' }); }));
    const titleRow = h('label', { class: 'field' }, h('span', { text: 'Name' }), title);
    target.addEventListener('change', function () { titleRow.hidden = !!target.value; });
    const settings = h('div', { hidden: true },
      h('label', { class: 'field' }, h('span', { text: 'Add to' }), target), titleRow);

    function usable() {
      return read.filter(function (f) { return f.questions.length; });
    }
    function refresh() {
      const any = usable().length > 0;
      settings.hidden = !any;
      if (addButton) addButton.disabled = busy || !any;
    }

    async function take(list) {
      const files = Array.from(list);
      if (!files.length || busy) return;
      busy = true;
      refresh();
      for (const file of files) {
        bar.hidden = false;
        bar.value = 0;
        note.textContent = 'Reading ' + file.name;
        try {
          const f = await readFile(file, function (share, text) {
            bar.value = share;
            note.textContent = file.name + ': ' + text;
          });
          read.push(f);
          if (!title.value) title.value = f.title || baseName(file.name);
          results.append(reportView(f, refresh));
        } catch (err) {
          console.error(err);
          results.append(h('p', { class: 'import-bad' }, h('strong', { text: file.name }), ': ' + err.message));
        }
      }
      bar.hidden = true;
      note.textContent = '';
      busy = false;
      refresh();
    }

    const picker = h('input', {
      type: 'file',
      multiple: true,
      accept: ACCEPT,
      'aria-label': 'Choose question files',
      onchange: function () {
        take(picker.files);
      }
    });
    const drop = h('label', { class: 'drop' },
      h('strong', { text: 'Choose files or drop them here' }),
      h('span', { class: 'muted', text: 'PDF, Word, Excel, CSV, PowerPoint, OpenDocument, RTF, HTML, text, or a file exported from this simulator' }),
      picker);
    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('over');
      take(e.dataTransfer.files);
    });

    const template = function (label, get) {
      return h('button', { type: 'button', class: 'link', text: label, onclick: get });
    };
    if (startFiles && startFiles.length) setTimeout(function () { take(startFiles); }, 0);
    const ok = await Sim.dom.dialog('Upload questions', [
      drop,
      bar,
      note,
      results,
      settings,
      h('p', { class: 'muted' }, 'Files stay on this computer. Templates: ',
        template('Word', Sim.templates.word), ' · ', template('Excel', Sim.templates.excel), ' · ', template('Text', Sim.templates.text))
    ], [
      { label: 'Add to library', value: true, primary: true, bind: function (el) { addButton = el; el.disabled = true; } },
      { label: 'Cancel', value: false }
    ], 'wide');
    const ready = usable();
    if (!ok || !ready.length) return null;
    return addToLibrary(ready, target.value, title.value.trim() || baseName(ready[0].name));
  }

  async function addSamples() {
    const parsed = Sim.parser.parse(Sim.parser.textToBlocks(Sim.SAMPLE_TEXT));
    return addToLibrary([{
      name: 'Built-in samples',
      heading: 'Sample questions for trying out the simulator',
      images: {},
      questions: parsed.questions,
      cases: parsed.cases
    }], '', Sim.SAMPLE_TITLE);
  }

  Sim.importer = { open: open, addSamples: addSamples, exportPackage: exportPackage, readPackage: readPackage, readFile: readFile, kindOf: kindOf };
})();
