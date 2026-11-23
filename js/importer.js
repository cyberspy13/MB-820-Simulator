/* Uploading: reads files, shows what was found, and adds the questions to the library. */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};
  const S = Sim.store;
  const E = Sim.engine;
  const h = Sim.dom.h;

  const FORMAT = 'mb820-exam-simulator';
  const TYPES = ['choice', 'match', 'blanks', 'order', 'self'];

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  function listNumbers(nums) {
    return nums.slice(0, 25).join(', ') + (nums.length > 25 ? ' and ' + (nums.length - 25) + ' more' : '');
  }

  /* ---------- reading files ---------- */

  async function readFile(file, onProgress) {
    const name = file.name;
    if (/\.json$/i.test(name)) return readPackage(name, await file.text());
    let source;
    if (/\.pdf$/i.test(name)) {
      source = await Sim.pdf.read(await file.arrayBuffer(), onProgress);
    } else if (/\.(txt|md)$/i.test(name)) {
      source = { blocks: Sim.parser.textToBlocks(await file.text()), images: {}, heading: '' };
    } else {
      throw new Error('This file type is not supported. Use PDF, TXT, MD or JSON.');
    }
    const parsed = Sim.parser.parse(source.blocks);
    if (!parsed.questions.length) {
      throw new Error('No questions found. Each one should start with a line such as "Question 1" and have an "Answer:" line.');
    }
    return {
      name: name,
      heading: source.heading,
      images: keepUsed(parsed, source.images),
      questions: parsed.questions,
      cases: parsed.cases,
      report: parsed.report
    };
  }

  function keepUsed(parsed, images) {
    const used = new Set();
    const scan = function (blocks) {
      (blocks || []).forEach(function (b) { if (b.t === 'img') used.add(b.ref); });
    };
    parsed.cases.forEach(function (c) { scan(c.blocks); });
    parsed.questions.forEach(function (q) {
      scan(q.stem);
      scan(q.explanation);
      scan(q.solution);
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
      data = JSON.parse(text);
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
      if (img && /^data:image\/(?:png|jpeg|webp|gif);base64,/.test(img.url)) images[ref] = { url: img.url, w: Number(img.w) || 400 };
    });
    const types = {};
    data.questions.forEach(function (q) { types[q.type] = (types[q.type] || 0) + 1; });
    return {
      name: name,
      packaged: true,
      title: typeof data.title === 'string' ? data.title : baseName(name),
      heading: typeof data.heading === 'string' ? data.heading : '',
      passing: Number(data.passing) || 700,
      minutes: Number(data.minutes) || 120,
      questions: data.questions,
      cases: Array.isArray(data.cases) ? data.cases : [],
      images: images,
      report: { total: data.questions.length, types: types, missing: [], repeated: [], self: [], noAnswer: [], pictureOptions: [] }
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
          content.questions.push(q);
        });
        meta.exams.push({ name: name, count: list.length, source: f.name });
      });
      Object.assign(content.images, f.images);
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

  function reportView(f) {
    const r = f.report;
    const lines = [];
    const kinds = Object.keys(r.types).map(function (t) { return E.TYPE_NAMES[t] + ': ' + r.types[t]; }).join(' · ');
    if (r.missing.length) lines.push('Numbers missing from the file: ' + listNumbers(r.missing));
    if (r.repeated.length) lines.push('Numbers used more than once: ' + listNumbers(r.repeated));
    if (r.self.length) lines.push('You mark these yourself, because the answer is a picture or free text: ' + listNumbers(r.self));
    if (r.noAnswer.length) lines.push('No answer found, so you mark these yourself: ' + listNumbers(r.noAnswer));
    if (r.pictureOptions.length) lines.push('The answer choices are only in a picture: ' + listNumbers(r.pictureOptions));
    return h('div', { class: 'import-ok' },
      h('p', {}, h('strong', { text: f.name }), ': ' + r.total + ' questions' + (f.cases.length ? ', ' + f.cases.length + ' case studies' : '')),
      h('p', { class: 'muted', text: kinds }),
      lines.length ? h('ul', {}, lines.map(function (t) { return h('li', { text: t }); })) : null);
  }

  // Resolves with the exam the questions went into, or null.
  async function open(startFiles) {
    const exams = await S.all('exams');
    let ready = [];
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

    function refresh() {
      settings.hidden = !ready.length;
      if (addButton) addButton.disabled = busy || !ready.length;
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
          ready.push(f);
          if (!title.value) title.value = f.title || baseName(file.name);
          results.append(reportView(f));
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
      accept: '.pdf,.txt,.md,.json',
      'aria-label': 'Choose question files',
      onchange: function () {
        take(picker.files);
      }
    });
    const drop = h('label', { class: 'drop' },
      h('strong', { text: 'Choose files or drop them here' }),
      h('span', { class: 'muted', text: 'PDF, TXT, MD, or a JSON file exported from this simulator' }),
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

    if (startFiles && startFiles.length) setTimeout(function () { take(startFiles); }, 0);
    const ok = await Sim.dom.dialog('Upload questions', [
      drop,
      bar,
      note,
      results,
      settings,
      h('p', { class: 'muted' }, 'Files stay on this computer. ',
        h('button', {
          type: 'button',
          class: 'link',
          text: 'Download a text template',
          onclick: function () { Sim.dom.download('Question template.txt', Sim.SAMPLE_TEXT, 'text/plain'); }
        }))
    ], [
      { label: 'Add to library', value: true, primary: true, bind: function (el) { addButton = el; el.disabled = true; } },
      { label: 'Cancel', value: false }
    ], 'wide');
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

  Sim.importer = { open: open, addSamples: addSamples, exportPackage: exportPackage, readPackage: readPackage };
})();
