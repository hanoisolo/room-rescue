'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const harness = require('./dom-harness.js');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

const REQUIRED_IDS = [
  'mistral-key-input',
  'save-key-btn',
  'clear-key-btn',
  'key-status-text',
  'dropzone',
  'room-photo-input',
  'room-hint-select',
  'analyze-btn',
  'load-demo-btn',
  'progress-panel',
  'status-banner',
  'results-section',
  'preview-image',
  'grounding-badge',
  'ocr-details-drawer',
  'summary-card',
  'quick-win-card',
  'checklist-progress',
  'actions-container',
  'zones-container',
  'items-container'
];

test('gitignore_excludes_env_and_plans', function () {
  const lines = read('.gitignore').split(/\r?\n/).map(function (line) { return line.trim(); });
  ['.env', '.env.*', 'plans/', 'node_modules/', '__pycache__/'].forEach(function (entry) {
    assert.ok(lines.indexOf(entry) !== -1, 'expected .gitignore to contain ' + entry);
  });
});

test('index_html_declares_every_required_dom_id', function () {
  const html = read('index.html');
  REQUIRED_IDS.forEach(function (id) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1, 'index.html is missing id="' + id + '"');
  });
});

test('index_html_loads_classic_scripts_in_dependency_order', function () {
  const html = read('index.html');
  const tags = html.match(/<script\b[^>]*>/g) || [];
  assert.equal(tags.length, 4, 'expected exactly four script tags');

  const sources = tags.map(function (tag) {
    const match = tag.match(/src="([^"]+)"/);
    assert.ok(match, 'every script tag must have a src attribute');
    assert.match(tag, /\bdefer\b/, 'every script tag must be deferred');
    assert.equal(/^https?:/i.test(match[1]), false, 'no external script may be loaded');
    return match[1];
  });

  assert.deepEqual(sources, ['src/core.js', 'src/api.js', 'src/demo-fixture.js', 'src/app.js']);
});

test('credential_input_is_masked_without_a_native_hidden_field', function () {
  const html = read('index.html');
  const inputTag = (html.match(/<input[^>]*id="mistral-key-input"[^>]*>/) || [])[0];
  assert.ok(inputTag, 'the credential input must exist');
  assert.match(inputTag, /type="text"/);
  assert.match(inputTag, /class="[^"]*masked-credential[^"]*"/);
  assert.match(inputTag, /autocomplete="off"/);
});

test('styles_css_defines_responsive_layout_and_priority_pills', function () {
  const css = read('styles.css');
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.results-top\s*\{[^}]*grid-template-columns/);
  ['.pill-high', '.pill-medium', '.pill-low'].forEach(function (selector) {
    assert.ok(css.indexOf(selector) !== -1, 'styles.css is missing ' + selector);
  });
  ['.status-banner.is-error', '.status-banner.is-warning', '.status-banner.is-info', '.status-banner.is-success'].forEach(function (selector) {
    assert.ok(css.indexOf(selector) !== -1, 'styles.css is missing ' + selector);
  });
  assert.match(css, /@media print/);
});

test('styles_css_masks_the_credential_input', function () {
  const css = read('styles.css');
  assert.match(css, /\.masked-credential\s*\{[^}]*-webkit-text-security:\s*disc/);
  assert.match(css, /\.action-step\.is-done \.action-text\s*\{[^}]*line-through/);
});

test('harness_render_ids_all_exist_in_index_html', function () {
  const html = read('index.html');

  harness.RENDER_IDS.forEach(function (id) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1, 'index.html is missing id="' + id + '"');
  });

  harness.INITIALLY_HIDDEN.forEach(function (id) {
    const tag = (html.match(new RegExp('<[^>]*id="' + id + '"[^>]*>')) || [])[0];
    assert.ok(tag, 'index.html is missing the element for ' + id);
    assert.match(tag, /\bhidden\b/, id + ' must ship hidden');
  });
});

test('styles_css_forces_hidden_elements_to_stay_hidden', function () {
  const css = read('styles.css');
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});
