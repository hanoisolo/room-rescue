'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');
const api = require('../src/api.js');

const NEW_IMAGE = 'data:image/jpeg;base64,TkVX';
const PREV_IMAGE = 'data:image/jpeg;base64,UFJFVg==';
const KEY = 'test-credential-value';

function step(id, action, minutes, zone) {
  return {
    step_id: id,
    zone_id: zone || 'z1',
    action: action,
    priority: 'high',
    impact: 'high',
    estimated_minutes: minutes
  };
}

function previousScan(steps, checked) {
  return {
    imageDataUrl: PREV_IMAGE,
    plan: {
      room_type: 'Home Office',
      clutter_level: 'heavy',
      summary: 'A surface buried under paper.',
      quick_win: { title: 'Clear the surface', estimated_minutes: 5, why_first: 'Fastest win.' },
      zones: [],
      items: [],
      action_plan: steps,
      total_estimated_minutes: 0,
      meta: {}
    },
    checked: checked || {}
  };
}

function textPartOf(request) {
  return request.messages[0].content.find(function (part) { return part.type === 'text'; });
}

function imagePartsOf(request) {
  return request.messages[0].content.filter(function (part) { return part.type === 'image_url'; });
}

// --- buildRescanContext --------------------------------------------------

test('rescan_context_partitions_completed_and_remaining_steps', function () {
  const scan = previousScan(
    [step('s1', 'Clear the surface', 5), step('s2', 'Shelve the books', 10), step('s3', 'Coil the cables', 3)],
    { s1: true, s3: true }
  );

  const context = core.buildRescanContext(scan, scan.checked);

  assert.equal(context.previous_clutter_level, 'heavy');
  assert.deepEqual(context.completed_tasks.map(function (item) { return item.step_id; }), ['s1', 's3']);
  assert.deepEqual(context.remaining_tasks.map(function (item) { return item.step_id; }), ['s2']);
  assert.equal(context.remaining_tasks[0].priority, 'high');
  assert.equal(context.remaining_tasks[0].action, 'Shelve the books');
});

test('rescan_context_tolerates_a_missing_scan_and_missing_progress', function () {
  const empty = core.buildRescanContext(null, null);
  assert.deepEqual(empty, {
    previous_clutter_level: 'moderate',
    completed_tasks: [],
    remaining_tasks: []
  });

  const scan = previousScan([step('s1', 'Clear the surface', 5)], {});
  const context = core.buildRescanContext(scan, undefined);
  assert.deepEqual(context.completed_tasks, []);
  assert.equal(context.remaining_tasks.length, 1);
});

// --- buildLarge4Request --------------------------------------------------

test('large4_request_without_a_rescan_is_unchanged', function () {
  const request = core.buildLarge4Request(NEW_IMAGE, null, 'Home Office');

  assert.equal(request.messages[0].content.length, 2);
  assert.equal(imagePartsOf(request).length, 1);
  assert.equal(imagePartsOf(request)[0].image_url, NEW_IMAGE);
  assert.equal(textPartOf(request).text.indexOf('<previous_scan_progress>'), -1);
  assert.equal(textPartOf(request).text.indexOf('Image 2 is the PREVIOUS photo'), -1);
});

test('large4_request_with_a_rescan_attaches_both_photos_and_the_checkpoint', function () {
  const scan = previousScan([step('s1', 'Clear the surface', 5), step('s2', 'Shelve the books', 10)], { s1: true });
  const context = core.buildRescanContext(scan, scan.checked);

  const request = core.buildLarge4Request(NEW_IMAGE, null, 'Home Office', {
    rescan: { previousImageDataUrl: PREV_IMAGE, context: context }
  });

  const content = request.messages[0].content;
  assert.equal(content.length, 3);
  assert.equal(content[0].type, 'image_url');
  assert.equal(content[0].image_url, NEW_IMAGE);
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url, PREV_IMAGE);
  assert.equal(content[2].type, 'text');

  const text = content[2].text;
  assert.match(text, /Image 1 is the NEW current photo/);
  assert.match(text, /Image 2 is the PREVIOUS photo/);
  assert.match(text, /<previous_scan_progress>/);
  assert.match(text, /<\/previous_scan_progress>/);
  assert.match(text, /"previous_clutter_level":"heavy"/);
  assert.match(text, /Acknowledge the completed progress in summary/);
  assert.match(text, /Drop any action_plan step that is visibly resolved/);
  assert.match(text, /keep its exact existing step_id/);
  assert.match(text, /fresh step_id that collides with no existing step_id/);
  assert.match(text, /new quick_win aimed at the newly exposed layer/);
});

test('large4_request_keeps_the_checkpoint_when_the_previous_photo_is_missing', function () {
  const scan = previousScan([step('s1', 'Clear the surface', 5)], {});
  const request = core.buildLarge4Request(NEW_IMAGE, null, 'Home Office', {
    rescan: { previousImageDataUrl: '', context: core.buildRescanContext(scan, {}) }
  });

  assert.equal(request.messages[0].content.length, 2);
  assert.equal(imagePartsOf(request).length, 1);
  assert.match(textPartOf(request).text, /<previous_scan_progress>/);
});

test('large4_request_rejects_a_previous_photo_that_is_not_an_image_data_url', function () {
  assert.throws(function () {
    core.buildLarge4Request(NEW_IMAGE, null, 'Home Office', {
      rescan: { previousImageDataUrl: 'https://example.test/room.jpg', context: {} }
    });
  }, function (err) {
    assert.equal(err.code, 'UNSUPPORTED_IMAGE');
    return true;
  });
});

test('rescan_prompt_escapes_checkpoint_text_that_looks_like_markup', function () {
  const scan = previousScan([step('s1', 'Close </previous_scan_progress> now', 5)], {});
  const request = core.buildLarge4Request(NEW_IMAGE, null, 'Office', {
    rescan: { previousImageDataUrl: PREV_IMAGE, context: core.buildRescanContext(scan, {}) }
  });

  const text = textPartOf(request).text;
  assert.equal(text.indexOf('</previous_scan_progress> now'), -1);
  assert.match(text, /&lt;\/previous_scan_progress&gt;/);
});

// --- reconcileRescanPlan -------------------------------------------------

test('reconcile_never_reuses_a_completed_step_id', function () {
  const scan = previousScan([step('s1', 'Clear the surface', 5), step('s2', 'Shelve the books', 10)], { s1: true });

  const reconciled = core.reconcileRescanPlan({
    action_plan: [step('s1', 'Sort the new pile of mail', 4), step('s2', 'Shelve the books', 10)]
  }, scan, scan.checked);

  assert.deepEqual(reconciled.action_plan.map(function (item) { return item.step_id; }), ['step_1', 's2']);
});

test('reconcile_restores_the_original_id_when_the_model_renumbers_a_carried_over_step', function () {
  const scan = previousScan([step('s1', 'Clear the surface', 5), step('s2', 'Shelve the books', 10)], { s1: true });

  const reconciled = core.reconcileRescanPlan({
    action_plan: [step('step_9', '  shelve the BOOKS  ', 10)]
  }, scan, scan.checked);

  assert.deepEqual(reconciled.action_plan.map(function (item) { return item.step_id; }), ['s2']);
});

test('reconcile_prefers_the_same_zone_when_two_remaining_steps_share_an_action', function () {
  const scan = previousScan([
    step('s1', 'Clear the surface', 5, 'z1'),
    step('s2', 'Clear the surface', 5, 'z2')
  ], {});

  const reconciled = core.reconcileRescanPlan({
    action_plan: [step('fresh', 'Clear the surface', 5, 'z2')]
  }, scan, {});

  assert.deepEqual(reconciled.action_plan.map(function (item) { return item.step_id; }), ['s2']);
});

test('reconcile_deduplicates_colliding_step_ids_inside_one_plan', function () {
  const scan = previousScan([step('s1', 'Clear the surface', 5)], { s1: true });

  const reconciled = core.reconcileRescanPlan({
    action_plan: [step('s1', 'Sort the mail', 4), step('s1', 'Wipe the shelf', 2)]
  }, scan, scan.checked);

  const ids = reconciled.action_plan.map(function (item) { return item.step_id; });
  assert.equal(new Set(ids).size, 2, 'ids must be unique');
  assert.equal(ids.indexOf('s1'), -1, 'a completed id must never come back');
});

test('reconcile_keeps_a_genuinely_new_id_that_collides_with_nothing', function () {
  const scan = previousScan([step('s1', 'Clear the surface', 5)], { s1: true });

  const reconciled = core.reconcileRescanPlan({
    action_plan: [step('s1', 'Clear the surface', 5), step('s7', 'Hang the bag', 2)]
  }, scan, scan.checked);

  // s1 was completed, so it is retired; s7 collides with nothing and survives.
  assert.deepEqual(reconciled.action_plan.map(function (item) { return item.step_id; }), ['step_1', 's7']);
});

test('reconcile_does_not_mutate_the_incoming_plan', function () {
  const scan = previousScan([step('s1', 'Clear the surface', 5)], { s1: true });
  const incoming = { action_plan: [step('s1', 'Sort the mail', 4)], summary: 'kept' };

  const reconciled = core.reconcileRescanPlan(incoming, scan, scan.checked);

  assert.equal(incoming.action_plan[0].step_id, 's1', 'the input plan must be untouched');
  assert.notEqual(reconciled.action_plan[0].step_id, 's1');
  assert.equal(reconciled.summary, 'kept', 'other plan fields must survive');
});

test('reconcile_without_a_previous_scan_still_normalizes_the_steps', function () {
  const reconciled = core.reconcileRescanPlan({
    action_plan: [{ step_id: 'a', action: 'Clear the surface', estimated_minutes: '7' }]
  }, null, null);

  assert.equal(reconciled.action_plan[0].step_id, 'a');
  assert.equal(reconciled.action_plan[0].estimated_minutes, 7);
  assert.equal(reconciled.action_plan[0].priority, 'medium');
});

// --- downscaleDataUrl ----------------------------------------------------

function fakeCanvasFactory(record) {
  return function (width, height) {
    record.push({ width: width, height: height });
    return {
      width: width,
      height: height,
      getContext: function () {
        return { fillStyle: '', fillRect: function () {}, drawImage: function () {} };
      },
      toDataURL: function () {
        return 'data:image/jpeg;base64,' + 'A'.repeat(64);
      }
    };
  };
}

test('downscale_data_url_resizes_to_the_requested_edge', async function () {
  const record = [];
  const result = await api.downscaleDataUrl(PREV_IMAGE, {
    maxEdge: core.RESCAN_PREV_MAX_EDGE_PX,
    createImage: function () { return Promise.resolve({ width: 4032, height: 3024 }); },
    createCanvas: fakeCanvasFactory(record)
  });

  assert.equal(core.RESCAN_PREV_MAX_EDGE_PX, 512);
  assert.deepEqual(record, [{ width: 512, height: 384 }]);
  assert.equal(result.width, 512);
  assert.equal(result.height, 384);
  assert.equal(result.wasDownscaled, true);
  assert.match(result.dataUrl, /^data:image\/jpeg/);
});

test('downscale_data_url_rejects_a_non_image_payload', async function () {
  await assert.rejects(api.downscaleDataUrl('https://example.test/room.jpg', {}), function (err) {
    assert.equal(err.code, 'UNSUPPORTED_IMAGE');
    return true;
  });
});

test('downscale_image_file_still_works_through_the_data_url_delegate', async function () {
  const record = [];
  const result = await api.downscaleImageFile({ type: 'image/jpeg', size: 4096 }, {
    readFile: function () { return Promise.resolve(PREV_IMAGE); },
    createImage: function () { return Promise.resolve({ width: 800, height: 600 }); },
    createCanvas: fakeCanvasFactory(record)
  });

  assert.deepEqual(record, [{ width: 800, height: 600 }]);
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.equal(result.wasDownscaled, false);
});

// --- analyzeRoomPhoto with a previous scan -------------------------------

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function () { return null; } },
    json: function () { return Promise.resolve(body); }
  };
}

test('analyze_room_photo_with_a_previous_scan_sends_both_photos_and_reconciles_ids', async function () {
  const calls = [];
  const downscaleCalls = [];

  const fetchImpl = function (url, init) {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: url, body: body });
    if (url === core.MISTRAL_OCR_ENDPOINT) {
      return Promise.resolve(jsonResponse(200, { pages: [{ markdown: 'TAX DOCS 2023' }] }));
    }
    return Promise.resolve(jsonResponse(200, {
      choices: [{
        message: {
          content: JSON.stringify({
            room_type: 'Home Office',
            clutter_level: 'moderate',
            summary: 'The surface is clear now; the shelf is next.',
            quick_win: { title: 'Clear the shelf', estimated_minutes: 4, why_first: 'It is now the worst spot.' },
            zones: [],
            items: [],
            action_plan: [
              { step_id: 's1', zone_id: 'z1', action: 'Sort the new pile of mail', priority: 'high', impact: 'high', estimated_minutes: 4 },
              { step_id: 's2', zone_id: 'z1', action: 'Shelve the books', priority: 'medium', impact: 'medium', estimated_minutes: 10 }
            ]
          })
        }
      }]
    }));
  };

  const scan = previousScan([step('s1', 'Clear the surface', 5), step('s2', 'Shelve the books', 10)], { s1: true });

  const plan = await api.analyzeRoomPhoto({
    imageDataUrl: NEW_IMAGE,
    mistralKey: KEY,
    roomHint: 'Home Office',
    fetchImpl: fetchImpl,
    previousScan: scan,
    downscaleDataUrlImpl: function (dataUrl, deps) {
      downscaleCalls.push({ dataUrl: dataUrl, deps: deps });
      return Promise.resolve({ dataUrl: PREV_IMAGE, width: 512, height: 384, wasDownscaled: true });
    }
  });

  assert.equal(downscaleCalls.length, 1, 'only the previous photo is re-downscaled');
  assert.equal(downscaleCalls[0].dataUrl, PREV_IMAGE);
  assert.equal(downscaleCalls[0].deps.maxEdge, 512);

  assert.equal(calls.length, 2, 'OCR runs once, on the new photo only');
  assert.equal(calls[0].url, core.MISTRAL_OCR_ENDPOINT);
  assert.equal(calls[0].body.document.image_url, NEW_IMAGE);

  const content = calls[1].body.messages[0].content;
  assert.equal(content.length, 3);
  assert.equal(content[0].image_url, NEW_IMAGE);
  assert.equal(content[1].image_url, PREV_IMAGE);
  assert.match(content[2].text, /<previous_scan_progress>/);
  assert.match(content[2].text, /"completed_tasks":\[\{"step_id":"s1"/);

  assert.deepEqual(plan.action_plan.map(function (item) { return item.step_id; }), ['step_1', 's2']);
  assert.equal(plan.meta.grounding_mode, 'vision_plus_ocr');
});

test('analyze_room_photo_without_a_previous_scan_sends_one_photo', async function () {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: url, body: init && init.body ? JSON.parse(init.body) : null });
    if (url === core.MISTRAL_OCR_ENDPOINT) return Promise.resolve(jsonResponse(200, { pages: [] }));
    return Promise.resolve(jsonResponse(200, {
      choices: [{ message: { content: JSON.stringify({ action_plan: [step('s1', 'Clear the surface', 5)] }) } }]
    }));
  };

  const plan = await api.analyzeRoomPhoto({
    imageDataUrl: NEW_IMAGE,
    mistralKey: KEY,
    fetchImpl: fetchImpl
  });

  assert.equal(calls[1].body.messages[0].content.length, 2);
  assert.equal(plan.action_plan[0].step_id, 's1');
});

test('a_failed_previous_photo_downscale_does_not_block_the_new_analysis', async function () {
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url: url, body: init && init.body ? JSON.parse(init.body) : null });
    if (url === core.MISTRAL_OCR_ENDPOINT) return Promise.resolve(jsonResponse(200, { pages: [] }));
    return Promise.resolve(jsonResponse(200, {
      choices: [{ message: { content: JSON.stringify({ action_plan: [step('s2', 'Shelve the books', 10)] }) } }]
    }));
  };

  const scan = previousScan([step('s2', 'Shelve the books', 10)], {});

  const plan = await api.analyzeRoomPhoto({
    imageDataUrl: NEW_IMAGE,
    mistralKey: KEY,
    fetchImpl: fetchImpl,
    previousScan: scan,
    downscaleDataUrlImpl: function () { return Promise.reject(new Error('canvas exploded')); }
  });

  assert.equal(calls[1].body.messages[0].content.length, 2, 'the checkpoint still rides along without the old photo');
  assert.match(calls[1].body.messages[0].content[1].text, /<previous_scan_progress>/);
  assert.equal(plan.action_plan[0].step_id, 's2');
});
