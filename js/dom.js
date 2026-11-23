/* Small helpers for building the page. Uploaded text is only ever inserted as text, never as HTML. */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const AS_PROPERTY = ['checked', 'disabled', 'selected', 'multiple', 'readOnly'];

  function add(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(function (k) { add(el, k); });
    else el.append(kid);
  }

  // h('button', { class: 'btn', onclick: fn }, 'Save')
  function h(tag, props) {
    const el = document.createElement(tag);
    const all = props || {};
    Object.keys(all).forEach(function (key) {
      const v = all[key];
      if (v === undefined || v === null || key === 'value') return;
      if (key === 'class') el.className = v;
      else if (key === 'text') el.textContent = v;
      else if (key.slice(0, 2) === 'on') el.addEventListener(key.slice(2), v);
      else if (AS_PROPERTY.indexOf(key) >= 0) el[key] = v;
      else if (v !== false) el.setAttribute(key, v === true ? '' : String(v));
    });
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    if (all.value !== undefined && all.value !== null) el.value = all.value;
    return el;
  }

  // buttons: [{ label, value, primary, danger, check }]. Resolves with the chosen value, or null.
  function dialog(title, body, buttons, className) {
    return new Promise(function (resolve) {
      let result = null;
      const d = h('dialog', { class: 'dlg ' + (className || ''), 'aria-label': title });
      const bar = h('div', { class: 'dlg-actions' });
      let primary = null;
      buttons.forEach(function (b) {
        const el = h('button', {
          type: 'button',
          class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
          text: b.label,
          onclick: function () {
            if (b.check && !b.check()) return;
            result = b.value;
            d.close();
          }
        });
        if (b.primary) primary = el;
        if (b.bind) b.bind(el);
        bar.append(el);
      });
      d.append(
        h('div', { class: 'dlg-head' },
          h('h2', { text: title }),
          h('button', { type: 'button', class: 'dlg-x', 'aria-label': 'Close', text: '✕', onclick: function () { d.close(); } })),
        h('div', { class: 'dlg-body' }, body),
        bar
      );
      d.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && primary && !primary.disabled && e.target.tagName === 'INPUT' && e.target.type !== 'file') {
          e.preventDefault();
          primary.click();
        }
      });
      d.addEventListener('close', function () {
        d.remove();
        resolve(result);
      });
      document.body.append(d);
      d.showModal();
      // Start on the first field or the main button, not on the close button.
      const first = d.querySelector('.dlg-body input[type=text], .dlg-body input[type=file]') || (primary && !primary.disabled ? primary : null);
      if (first) first.focus();
    });
  }

  function confirmBox(title, text, yes, danger) {
    const lines = [].concat(text).map(function (t) { return h('p', { text: t }); });
    return dialog(title, lines, [
      { label: yes, value: true, primary: !danger, danger: danger },
      { label: 'Cancel', value: false }
    ], 'small').then(Boolean);
  }

  function alertBox(title, text) {
    const lines = [].concat(text).map(function (t) { return h('p', { text: t }); });
    return dialog(title, lines, [{ label: 'OK', value: true, primary: true }], 'small');
  }

  function linkify(text) {
    const out = [];
    text.split(/(https?:\/\/[^\s)]+)/).forEach(function (part) {
      if (/^https?:\/\//.test(part)) out.push(h('a', { href: part, target: '_blank', rel: 'noopener noreferrer', text: part }));
      else if (part) out.push(part);
    });
    return out;
  }

  function picture(ref, images) {
    const img = images[ref];
    if (!img) return null;
    return h('img', { class: 'exhibit', src: img.url, alt: 'Exhibit from the question', style: 'width:' + Math.round((img.w || 400) * 1.5) + 'px' });
  }

  function renderBlocks(blocks, images) {
    const box = document.createDocumentFragment();
    let list = null;
    (blocks || []).forEach(function (b) {
      if (b.t === 'li') {
        if (!list) {
          list = h('ul', {});
          box.append(list);
        }
        list.append(h('li', {}, linkify(b.text)));
        return;
      }
      list = null;
      if (b.t === 'h') box.append(h('h3', { text: b.text }));
      else if (b.t === 'code') box.append(h('pre', { class: 'code', text: b.text }));
      else if (b.t === 'img') add(box, picture(b.ref, images));
      else box.append(h('p', {}, linkify(b.text)));
    });
    return box;
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  Sim.dom = {
    h: h,
    dialog: dialog,
    confirmBox: confirmBox,
    alertBox: alertBox,
    renderBlocks: renderBlocks,
    picture: picture,
    download: download
  };
})();
