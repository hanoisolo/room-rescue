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
  'summary-text', 'clutter-level', 'total-minutes', 'remaining-minutes', 'quick-win-title', 'quick-win-why', 'ocr-text'
];

// Regions that index.html ships hidden until there is something to show.
const INITIALLY_HIDDEN = ['results-section', 'progress-panel', 'status-banner'];

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

module.exports = {
  RENDER_IDS: RENDER_IDS,
  INITIALLY_HIDDEN: INITIALLY_HIDDEN,
  createFakeDocument: createFakeDocument,
  createMemoryStorage: createMemoryStorage,
  textOf: textOf,
  descendants: descendants
};
