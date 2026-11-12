'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./dom-harness.js');
const app = require('../src/app.js');
const demo = require('../src/demo-fixture.js');

const REQUIRED_IDS = harness.RENDER_IDS;

function boot() {
  const doc = harness.createFakeDocument(REQUIRED_IDS);
  // Mirror the initial state declared in index.html.
  harness.INITIALLY_HIDDEN.forEach(function (id) {
    doc.getElementById(id).hidden = true;
  });
  const storage = harness.createMemoryStorage();
  let networkCalls = 0;
  const fetchImpl = function () {
    networkCalls += 1;
    return Promise.reject(new Error('the demo must not touch the network'));
  };
  const ctx = app.initApp({ document: doc, storage: storage, fetch: fetchImpl });
  return {
    doc: doc,
    storage: storage,
    ctx: ctx,
    networkCalls: function () { return networkCalls; }
  };
}

test('demo_button_populates_the_full_results_view_with_no_key_and_no_network', function () {
  const env = boot();
  const doc = env.doc;

  assert.equal(doc.getElementById('results-section').hidden, true);

  doc.getElementById('load-demo-btn').click();

  assert.equal(env.networkCalls(), 0, 'the demo must not call the network');
  assert.equal(env.storage.getItem('room_rescue_mistral_credential'), null, 'the demo must not need a key');

  assert.equal(doc.getElementById('results-section').hidden, false);
  assert.match(doc.getElementById('preview-image').getAttribute('src'), /^data:image\/svg\+xml/);
  assert.ok(harness.textOf(doc.getElementById('summary-text')).length > 40);
  assert.equal(doc.getElementById('clutter-level').textContent, 'heavy');
  assert.match(doc.getElementById('total-minutes').textContent, /^\d+ min$/);
  assert.match(doc.getElementById('quick-win-title').textContent, /\(\d+ min\)$/);

  assert.equal(doc.getElementById('actions-container').children.length, 5);
  assert.equal(doc.getElementById('zones-container').children.length, 3);
  assert.equal(doc.getElementById('items-container').children.length, 5);
  assert.equal(doc.getElementById('checklist-progress').textContent, '0 of 5 steps done');

  const banner = doc.getElementById('status-banner');
  assert.equal(banner.hidden, false);
  assert.ok(banner.classList.contains('is-success'));
  assert.match(banner.textContent, /Sample room loaded/);

  const badge = doc.getElementById('grounding-badge');
  assert.equal(badge.textContent, 'Bundled sample');
});

test('demo_fixture_matches_the_live_render_contract', function () {
  const fixture = demo.getDemoFixture();
  const plan = fixture.plan;

  ['room_type', 'clutter_level', 'summary', 'quick_win', 'zones', 'items', 'action_plan', 'total_estimated_minutes', 'meta'].forEach(function (key) {
    assert.ok(Object.prototype.hasOwnProperty.call(plan, key), 'fixture plan is missing ' + key);
  });

  assert.equal(plan.meta.is_demo, true);
  assert.equal(plan.meta.grounding_mode, 'demo_fixture');
  assert.equal(plan.meta.ocr_status, 'ocr_grounded');
  assert.ok(plan.meta.ocr_text.length > 0);
  assert.ok(plan.zones.length >= 3);
  assert.ok(plan.items.length >= 5);
  assert.ok(plan.action_plan.length >= 5);
  assert.ok(plan.total_estimated_minutes > 0);
  assert.match(fixture.imageDataUrl, /^data:image\//);

  const ranked = plan.action_plan.map(function (step) { return step.priority; });
  assert.equal(ranked[0], 'high', 'the highest priority step must come first');
  assert.equal(ranked[ranked.length - 1], 'low', 'the lowest priority step must come last');

  const labelled = plan.items.filter(function (item) { return item.source === 'vision_and_ocr'; });
  assert.ok(labelled.length >= 2, 'the fixture must exercise the OCR-grounded item path');
});

test('checklist_checkbox_updates_completion_progress', function () {
  const env = boot();
  const doc = env.doc;
  doc.getElementById('load-demo-btn').click();

  const container = doc.getElementById('actions-container');
  const firstRow = container.children[0];
  const box = firstRow.children[0];

  assert.equal(box.getAttribute('type'), 'checkbox');
  assert.equal(box.checked, false);

  box.checked = true;
  container.dispatch('change', { target: box });

  assert.ok(firstRow.classList.contains('is-done'));
  assert.equal(doc.getElementById('checklist-progress').textContent, '1 of 5 steps done');

  box.checked = false;
  container.dispatch('change', { target: box });

  assert.equal(firstRow.classList.contains('is-done'), false);
  assert.equal(doc.getElementById('checklist-progress').textContent, '0 of 5 steps done');
});

test('init_app_is_idempotent_per_document', function () {
  const doc = harness.createFakeDocument(REQUIRED_IDS);
  const storage = harness.createMemoryStorage();

  const first = app.initApp({ document: doc, storage: storage });
  assert.ok(first, 'the first call must return a context');

  const second = app.initApp({ document: doc, storage: storage });
  assert.equal(second, null, 'a second call on the same document must be a no-op');

  const otherDoc = harness.createFakeDocument(REQUIRED_IDS);
  const third = app.initApp({ document: otherDoc, storage: storage });
  assert.ok(third, 'a different document must still initialize');
});

test('renders_the_vision_only_notice_when_ocr_found_no_text', function () {
  const doc = harness.createFakeDocument(REQUIRED_IDS);

  app.renderStatusBanner(doc, { code: 'vision_only_ocr_empty' });
  const banner = doc.getElementById('status-banner');
  assert.equal(banner.hidden, false);
  assert.ok(banner.classList.contains('is-info'));
  assert.match(banner.textContent, /visual analysis/);

  app.renderStatusBanner(doc, { code: 'AUTH_INVALID' });
  assert.ok(banner.classList.contains('is-error'));
  assert.match(banner.textContent, /rejected that API key/);

  app.renderStatusBanner(doc, { code: 'RATE_LIMITED' });
  assert.ok(banner.classList.contains('is-error'));
  assert.match(banner.textContent, /rate limiting/);

  app.renderStatusBanner(doc, { code: 'NETWORK_ERROR' });
  assert.match(banner.textContent, /Could not reach the Mistral API/);

  app.renderStatusBanner(doc, { code: 'IMAGE_TOO_LARGE' });
  assert.match(banner.textContent, /too large/);

  app.renderStatusBanner(doc, { code: 'MISSING_KEY' });
  assert.match(banner.textContent, /Paste your Mistral API key/);
});
