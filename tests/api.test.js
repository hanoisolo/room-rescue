'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');
const api = require('../src/api.js');

const IMAGE = 'data:image/jpeg;base64,AAAA';
const KEY = 'test-credential-value';

const PLAN = {
  room_type: 'Home Office',
  clutter_level: 'heavy',
  summary: 'A desk buried in paper and cables.',
  quick_win: { title: 'Clear the desk surface', estimated_minutes: 5, why_first: 'It is the first thing you see.' },
  zones: [{ id: 'z1', name: 'Desk surface', observation: 'Covered in paper.', priority: 'high', goal_state: 'Clear workspace.' }],
  items: [{ name: 'Tax documents', zone_id: 'z1', category: 'paper', disposition: 'contain', source: 'vision_and_ocr', suggestion: 'File in a labelled box.' }],
  action_plan: [{ step_id: 's1', zone_id: 'z1', action: 'Sort paper into keep and shred.', priority: 'high', impact: 'high', estimated_minutes: 15 }]
};

function jsonResponse(status, body, headers) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function (name) { return (headers || {})[String(name).toLowerCase()] || null; } },
    json: function () { return Promise.resolve(body); }
  };
}

function makeFetch(handlers) {
  const calls = [];
  function fetchImpl(url, init) {
    const record = { url: url, init: init, body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(record);
    const handler = handlers[url];
    if (!handler) return Promise.reject(new Error('unexpected url ' + url));
    return Promise.resolve(handler(record, calls.length));
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

function ocrWithLabels() {
  return jsonResponse(200, { pages: [{ index: 0, markdown: 'TAX DOCS 2023', confidence_scores: { average_page_confidence_score: 0.9 } }] });
}

function ocrEmpty() {
  return jsonResponse(200, { pages: [{ index: 0, markdown: '![img-0.jpeg](img-0.jpeg)' }] });
}

function chatWithPlan() {
  return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(PLAN) } }] });
}

test('orchestrates_happy_path_with_ocr_labels', async function () {
  const fetchImpl = makeFetch({
    [core.MISTRAL_OCR_ENDPOINT]: ocrWithLabels,
    [core.MISTRAL_CHAT_ENDPOINT]: chatWithPlan
  });
  const stages = [];
  const plan = await api.analyzeRoomPhoto({
    imageDataUrl: IMAGE,
    mistralKey: KEY,
    roomHint: 'Home Office',
    fetchImpl: fetchImpl,
    onStage: function (stage) { stages.push(stage); }
  });

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].body.model, 'mistral-ocr-4');
  assert.equal(fetchImpl.calls[1].body.model, 'mistral-large-4');
  assert.equal(fetchImpl.calls[1].init.headers.Authorization, 'Bearer ' + KEY);

  const visionText = fetchImpl.calls[1].body.messages[0].content.find(function (p) { return p.type === 'text'; }).text;
  assert.match(visionText, /TAX DOCS 2023/);

  assert.equal(plan.room_type, 'Home Office');
  assert.equal(plan.meta.grounding_mode, 'vision_plus_ocr');
  assert.equal(plan.total_estimated_minutes, 15);
  assert.deepEqual(stages, ['ocr', 'vision', 'done']);
});

test('orchestrates_ocr_empty_but_vision_ok_path', async function () {
  const fetchImpl = makeFetch({
    [core.MISTRAL_OCR_ENDPOINT]: ocrEmpty,
    [core.MISTRAL_CHAT_ENDPOINT]: chatWithPlan
  });
  const plan = await api.analyzeRoomPhoto({ imageDataUrl: IMAGE, mistralKey: KEY, fetchImpl: fetchImpl });

  assert.equal(fetchImpl.calls.length, 2);
  const content = fetchImpl.calls[1].body.messages[0].content;
  assert.equal(content[0].type, 'image_url');
  assert.equal(content[0].image_url, IMAGE);
  assert.match(content[1].text, /status="none"/);
  assert.equal(plan.meta.grounding_mode, 'vision_only_ocr_empty');
  assert.equal(plan.meta.ocr_status, 'ocr_empty');
});

test('falls_back_to_vision_when_ocr_returns_a_non_auth_error', async function () {
  const fetchImpl = makeFetch({
    [core.MISTRAL_OCR_ENDPOINT]: function () { return jsonResponse(500, { message: 'Internal failure' }); },
    [core.MISTRAL_CHAT_ENDPOINT]: chatWithPlan
  });
  const plan = await api.analyzeRoomPhoto({ imageDataUrl: IMAGE, mistralKey: KEY, fetchImpl: fetchImpl });

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(plan.meta.grounding_mode, 'vision_only_ocr_unavailable');
  assert.equal(plan.meta.ocr_status, 'ocr_unavailable');
});

test('rejects_missing_key_before_any_network_call', async function () {
  const fetchImpl = makeFetch({});
  await assert.rejects(
    api.analyzeRoomPhoto({ imageDataUrl: IMAGE, mistralKey: '', fetchImpl: fetchImpl }),
    function (err) {
      assert.equal(err.code, 'MISSING_KEY');
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('maps_http_401_to_auth_invalid', async function () {
  const fetchImpl = makeFetch({
    [core.MISTRAL_OCR_ENDPOINT]: function () { return jsonResponse(401, { message: 'Unauthorized' }); }
  });
  await assert.rejects(
    api.analyzeRoomPhoto({ imageDataUrl: IMAGE, mistralKey: KEY, fetchImpl: fetchImpl }),
    function (err) {
      assert.equal(err.code, 'AUTH_INVALID');
      assert.equal(err.status, 401);
      assert.match(err.userMessage, /rejected that API key/);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('maps_http_429_to_rate_limited_with_retry_after', async function () {
  const fetchImpl = makeFetch({
    [core.MISTRAL_OCR_ENDPOINT]: function () { return jsonResponse(429, { message: 'Too many requests' }, { 'retry-after': '12' }); }
  });
  await assert.rejects(
    api.analyzeRoomPhoto({ imageDataUrl: IMAGE, mistralKey: KEY, fetchImpl: fetchImpl }),
    function (err) {
      assert.equal(err.code, 'RATE_LIMITED');
      assert.match(err.userMessage, /12 seconds/);
      return true;
    }
  );
});

test('maps_fetch_rejection_to_network_error', async function () {
  const fetchImpl = function () { return Promise.reject(new TypeError('Failed to fetch')); };
  await assert.rejects(
    api.analyzeRoomPhoto({ imageDataUrl: IMAGE, mistralKey: KEY, fetchImpl: fetchImpl }),
    function (err) {
      assert.equal(err.code, 'NETWORK_ERROR');
      return true;
    }
  );
});

test('rejects_oversized_image_payload', async function () {
  const fetchImpl = makeFetch({});
  await assert.rejects(
    api.analyzeRoomPhoto({ imageDataUrl: IMAGE, mistralKey: KEY, fetchImpl: fetchImpl, maxPayloadBytes: 2 }),
    function (err) {
      assert.equal(err.code, 'IMAGE_TOO_LARGE');
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('rejects_unsupported_file_type', function () {
  assert.throws(function () { api.validateRawFile({ type: 'application/pdf', size: 100 }); }, function (err) {
    assert.equal(err.code, 'UNSUPPORTED_IMAGE');
    return true;
  });
  assert.throws(function () { api.validateRawFile({ type: 'image/jpeg', size: core.MAX_RAW_FILE_BYTES + 1 }); }, function (err) {
    assert.equal(err.code, 'IMAGE_TOO_LARGE');
    return true;
  });
  assert.deepEqual(api.validateRawFile({ type: 'image/png', size: 2048 }), { type: 'image/png', size: 2048 });
});

test('persists_and_clears_the_credential_in_storage', function () {
  const store = {
    data: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
    setItem: function (k, v) { this.data[k] = String(v); },
    removeItem: function (k) { delete this.data[k]; }
  };

  assert.equal(api.loadMistralKey(store), '');
  assert.equal(api.saveMistralKey('  abc123  ', store), 'abc123');
  assert.equal(api.loadMistralKey(store), 'abc123');
  assert.equal(store.data[core.STORAGE_KEY_NAME], 'abc123');
  assert.equal(api.clearMistralKey(store), '');
  assert.equal(api.loadMistralKey(store), '');

  assert.throws(function () { api.saveMistralKey('   ', store); }, function (err) {
    assert.equal(err.code, 'MISSING_KEY');
    return true;
  });
});

test('retries_once_with_json_object_when_schema_is_rejected', async function () {
  let chatAttempts = 0;
  const fetchImpl = makeFetch({
    [core.MISTRAL_OCR_ENDPOINT]: ocrWithLabels,
    [core.MISTRAL_CHAT_ENDPOINT]: function (record) {
      chatAttempts += 1;
      if (record.body.response_format.type === 'json_schema') {
        return jsonResponse(400, { message: 'response_format is not supported for this model' });
      }
      return chatWithPlan();
    }
  });

  const plan = await api.analyzeRoomPhoto({ imageDataUrl: IMAGE, mistralKey: KEY, fetchImpl: fetchImpl });

  assert.equal(chatAttempts, 2);
  assert.equal(fetchImpl.calls[1].body.response_format.type, 'json_schema');
  assert.equal(fetchImpl.calls[2].body.response_format.type, 'json_object');
  assert.equal(plan.room_type, 'Home Office');
});

test('does_not_retry_on_auth_or_rate_limit_failures', async function () {
  let chatAttempts = 0;
  const fetchImpl = makeFetch({
    [core.MISTRAL_OCR_ENDPOINT]: ocrWithLabels,
    [core.MISTRAL_CHAT_ENDPOINT]: function () {
      chatAttempts += 1;
      return jsonResponse(401, { message: 'Unauthorized' });
    }
  });

  await assert.rejects(
    api.analyzeRoomPhoto({ imageDataUrl: IMAGE, mistralKey: KEY, fetchImpl: fetchImpl }),
    function (err) {
      assert.equal(err.code, 'AUTH_INVALID');
      return true;
    }
  );
  assert.equal(chatAttempts, 1);
});
