'use strict';

// A deliberately small DOM stand-in: just enough surface for src/app.js to render
// into, so the UI layer can be exercised headlessly with no browser and no npm.

// Every element id src/app.js renders into. shell.test.js asserts these all
// exist in index.html, so the harness and the real markup cannot drift apart.
const RENDER_IDS = [
  'mistral-key-input', 'save-key-btn', 'clear-key-btn', 'key-status-text',
  'dropzone', 'room-photo-input', 'room-hint-select', 'analyze-btn', 'load-demo-btn',
  'progress-panel', 'status-banner', 'results-section', 'preview-image', 'grounding-badge',
  'ocr-details-drawer', 'summary-card', 'quick-win-card', 'checklist-progress',
  'actions-container', 'zones-container', 'items-container',
  'summary-text', 'clutter-level', 'total-minutes', 'remaining-minutes', 'quick-win-title', 'quick-win-why', 'ocr-text',
  'session-bar', 'session-resume-text', 'session-switcher', 'resume-session-btn', 'new-session-btn',
  'rescan-btn', 'rescan-photo-input', 'before-after-container', 'before-image', 'after-image', 'compare-slider',
  'print-btn', 'copy-md-btn', 'export-json-btn', 'import-json-btn', 'import-json-input'
];

// Regions that index.html ships hidden until there is something to show.
const INITIALLY_HIDDEN = [
  'results-section', 'progress-panel', 'status-banner',
  'session-bar', 'rescan-btn', 'rescan-photo-input', 'before-after-container', 'import-json-input'
];

function createFakeDocument(ids) {
  const registry = new Map();

  function makeNode(tagName) {
    const node = {
      tagName: String(tagName || 'div').toUpperCase(),
      children: [],
      attributes: {},
      classes: new Set(),
      text: '',
      hidden: false,
      value: '',
      checked: false,
      files: null,
      style: {},
      listeners: {},
      parentNode: null
    };

    node.classList = {
      add: function () {
        for (let i = 0; i < arguments.length; i += 1) node.classes.add(arguments[i]);
      },
      remove: function () {
        for (let i = 0; i < arguments.length; i += 1) node.classes.delete(arguments[i]);
      },
      contains: function (name) { return node.classes.has(name); },
      toggle: function (name, force) {
        const on = force === undefined ? !node.classes.has(name) : Boolean(force);
        if (on) node.classes.add(name);
        else node.classes.delete(name);
        return on;
      }
    };

    node.setAttribute = function (name, value) {
      node.attributes[name] = String(value);
      if (name === 'id') {
        node.id = String(value);
        registry.set(node.id, node);
      }
      if (name === 'class') {
        node.classes.clear();
        String(value).split(/\s+/).filter(Boolean).forEach(function (name2) { node.classes.add(name2); });
      }
    };

    node.getAttribute = function (name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
    };

    node.appendChild = function (child) {
      node.children.push(child);
      child.parentNode = node;
      return child;
    };

    node.removeChild = function (child) {
      const index = node.children.indexOf(child);
      if (index !== -1) node.children.splice(index, 1);
      child.parentNode = null;
      return child;
    };

    node.addEventListener = function (type, handler) {
      if (!node.listeners[type]) node.listeners[type] = [];
      node.listeners[type].push(handler);
    };

    node.dispatch = function (type, event) {
      const payload = event || {};
      if (!payload.target) payload.target = node;
      if (!payload.preventDefault) payload.preventDefault = function () {};
      (node.listeners[type] || []).forEach(function (handler) { handler(payload); });
      return payload;
    };

    node.click = function () { node.dispatch('click'); };

    Object.defineProperty(node, 'textContent', {
      get: function () { return node.text; },
      set: function (value) {
        node.text = value === null || value === undefined ? '' : String(value);
        node.children.length = 0;
      }
    });

    Object.defineProperty(node, 'innerHTML', {
      get: function () { return node.text; },
      set: function (value) {
        node.text = value === null || value === undefined ? '' : String(value);
        node.children.length = 0;
      }
    });

    return node;
  }

  const doc = {
    readyState: 'complete',
    createElement: function (tag) { return makeNode(tag); },
    getElementById: function (id) { return registry.get(id) || null; },
    addEventListener: function () {}
  };

  (ids || []).forEach(function (id) {
    const node = makeNode('div');
    node.setAttribute('id', id);
  });

  return doc;
}

function textOf(node) {
  if (!node) return '';
  if (node.children && node.children.length) return node.children.map(textOf).join(' ');
  return node.text || '';
}

function descendants(node, predicate, acc) {
  const found = acc || [];
  (node && node.children ? node.children : []).forEach(function (child) {
    if (!predicate || predicate(child)) found.push(child);
    descendants(child, predicate, found);
  });
  return found;
}

function createMemoryStorage() {
  const data = {};
  return {
    data: data,
    getItem: function (name) {
      return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : null;
    },
    setItem: function (name, value) { data[name] = String(value); },
    removeItem: function (name) { delete data[name]; }
  };
}

// A hand-written IndexedDB stand-in. Node has no indexedDB, so the storage
// wrapper is exercised against exactly the surface src/storage.js touches.
// Requests settle on a microtask and a transaction completes once its last
// request settles.
function createFakeIndexedDb(options) {
  const opts = options || {};
  const databases = new Map();
  const log = { opened: 0, closed: 0, transactions: [] };

  function createStoreHandle(def, tx) {
    function run(opName, work) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      tx._register();
      queueMicrotask(function () {
        if (opts.failOn === opName) {
          request.error = new Error('fake failure on ' + opName);
          if (request.onerror) request.onerror({ target: request });
          tx._fail();
          return;
        }
        try {
          work(request);
          if (request.onsuccess) request.onsuccess({ target: request });
          tx._settle();
        } catch (err) {
          request.error = err;
          if (request.onerror) request.onerror({ target: request });
          tx._fail();
        }
      });
      return request;
    }

    return {
      name: def.name,
      keyPath: def.keyPath,
      put: function (value) {
        return run('put', function (request) {
          const key = def.keyPath ? value[def.keyPath] : value;
          def.rows.set(key, value);
          request.result = key;
        });
      },
      get: function (key) {
        return run('get', function (request) {
          request.result = def.rows.has(key) ? def.rows.get(key) : undefined;
        });
      },
      getAll: function () {
        return run('getAll', function (request) {
          request.result = Array.from(def.rows.values());
        });
      },
      delete: function (key) {
        return run('delete', function (request) {
          def.rows.delete(key);
          request.result = undefined;
        });
      },
      clear: function () {
        return run('clear', function (request) {
          def.rows.clear();
          request.result = undefined;
        });
      }
    };
  }

  function createTransaction(storeName, mode) {
    const tx = {
      mode: mode,
      oncomplete: null,
      onerror: null,
      onabort: null,
      _pending: 0,
      _closed: false,
      _store: null
    };

    function maybeComplete() {
      if (tx._closed || tx._pending > 0) return;
      tx._closed = true;
      queueMicrotask(function () {
        if (tx.oncomplete) tx.oncomplete({ target: tx });
      });
    }

    tx._register = function () { tx._pending += 1; };
    tx._settle = function () {
      tx._pending -= 1;
      maybeComplete();
    };
    tx._fail = function () {
      if (tx._closed) return;
      tx._closed = true;
      queueMicrotask(function () {
        if (tx.onerror) tx.onerror({ target: tx });
      });
    };
    tx.objectStore = function () { return tx._store; };
    return tx;
  }

  function createDatabase(name, version) {
    const storeDefs = new Map();
    const db = {
      name: name,
      version: version,
      _defs: storeDefs,
      objectStoreNames: {
        contains: function (storeName) { return storeDefs.has(storeName); }
      },
      createObjectStore: function (storeName, config) {
        const def = {
          name: storeName,
          keyPath: config && config.keyPath ? config.keyPath : null,
          rows: new Map(),
          indexes: new Map()
        };
        storeDefs.set(storeName, def);
        return {
          createIndex: function (indexName, keyPath, indexConfig) {
            const index = {
              name: indexName,
              keyPath: keyPath,
              unique: Boolean(indexConfig && indexConfig.unique)
            };
            def.indexes.set(indexName, index);
            return index;
          }
        };
      },
      transaction: function (storeName, mode) {
        const def = storeDefs.get(storeName);
        if (!def) throw new Error('no such object store: ' + storeName);
        const tx = createTransaction(storeName, mode);
        tx._store = createStoreHandle(def, tx);
        log.transactions.push({ store: storeName, mode: mode });
        return tx;
      },
      close: function () {
        log.closed += 1;
        db._closed = true;
      },
      _closed: false
    };
    return db;
  }

  return {
    open: function (name, version) {
      const request = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null
      };
      log.opened += 1;
      queueMicrotask(function () {
        let db = databases.get(name);
        const isNew = !db;
        if (!db) {
          db = createDatabase(name, version);
          databases.set(name, db);
        }
        request.result = db;
        if (isNew && request.onupgradeneeded) {
          request.onupgradeneeded({ target: request, oldVersion: 0, newVersion: version });
        }
        if (request.onsuccess) request.onsuccess({ target: request });
      });
      return request;
    },
    _databases: databases,
    _log: log
  };
}

module.exports = {
  RENDER_IDS: RENDER_IDS,
  INITIALLY_HIDDEN: INITIALLY_HIDDEN,
  createFakeDocument: createFakeDocument,
  createMemoryStorage: createMemoryStorage,
  createFakeIndexedDb: createFakeIndexedDb,
  textOf: textOf,
  descendants: descendants
};
