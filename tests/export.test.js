'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../src/storage.js');
const exporter = require('../src/export.js');

const IMAGE = 'data:image/jpeg;base64,AAAA';
const IMAGE_TWO = 'data:image/jpeg;base64,BBBB';

function step(id, action, minutes, priority) {
  return {
    step_id: id,
    zone_id: 'z1',
    action: action,
    priority: priority || 'high',
    impact: 'high',
    estimated_minutes: minutes
  };
}

function fullPlan() {
  return {
    room_type: 'Home Office',
    clutter_level: 'heavy',
    summary: 'A surface buried under paper and cables.',
    quick_win: { title: 'Clear the surface', estimated_minutes: 5, why_first: 'Fastest visible win.' },
    zones: [
      { id: 'z1', name: 'Surface', observation: 'Covered in paper.', priority: 'high', goal_state: 'Clear workspace.' }
    ],
    items: [
      { name: 'Tax documents box', zone_id: 'z1', category: 'paper', disposition: 'contain', source: 'vision', suggestion: 'Shelve it.' }
    ],
    action_plan: [step('s1', 'Clear the surface', 5), step('s2', 'Shelve the books', 10, 'low')],
    total_estimated_minutes: 15,
    meta: {}
  };
}

function sessionWith(scans) {
  const first = storage.createSession(
    { roomType: 'Home Office', imageDataUrl: IMAGE, plan: fullPlan(), ocrText: 'TAX DOCS' },
    function () { return new Date('2026-04-01T12:00:00.000Z'); }
  );
  if (!scans || scans < 2) return first;
  return storage.appendScanToSession(
    first,
    { roomType: 'Home Office', imageDataUrl: IMAGE_TWO, plan: fullPlan(), ocrText: '' },
    function () { return new Date('2026-04-01T12:20:00.000Z'); }
  );
}

// --- Markdown ------------------------------------------------------------

test('markdown_export_renders_checked_and_unchecked_steps', function () {
  const markdown = exporter.formatPlanAsMarkdown(fullPlan(), { s1: true });

  assert.match(markdown, /^# Room Rescue — Home Office/);
  assert.match(markdown, /Clutter level: heavy/);
  assert.match(markdown, /Total effort: 15 min/);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /## Start here — your 5-minute win/);
  assert.match(markdown, /- Clear the surface \(5 min\)/);
  assert.match(markdown, /## Checklist/);
  assert.match(markdown, /- \[x\] Clear the surface \(5 min · high\)/);
  assert.match(markdown, /- \[ \] Shelve the books \(10 min · low\)/);
  assert.match(markdown, /## Zones/);
  assert.match(markdown, /### Surface — high/);
  assert.match(markdown, /Goal: Clear workspace\./);
  assert.match(markdown, /## Items to deal with/);
  assert.match(markdown, /- \*\*Tax documents box\*\* — contain: Shelve it\./);
});

test('markdown_export_survives_an_empty_plan_and_a_missing_progress_map', function () {
  const markdown = exporter.formatPlanAsMarkdown({}, undefined);

  assert.match(markdown, /^# Room Rescue — Room/);
  assert.match(markdown, /## Checklist/);
  assert.match(markdown, /- \[ \] No action steps were returned\./);
  assert.equal(markdown.indexOf('## Zones'), -1);
  assert.equal(markdown.indexOf('## Items to deal with'), -1);
  assert.equal(markdown.indexOf('undefined'), -1);
  assert.equal(markdown.indexOf('NaN'), -1);
});

test('markdown_export_treats_a_missing_progress_map_as_nothing_done', function () {
  const markdown = exporter.formatPlanAsMarkdown(fullPlan());
  assert.match(markdown, /- \[ \] Clear the surface/);
  assert.equal(markdown.indexOf('- [x]'), -1);
});

// --- JSON round trip -----------------------------------------------------

test('a_multi_scan_session_round_trips_through_export_and_import', function () {
  const session = sessionWith(2);
  const json = exporter.serializeSessionForExport(session);

  const parsed = JSON.parse(json);
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.exportedAt, 'string');
  assert.equal(parsed.session.id, session.id);

  const restored = exporter.parseImportedSessionJson(json);
  assert.equal(restored.id, session.id);
  assert.equal(restored.scans.length, 2);
  assert.equal(restored.scans[1].imageDataUrl, IMAGE_TWO);
  assert.equal(restored.activeScanIndex, 1);
});

test('import_accepts_a_raw_session_object_as_well_as_a_wrapped_export', function () {
  const session = sessionWith(1);

  const fromRaw = exporter.parseImportedSessionJson(JSON.stringify(session));
  assert.equal(fromRaw.id, session.id);

  const fromWrapped = exporter.parseImportedSessionJson(JSON.stringify({ version: 1, session: session }));
  assert.equal(fromWrapped.id, session.id);
});

test('import_rejects_garbage_a_foreign_version_and_an_invalid_session', function () {
  const cases = [
    { name: 'empty text', value: '' },
    { name: 'not json', value: 'this is not json' },
    { name: 'a json array', value: '[1,2,3]' },
    { name: 'a json scalar', value: '42' },
    { name: 'a foreign version', value: JSON.stringify({ version: 99, session: sessionWith(1) }) },
    { name: 'a wrapped session that is not a session', value: JSON.stringify({ version: 1, session: { id: 'x' } }) },
    { name: 'a raw object that is not a session', value: JSON.stringify({ id: 'x', scans: [] }) }
  ];

  cases.forEach(function (item) {
    assert.throws(function () { exporter.parseImportedSessionJson(item.value); }, function (err) {
      assert.equal(err.code, 'INVALID_IMPORT', item.name + ' must be rejected');
      return true;
    }, item.name);
  });
});

test('export_rejects_an_invalid_session_instead_of_writing_a_broken_file', function () {
  assert.throws(function () { exporter.serializeSessionForExport({ id: 'x' }); }, function (err) {
    assert.equal(err.code, 'INVALID_SESSION');
    return true;
  });
});

// --- Clipboard -----------------------------------------------------------

test('copy_passes_the_text_to_the_injected_clipboard', async function () {
  const written = [];
  const clipboard = { writeText: function (text) { written.push(text); return Promise.resolve(); } };

  assert.equal(await exporter.copyTextToClipboard('- [ ] Clear the surface', clipboard), true);
  assert.deepEqual(written, ['- [ ] Clear the surface']);
});

test('copy_rejects_cleanly_when_no_clipboard_is_available', async function () {
  await assert.rejects(exporter.copyTextToClipboard('text', null), function (err) {
    assert.equal(err.code, 'CLIPBOARD_UNAVAILABLE');
    return true;
  });

  await assert.rejects(exporter.copyTextToClipboard('text', {}), function (err) {
    assert.equal(err.code, 'CLIPBOARD_UNAVAILABLE');
    return true;
  });
});

test('copy_rejects_cleanly_when_the_clipboard_refuses', async function () {
  const clipboard = { writeText: function () { return Promise.reject(new Error('denied')); } };
  await assert.rejects(exporter.copyTextToClipboard('text', clipboard), function (err) {
    assert.equal(err.code, 'CLIPBOARD_UNAVAILABLE');
    return true;
  });
});

// --- Download ------------------------------------------------------------

test('download_uses_the_injected_writer', function () {
  const written = [];
  const ok = exporter.downloadTextFile('room.json', '{"a":1}', 'application/json', {
    downloadImpl: function (filename, content, mimeType) {
      written.push({ filename: filename, content: content, mimeType: mimeType });
    }
  });

  assert.equal(ok, true);
  assert.deepEqual(written, [{ filename: 'room.json', content: '{"a":1}', mimeType: 'application/json' }]);
});

test('download_reports_false_when_there_is_no_dom_to_write_into', function () {
  assert.equal(exporter.downloadTextFile('room.json', '{}', 'application/json', {}), false);
});
