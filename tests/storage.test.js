'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../src/storage.js');

const IMAGE = 'data:image/jpeg;base64,AAAA';
const IMAGE_TWO = 'data:image/jpeg;base64,BBBB';

// --- A hand-written IndexedDB stand-in -----------------------------------
// Node has no indexedDB, so the wrapper is exercised against a fake that
// implements exactly the surface src/storage.js touches. Requests settle on a
// microtask, and a transaction completes once its last request settles.

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

// --- Fixtures ------------------------------------------------------------

function fixedNow(iso) {
  return function () { return new Date(iso); };
}

function planWith(steps) {
  return {
    room_type: 'Home Office',
    clutter_level: 'heavy',
    summary: 'A surface buried under paper and cables.',
    quick_win: { title: 'Clear the surface', estimated_minutes: 5, why_first: 'Fastest visible win.' },
    zones: [],
    items: [],
    action_plan: steps,
    total_estimated_minutes: 0,
    meta: {}
  };
}

function step(id, minutes) {
  return {
    step_id: id,
    zone_id: 'z1',
    action: 'Clear ' + id,
    priority: 'high',
    impact: 'high',
    estimated_minutes: minutes
  };
}

function scanInput(image, steps) {
  return {
    roomType: 'Home Office',
    imageDataUrl: image,
    plan: planWith(steps),
    ocrText: 'TAX DOCS 2023'
  };
}

function validSession(overrides) {
  const base = storage.createSession(scanInput(IMAGE, [step('s1', 5), step('s2', 10)]), fixedNow('2026-04-01T12:00:00.000Z'));
  return Object.assign({}, base, overrides || {});
}

// --- Graceful degradation ------------------------------------------------

test('every_operation_degrades_quietly_when_indexeddb_is_absent', async function () {
  assert.equal(storage.isIndexedDbAvailable({}), false);
  assert.equal(storage.isIndexedDbAvailable({ indexedDB: null }), false);
  assert.equal(storage.isIndexedDbAvailable({ indexedDB: createFakeIndexedDb() }), true);

  const env = { indexedDB: null };
  assert.equal(await storage.openDatabase(env), null);
  assert.equal(await storage.saveSession(validSession(), env), null);
  assert.equal(await storage.getSession('session_1', env), null);
  assert.deepEqual(await storage.listSessions(env), []);
  assert.equal(await storage.deleteSession('session_1', env), false);
  assert.equal(await storage.clearAllSessions(env), false);
});

// --- Object store creation ----------------------------------------------

test('open_database_creates_the_sessions_store_with_an_updated_at_index', async function () {
  const factory = createFakeIndexedDb();
  const db = await storage.openDatabase({ indexedDB: factory });

  assert.ok(db, 'a database handle must be returned');
  assert.equal(db.name, 'room_rescue_db');
  assert.equal(db.version, 1);
  assert.equal(db.objectStoreNames.contains('sessions'), true);

  const def = db._defs.get('sessions');
  assert.equal(def.keyPath, 'id');
  assert.equal(def.indexes.has('updatedAt'), true);
  assert.equal(def.indexes.get('updatedAt').keyPath, 'updatedAt');
  assert.equal(def.indexes.get('updatedAt').unique, false);
});

// --- CRUD round trip -----------------------------------------------------

test('sessions_round_trip_through_save_get_list_delete_and_clear', async function () {
  const factory = createFakeIndexedDb();
  const env = { indexedDB: factory };

  const first = storage.createSession(scanInput(IMAGE, [step('s1', 5)]), fixedNow('2026-04-01T12:00:00.000Z'));
  const second = storage.createSession(scanInput(IMAGE_TWO, [step('s1', 3)]), fixedNow('2026-04-02T09:30:00.000Z'));

  assert.equal((await storage.saveSession(first, env)).id, first.id);
  assert.equal((await storage.saveSession(second, env)).id, second.id);

  const loaded = await storage.getSession(first.id, env);
  assert.equal(loaded.id, first.id);
  assert.equal(loaded.scans.length, 1);
  assert.equal(loaded.scans[0].imageDataUrl, IMAGE);
  assert.equal(loaded.scans[0].plan.action_plan[0].step_id, 's1');

  const listed = await storage.listSessions(env);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map(function (s) { return s.id; }), [second.id, first.id], 'newest updatedAt must come first');

  assert.equal(await storage.deleteSession(first.id, env), true);
  assert.equal(await storage.getSession(first.id, env), null);
  assert.equal((await storage.listSessions(env)).length, 1);

  assert.equal(await storage.clearAllSessions(env), true);
  assert.deepEqual(await storage.listSessions(env), []);
});

test('get_session_returns_null_for_an_unknown_or_blank_id', async function () {
  const env = { indexedDB: createFakeIndexedDb() };
  assert.equal(await storage.getSession('nope', env), null);
  assert.equal(await storage.getSession('', env), null);
  assert.equal(await storage.getSession(null, env), null);
});

test('save_session_rejects_an_invalid_session_without_touching_the_store', async function () {
  const factory = createFakeIndexedDb();
  const env = { indexedDB: factory };

  await assert.rejects(storage.saveSession({ id: 'x' }, env), function (err) {
    assert.equal(err.code, 'INVALID_SESSION');
    return true;
  });
  assert.deepEqual(await storage.listSessions(env), []);
});

// --- Connection hygiene --------------------------------------------------

test('the_database_connection_is_closed_after_a_completed_transaction', async function () {
  const factory = createFakeIndexedDb();
  const env = { indexedDB: factory };
  const before = factory._log.closed;

  await storage.listSessions(env);

  assert.equal(factory._log.closed, before + 1, 'a completed transaction must close its connection');
});

test('the_database_connection_is_closed_after_a_failed_transaction', async function () {
  const factory = createFakeIndexedDb({ failOn: 'put' });
  const env = { indexedDB: factory };
  const before = factory._log.closed;

  await assert.rejects(storage.saveSession(validSession(), env), function (err) {
    assert.equal(err.code, 'STORAGE_UNAVAILABLE');
    return true;
  });

  assert.equal(factory._log.closed, before + 1, 'a failed transaction must close its connection');
});

test('a_request_error_rejects_the_returned_promise_instead_of_hanging', async function () {
  const env = { indexedDB: createFakeIndexedDb({ failOn: 'getAll' }) };
  await assert.rejects(storage.listSessions(env), function (err) {
    assert.equal(err.code, 'STORAGE_UNAVAILABLE');
    return true;
  });
});

// --- appendScanToSession -------------------------------------------------

test('appending_a_scan_increments_the_index_and_prunes_stale_progress', async function () {
  const first = storage.createSession(
    scanInput(IMAGE, [step('s1', 5), step('s2', 10)]),
    fixedNow('2026-04-01T12:00:00.000Z')
  );
  const withProgress = Object.assign({}, first, { checked: { s1: true, s2: true } });

  const second = storage.appendScanToSession(
    withProgress,
    scanInput(IMAGE_TWO, [step('s2', 4), step('s3', 6)]),
    fixedNow('2026-04-01T12:20:00.000Z')
  );

  assert.equal(second.id, first.id, 'the session id must survive a re-scan');
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.updatedAt, '2026-04-01T12:20:00.000Z');
  assert.equal(second.scans.length, 2);
  assert.equal(second.scans[1].scanIndex, 1);
  assert.equal(second.scans[1].imageDataUrl, IMAGE_TWO);
  assert.equal(second.activeScanIndex, 1);

  assert.deepEqual(second.checked, { s2: true }, 'only step ids still in the new plan keep their tick');
});

test('appending_a_scan_keeps_the_previous_room_type_when_the_new_one_is_blank', async function () {
  const first = storage.createSession(scanInput(IMAGE, [step('s1', 5)]), fixedNow('2026-04-01T12:00:00.000Z'));
  const second = storage.appendScanToSession(
    first,
    { imageDataUrl: IMAGE_TWO, plan: planWith([step('s1', 5)]), ocrText: '' },
    fixedNow('2026-04-01T12:10:00.000Z')
  );
  assert.equal(second.roomType, 'Home Office');
});

// --- computeSessionProgress ---------------------------------------------

test('session_progress_counts_done_steps_and_remaining_minutes', function () {
  const session = storage.createSession(
    scanInput(IMAGE, [step('s1', 5), step('s2', 10), step('s3', 2)]),
    fixedNow('2026-04-01T12:00:00.000Z')
  );

  const fresh = storage.computeSessionProgress(session);
  assert.deepEqual(fresh, {
    doneCount: 0,
    totalCount: 3,
    remainingMinutes: 17,
    roomType: 'Home Office',
    activeScanIndex: 0,
    scanCount: 1
  });

  const partial = storage.computeSessionProgress(Object.assign({}, session, { checked: { s1: true, s3: true } }));
  assert.equal(partial.doneCount, 2);
  assert.equal(partial.totalCount, 3);
  assert.equal(partial.remainingMinutes, 10);
});

test('session_progress_tolerates_an_empty_or_malformed_session', function () {
  assert.deepEqual(storage.computeSessionProgress(null), {
    doneCount: 0,
    totalCount: 0,
    remainingMinutes: 0,
    roomType: '',
    activeScanIndex: -1,
    scanCount: 0
  });
});

// --- validateSessionObject ----------------------------------------------

test('validate_session_accepts_a_well_formed_session_and_normalizes_checked', function () {
  const session = validSession({ checked: { s1: true, s2: false } });
  const validated = storage.validateSessionObject(session);

  assert.equal(validated.id, session.id);
  assert.equal(validated.scans.length, 1);
  assert.deepEqual(validated.checked, { s1: true }, 'only truthy ticks are kept');
});

test('validate_session_rejects_every_malformed_shape', function () {
  const cases = [
    { name: 'not an object', value: null },
    { name: 'an array', value: [] },
    { name: 'a missing id', value: validSession({ id: '' }) },
    { name: 'a missing createdAt', value: validSession({ createdAt: '' }) },
    { name: 'a missing updatedAt', value: validSession({ updatedAt: '' }) },
    { name: 'no scans', value: validSession({ scans: [] }) },
    { name: 'a non-array scans field', value: validSession({ scans: 'nope' }) },
    { name: 'a negative activeScanIndex', value: validSession({ activeScanIndex: -1 }) },
    { name: 'an out-of-bounds activeScanIndex', value: validSession({ activeScanIndex: 4 }) },
    { name: 'a non-numeric activeScanIndex', value: validSession({ activeScanIndex: '0' }) }
  ];

  cases.forEach(function (item) {
    assert.throws(function () { storage.validateSessionObject(item.value); }, function (err) {
      assert.equal(err.code, 'INVALID_SESSION', item.name + ' must be rejected');
      return true;
    }, item.name);
  });
});

test('validate_session_rejects_a_scan_without_an_image_or_with_a_broken_plan', function () {
  const noImage = validSession();
  noImage.scans = [Object.assign({}, noImage.scans[0], { imageDataUrl: 'https://example.test/room.jpg' })];
  assert.throws(function () { storage.validateSessionObject(noImage); }, function (err) {
    assert.equal(err.code, 'INVALID_SESSION');
    return true;
  });

  const noPlan = validSession();
  noPlan.scans = [Object.assign({}, noPlan.scans[0], { plan: null })];
  assert.throws(function () { storage.validateSessionObject(noPlan); }, function (err) {
    assert.equal(err.code, 'INVALID_SESSION');
    return true;
  });

  const badPlan = validSession();
  badPlan.scans = [Object.assign({}, badPlan.scans[0], { plan: { action_plan: 'nope' } })];
  assert.throws(function () { storage.validateSessionObject(badPlan); }, function (err) {
    assert.equal(err.code, 'INVALID_SESSION');
    return true;
  });
});

// --- Identity ------------------------------------------------------------

test('session_ids_are_unique_and_time_ordered', function () {
  const now = fixedNow('2026-04-01T12:00:00.000Z');
  const ids = [];
  for (let i = 0; i < 20; i += 1) ids.push(storage.generateSessionId(now));

  assert.equal(new Set(ids).size, 20, 'ids must not collide');
  ids.forEach(function (id) {
    assert.match(id, /^session_\d+_[a-z0-9]+$/);
  });
});
