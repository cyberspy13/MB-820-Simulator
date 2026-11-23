/*
 * Keeps exams, saved sessions, history and per-question statistics in the browser (IndexedDB).
 * Falls back to memory when the browser blocks storage, and says so through `persistent`.
 */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const NAME = 'mb820-exam-simulator';
  const STORES = ['exams', 'content', 'sessions', 'history', 'stats'];

  let opening = null;
  let memory = null;

  function useMemory() {
    if (!memory) {
      memory = {};
      STORES.forEach(function (s) { memory[s] = new Map(); });
      Sim.store.persistent = false;
    }
    return null;
  }

  function open() {
    if (!opening) {
      opening = new Promise(function (resolve) {
        let req;
        try {
          req = indexedDB.open(NAME, 1);
        } catch (err) {
          resolve(useMemory());
          return;
        }
        req.onupgradeneeded = function () {
          STORES.forEach(function (s) {
            if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
          });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(useMemory()); };
        req.onblocked = function () { resolve(useMemory()); };
      });
    }
    return opening;
  }

  function run(store, mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(store, mode);
        const req = work(tx.objectStore(store));
        tx.oncomplete = function () { resolve(req.result); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error('Saving failed')); };
      });
    });
  }

  async function get(store, id) {
    await open();
    if (memory) return memory[store].get(id);
    return run(store, 'readonly', function (s) { return s.get(id); });
  }

  async function all(store) {
    await open();
    if (memory) return Array.from(memory[store].values());
    return run(store, 'readonly', function (s) { return s.getAll(); });
  }

  async function put(store, value) {
    await open();
    if (memory) {
      memory[store].set(value.id, structuredClone(value));
      return;
    }
    await run(store, 'readwrite', function (s) { return s.put(value); });
  }

  async function remove(store, id) {
    await open();
    if (memory) {
      memory[store].delete(id);
      return;
    }
    await run(store, 'readwrite', function (s) { return s.delete(id); });
  }

  const prefs = {
    get: function (key, fallback) {
      try {
        const raw = localStorage.getItem('mb820sim:' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        localStorage.setItem('mb820sim:' + key, JSON.stringify(value));
      } catch (err) {
        // Preferences are a convenience; the app works without them.
      }
    }
  };

  Sim.store = { get: get, all: all, put: put, remove: remove, prefs: prefs, persistent: true };
})();
