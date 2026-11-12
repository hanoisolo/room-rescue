'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./dom-harness.js');
const core = require('../src/core.js');
const api = require('../src/api.js');
const app = require('../src/app.js');

const ROOT = path.join(__dirname, '..');
const IMAGE = 'data:image/jpeg;base64,AAAA';
const KEY = 'test-credential-value';

const IDS = harness.RENDER_IDS;

const PLAN = {
  room_type: 'Bedroom',
  clutter_level: 'moderate',
  summary: 'Clothes on the chair and a crowded nightstand.',
  quick_win: { title: 'Clear the chair', estimated_minutes: 5, why_first: 'It is the easiest visible win.' },
  zones: [{ id: 'z1', name: 'Chair', observation: 'Covered in clothes.', priority: 'high', goal_state: 'Empty chair.' }],
  items: [{ name: 'Laundry pile', zone_id: 'z1', category: 'clothes', disposition: 'contain', source: 'vision', suggestion: 'One basket, one load.' }],
  action_plan: [{ step_id: 's1', zone_id: 'z1', action: 'Move clothes to the basket.', priority: 'high', impact: 'high', estimated_minutes: 10 }]
};

function jsonResponse(status, body, headers) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function (name) { return (headers || {})[String(name).toLowerCase()] || null; } },
    json: function () { return Promise.resolve(body); }
  };
}

function boot(options) {
  const opts = options || {};
  const doc = harness.createFakeDocument(IDS);
  harness.INITIALLY_HIDDEN.forEach(function (id) {
    doc.getElementById(id).hidden = true;
  });
  const storage = harness.createMemoryStorage();
  const ctx = app.initApp({
    document: doc,
    storage: storage,
    fetch: opts.fetch,
    downscaleImpl: opts.downscaleImpl
  });
  return { doc: doc, storage: storage, ctx: ctx };
}

function prepare(doc, withFile) {
  doc.getElementById('mistral-key-input').value = KEY;
  doc.getElementById('room-hint-select').value = 'Bedroom';
  if (withFile) doc.getElementById('room-photo-input').files = [{ type: 'image/jpeg', size: 4096 }];
}

function downscaleStub() {
  return function () { return Promise.resolve({ dataUrl: IMAGE, wasDownscaled: true }); };
}

function happyFetch(ocrBody) {
  const calls = [];
  function fetchImpl(url, init) {
    calls.push({ url: url, body: init && init.body ? JSON.parse(init.body) : null });
    if (url === core.MISTRAL_OCR_ENDPOINT) return Promise.resolve(jsonResponse(200, ocrBody));
    if (url === core.MISTRAL_CHAT_ENDPOINT) {
      return Promise.resolve(jsonResponse(200, { choices: [{ message: { content: JSON.stringify(PLAN) } }] }));
    }
    return Promise.reject(new Error('unexpected url ' + url));
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('live_upload_flow_renders_the_plan_with_a_mocked_api', async function () {
  const fetchImpl = happyFetch({ pages: [{ index: 0, markdown: 'LAUNDRY', confidence_scores: { average_page_confidence_score: 0.88 } }] });
  const env = boot({ fetch: fetchImpl, downscaleImpl: downscaleStub() });
  prepare(env.doc, true);

  const plan = await app.handleAnalyzeSubmit(env.ctx);

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].body.model, 'mistral-ocr-4');
  assert.equal(fetchImpl.calls[1].body.model, 'mistral-large-4');
  assert.equal(plan.meta.grounding_mode, 'vision_plus_ocr');

  const doc = env.doc;
  assert.equal(doc.getElementById('results-section').hidden, false);
  assert.equal(doc.getElementById('preview-image').getAttribute('src'), IMAGE);
  assert.equal(doc.getElementById('grounding-badge').textContent, 'Vision + OCR labels');
  assert.equal(doc.getElementById('actions-container').children.length, 1);
  assert.equal(doc.getElementById('zones-container').children.length, 1);
  assert.equal(doc.getElementById('items-container').children.length, 1);
  assert.equal(doc.getElementById('checklist-progress').textContent, '0 of 1 steps done');
  assert.match(doc.getElementById('ocr-text').textContent, /LAUNDRY/);

  const banner = doc.getElementById('status-banner');
  assert.ok(banner.classList.contains('is-success'));
  assert.equal(doc.getElementById('progress-panel').hidden, true);
});

test('live_flow_shows_the_vision_only_notice_when_ocr_is_empty', async function () {
  const fetchImpl = happyFetch({ pages: [{ index: 0, markdown: '![img-0.jpeg](img-0.jpeg)' }] });
  const env = boot({ fetch: fetchImpl, downscaleImpl: downscaleStub() });
  prepare(env.doc, true);

  const plan = await app.handleAnalyzeSubmit(env.ctx);

  assert.equal(plan.meta.grounding_mode, 'vision_only_ocr_empty');
  const banner = env.doc.getElementById('status-banner');
  assert.ok(banner.classList.contains('is-info'));
  assert.match(banner.textContent, /visual analysis/);
  assert.equal(env.doc.getElementById('grounding-badge').textContent, 'Vision only — no text found');
  assert.equal(env.doc.getElementById('results-section').hidden, false);
});

test('every_actionable_error_renders_distinct_guidance', async function () {
  const cases = [];

  const noKey = boot({ fetch: happyFetch({ pages: [] }), downscaleImpl: downscaleStub() });
  cases.push({ name: 'MISSING_KEY', env: noKey, expect: /Paste your Mistral API key/ });

  const unauthorized = boot({
    fetch: function () { return Promise.resolve(jsonResponse(401, { message: 'Unauthorized' })); },
    downscaleImpl: downscaleStub()
  });
  prepare(unauthorized.doc, true);
  cases.push({ name: 'AUTH_INVALID', env: unauthorized, expect: /rejected that API key/ });

  const limited = boot({
    fetch: function () { return Promise.resolve(jsonResponse(429, { message: 'Too many requests' }, { 'retry-after': '9' })); },
    downscaleImpl: downscaleStub()
  });
  prepare(limited.doc, true);
  cases.push({ name: 'RATE_LIMITED', env: limited, expect: /rate limiting/ });

  const offline = boot({
    fetch: function () { return Promise.reject(new TypeError('Failed to fetch')); },
    downscaleImpl: downscaleStub()
  });
  prepare(offline.doc, true);
  cases.push({ name: 'NETWORK_ERROR', env: offline, expect: /Could not reach the Mistral API/ });

  const tooBig = boot({
    fetch: happyFetch({ pages: [] }),
    downscaleImpl: function () {
      return Promise.reject(new api.RoomRescueError('IMAGE_TOO_LARGE', 'That photo is too large even after resizing.'));
    }
  });
  prepare(tooBig.doc, true);
  cases.push({ name: 'IMAGE_TOO_LARGE', env: tooBig, expect: /too large/ });

  const noFile = boot({ fetch: happyFetch({ pages: [] }), downscaleImpl: downscaleStub() });
  prepare(noFile.doc, false);
  cases.push({ name: 'UNSUPPORTED_IMAGE', env: noFile, expect: /Choose a photo of the room first/ });

  // These two exercise the real downscaler so validateRawFile actually runs.
  const wrongType = boot({ fetch: happyFetch({ pages: [] }) });
  wrongType.doc.getElementById('mistral-key-input').value = KEY;
  wrongType.doc.getElementById('room-photo-input').files = [{ type: 'application/pdf', size: 1024 }];
  cases.push({ name: 'UNSUPPORTED_IMAGE', env: wrongType, expect: /not supported/ });

  const hugeRaw = boot({ fetch: happyFetch({ pages: [] }) });
  hugeRaw.doc.getElementById('mistral-key-input').value = KEY;
  hugeRaw.doc.getElementById('room-photo-input').files = [{ type: 'image/jpeg', size: 30 * 1048576 }];
  cases.push({ name: 'IMAGE_TOO_LARGE', env: hugeRaw, expect: /25 MB/ });

  const seen = new Set();
  for (const item of cases) {
    await assert.rejects(app.handleAnalyzeSubmit(item.env.ctx), function (err) {
      assert.equal(err.code, item.name);
      return true;
    });
    const banner = item.env.doc.getElementById('status-banner');
    assert.equal(banner.hidden, false, item.name + ' must show a banner');
    assert.ok(banner.classList.contains('is-error'), item.name + ' must render as an error');
    assert.match(banner.textContent, item.expect, item.name + ' copy mismatch');
    assert.equal(item.env.doc.getElementById('progress-panel').hidden, true);
    seen.add(banner.textContent);
  }

  assert.equal(seen.size, cases.length, 'each failure must produce distinct guidance');
});

test('missing_key_blocks_the_request_before_any_network_call', async function () {
  let calls = 0;
  const env = boot({
    fetch: function () { calls += 1; return Promise.resolve(jsonResponse(200, {})); },
    downscaleImpl: downscaleStub()
  });
  env.doc.getElementById('room-photo-input').files = [{ type: 'image/jpeg', size: 4096 }];

  await assert.rejects(app.handleAnalyzeSubmit(env.ctx), function (err) {
    assert.equal(err.code, 'MISSING_KEY');
    return true;
  });
  assert.equal(calls, 0);
});

test('drag_and_drop_selects_the_file_without_assigning_input_files', async function () {
  const fetchImpl = happyFetch({ pages: [{ index: 0, markdown: 'LAUNDRY' }] });
  const env = boot({ fetch: fetchImpl, downscaleImpl: downscaleStub() });
  env.doc.getElementById('mistral-key-input').value = KEY;

  const dropped = { type: 'image/jpeg', size: 4096, name: 'room.jpg' };
  env.doc.getElementById('dropzone').dispatch('drop', { dataTransfer: { files: [dropped] } });

  assert.equal(env.ctx.state.selectedFile, dropped);
  assert.equal(
    env.doc.getElementById('room-photo-input').files,
    null,
    'input.files must never be assigned a plain array'
  );

  const plan = await app.handleAnalyzeSubmit(env.ctx);
  assert.equal(plan.room_type, 'Bedroom');
  assert.equal(env.doc.getElementById('results-section').hidden, false);
});

test('demo_click_during_an_in_flight_analysis_is_not_overwritten', async function () {
  let release;
  const gate = new Promise(function (resolve) { release = resolve; });
  const fetchImpl = function (url) {
    return gate.then(function () {
      if (url === core.MISTRAL_OCR_ENDPOINT) return jsonResponse(200, { pages: [{ markdown: 'LAUNDRY' }] });
      return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(PLAN) } }] });
    });
  };

  const env = boot({ fetch: fetchImpl, downscaleImpl: downscaleStub() });
  prepare(env.doc, true);

  const pending = app.handleAnalyzeSubmit(env.ctx);
  env.doc.getElementById('load-demo-btn').click();
  release();
  await pending;

  assert.equal(env.doc.getElementById('grounding-badge').textContent, 'Bundled sample');
  assert.equal(env.doc.getElementById('actions-container').children.length, 5);
  assert.equal(env.doc.getElementById('analyze-btn').disabled, false);
});

test('every_script_src_exists_on_disk', function () {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sources = (html.match(/<script\b[^>]*src="([^"]+)"/g) || []).map(function (tag) {
    return tag.match(/src="([^"]+)"/)[1];
  });

  assert.equal(sources.length, 4);
  sources.forEach(function (src) {
    assert.equal(fs.existsSync(path.join(ROOT, src)), true, 'missing script file: ' + src);
  });

  ['styles.css', 'index.html', '.gitignore'].forEach(function (file) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, 'missing file: ' + file);
  });
});

test('repository_contains_no_banned_markers', function () {
  const banned = [
    'A' + 'Iza',
    's' + 'k-',
    'g' + 'hp_',
    'api' + '_key',
    'sec' + 'ret',
    'to' + 'ken',
    'pass' + 'word'
  ];

  const skipDirs = ['.git', 'plans', 'node_modules', '__pycache__'];

  function walk(dir, acc) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.indexOf(entry.name) !== -1) return;
        walk(full, acc);
        return;
      }
      acc.push(full);
    });
    return acc;
  }

  const files = walk(ROOT, []);
  assert.ok(files.length >= 10, 'expected the repository to contain the source and test files');

  // No environment file may sit in the working tree at all, so nothing is skipped.
  const envFiles = files.filter(function (file) {
    return /(^|[\\/])\.env/.test(file);
  });
  assert.deepEqual(envFiles, [], 'no environment file may exist in the working tree');

  const hits = [];
  files.forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    banned.forEach(function (marker) {
      if (text.indexOf(marker) !== -1) {
        hits.push(path.relative(ROOT, file) + ' contains a banned marker');
      }
    });
  });

  assert.deepEqual(hits, [], 'banned markers found: ' + hits.join('; '));
});
