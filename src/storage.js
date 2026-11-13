(function (root) {
  'use strict';

  // Room history lives in IndexedDB, never in localStorage: a single room photo is
  // already megabytes of base64, and localStorage caps out around 5 MB. The Mistral
  // credential stays in localStorage (see src/api.js) because it is a few dozen bytes.

  var DB_NAME = 'room_rescue_db';
  var DB_VERSION = 1;
  var STORE_NAME = 'sessions';
  var UPDATED_AT_INDEX = 'updatedAt';

  function storageError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function isImageDataUrl(value) {
    return typeof value === 'string' && value.indexOf('data:image/') === 0;
  }

  function nowIso(nowFn) {
    var fn = typeof nowFn === 'function' ? nowFn : function () { return new Date(); };
    var value = fn();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' && value) return value;
    var parsed = new Date(value);
    return isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString();
  }

  function generateSessionId(nowFn) {
    var stamp = Date.parse(nowIso(nowFn));
    if (!isFinite(stamp)) stamp = 0;
    var suffix = Math.random().toString(36).slice(2, 8);
    return 'session_' + stamp + '_' + suffix;
  }

  function collectStepIds(plan) {
    var steps = plan && Array.isArray(plan.action_plan) ? plan.action_plan : [];
    var ids = [];
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (step && typeof step.step_id === 'string' && step.step_id) ids.push(step.step_id);
    }
    return ids;
  }

  // --- Session schema -----------------------------------------------------

  function buildScan(scanInput, scanIndex, stamp) {
    var input = scanInput || {};
    return {
      scanIndex: scanIndex,
      imageDataUrl: typeof input.imageDataUrl === 'string' ? input.imageDataUrl : '',
      plan: input.plan && typeof input.plan === 'object' && !Array.isArray(input.plan) ? input.plan : {},
      ocrText: typeof input.ocrText === 'string' ? input.ocrText : '',
      createdAt: stamp
    };
  }

  function validateScan(scan, position) {
    if (!scan || typeof scan !== 'object' || Array.isArray(scan)) {
      throw storageError('INVALID_SESSION', 'Scan ' + position + ' must be an object.');
    }
    if (!isImageDataUrl(scan.imageDataUrl)) {
      throw storageError('INVALID_SESSION', 'Scan ' + position + ' needs an image data URL.');
    }
    if (!scan.plan || typeof scan.plan !== 'object' || Array.isArray(scan.plan)) {
      throw storageError('INVALID_SESSION', 'Scan ' + position + ' needs a plan object.');
    }
    if (scan.plan.action_plan !== undefined && !Array.isArray(scan.plan.action_plan)) {
      throw storageError('INVALID_SESSION', 'Scan ' + position + ' has a malformed action_plan.');
    }
    return {
      scanIndex: typeof scan.scanIndex === 'number' && isFinite(scan.scanIndex) ? scan.scanIndex : position,
      imageDataUrl: scan.imageDataUrl,
      plan: scan.plan,
      ocrText: typeof scan.ocrText === 'string' ? scan.ocrText : '',
      createdAt: typeof scan.createdAt === 'string' ? scan.createdAt : ''
    };
  }

  function validateSessionObject(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw storageError('INVALID_SESSION', 'A room session must be an object.');
    }
    if (!isNonEmptyString(raw.id)) {
      throw storageError('INVALID_SESSION', 'A room session needs an id.');
    }
    if (!isNonEmptyString(raw.createdAt)) {
      throw storageError('INVALID_SESSION', 'A room session needs a createdAt timestamp.');
    }
    if (!isNonEmptyString(raw.updatedAt)) {
      throw storageError('INVALID_SESSION', 'A room session needs an updatedAt timestamp.');
    }
    if (!Array.isArray(raw.scans) || raw.scans.length === 0) {
      throw storageError('INVALID_SESSION', 'A room session needs at least one scan.');
    }

    var scans = [];
    for (var i = 0; i < raw.scans.length; i++) scans.push(validateScan(raw.scans[i], i));

    var index = raw.activeScanIndex;
    if (typeof index !== 'number' || !isFinite(index) || index < 0 || index >= scans.length) {
      throw storageError('INVALID_SESSION', 'activeScanIndex must point at an existing scan.');
    }

    var checked = {};
    if (raw.checked && typeof raw.checked === 'object' && !Array.isArray(raw.checked)) {
      Object.keys(raw.checked).forEach(function (id) {
        if (raw.checked[id]) checked[id] = true;
      });
    }

    return {
      id: raw.id,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      roomType: typeof raw.roomType === 'string' ? raw.roomType : '',
      scans: scans,
      checked: checked,
      activeScanIndex: index
    };
  }

  function createSession(scanInput, nowFn) {
    var input = scanInput || {};
    var stamp = nowIso(nowFn);
    return validateSessionObject({
      id: generateSessionId(nowFn),
      createdAt: stamp,
      updatedAt: stamp,
      roomType: typeof input.roomType === 'string' ? input.roomType : '',
      scans: [buildScan(input, 0, stamp)],
      checked: {},
      activeScanIndex: 0
    });
  }

  function appendScanToSession(session, scanInput, nowFn) {
    var base = validateSessionObject(session);
    var stamp = nowIso(nowFn);
    var scans = base.scans.slice();
    var nextIndex = scans.length;
    scans.push(buildScan(scanInput, nextIndex, stamp));

    // A re-scan replaces the checklist, so progress only survives for step ids the
    // new plan still contains. Anything else would show a stale tick on a new step.
    var liveIds = collectStepIds(scans[nextIndex].plan);
    var checked = {};
    Object.keys(base.checked).forEach(function (id) {
      if (base.checked[id] && liveIds.indexOf(id) !== -1) checked[id] = true;
    });

    var roomType = isNonEmptyString(scanInput && scanInput.roomType)
      ? scanInput.roomType
      : base.roomType;

    return validateSessionObject({
      id: base.id,
      createdAt: base.createdAt,
      updatedAt: stamp,
      roomType: roomType,
      scans: scans,
      checked: checked,
      activeScanIndex: nextIndex
    });
  }

  function computeSessionProgress(session) {
    var base = session && typeof session === 'object' ? session : {};
    var scans = Array.isArray(base.scans) ? base.scans : [];
    var index = typeof base.activeScanIndex === 'number' && isFinite(base.activeScanIndex)
      ? base.activeScanIndex
      : scans.length - 1;
    var scan = scans[index] || scans[scans.length - 1] || null;
    var plan = scan && scan.plan && typeof scan.plan === 'object' ? scan.plan : {};
    var steps = Array.isArray(plan.action_plan) ? plan.action_plan : [];
    var checked = base.checked && typeof base.checked === 'object' ? base.checked : {};

    var doneCount = 0;
    var remainingMinutes = 0;
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i] || {};
      var id = typeof step.step_id === 'string' ? step.step_id : '';
      var minutes = Number(step.estimated_minutes);
      if (!isFinite(minutes) || minutes < 0) minutes = 0;
      if (id && checked[id]) doneCount += 1;
      else remainingMinutes += Math.round(minutes);
    }

    return {
      doneCount: doneCount,
      totalCount: steps.length,
      remainingMinutes: remainingMinutes,
      roomType: typeof base.roomType === 'string' ? base.roomType : '',
      activeScanIndex: index,
      scanCount: scans.length
    };
  }

  // --- IndexedDB Promise wrapper ------------------------------------------

  function resolveIndexedDb(env) {
    var source = env || {};
    // An explicit `indexedDB: null` means "no room history" and must not fall
    // through to whatever the host happens to expose.
    if (Object.prototype.hasOwnProperty.call(source, 'indexedDB')) return source.indexedDB || null;
    if (typeof indexedDB !== 'undefined') return indexedDB;
    return null;
  }

  function isIndexedDbAvailable(env) {
    return Boolean(resolveIndexedDb(env));
  }

  function closeQuietly(db) {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (err) { /* already closed */ }
    }
  }

  function openDatabase(env) {
    var factory = resolveIndexedDb(env);
    if (!factory) return Promise.resolve(null);

    return new Promise(function (resolve, reject) {
      var request;
      try {
        request = factory.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(storageError('STORAGE_UNAVAILABLE', 'Room history could not be opened.'));
        return;
      }

      request.onupgradeneeded = function (event) {
        var db = request.result || (event && event.target && event.target.result);
        if (!db) return;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex(UPDATED_AT_INDEX, UPDATED_AT_INDEX, { unique: false });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () {
        reject(storageError('STORAGE_UNAVAILABLE', 'Room history could not be opened.'));
      };
    });
  }

  // One transaction per operation, and the connection is closed as soon as it
  // settles so a later version upgrade is never blocked by a leaked handle.
  function runTransaction(env, mode, work) {
    return openDatabase(env).then(function (db) {
      if (!db) return null;

      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(STORE_NAME, mode);
        } catch (err) {
          closeQuietly(db);
          reject(storageError('STORAGE_UNAVAILABLE', 'Room history is unavailable.'));
          return;
        }

        var store = tx.objectStore(STORE_NAME);
        var outcome = { value: null };
        var failed = false;

        function fail(err) {
          if (failed) return;
          failed = true;
          closeQuietly(db);
          reject(err);
        }

        tx.oncomplete = function () {
          closeQuietly(db);
          if (!failed) resolve(outcome.value);
        };
        tx.onerror = function () {
          fail(storageError('STORAGE_UNAVAILABLE', 'Room history could not be read or written.'));
        };
        tx.onabort = function () {
          fail(storageError('STORAGE_UNAVAILABLE', 'Room history could not be read or written.'));
        };

        try {
          work(store, outcome, fail);
        } catch (err) {
          fail(err && err.code ? err : storageError('STORAGE_UNAVAILABLE', 'Room history could not be read or written.'));
        }
      });
    });
  }

  function saveSession(session, env) {
    var valid;
    try {
      valid = validateSessionObject(session);
    } catch (err) {
      return Promise.reject(err);
    }
    return runTransaction(env, 'readwrite', function (store, outcome, fail) {
      var request = store.put(valid);
      request.onsuccess = function () { outcome.value = valid; };
      request.onerror = function () {
        fail(storageError('STORAGE_UNAVAILABLE', 'That room could not be saved.'));
      };
    });
  }

  function getSession(id, env) {
    if (!isNonEmptyString(id)) return Promise.resolve(null);
    return runTransaction(env, 'readonly', function (store, outcome, fail) {
      var request = store.get(id);
      request.onsuccess = function () {
        var found = request.result;
        if (!found) {
          outcome.value = null;
          return;
        }
        try {
          outcome.value = validateSessionObject(found);
        } catch (err) {
          outcome.value = null;
        }
      };
      request.onerror = function () {
        fail(storageError('STORAGE_UNAVAILABLE', 'That room could not be read.'));
      };
    });
  }

  function listSessions(env) {
    return runTransaction(env, 'readonly', function (store, outcome, fail) {
      var request = store.getAll();
      request.onsuccess = function () {
        var rows = Array.isArray(request.result) ? request.result : [];
        var valid = [];
        for (var i = 0; i < rows.length; i++) {
          try { valid.push(validateSessionObject(rows[i])); } catch (err) { /* skip a corrupt row */ }
        }
        valid.sort(function (a, b) {
          var left = Date.parse(a.updatedAt);
          var right = Date.parse(b.updatedAt);
          if (!isFinite(left)) left = 0;
          if (!isFinite(right)) right = 0;
          return right - left;
        });
        outcome.value = valid;
      };
      request.onerror = function () {
        fail(storageError('STORAGE_UNAVAILABLE', 'Room history could not be listed.'));
      };
    }).then(function (value) {
      return Array.isArray(value) ? value : [];
    });
  }

  function deleteSession(id, env) {
    if (!isNonEmptyString(id)) return Promise.resolve(false);
    return runTransaction(env, 'readwrite', function (store, outcome, fail) {
      var request = store.delete(id);
      request.onsuccess = function () { outcome.value = true; };
      request.onerror = function () {
        fail(storageError('STORAGE_UNAVAILABLE', 'That room could not be removed.'));
      };
    }).then(function (value) { return value === true; });
  }

  function clearAllSessions(env) {
    return runTransaction(env, 'readwrite', function (store, outcome, fail) {
      var request = store.clear();
      request.onsuccess = function () { outcome.value = true; };
      request.onerror = function () {
        fail(storageError('STORAGE_UNAVAILABLE', 'Room history could not be cleared.'));
      };
    }).then(function (value) { return value === true; });
  }

  var api = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_NAME: STORE_NAME,
    UPDATED_AT_INDEX: UPDATED_AT_INDEX,
    generateSessionId: generateSessionId,
    createSession: createSession,
    appendScanToSession: appendScanToSession,
    computeSessionProgress: computeSessionProgress,
    validateSessionObject: validateSessionObject,
    isIndexedDbAvailable: isIndexedDbAvailable,
    openDatabase: openDatabase,
    saveSession: saveSession,
    getSession: getSession,
    listSessions: listSessions,
    deleteSession: deleteSession,
    clearAllSessions: clearAllSessions
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RoomRescueStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
