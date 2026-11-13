'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./dom-harness.js');
const core = require('../src/core.js');
const storage = require('../src/storage.js');
const exporter = require('../src/export.js');
const app = require('../src/app.js');

const IMAGE = 'data:image/jpeg;base64,AAAA';
const IMAGE_TWO = 'data:image/jpeg;base64,BBBB';
const KEY = 'test-credential-value';

const PLAN = {
  room_type: 'Bedroom',
  clutter_level: 'moderate',
  summary: 'Clothes on the chair and a crowded nightstand.',
  quick_win: { title: 'Clear the chair', estimated_minutes: 5, why_first: 'It is the easiest visible win.' },
  zones: [{ id: 'z1', name: 'Chair', observation: 'Covered in clothes.', priority: 'high', goal_state: 'Empty chair.' }],
  items: [{ name: 'Laundry pile', zone_id: 'z1', category: 'clothes', disposition: 'contain', source: 'vision', suggestion: 'One basket, one load.' }],
  action_plan: [{ step_id: 's1', zone_id: 'z1', action: 'Move clothes to the basket.', priority: 'high', impact: 'high', estimated_minutes: 10 }]
};

const PLAN_TWO = {
  room_type: 'Bedroom',
  clutter_level: 'light',
  summary: 'The chair is clear; the nightstand is next.',
  quick_win: { title: 'Clear the nightstand', estimated_minutes: 4, why_first: 'It is now the worst spot.' },
  zones: [],
  items: [],
  action_plan: [
    { step_id: 's1', zone_id: 'z1', action: 'Move clothes to the basket.', priority: 'high', impact: 'high', estimated_minutes: 10 },
    { step_id: 's2', zone_id: 'z2', action: 'Sort the nightstand drawer.', priority: 'medium', impact: 'medium', estimated_minutes: 6 }
  ]
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function () { return null; } },
    json: function () { return Promise.resolve(body); }
  };
}

function happyFetch(plan) {
  return function (url) {
    if (url === core.MISTRAL_OCR_ENDPOINT) {
      return Promise.resolve(jsonResponse(200, { pages: [{ markdown: 'LAUNDRY' }] }));
    }
    return Promise.resolve(jsonResponse(200, {
      choices: [{ message: { content: JSON.stringify(plan || PLAN) } }]
    }));
  };
}

function downscaleStub() {
  return function () { return Promise.resolve({ dataUrl: IMAGE, wasDownscaled: true }); };
}

function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function boot(options) {
  const opts = options || {};
  const doc = harness.createFakeDocument(harness.RENDER_IDS);
  harness.INITIALLY_HIDDEN.forEach(function (id) {
    doc.getElementById(id).hidden = true;
  });
  const ctx = app.initApp({
    document: doc,
    storage: harness.createMemoryStorage(),
    indexedDB: opts.indexedDB === undefined ? null : opts.indexedDB,
    fetch: opts.fetch,
    downscaleImpl: opts.downscaleImpl
  });
  return { doc: doc, ctx: ctx };
}

function prepare(doc) {
  doc.getElementById('mistral-key-input').value = KEY;
  doc.getElementById('room-hint-select').value = 'Bedroom';
  doc.getElementById('room-photo-input').files = [{ type: 'image/jpeg', size: 4096 }];
}

function rowFor(doc, stepId) {
  return doc.getElementById('actions-container').children.filter(function (row) {
    return row.getAttribute('data-step-id') === stepId;
  })[0];
}

function toggle(doc, stepId, checked) {
  const box = rowFor(doc, stepId).children[0];
  box.checked = checked;
  doc.getElementById('actions-container').dispatch('change', { target: box });
}

async function analyze(env) {
  prepare(env.doc);
  return app.handleAnalyzeSubmit(env.ctx);
}

// --- No IndexedDB --------------------------------------------------------

test('init_app_without_indexeddb_boots_cleanly_and_keeps_the_session_bar_hidden', async function () {
  const env = boot({ fetch: happyFetch(), downscaleImpl: downscaleStub() });
  await env.ctx.ready;

  assert.equal(env.doc.getElementById('session-bar').hidden, true);
  assert.deepEqual(env.ctx.state.sessions, []);

  const plan = await analyze(env);
  assert.equal(plan.room_type, 'Bedroom');
  assert.equal(env.doc.getElementById('results-section').hidden, false);
  assert.equal(env.doc.getElementById('session-bar').hidden, true, 'nothing can be resumed without a store');
});

// --- Saving --------------------------------------------------------------

test('an_analysis_saves_a_session_and_reveals_the_rescan_button', async function () {
  const factory = harness.createFakeIndexedDb();
  const env = boot({ indexedDB: factory, fetch: happyFetch(), downscaleImpl: downscaleStub() });
  await env.ctx.ready;

  assert.equal(env.doc.getElementById('rescan-btn').hidden, true);

  await analyze(env);
  await tick();

  assert.ok(env.ctx.state.activeSession, 'the analysis must open a session');
  assert.equal(env.ctx.state.activeSession.scans.length, 1);
  assert.equal(env.ctx.state.activeSession.scans[0].imageDataUrl, IMAGE);
  assert.equal(env.doc.getElementById('rescan-btn').hidden, false);

  const saved = await storage.listSessions({ indexedDB: factory });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, env.ctx.state.activeSession.id);
  assert.equal(saved[0].roomType, 'Bedroom');
});

test('checking_a_step_auto_saves_the_progress_immediately', async function () {
  const factory = harness.createFakeIndexedDb();
  const env = boot({ indexedDB: factory, fetch: happyFetch(), downscaleImpl: downscaleStub() });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  toggle(env.doc, 's1', true);
  await tick();

  const saved = await storage.listSessions({ indexedDB: factory });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].checked, { s1: true });
  assert.equal(env.doc.getElementById('checklist-progress').textContent, '1 of 1 steps done');

  toggle(env.doc, 's1', false);
  await tick();

  const cleared = await storage.listSessions({ indexedDB: factory });
  assert.deepEqual(cleared[0].checked, {});
});

// --- Resume --------------------------------------------------------------

test('a_fresh_document_shows_the_resume_bar_and_resume_restores_the_plan', async function () {
  const factory = harness.createFakeIndexedDb();

  const first = boot({ indexedDB: factory, fetch: happyFetch(), downscaleImpl: downscaleStub() });
  await first.ctx.ready;
  await analyze(first);
  await tick();
  toggle(first.doc, 's1', true);
  await tick();

  const second = boot({ indexedDB: factory });
  await second.ctx.ready;

  const bar = second.doc.getElementById('session-bar');
  assert.equal(bar.hidden, false);
  assert.match(second.doc.getElementById('session-resume-text').textContent, /Resume previous room \(1 of 1 done\)/);
  assert.equal(second.doc.getElementById('results-section').hidden, true, 'hydration must not open the results view');

  second.doc.getElementById('resume-session-btn').click();
  await tick();

  assert.equal(second.doc.getElementById('results-section').hidden, false);
  assert.equal(second.doc.getElementById('checklist-progress').textContent, '1 of 1 steps done');
  assert.equal(second.doc.getElementById('preview-image').getAttribute('src'), IMAGE);
  assert.equal(second.doc.getElementById('rescan-btn').hidden, false);
  assert.match(second.doc.getElementById('session-resume-text').textContent, /Resumed Bedroom/);
  assert.ok(second.doc.getElementById('status-banner').classList.contains('is-success'));
});

test('the_room_switcher_lists_every_saved_room_and_loads_the_chosen_one', async function () {
  const factory = harness.createFakeIndexedDb();
  const env = { indexedDB: factory };

  const bedroom = storage.createSession(
    { roomType: 'Bedroom', imageDataUrl: IMAGE, plan: PLAN, ocrText: '' },
    function () { return new Date('2026-04-01T12:00:00.000Z'); }
  );
  const garage = storage.createSession(
    { roomType: 'Garage', imageDataUrl: IMAGE_TWO, plan: PLAN_TWO, ocrText: '' },
    function () { return new Date('2026-04-02T12:00:00.000Z'); }
  );
  await storage.saveSession(bedroom, env);
  await storage.saveSession(garage, env);

  const booted = boot({ indexedDB: factory });
  await booted.ctx.ready;

  const switcher = booted.doc.getElementById('session-switcher');
  assert.equal(switcher.children.length, 2);
  assert.match(switcher.children[0].textContent, /Garage/, 'the newest room must be listed first');

  switcher.value = bedroom.id;
  switcher.dispatch('change');
  await tick();

  assert.equal(booted.ctx.state.activeSession.id, bedroom.id);
  assert.equal(booted.doc.getElementById('results-section').hidden, false);
  assert.equal(booted.doc.getElementById('checklist-progress').textContent, '0 of 1 steps done');
});

test('starting_a_new_room_clears_the_view_and_keeps_saved_rooms', async function () {
  const factory = harness.createFakeIndexedDb();
  const env = boot({ indexedDB: factory, fetch: happyFetch(), downscaleImpl: downscaleStub() });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  env.doc.getElementById('new-session-btn').click();
  await tick();

  assert.equal(env.ctx.state.activeSession, null);
  assert.equal(env.ctx.state.currentPlan, null);
  assert.equal(env.doc.getElementById('results-section').hidden, true);
  assert.equal(env.doc.getElementById('rescan-btn').hidden, true);
  assert.equal(env.doc.getElementById('before-after-container').hidden, true);

  const saved = await storage.listSessions({ indexedDB: factory });
  assert.equal(saved.length, 1, 'starting a new room must not delete history');
});

test('resuming_a_two_scan_session_restores_the_before_after_view', async function () {
  const factory = harness.createFakeIndexedDb();
  const env = { indexedDB: factory };

  const first = storage.createSession(
    { roomType: 'Bedroom', imageDataUrl: IMAGE, plan: PLAN, ocrText: '' },
    function () { return new Date('2026-04-01T12:00:00.000Z'); }
  );
  const second = storage.appendScanToSession(
    first,
    { roomType: 'Bedroom', imageDataUrl: IMAGE_TWO, plan: PLAN_TWO, ocrText: '' },
    function () { return new Date('2026-04-01T12:20:00.000Z'); }
  );
  await storage.saveSession(second, env);

  const booted = boot({ indexedDB: factory });
  await booted.ctx.ready;
  await app.handleResumeSession(booted.ctx, second.id);
  await tick();

  const container = booted.doc.getElementById('before-after-container');
  assert.equal(container.hidden, false);
  assert.equal(booted.doc.getElementById('before-image').getAttribute('src'), IMAGE);
  assert.equal(booted.doc.getElementById('after-image').getAttribute('src'), IMAGE_TWO);
  assert.equal(booted.doc.getElementById('rescan-btn').hidden, false);
  assert.equal(booted.doc.getElementById('checklist-progress').textContent, '0 of 2 steps done');
});

// --- Demo isolation ------------------------------------------------------

test('the_demo_stays_ephemeral_and_never_touches_saved_rooms', async function () {
  const factory = harness.createFakeIndexedDb();
  const env = boot({ indexedDB: factory, fetch: happyFetch(), downscaleImpl: downscaleStub() });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  const before = await storage.listSessions({ indexedDB: factory });
  assert.equal(before.length, 1);

  env.doc.getElementById('load-demo-btn').click();
  await tick();

  assert.equal(env.ctx.state.activeSession, null, 'the demo must not own a session');
  assert.equal(env.doc.getElementById('rescan-btn').hidden, true);
  assert.equal(env.doc.getElementById('before-after-container').hidden, true);
  assert.equal(env.doc.getElementById('results-section').hidden, false);

  const after = await storage.listSessions({ indexedDB: factory });
  assert.equal(after.length, 1);
  assert.deepEqual(after[0].checked, before[0].checked, 'the demo must not rewrite saved progress');
  assert.equal(after[0].updatedAt, before[0].updatedAt);
});

test('a_demo_click_during_an_in_flight_analysis_leaves_no_session_behind', async function () {
  const factory = harness.createFakeIndexedDb();
  let release;
  const gate = new Promise(function (resolve) { release = resolve; });
  const fetchImpl = function (url) {
    return gate.then(function () {
      if (url === core.MISTRAL_OCR_ENDPOINT) return jsonResponse(200, { pages: [{ markdown: 'LAUNDRY' }] });
      return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(PLAN) } }] });
    });
  };

  const env = boot({ indexedDB: factory, fetch: fetchImpl, downscaleImpl: downscaleStub() });
  await env.ctx.ready;

  const pending = analyze(env);
  env.doc.getElementById('load-demo-btn').click();
  release();
  await pending;
  await tick();

  assert.equal(env.ctx.state.activeSession, null);
  assert.equal(env.doc.getElementById('rescan-btn').hidden, true);
  assert.equal(env.doc.getElementById('grounding-badge').textContent, 'Bundled sample');

  const saved = await storage.listSessions({ indexedDB: factory });
  assert.deepEqual(saved, [], 'a superseded analysis must not be persisted');
});

// --- Superseded requests must not strand the loading UI -------------------

function gatedFetch() {
  let release;
  const gate = new Promise(function (resolve) { release = resolve; });
  const impl = function (url) {
    return gate.then(function () {
      if (url === core.MISTRAL_OCR_ENDPOINT) return jsonResponse(200, { pages: [{ markdown: 'LAUNDRY' }] });
      return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(PLAN) } }] });
    });
  };
  return { fetchImpl: impl, release: release };
}

test('resuming_a_room_during_an_in_flight_analysis_clears_the_loading_ui', async function () {
  const factory = harness.createFakeIndexedDb();
  const saved = storage.createSession(
    { roomType: 'Garage', imageDataUrl: IMAGE_TWO, plan: PLAN_TWO, ocrText: '' },
    function () { return new Date('2026-04-02T12:00:00.000Z'); }
  );
  await storage.saveSession(saved, { indexedDB: factory });

  const gate = gatedFetch();
  const env = boot({ indexedDB: factory, fetch: gate.fetchImpl, downscaleImpl: downscaleStub() });
  await env.ctx.ready;

  const pending = analyze(env);
  await tick();
  assert.equal(env.doc.getElementById('progress-panel').hidden, false, 'the analysis must show progress');
  assert.equal(env.doc.getElementById('analyze-btn').disabled, true);

  await app.handleResumeSession(env.ctx, saved.id);
  gate.release();
  await pending;
  await tick();

  assert.equal(env.doc.getElementById('progress-panel').hidden, true, 'the superseded request must not leave progress on screen');
  assert.equal(env.doc.getElementById('analyze-btn').disabled, false, 'the analyze button must be usable again');
  assert.equal(env.doc.getElementById('rescan-btn').disabled, false);
  assert.equal(env.ctx.state.activeSession.id, saved.id, 'the resumed room must win');
  assert.equal(env.doc.getElementById('checklist-progress').textContent, '0 of 2 steps done');
});

test('importing_a_room_during_an_in_flight_analysis_clears_the_loading_ui', async function () {
  const factory = harness.createFakeIndexedDb();
  const imported = storage.createSession(
    { roomType: 'Garage', imageDataUrl: IMAGE_TWO, plan: PLAN_TWO, ocrText: '' },
    function () { return new Date('2026-04-02T12:00:00.000Z'); }
  );

  const gate = gatedFetch();
  const env = boot({ indexedDB: factory, fetch: gate.fetchImpl, downscaleImpl: downscaleStub() });
  await env.ctx.ready;

  const pending = analyze(env);
  await tick();
  assert.equal(env.doc.getElementById('progress-panel').hidden, false);

  await app.handleImportSessionText(env.ctx, exporter.serializeSessionForExport(imported));
  gate.release();
  await pending;
  await tick();

  assert.equal(env.doc.getElementById('progress-panel').hidden, true);
  assert.equal(env.doc.getElementById('analyze-btn').disabled, false);
  assert.equal(env.doc.getElementById('rescan-btn').disabled, false);
  assert.equal(env.ctx.state.activeSession.roomType, 'Garage', 'the imported room must win');
  assert.equal(env.doc.getElementById('checklist-progress').textContent, '0 of 2 steps done');
});

test('a_failed_resume_leaves_the_in_flight_analysis_untouched', async function () {
  const factory = harness.createFakeIndexedDb();
  const gate = gatedFetch();
  const env = boot({ indexedDB: factory, fetch: gate.fetchImpl, downscaleImpl: downscaleStub() });
  await env.ctx.ready;

  const pending = analyze(env);
  await tick();

  const missing = await app.handleResumeSession(env.ctx, 'no-such-session');
  assert.equal(missing, null);

  gate.release();
  const plan = await pending;
  await tick();

  assert.equal(plan.room_type, 'Bedroom', 'a resume that found nothing must not cancel the analysis');
  assert.equal(env.doc.getElementById('progress-panel').hidden, true);
  assert.equal(env.doc.getElementById('analyze-btn').disabled, false);
  assert.ok(env.ctx.state.activeSession, 'the analysis must still open its session');
});

test('a_rescan_superseding_an_analysis_leaves_both_buttons_usable', async function () {
  const factory = harness.createFakeIndexedDb();
  const env = boot({ indexedDB: factory, fetch: happyFetch(), downscaleImpl: downscaleStub() });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  const gate = gatedFetch();
  env.ctx.fetch = gate.fetchImpl;

  const pendingAnalysis = analyze(env);
  await tick();
  assert.equal(env.doc.getElementById('analyze-btn').disabled, true);

  const pendingRescan = app.handleRescanSubmit(env.ctx, { type: 'image/jpeg', size: 4096 });
  await tick();
  assert.equal(env.doc.getElementById('rescan-btn').disabled, true);

  gate.release();
  await pendingAnalysis;
  await pendingRescan;
  await tick();

  assert.equal(env.doc.getElementById('analyze-btn').disabled, false, 'the superseded analysis must not strand the analyze button');
  assert.equal(env.doc.getElementById('rescan-btn').disabled, false, 'the winning rescan must re-enable the rescan button');
  assert.equal(env.doc.getElementById('progress-panel').hidden, true);
});

test('an_analysis_superseding_a_rescan_leaves_both_buttons_usable', async function () {
  const factory = harness.createFakeIndexedDb();
  const env = boot({ indexedDB: factory, fetch: happyFetch(), downscaleImpl: downscaleStub() });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  const gate = gatedFetch();
  env.ctx.fetch = gate.fetchImpl;

  const pendingRescan = app.handleRescanSubmit(env.ctx, { type: 'image/jpeg', size: 4096 });
  await tick();
  assert.equal(env.doc.getElementById('rescan-btn').disabled, true);

  const pendingAnalysis = analyze(env);
  await tick();
  assert.equal(env.doc.getElementById('analyze-btn').disabled, true);

  gate.release();
  await pendingRescan;
  await pendingAnalysis;
  await tick();

  assert.equal(env.doc.getElementById('analyze-btn').disabled, false, 'the winning analysis must re-enable the analyze button');
  assert.equal(env.doc.getElementById('rescan-btn').disabled, false, 'the superseded rescan must not strand the rescan button');
  assert.equal(env.doc.getElementById('progress-panel').hidden, true);
});
