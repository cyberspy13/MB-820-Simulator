/*
 * Exam rules: which questions are in a session, what counts as answered, and how answers are scored.
 * No DOM and no storage.
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const TYPE_NAMES = {
    choice: 'Multiple choice',
    match: 'Match or select',
    blanks: 'Complete the code',
    order: 'Put in order',
    self: 'Check it yourself'
  };

  function shuffle(list, rng) {
    const random = rng || Math.random;
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function wrongCount(stats, id) {
    const s = stats && stats.q && stats.q[id];
    return s ? s.wrong : 0;
  }

  // Returns the question ids for a session, in the order they will be shown.
  function select(questions, cfg, stats, rng) {
    let list;
    if (cfg.mode === 'exam') {
      list = questions.filter(function (q) { return q.exam === cfg.exam; });
    } else if (cfg.mode === 'sections') {
      list = questions.filter(function (q) { return cfg.sections.indexOf(q.section) >= 0; });
    } else if (cfg.mode === 'count') {
      const picked = new Set(shuffle(questions, rng).slice(0, cfg.count).map(function (q) { return q.id; }));
      list = questions.filter(function (q) { return picked.has(q.id); });
    } else if (cfg.mode === 'range') {
      list = questions.slice(cfg.from - 1, cfg.to);
    } else if (cfg.mode === 'wrong') {
      list = questions.filter(function (q) { return wrongCount(stats, q.id) >= cfg.wrong; });
    } else if (cfg.mode === 'ids') {
      const wanted = new Set(cfg.ids);
      list = questions.filter(function (q) { return wanted.has(q.id); });
    } else {
      list = questions;
    }
    const ids = list.map(function (q) { return q.id; });
    return cfg.shuffle ? shuffle(ids, rng) : ids;
  }

  function newSession(examId, cfg, ids, questionsById, now) {
    const pools = {};
    ids.forEach(function (id) {
      const q = questionsById.get(id);
      if (q.type === 'order') pools[id] = shuffle(q.items.map(function (_, i) { return i; }));
    });
    return {
      id: examId,
      sid: 's' + now.toString(36),
      candidate: cfg.candidate,
      cfg: cfg,
      created: now,
      training: !!cfg.training,
      timer: { on: !!cfg.timerOn, limit: cfg.minutes * 60000 },
      timeLeft: cfg.minutes * 60000,
      elapsed: 0,
      order: ids,
      pools: pools,
      idx: 0,
      begun: false,
      answers: {},
      flags: {},
      skipped: {},
      seen: {},
      shown: {},
      checked: {},
      accepted: {}
    };
  }

  // 'none', 'partial' or 'done'
  function status(q, resp) {
    if (resp === undefined || resp === null) return 'none';
    let filled;
    let needed;
    if (q.type === 'choice') {
      filled = resp.length;
      needed = q.answer.length;
    } else if (q.type === 'order') {
      filled = resp.length;
      needed = q.items.length;
    } else if (q.type === 'self') {
      if (resp.mark) return 'done';
      return resp.note ? 'partial' : 'none';
    } else {
      filled = resp.filter(Boolean).length;
      needed = q.rows.length;
    }
    if (!filled) return 'none';
    return filled >= needed ? 'done' : 'partial';
  }

  // Returns a score from 0 to 1. `accepted` is the candidate's own "count this as correct".
  function grade(q, resp, accepted) {
    if (status(q, resp) === 'none') return { score: 0, correct: false };
    let score = 0;
    if (accepted) {
      score = 1;
    } else if (q.type === 'choice') {
      const hits = resp.filter(function (k) { return q.answer.indexOf(k) >= 0; }).length;
      score = Math.max(0, hits - (resp.length - hits)) / q.answer.length;
    } else if (q.type === 'order') {
      const same = resp.length === q.items.length && resp.every(function (n, i) { return q.items[n] === q.items[i]; });
      score = same ? 1 : 0;
    } else if (q.type === 'self') {
      score = resp.mark === 'right' ? 1 : 0;
    } else {
      const right = q.rows.filter(function (r, i) { return resp[i] === r.answer; }).length;
      score = right / q.rows.length;
    }
    return { score: score, correct: score > 0.999 };
  }

  function counts(session, questionsById) {
    const c = { total: session.order.length, done: 0, partial: 0, none: 0, skipped: 0, flagged: 0 };
    session.order.forEach(function (id) {
      c[status(questionsById.get(id), session.answers[id])]++;
      if (session.skipped[id]) c.skipped++;
      if (session.flags[id]) c.flagged++;
    });
    return c;
  }

  function outcome(q, resp, accepted) {
    const g = grade(q, resp, accepted);
    if (status(q, resp) === 'none') return 'unanswered';
    if (g.correct) return 'correct';
    return g.score > 0 ? 'partial' : 'wrong';
  }

  function score(session, questionsById, passing) {
    const r = { total: session.order.length, correct: 0, partial: 0, wrong: 0, unanswered: 0, points: 0, sections: [], items: [] };
    const bySection = new Map();
    session.order.forEach(function (id) {
      const q = questionsById.get(id);
      const g = grade(q, session.answers[id], session.accepted[id]);
      const result = outcome(q, session.answers[id], session.accepted[id]);
      r[result]++;
      r.points += g.score;
      r.items.push({ id: id, result: result, score: g.score });
      const name = q.section;
      if (!bySection.has(name)) bySection.set(name, { name: name, total: 0, points: 0 });
      const s = bySection.get(name);
      s.total++;
      s.points += g.score;
    });
    r.sections = Array.from(bySection.values());
    r.scaled = r.total ? Math.round(r.points / r.total * 1000) : 0;
    r.passed = r.scaled >= passing;
    return r;
  }

  function addToStats(stats, result) {
    result.items.forEach(function (item) {
      if (item.result === 'unanswered') return;
      const s = stats.q[item.id] || { right: 0, wrong: 0 };
      if (item.result === 'correct') s.right++;
      else s.wrong++;
      stats.q[item.id] = s;
    });
    return stats;
  }

  // The right answer as lines of text.
  function answerLines(q) {
    if (q.type === 'choice') {
      return q.answer.map(function (key) {
        const o = q.options.find(function (x) { return x.key === key; });
        return key + (o && o.text ? '. ' + o.text : '');
      });
    }
    if (q.type === 'order') return q.items.map(function (t, i) { return (i + 1) + '. ' + t; });
    if (q.type === 'match' || q.type === 'blanks') return q.rows.map(function (r) { return r.prompt + ': ' + r.answer; });
    return [];
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const two = function (n) { return String(n).padStart(2, '0'); };
    return Math.floor(s / 3600) + ':' + two(Math.floor(s / 60) % 60) + ':' + two(s % 60);
  }

  Sim.engine = {
    TYPE_NAMES: TYPE_NAMES,
    shuffle: shuffle,
    wrongCount: wrongCount,
    select: select,
    newSession: newSession,
    status: status,
    grade: grade,
    outcome: outcome,
    counts: counts,
    score: score,
    addToStats: addToStats,
    answerLines: answerLines,
    formatTime: formatTime
  };
})();
