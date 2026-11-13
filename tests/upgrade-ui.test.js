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
const PREV_SMALL = 'data:image/jpeg;base64,UFJFVg==';
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

function makeFetch(plans) {
  const calls = [];
  let chatIndex = 0;
  function fetchImpl(url, init) {
    calls.push({ url: url, body: init && init.body ? JSON.parse(init.body) : null });
    if (url === core.MISTRAL_OCR_ENDPOINT) {
      return Promise.resolve(jsonResponse(200, { pages: [{ markdown: 'LAUNDRY' }] }));
    }
    const plan = plans[Math.min(chatIndex, plans.length - 1)];
    chatIndex += 1;
    return Promise.resolve(jsonResponse(200, { choices: [{ message: { content: JSON.stringify(plan) } }] }));
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

function downscaleStub() {
  let count = 0;
  return function () {
    count += 1;
    return Promise.resolve({ dataUrl: count === 1 ? IMAGE : IMAGE_TWO, wasDownscaled: true });
  };
}

function prevStub() {
  return function () {
    return Promise.resolve({ dataUrl: PREV_SMALL, width: 512, height: 384, wasDownscaled: true });
  };
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
    downscaleImpl: opts.downscaleImpl,
    downscaleDataUrlImpl: opts.downscaleDataUrlImpl,
    clipboard: opts.clipboard,
    printImpl: opts.printImpl,
    downloadImpl: opts.downloadImpl,
    readTextImpl: opts.readTextImpl
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

// --- Progress re-scan ----------------------------------------------------

test('a_progress_rescan_sends_the_previous_photo_at_512_and_appends_a_scan', async function () {
  const factory = harness.createFakeIndexedDb();
  const fetchImpl = makeFetch([PLAN, PLAN_TWO]);
  const downscaleCalls = [];

  const env = boot({
    indexedDB: factory,
    fetch: fetchImpl,
    downscaleImpl: downscaleStub(),
    downscaleDataUrlImpl: function (dataUrl, deps) {
      downscaleCalls.push({ dataUrl: dataUrl, deps: deps });
      return prevStub()(dataUrl, deps);
    }
  });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  toggle(env.doc, 's1', true);
  await tick();

  const plan = await app.handleRescanSubmit(env.ctx, { type: 'image/jpeg', size: 4096 });
  await tick();

  assert.equal(downscaleCalls.length, 1, 'only the previous photo is re-downscaled');
  assert.equal(downscaleCalls[0].dataUrl, IMAGE);
  assert.equal(downscaleCalls[0].deps.maxEdge, 512);

  const chatCalls = fetchImpl.calls.filter(function (call) { return call.url === core.MISTRAL_CHAT_ENDPOINT; });
  assert.equal(chatCalls.length, 2);
  const content = chatCalls[1].body.messages[0].content;
  assert.equal(content.length, 3);
  assert.equal(content[0].image_url, IMAGE_TWO, 'the new photo rides first');
  assert.equal(content[1].image_url, PREV_SMALL, 'the previous photo rides second, at 512px');
  assert.match(content[2].text, /<previous_scan_progress>/);
  assert.match(content[2].text, /"completed_tasks":\[\{"step_id":"s1"/);

  assert.equal(plan.room_type, 'Bedroom');
  assert.equal(env.ctx.state.activeSession.scans.length, 2);
  assert.equal(env.ctx.state.activeSession.activeScanIndex, 1);
  assert.equal(env.doc.getElementById('before-after-container').hidden, false);
  assert.equal(env.doc.getElementById('before-image').getAttribute('src'), IMAGE);
  assert.equal(env.doc.getElementById('after-image').getAttribute('src'), IMAGE_TWO);
  assert.equal(env.doc.getElementById('checklist-progress').textContent, '0 of 2 steps done');
  assert.ok(env.doc.getElementById('status-banner').classList.contains('is-success'));

  const saved = await storage.listSessions({ indexedDB: factory });
  assert.equal(saved[0].scans.length, 2);
});

test('the_comparison_slider_moves_the_clip_boundary', async function () {
  const factory = harness.createFakeIndexedDb();
  const env = boot({
    indexedDB: factory,
    fetch: makeFetch([PLAN, PLAN_TWO]),
    downscaleImpl: downscaleStub(),
    downscaleDataUrlImpl: prevStub()
  });
  await env.ctx.ready;
  await analyze(env);
  await tick();
  await app.handleRescanSubmit(env.ctx, { type: 'image/jpeg', size: 4096 });
  await tick();

  const slider = env.doc.getElementById('compare-slider');
  slider.value = '30';
  slider.dispatch('input');

  assert.equal(env.doc.getElementById('after-image').style.clipPath, 'inset(0 0 0 30%)');
  assert.equal(env.doc.getElementById('before-image').style.clipPath, 'inset(0 70% 0 0)');

  slider.value = '0';
  slider.dispatch('input');
  assert.equal(env.doc.getElementById('after-image').style.clipPath, 'inset(0 0 0 0%)');
});

test('a_failed_rescan_leaves_the_first_scan_intact', async function () {
  const factory = harness.createFakeIndexedDb();
  let chatCalls = 0;
  const fetchImpl = function (url) {
    if (url === core.MISTRAL_OCR_ENDPOINT) {
      return Promise.resolve(jsonResponse(200, { pages: [{ markdown: 'LAUNDRY' }] }));
    }
    chatCalls += 1;
    if (chatCalls === 1) {
      return Promise.resolve(jsonResponse(200, { choices: [{ message: { content: JSON.stringify(PLAN) } }] }));
    }
    return Promise.resolve(jsonResponse(500, { message: 'boom' }));
  };

  const env = boot({
    indexedDB: factory,
    fetch: fetchImpl,
    downscaleImpl: downscaleStub(),
    downscaleDataUrlImpl: prevStub()
  });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  await assert.rejects(app.handleRescanSubmit(env.ctx, { type: 'image/jpeg', size: 4096 }), function (err) {
    assert.equal(err.code, 'API_ERROR');
    return true;
  });
  await tick();

  assert.equal(env.ctx.state.activeSession.scans.length, 1, 'the first scan must survive a failed update');
  assert.equal(env.doc.getElementById('rescan-btn').disabled, false, 'the button must be usable again');
  assert.ok(env.doc.getElementById('status-banner').classList.contains('is-error'));

  const saved = await storage.listSessions({ indexedDB: factory });
  assert.equal(saved[0].scans.length, 1);
});

test('a_demo_click_during_an_in_flight_rescan_is_not_overwritten', async function () {
  const factory = harness.createFakeIndexedDb();
  let release;
  const gate = new Promise(function (resolve) { release = resolve; });
  let chatCalls = 0;

  const fetchImpl = function (url) {
    if (url === core.MISTRAL_OCR_ENDPOINT) {
      return Promise.resolve(jsonResponse(200, { pages: [{ markdown: 'LAUNDRY' }] }));
    }
    chatCalls += 1;
    if (chatCalls === 1) {
      return Promise.resolve(jsonResponse(200, { choices: [{ message: { content: JSON.stringify(PLAN) } }] }));
    }
    return gate.then(function () {
      return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(PLAN_TWO) } }] });
    });
  };

  const env = boot({
    indexedDB: factory,
    fetch: fetchImpl,
    downscaleImpl: downscaleStub(),
    downscaleDataUrlImpl: prevStub()
  });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  const pending = app.handleRescanSubmit(env.ctx, { type: 'image/jpeg', size: 4096 });
  env.doc.getElementById('load-demo-btn').click();
  release();
  await pending;
  await tick();

  assert.equal(env.ctx.state.activeSession, null);
  assert.equal(env.doc.getElementById('grounding-badge').textContent, 'Bundled sample');
  assert.equal(env.doc.getElementById('before-after-container').hidden, true);
  assert.equal(env.doc.getElementById('rescan-btn').hidden, true);

  const saved = await storage.listSessions({ indexedDB: factory });
  assert.equal(saved[0].scans.length, 1, 'a superseded rescan must not be persisted');
});

test('a_rescan_without_an_active_room_is_refused_cleanly', async function () {
  const env = boot({});
  await env.ctx.ready;

  await assert.rejects(app.handleRescanSubmit(env.ctx, { type: 'image/jpeg', size: 4096 }), /no active room/);

  const banner = env.doc.getElementById('status-banner');
  assert.equal(banner.hidden, false);
  assert.ok(banner.classList.contains('is-info'));
  assert.match(banner.textContent, /Analyze a room first/);
});

// --- Copy as Markdown ----------------------------------------------------

test('copy_as_markdown_writes_the_checklist_through_the_injected_clipboard', async function () {
  const written = [];
  const env = boot({
    indexedDB: harness.createFakeIndexedDb(),
    fetch: makeFetch([PLAN]),
    downscaleImpl: downscaleStub(),
    clipboard: { writeText: function (text) { written.push(text); return Promise.resolve(); } }
  });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  toggle(env.doc, 's1', true);
  env.doc.getElementById('copy-md-btn').click();
  await tick();

  assert.equal(written.length, 1);
  assert.match(written[0], /# Room Rescue — Bedroom/);
  assert.match(written[0], /- \[x\] Move clothes to the basket\./);
  assert.ok(env.doc.getElementById('status-banner').classList.contains('is-success'));
});

test('copy_as_markdown_works_on_the_demo_plan', async function () {
  const written = [];
  const env = boot({
    clipboard: { writeText: function (text) { written.push(text); return Promise.resolve(); } }
  });
  await env.ctx.ready;

  env.doc.getElementById('load-demo-btn').click();
  env.doc.getElementById('copy-md-btn').click();
  await tick();

  assert.equal(written.length, 1);
  assert.match(written[0], /# Room Rescue — Home Office/);
  assert.match(written[0], /- \[ \] Clear the centre of the desk into a single staging box\./);
});

test('copy_as_markdown_shows_guidance_when_the_clipboard_refuses', async function () {
  const env = boot({
    clipboard: { writeText: function () { return Promise.reject(new Error('denied')); } }
  });
  await env.ctx.ready;

  env.doc.getElementById('load-demo-btn').click();
  env.doc.getElementById('copy-md-btn').click();
  await tick();

  const banner = env.doc.getElementById('status-banner');
  assert.ok(banner.classList.contains('is-error'));
  assert.match(banner.textContent, /clipboard/);
});

// --- Print ---------------------------------------------------------------

test('print_invokes_the_injected_printer', async function () {
  let printed = 0;
  const env = boot({ printImpl: function () { printed += 1; } });
  await env.ctx.ready;

  env.doc.getElementById('load-demo-btn').click();
  env.doc.getElementById('print-btn').click();

  assert.equal(printed, 1);
});

// --- Export / import -----------------------------------------------------

test('export_writes_the_session_through_the_injected_downloader', async function () {
  const written = [];
  const env = boot({
    indexedDB: harness.createFakeIndexedDb(),
    fetch: makeFetch([PLAN]),
    downscaleImpl: downscaleStub(),
    downloadImpl: function (filename, content, mimeType) {
      written.push({ filename: filename, content: content, mimeType: mimeType });
    }
  });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  env.doc.getElementById('export-json-btn').click();

  assert.equal(written.length, 1);
  assert.match(written[0].filename, /^room-rescue-session_.*\.json$/);
  assert.equal(written[0].mimeType, 'application/json');

  const parsed = JSON.parse(written[0].content);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.session.scans.length, 1);
  assert.ok(env.doc.getElementById('status-banner').classList.contains('is-success'));
});

test('export_in_demo_mode_explains_itself_instead_of_throwing', async function () {
  let downloads = 0;
  const env = boot({ downloadImpl: function () { downloads += 1; } });
  await env.ctx.ready;

  env.doc.getElementById('load-demo-btn').click();
  env.doc.getElementById('export-json-btn').click();

  assert.equal(downloads, 0, 'the demo has no session to export');
  const banner = env.doc.getElementById('status-banner');
  assert.ok(banner.classList.contains('is-info'));
  assert.match(banner.textContent, /Analyze a room first/);
});

test('importing_a_json_session_persists_and_renders_it', async function () {
  const factory = harness.createFakeIndexedDb();
  const source = storage.createSession({
    roomType: 'Garage',
    imageDataUrl: IMAGE,
    plan: PLAN,
    ocrText: ''
  });
  const json = exporter.serializeSessionForExport(source);

  const env = boot({ indexedDB: factory });
  await env.ctx.ready;

  const imported = await app.handleImportSessionText(env.ctx, json);
  await tick();

  assert.equal(imported.id, source.id);
  assert.equal(env.doc.getElementById('results-section').hidden, false);
  assert.equal(env.doc.getElementById('checklist-progress').textContent, '0 of 1 steps done');
  assert.equal(env.doc.getElementById('rescan-btn').hidden, false);
  assert.ok(env.doc.getElementById('status-banner').classList.contains('is-success'));

  const saved = await storage.listSessions({ indexedDB: factory });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, source.id);
});

test('importing_garbage_shows_an_error_and_keeps_the_current_room', async function () {
  const env = boot({
    indexedDB: harness.createFakeIndexedDb(),
    fetch: makeFetch([PLAN]),
    downscaleImpl: downscaleStub()
  });
  await env.ctx.ready;
  await analyze(env);
  await tick();

  const before = env.ctx.state.activeSession.id;

  await assert.rejects(app.handleImportSessionText(env.ctx, 'this is not json'), function (err) {
    assert.equal(err.code, 'INVALID_IMPORT');
    return true;
  });

  assert.equal(env.ctx.state.activeSession.id, before, 'a bad file must not replace the open room');
  const banner = env.doc.getElementById('status-banner');
  assert.ok(banner.classList.contains('is-error'));
  assert.match(banner.textContent, /not a Room Rescue session/);
});
