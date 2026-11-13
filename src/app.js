(function (root) {
  'use strict';

  var core = (typeof module === 'object' && module.exports) ? require('./core.js') : root.RoomRescueCore;
  var api = (typeof module === 'object' && module.exports) ? require('./api.js') : root.RoomRescueApi;
  var storage = (typeof module === 'object' && module.exports) ? require('./storage.js') : root.RoomRescueStorage;
  var exporter = (typeof module === 'object' && module.exports) ? require('./export.js') : root.RoomRescueExport;
  var demo = (typeof module === 'object' && module.exports) ? require('./demo-fixture.js') : root.RoomRescueDemo;

  var initializedDocs = new WeakSet();

  var ERROR_COPY = {
    MISSING_KEY: 'Paste your Mistral API key above, then analyze the room.',
    AUTH_INVALID: 'Mistral rejected that API key. Check it in your Mistral console and paste it again.',
    RATE_LIMITED: 'Mistral is rate limiting this key. Wait a moment and try again.',
    NETWORK_ERROR: 'Could not reach the Mistral API. Check your connection and try again.',
    IMAGE_TOO_LARGE: 'That photo is too large even after resizing. Try a smaller photo.',
    UNSUPPORTED_IMAGE: 'That file type is not supported. Use a JPEG, PNG, or WebP photo.',
    PARSE_ERROR: 'The model returned a response that could not be read. Try analyzing again.',
    API_ERROR: 'Mistral returned an error. Try again in a moment.',
    CLIPBOARD_UNAVAILABLE: 'This browser would not let Room Rescue copy to the clipboard. Select the checklist and copy it by hand.',
    INVALID_IMPORT: 'That file is not a Room Rescue session. Pick a .json file exported from this app.',
    DOWNLOAD_UNAVAILABLE: 'This browser cannot save files. Try a different browser.',
    PRINT_UNAVAILABLE: 'This browser cannot open the print dialog.'
  };

  var STAGE_ORDER = ['downscaling', 'ocr', 'vision', 'done'];

  function el(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function toArray(list) {
    return list ? Array.prototype.slice.call(list) : [];
  }

  function setBanner(doc, kind, message) {
    var banner = doc.getElementById('status-banner');
    if (!banner) return;
    if (!message) {
      banner.hidden = true;
      banner.textContent = '';
      banner.setAttribute('class', 'status-banner');
      return;
    }
    banner.hidden = false;
    banner.textContent = message;
    banner.setAttribute('class', 'status-banner is-' + kind);
  }

  function renderStatusBanner(doc, state) {
    var s = state || {};
    if (s.code === 'vision_only_ocr_empty') {
      setBanner(doc, 'info', 'No readable text was found in this photo, so the plan is based on direct visual analysis of the room.');
      return;
    }
    if (s.code === 'vision_only_ocr_unavailable') {
      setBanner(doc, 'warning', 'Label scanning was unavailable, so the plan is based on direct visual analysis of the room.');
      return;
    }
    if (s.code === 'demo') {
      setBanner(doc, 'success', 'Sample room loaded. This is bundled demo data — no API key and no network were used.');
      return;
    }
    if (s.code === 'resumed') {
      setBanner(doc, 'success', 'Room resumed. Your checklist progress is restored.');
      return;
    }
    if (s.code === 'rescan') {
      setBanner(doc, 'success', 'Progress update saved. Your plan now reflects the new photo.');
      return;
    }
    if (s.code === 'imported') {
      setBanner(doc, 'success', 'Room imported. Your checklist is ready.');
      return;
    }
    if (s.code === 'copied') {
      setBanner(doc, 'success', 'Checklist copied as Markdown.');
      return;
    }
    if (s.code === 'exported') {
      setBanner(doc, 'success', 'Room exported as a .json file.');
      return;
    }
    if (s.code === 'NO_SESSION') {
      setBanner(doc, 'info', 'Analyze a room first, then scan a progress photo.');
      return;
    }
    if (s.code === 'NO_PLAN') {
      setBanner(doc, 'info', 'Analyze a room or load the sample first.');
      return;
    }
    if (s.code === 'success') {
      setBanner(doc, 'success', 'Analysis complete. Your plan is below.');
      return;
    }
    setBanner(doc, 'error', s.message || ERROR_COPY[s.code] || 'Something went wrong. Try again.');
  }

  function collectStageNodes(node, acc) {
    var kids = toArray(node && node.children);
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.getAttribute && child.getAttribute('data-stage')) acc.push(child);
      collectStageNodes(child, acc);
    }
    return acc;
  }

  function setStage(doc, stage) {
    var panel = doc.getElementById('progress-panel');
    if (!panel) return;
    var currentIndex = STAGE_ORDER.indexOf(stage);
    collectStageNodes(panel, []).forEach(function (node) {
      var nodeIndex = STAGE_ORDER.indexOf(node.getAttribute('data-stage'));
      node.classList.remove('is-active');
      node.classList.remove('is-complete');
      if (nodeIndex === currentIndex) node.classList.add('is-active');
      else if (nodeIndex !== -1 && currentIndex !== -1 && nodeIndex < currentIndex) node.classList.add('is-complete');
    });
  }

  function updateKeyStatus(doc, saved) {
    var status = doc.getElementById('key-status-text');
    if (!status) return;
    if (saved) {
      status.textContent = 'Key saved in this browser.';
      status.setAttribute('class', 'key-status is-saved');
    } else {
      status.textContent = 'No key saved yet.';
      status.setAttribute('class', 'key-status');
    }
  }

  function updateChecklistProgress(doc, state) {
    var container = doc.getElementById('actions-container');
    var progress = doc.getElementById('checklist-progress');
    if (!container || !progress) return;
    var rows = toArray(container.children).filter(function (child) {
      return child.classList && child.classList.contains('action-step');
    });
    var done = rows.filter(function (row) { return row.classList.contains('is-done'); }).length;
    progress.textContent = done + ' of ' + rows.length + ' steps done';

    var remaining = doc.getElementById('remaining-minutes');
    if (!remaining) return;
    if (!rows.length) {
      remaining.textContent = '—';
      return;
    }
    var left = 0;
    rows.forEach(function (row) {
      if (row.classList.contains('is-done')) return;
      left += stepMinutes({ estimated_minutes: row.getAttribute('data-minutes') });
    });
    remaining.textContent = left + ' min left';
  }

  // The header total is derived from the steps themselves, so a model that
  // reports its own total cannot drift out of sync with the checklist.
  function stepMinutes(step) {
    var raw = step && step.estimated_minutes;
    if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return 0;
    var n = Number(raw);
    if (!isFinite(n) || n < 0) return 0;
    return Math.round(n);
  }

  function computePlanTotalMinutes(plan) {
    var steps = plan && Array.isArray(plan.action_plan) ? plan.action_plan : [];
    var total = 0;
    for (var i = 0; i < steps.length; i++) total += stepMinutes(steps[i]);
    return total;
  }

  function renderActions(doc, plan, state) {
    var container = doc.getElementById('actions-container');
    if (!container) return;
    container.textContent = '';
    var actions = plan.action_plan || [];
    if (!actions.length) {
      container.appendChild(el(doc, 'p', 'hint', 'No action steps were returned.'));
      return;
    }
    actions.forEach(function (step) {
      var mins = stepMinutes(step);
      var row = el(doc, 'div', 'action-step');
      row.setAttribute('data-step-id', step.step_id);
      row.setAttribute('data-minutes', String(mins));

      var box = el(doc, 'input');
      box.setAttribute('type', 'checkbox');
      box.setAttribute('data-step-id', step.step_id);
      box.checked = Boolean(state.checked && state.checked[step.step_id]);
      if (box.checked) row.classList.add('is-done');

      row.appendChild(box);
      row.appendChild(el(doc, 'p', 'action-text', step.action));
      row.appendChild(el(doc, 'span', 'action-meta', mins + ' min · ' + step.priority));
      container.appendChild(row);
    });
  }

  function renderZones(doc, plan) {
    var container = doc.getElementById('zones-container');
    if (!container) return;
    container.textContent = '';
    var zones = plan.zones || [];
    if (!zones.length) {
      container.appendChild(el(doc, 'p', 'hint', 'No zones were identified.'));
      return;
    }
    zones.forEach(function (zone) {
      var card = el(doc, 'div', 'zone-card');
      card.appendChild(el(doc, 'h4', null, zone.name));
      card.appendChild(el(doc, 'span', 'pill pill-' + zone.priority, zone.priority));
      card.appendChild(el(doc, 'p', null, zone.observation));
      card.appendChild(el(doc, 'p', 'hint', 'Goal: ' + zone.goal_state));
      container.appendChild(card);
    });
  }

  function renderItems(doc, plan) {
    var container = doc.getElementById('items-container');
    if (!container) return;
    container.textContent = '';
    var items = plan.items || [];
    if (!items.length) {
      container.appendChild(el(doc, 'p', 'hint', 'No individual items were identified.'));
      return;
    }
    items.forEach(function (item) {
      var row = el(doc, 'div', 'item-row');
      var left = el(doc, 'div');
      var name = el(doc, 'p', 'item-name', item.name);
      if (item.source === 'vision_and_ocr') name.appendChild(el(doc, 'span', 'source-tag', 'label read'));
      left.appendChild(name);
      left.appendChild(el(doc, 'p', 'item-suggestion', item.suggestion));
      row.appendChild(left);
      row.appendChild(el(doc, 'span', 'disposition-tag', String(item.disposition).replace(/_/g, ' ')));
      container.appendChild(row);
    });
  }

  function groundingLabel(mode) {
    if (mode === 'vision_plus_ocr') return 'Vision + OCR labels';
    if (mode === 'demo_fixture') return 'Bundled sample';
    if (mode === 'vision_only_ocr_unavailable') return 'Vision only — labels unavailable';
    return 'Vision only — no text found';
  }

  function renderAnalysisResult(doc, plan, imageDataUrl, appState) {
    var state = appState || {};
    var mode = plan.meta && plan.meta.grounding_mode;

    var preview = doc.getElementById('preview-image');
    if (preview && imageDataUrl) preview.setAttribute('src', imageDataUrl);

    var badge = doc.getElementById('grounding-badge');
    if (badge) {
      badge.textContent = groundingLabel(mode);
      badge.setAttribute('class', 'grounding-badge' + (mode === 'vision_plus_ocr' ? '' : ' is-vision-only'));
    }

    var summaryText = doc.getElementById('summary-text');
    if (summaryText) summaryText.textContent = plan.summary || '';

    var clutter = doc.getElementById('clutter-level');
    if (clutter) clutter.textContent = plan.clutter_level || '—';

    var total = doc.getElementById('total-minutes');
    if (total) {
      var steps = plan.action_plan || [];
      total.textContent = steps.length ? computePlanTotalMinutes(plan) + ' min' : '—';
    }

    var quickTitle = doc.getElementById('quick-win-title');
    if (quickTitle) quickTitle.textContent = plan.quick_win.title + ' (' + plan.quick_win.estimated_minutes + ' min)';

    var quickWhy = doc.getElementById('quick-win-why');
    if (quickWhy) quickWhy.textContent = plan.quick_win.why_first;

    var ocrText = doc.getElementById('ocr-text');
    if (ocrText) {
      ocrText.textContent = plan.meta && plan.meta.ocr_text
        ? plan.meta.ocr_text
        : 'No readable text was found in this photo.';
    }

    renderActions(doc, plan, state);
    renderZones(doc, plan);
    renderItems(doc, plan);
    updateChecklistProgress(doc, state);

    var results = doc.getElementById('results-section');
    if (results) results.hidden = false;
  }

  // --- Saved rooms --------------------------------------------------------

  function revealRescan(doc, visible) {
    var button = doc.getElementById('rescan-btn');
    if (!button) return;
    button.hidden = !visible;
    // Hiding must also clear a disabled state left behind by a superseded request.
    if (!visible) button.disabled = false;
  }

  function hideBeforeAfter(doc) {
    var container = doc.getElementById('before-after-container');
    if (container) container.hidden = true;
  }

  // A superseded request never reaches its own settle(), so any action that
  // invalidates an in-flight analysis must clear the loading UI itself.
  function clearLoadingState(doc) {
    var progress = doc.getElementById('progress-panel');
    if (progress) progress.hidden = true;
    var analyzeBtn = doc.getElementById('analyze-btn');
    if (analyzeBtn) analyzeBtn.disabled = false;
    var rescanBtn = doc.getElementById('rescan-btn');
    if (rescanBtn) rescanBtn.disabled = false;
  }

  function upsertSession(ctx, session) {
    var sessions = (ctx.state.sessions || []).filter(function (item) {
      return item.id !== session.id;
    });
    sessions.push(session);
    sessions.sort(function (a, b) {
      var left = Date.parse(a.updatedAt);
      var right = Date.parse(b.updatedAt);
      if (!isFinite(left)) left = 0;
      if (!isFinite(right)) right = 0;
      return right - left;
    });
    ctx.state.sessions = sessions;
  }

  // Only the session bar is touched here: hydration must never disturb whatever
  // the user is already looking at.
  function renderSessionBar(doc, ctx) {
    var bar = doc.getElementById('session-bar');
    if (!bar) return;

    var sessions = ctx.state.sessions || [];
    var text = doc.getElementById('session-resume-text');
    var switcher = doc.getElementById('session-switcher');

    if (!sessions.length) {
      bar.hidden = true;
      if (text) text.textContent = 'No saved rooms yet.';
      if (switcher) switcher.textContent = '';
      return;
    }

    bar.hidden = false;

    var active = ctx.state.activeSession;
    var target = active || sessions[0];
    var progress = storage.computeSessionProgress(target);
    var label = progress.roomType || 'Room';

    if (text) {
      text.textContent = active
        ? 'Resumed ' + label + ' — ' + progress.doneCount + ' of ' + progress.totalCount + ' done'
        : 'Resume previous room (' + progress.doneCount + ' of ' + progress.totalCount + ' done)';
    }

    if (switcher) {
      switcher.textContent = '';
      sessions.forEach(function (session) {
        var sessionProgress = storage.computeSessionProgress(session);
        var option = doc.createElement('option');
        option.setAttribute('value', session.id);
        option.textContent = (sessionProgress.roomType || 'Room') + ' — ' +
          sessionProgress.doneCount + ' of ' + sessionProgress.totalCount + ' done';
        if (active && session.id === active.id) option.setAttribute('selected', 'selected');
        switcher.appendChild(option);
      });
      if (active) switcher.value = active.id;
      else if (sessions.length) switcher.value = sessions[0].id;
    }
  }

  function renderBeforeAfter(doc, session) {
    var container = doc.getElementById('before-after-container');
    if (!container) return;

    var scans = session && Array.isArray(session.scans) ? session.scans : [];
    if (scans.length < 2) {
      container.hidden = true;
      return;
    }

    var index = typeof session.activeScanIndex === 'number' ? session.activeScanIndex : scans.length - 1;
    var after = scans[index] || scans[scans.length - 1];
    var before = scans[index - 1] || scans[0];

    var beforeImg = doc.getElementById('before-image');
    if (beforeImg && before) beforeImg.setAttribute('src', before.imageDataUrl);
    var afterImg = doc.getElementById('after-image');
    if (afterImg && after) afterImg.setAttribute('src', after.imageDataUrl);

    container.hidden = false;
  }

  function renderSessionState(doc, ctx) {
    var session = ctx.state.activeSession;
    if (!session) return null;

    var index = typeof session.activeScanIndex === 'number' ? session.activeScanIndex : session.scans.length - 1;
    var scan = session.scans[index] || session.scans[session.scans.length - 1];
    if (!scan) return null;

    ctx.state.currentPlan = scan.plan;
    ctx.state.checked = session.checked || {};
    ctx.state.lastImageDataUrl = scan.imageDataUrl;

    renderAnalysisResult(doc, scan.plan, scan.imageDataUrl, ctx.state);
    renderBeforeAfter(doc, session);
    revealRescan(doc, true);
    renderSessionBar(doc, ctx);
    return scan;
  }

  function persistActiveSession(ctx) {
    var session = ctx.state.activeSession;
    if (!session) return Promise.resolve(null);

    return storage.saveSession(session, { indexedDB: ctx.indexedDB })
      .then(function (saved) {
        if (!saved) return null;
        ctx.state.activeSession = saved;
        upsertSession(ctx, saved);
        renderSessionBar(ctx.document, ctx);
        return saved;
      })
      .catch(function () { return null; });
  }

  function loadSavedSessions(ctx) {
    return storage.listSessions({ indexedDB: ctx.indexedDB })
      .then(function (sessions) {
        ctx.state.sessions = sessions;
        renderSessionBar(ctx.document, ctx);
        return sessions;
      })
      .catch(function () {
        ctx.state.sessions = [];
        return [];
      });
  }

  function handleResumeSession(ctx, sessionId) {
    var id = sessionId;
    if (!id) {
      var switcher = ctx.document.getElementById('session-switcher');
      id = switcher && switcher.value ? switcher.value : '';
    }
    if (!id) return Promise.resolve(null);

    return storage.getSession(id, { indexedDB: ctx.indexedDB }).then(function (session) {
      if (!session) return null;
      // Invalidate any in-flight analysis so it cannot overwrite the resumed room.
      ctx.state.requestId += 1;
      ctx.state.activeSession = session;
      ctx.state.rescanFile = null;
      renderSessionState(ctx.document, ctx);
      clearLoadingState(ctx.document);
      renderStatusBanner(ctx.document, { code: 'resumed' });
      return session;
    });
  }

  function handleNewSession(ctx) {
    var doc = ctx.document;
    ctx.state.requestId += 1;
    ctx.state.activeSession = null;
    ctx.state.currentPlan = null;
    ctx.state.checked = {};
    ctx.state.rescanFile = null;
    ctx.state.lastImageDataUrl = '';

    var results = doc.getElementById('results-section');
    if (results) results.hidden = true;
    revealRescan(doc, false);
    hideBeforeAfter(doc);
    clearLoadingState(doc);
    setBanner(doc, null, '');
    renderSessionBar(doc, ctx);
    return null;
  }

  function startSession(ctx, plan, roomHint) {
    var session;
    try {
      session = storage.createSession({
        roomType: plan.room_type || roomHint || '',
        imageDataUrl: ctx.state.lastImageDataUrl,
        plan: plan,
        ocrText: plan.meta && plan.meta.ocr_text ? plan.meta.ocr_text : ''
      });
    } catch (err) {
      // A plan with no stored photo still renders; it just cannot be resumed.
      ctx.state.activeSession = null;
      revealRescan(ctx.document, false);
      return Promise.resolve(null);
    }

    ctx.state.activeSession = session;
    revealRescan(ctx.document, true);
    hideBeforeAfter(ctx.document);
    return persistActiveSession(ctx);
  }

  function readTextFile(file, readTextImpl) {
    if (typeof readTextImpl === 'function') return Promise.resolve(readTextImpl(file));
    if (typeof FileReader === 'undefined') {
      return Promise.reject(new Error('This browser cannot read local files.'));
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(new Error('That file could not be read.')); };
      reader.readAsText(file);
    });
  }

  function handleImportSessionText(ctx, jsonText) {
    var doc = ctx.document;
    var session;
    try {
      session = exporter.parseImportedSessionJson(jsonText);
    } catch (err) {
      renderStatusBanner(doc, { code: 'INVALID_IMPORT' });
      return Promise.reject(err);
    }

    // Invalidate any in-flight analysis so it cannot overwrite the imported room.
    ctx.state.requestId += 1;
    ctx.state.activeSession = session;
    ctx.state.rescanFile = null;
    renderSessionState(doc, ctx);
    clearLoadingState(doc);
    renderStatusBanner(doc, { code: 'imported' });
    return persistActiveSession(ctx).then(function () { return session; });
  }

  function handleRescanSubmit(ctx, file) {
    var doc = ctx.document;
    var session = ctx.state.activeSession;

    if (!session) {
      renderStatusBanner(doc, { code: 'NO_SESSION' });
      return Promise.reject(new Error('There is no active room to update.'));
    }

    var keyInput = doc.getElementById('mistral-key-input');
    var typed = keyInput && typeof keyInput.value === 'string' ? keyInput.value.trim() : '';
    var mistralKey = typed || api.loadMistralKey(ctx.storage);

    if (!mistralKey) {
      var missing = new api.RoomRescueError('MISSING_KEY', 'Paste your Mistral API key to analyze a room.');
      renderStatusBanner(doc, { code: 'MISSING_KEY', message: missing.userMessage });
      return Promise.reject(missing);
    }

    var rescanInput = doc.getElementById('rescan-photo-input');
    var chosen = file || ctx.state.rescanFile ||
      (rescanInput && rescanInput.files && rescanInput.files.length ? rescanInput.files[0] : null);

    var hintSelect = doc.getElementById('room-hint-select');
    var roomHint = hintSelect && hintSelect.value ? hintSelect.value : (session.roomType || '');

    var activeIndex = typeof session.activeScanIndex === 'number'
      ? session.activeScanIndex
      : session.scans.length - 1;
    var previousScan = session.scans[activeIndex] || session.scans[session.scans.length - 1];

    var requestId = ctx.state.requestId + 1;
    ctx.state.requestId = requestId;

    var progress = doc.getElementById('progress-panel');
    var rescanBtn = doc.getElementById('rescan-btn');
    if (progress) progress.hidden = false;
    if (rescanBtn) rescanBtn.disabled = true;
    setStage(doc, 'downscaling');

    function settle() {
      if (requestId !== ctx.state.requestId) return;
      clearLoadingState(doc);
    }

    var downscale = ctx.downscaleImpl || api.downscaleImageFile;
    var resolvedImage = '';
    var imagePromise = chosen
      ? Promise.resolve()
          .then(function () { return downscale(chosen, ctx.downscaleDeps); })
          .then(function (result) {
            resolvedImage = result.dataUrl;
            return result.dataUrl;
          })
      : Promise.resolve('');

    return imagePromise.then(function (dataUrl) {
      return api.analyzeRoomPhoto({
        imageDataUrl: dataUrl,
        mistralKey: mistralKey,
        roomHint: roomHint,
        fetchImpl: ctx.fetch,
        previousScan: {
          imageDataUrl: previousScan.imageDataUrl,
          plan: previousScan.plan,
          checked: session.checked || {}
        },
        downscaleDataUrlImpl: ctx.downscaleDataUrlImpl,
        onStage: function (stage) {
          if (requestId === ctx.state.requestId) setStage(doc, stage);
        }
      });
    }).then(function (plan) {
      if (requestId !== ctx.state.requestId) return plan;
      settle();
      if (resolvedImage) ctx.state.lastImageDataUrl = resolvedImage;

      var updated = storage.appendScanToSession(session, {
        roomType: plan.room_type || session.roomType,
        imageDataUrl: ctx.state.lastImageDataUrl,
        plan: plan,
        ocrText: plan.meta && plan.meta.ocr_text ? plan.meta.ocr_text : ''
      });

      ctx.state.activeSession = updated;
      ctx.state.rescanFile = null;
      ctx.state.currentPlan = plan;
      ctx.state.checked = updated.checked;
      ctx.state.lastImageDataUrl = updated.scans[updated.activeScanIndex].imageDataUrl;

      renderStatusBanner(doc, { code: 'rescan' });
      renderAnalysisResult(doc, plan, ctx.state.lastImageDataUrl, ctx.state);
      renderBeforeAfter(doc, updated);
      revealRescan(doc, true);
      renderSessionBar(doc, ctx);
      persistActiveSession(ctx);
      return plan;
    }).catch(function (err) {
      if (requestId !== ctx.state.requestId) throw err;
      settle();
      renderStatusBanner(doc, { code: err && err.code ? err.code : 'API_ERROR', message: err && err.userMessage });
      throw err;
    });
  }

  function handleLoadDemo(ctx) {
    var doc = ctx.document;
    var fixture = demo.getDemoFixture();
    // Invalidate any in-flight analysis so a late response cannot overwrite the demo.
    ctx.state.requestId += 1;
    ctx.state.checked = {};
    ctx.state.lastImageDataUrl = fixture.imageDataUrl;
    // The demo is ephemeral: it must never be written into saved room history.
    ctx.state.activeSession = null;
    ctx.state.rescanFile = null;
    ctx.state.currentPlan = fixture.plan;

    revealRescan(doc, false);
    hideBeforeAfter(doc);
    clearLoadingState(doc);
    renderStatusBanner(doc, { code: 'demo' });
    renderAnalysisResult(doc, fixture.plan, fixture.imageDataUrl, ctx.state);
    renderSessionBar(doc, ctx);
    return fixture;
  }

  function handleAnalyzeSubmit(ctx) {
    var doc = ctx.document;
    var keyInput = doc.getElementById('mistral-key-input');
    var typed = keyInput && typeof keyInput.value === 'string' ? keyInput.value.trim() : '';
    var mistralKey = typed || api.loadMistralKey(ctx.storage);

    var fileInput = doc.getElementById('room-photo-input');
    var file = ctx.state.selectedFile ||
      (fileInput && fileInput.files && fileInput.files.length ? fileInput.files[0] : null);

    var hintSelect = doc.getElementById('room-hint-select');
    var roomHint = hintSelect && hintSelect.value ? hintSelect.value : '';

    setBanner(doc, null, '');
    var progress = doc.getElementById('progress-panel');
    var analyzeBtn = doc.getElementById('analyze-btn');

    // Fail on the key before spending any work on the photo.
    if (!mistralKey) {
      var missing = new api.RoomRescueError('MISSING_KEY', 'Paste your Mistral API key to analyze a room.');
      renderStatusBanner(doc, { code: 'MISSING_KEY', message: missing.userMessage });
      return Promise.reject(missing);
    }

    var requestId = ctx.state.requestId + 1;
    ctx.state.requestId = requestId;
    if (progress) progress.hidden = false;
    if (analyzeBtn) analyzeBtn.disabled = true;
    setStage(doc, 'downscaling');

    function settle() {
      if (requestId !== ctx.state.requestId) return;
      clearLoadingState(doc);
    }

    var downscale = ctx.downscaleImpl || api.downscaleImageFile;
    // The photo is held locally until the request is known to still be current,
    // so a demo click during downscaling cannot leave a stale image on the state.
    var resolvedImage = '';
    var imagePromise = file
      ? Promise.resolve()
          .then(function () { return downscale(file, ctx.downscaleDeps); })
          .then(function (result) {
            resolvedImage = result.dataUrl;
            return result.dataUrl;
          })
      : Promise.resolve('');

    return imagePromise.then(function (dataUrl) {
      return api.analyzeRoomPhoto({
        imageDataUrl: dataUrl,
        mistralKey: mistralKey,
        roomHint: roomHint,
        fetchImpl: ctx.fetch,
        onStage: function (stage) {
          if (requestId === ctx.state.requestId) setStage(doc, stage);
        }
      });
    }).then(function (plan) {
      if (requestId !== ctx.state.requestId) return plan;
      settle();
      if (resolvedImage) ctx.state.lastImageDataUrl = resolvedImage;
      ctx.state.checked = {};
      ctx.state.currentPlan = plan;

      var mode = plan.meta && plan.meta.grounding_mode;
      if (mode === 'vision_only_ocr_empty') renderStatusBanner(doc, { code: 'vision_only_ocr_empty' });
      else if (mode === 'vision_only_ocr_unavailable') renderStatusBanner(doc, { code: 'vision_only_ocr_unavailable' });
      else renderStatusBanner(doc, { code: 'success' });

      renderAnalysisResult(doc, plan, ctx.state.lastImageDataUrl, ctx.state);
      startSession(ctx, plan, roomHint);
      return plan;
    }).catch(function (err) {
      if (requestId !== ctx.state.requestId) throw err;
      settle();
      renderStatusBanner(doc, { code: err && err.code ? err.code : 'API_ERROR', message: err && err.userMessage });
      throw err;
    });
  }

  function initApp(customEnv) {
    var env = customEnv || {};
    var doc = env.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('initApp requires a document.');

    if (initializedDocs.has(doc)) return null;
    initializedDocs.add(doc);

    var ctx = {
      document: doc,
      storage: env.storage || (typeof localStorage !== 'undefined' ? localStorage : null),
      // An explicit `indexedDB: null` means "no room history", so it must not fall
      // through to whatever the host happens to expose.
      indexedDB: Object.prototype.hasOwnProperty.call(env, 'indexedDB')
        ? env.indexedDB
        : (typeof indexedDB !== 'undefined' ? indexedDB : null),
      fetch: env.fetch,
      downscaleImpl: env.downscaleImpl,
      downscaleDeps: env.downscaleDeps,
      downscaleDataUrlImpl: env.downscaleDataUrlImpl,
      clipboard: env.clipboard,
      printImpl: env.printImpl,
      downloadImpl: env.downloadImpl,
      readTextImpl: env.readTextImpl,
      state: {
        checked: {},
        lastImageDataUrl: '',
        selectedFile: null,
        requestId: 0,
        activeSession: null,
        sessions: [],
        currentPlan: null,
        rescanFile: null
      }
    };

    var keyInput = doc.getElementById('mistral-key-input');
    var saved = api.loadMistralKey(ctx.storage);
    if (keyInput && saved) keyInput.value = saved;
    updateKeyStatus(doc, saved);

    var saveBtn = doc.getElementById('save-key-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        try {
          var stored = api.saveMistralKey(keyInput ? keyInput.value : '', ctx.storage);
          updateKeyStatus(doc, stored);
          setBanner(doc, null, '');
        } catch (err) {
          renderStatusBanner(doc, { code: err.code, message: err.userMessage });
        }
      });
    }

    var clearBtn = doc.getElementById('clear-key-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        api.clearMistralKey(ctx.storage);
        if (keyInput) keyInput.value = '';
        updateKeyStatus(doc, '');
      });
    }

    var fileInput = doc.getElementById('room-photo-input');
    var dropzone = doc.getElementById('dropzone');

    if (fileInput) {
      fileInput.addEventListener('change', function () {
        ctx.state.selectedFile = fileInput.files && fileInput.files.length ? fileInput.files[0] : null;
      });
    }

    if (dropzone) {
      dropzone.addEventListener('click', function (event) {
        // The file input lives inside the dropzone; its own click already opens
        // the picker, so re-dispatching here would open it twice.
        var target = event && event.target;
        if (target && target.tagName === 'INPUT') return;
        if (fileInput && typeof fileInput.click === 'function') fileInput.click();
      });
      dropzone.addEventListener('dragover', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        dropzone.classList.add('is-dragging');
      });
      dropzone.addEventListener('dragleave', function () {
        dropzone.classList.remove('is-dragging');
      });
      dropzone.addEventListener('drop', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        dropzone.classList.remove('is-dragging');
        var dropped = event && event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
        // A plain array cannot be assigned to input.files (the setter requires a
        // FileList), so the dropped file is held on the app state instead.
        if (dropped) ctx.state.selectedFile = dropped;
      });
    }

    var analyzeBtn = doc.getElementById('analyze-btn');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', function () {
        handleAnalyzeSubmit(ctx).catch(function () { /* the banner already explains the failure */ });
      });
    }

    var demoBtn = doc.getElementById('load-demo-btn');
    if (demoBtn) {
      demoBtn.addEventListener('click', function () { handleLoadDemo(ctx); });
    }

    var resumeBtn = doc.getElementById('resume-session-btn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', function () { handleResumeSession(ctx); });
    }

    var newSessionBtn = doc.getElementById('new-session-btn');
    if (newSessionBtn) {
      newSessionBtn.addEventListener('click', function () { handleNewSession(ctx); });
    }

    var sessionSwitcher = doc.getElementById('session-switcher');
    if (sessionSwitcher) {
      sessionSwitcher.addEventListener('change', function () {
        var id = sessionSwitcher.value;
        if (id) handleResumeSession(ctx, id);
      });
    }

    var rescanBtn = doc.getElementById('rescan-btn');
    var rescanInput = doc.getElementById('rescan-photo-input');
    if (rescanBtn && rescanInput) {
      rescanBtn.addEventListener('click', function () {
        if (typeof rescanInput.click === 'function') rescanInput.click();
      });
      rescanInput.addEventListener('change', function () {
        var file = rescanInput.files && rescanInput.files.length ? rescanInput.files[0] : null;
        if (!file) return;
        ctx.state.rescanFile = file;
        handleRescanSubmit(ctx, file).catch(function () { /* the banner already explains the failure */ });
      });
    }

    var compareSlider = doc.getElementById('compare-slider');
    if (compareSlider) {
      compareSlider.addEventListener('input', function () {
        var value = Number(compareSlider.value);
        if (!isFinite(value)) value = 50;
        if (value < 0) value = 0;
        if (value > 100) value = 100;
        var beforeImg = doc.getElementById('before-image');
        var afterImg = doc.getElementById('after-image');
        if (beforeImg && beforeImg.style) beforeImg.style.clipPath = 'inset(0 ' + (100 - value) + '% 0 0)';
        if (afterImg && afterImg.style) afterImg.style.clipPath = 'inset(0 0 0 ' + value + '%)';
      });
    }

    var printBtn = doc.getElementById('print-btn');
    if (printBtn) {
      printBtn.addEventListener('click', function () {
        var doPrint = ctx.printImpl;
        if (!doPrint && typeof window !== 'undefined' && typeof window.print === 'function') {
          doPrint = function () { window.print(); };
        }
        if (!doPrint) {
          renderStatusBanner(doc, { code: 'PRINT_UNAVAILABLE' });
          return;
        }
        doPrint();
      });
    }

    var copyBtn = doc.getElementById('copy-md-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var plan = ctx.state.currentPlan;
        if (!plan) {
          renderStatusBanner(doc, { code: 'NO_PLAN' });
          return;
        }
        var markdown = exporter.formatPlanAsMarkdown(plan, ctx.state.checked);
        exporter.copyTextToClipboard(markdown, ctx.clipboard)
          .then(function () { renderStatusBanner(doc, { code: 'copied' }); })
          .catch(function () { renderStatusBanner(doc, { code: 'CLIPBOARD_UNAVAILABLE' }); });
      });
    }

    var exportBtn = doc.getElementById('export-json-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        var session = ctx.state.activeSession;
        if (!session) {
          renderStatusBanner(doc, { code: 'NO_SESSION' });
          return;
        }
        var json;
        try {
          json = exporter.serializeSessionForExport(session);
        } catch (err) {
          renderStatusBanner(doc, { code: 'INVALID_SESSION' });
          return;
        }
        var ok = exporter.downloadTextFile(
          'room-rescue-' + session.id + '.json',
          json,
          'application/json',
          { downloadImpl: ctx.downloadImpl }
        );
        renderStatusBanner(doc, { code: ok ? 'exported' : 'DOWNLOAD_UNAVAILABLE' });
      });
    }

    var importBtn = doc.getElementById('import-json-btn');
    var importInput = doc.getElementById('import-json-input');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', function () {
        if (typeof importInput.click === 'function') importInput.click();
      });
      importInput.addEventListener('change', function () {
        var file = importInput.files && importInput.files.length ? importInput.files[0] : null;
        if (!file) return;
        readTextFile(file, ctx.readTextImpl)
          .then(function (text) { return handleImportSessionText(ctx, text); })
          .catch(function () { /* the banner already explains the failure */ });
      });
    }

    var actionsContainer = doc.getElementById('actions-container');
    if (actionsContainer) {
      actionsContainer.addEventListener('change', function (event) {
        var target = event && event.target;
        if (!target || !target.getAttribute) return;
        var stepId = target.getAttribute('data-step-id');
        if (!stepId) return;
        ctx.state.checked[stepId] = Boolean(target.checked);
        var row = target.parentNode;
        if (row && row.classList) {
          if (target.checked) row.classList.add('is-done');
          else row.classList.remove('is-done');
        }
        updateChecklistProgress(doc, ctx.state);

        // Every tick is written straight back, so a refresh never loses progress.
        if (ctx.state.activeSession) {
          ctx.state.activeSession = Object.assign({}, ctx.state.activeSession, {
            checked: Object.assign({}, ctx.state.checked),
            updatedAt: new Date().toISOString()
          });
          persistActiveSession(ctx);
        }
      });
    }

    ctx.ready = loadSavedSessions(ctx);
    return ctx;
  }

  var exported = {
    initApp: initApp,
    renderStatusBanner: renderStatusBanner,
    renderAnalysisResult: renderAnalysisResult,
    updateChecklistProgress: updateChecklistProgress,
    renderSessionBar: renderSessionBar,
    renderSessionState: renderSessionState,
    renderBeforeAfter: renderBeforeAfter,
    persistActiveSession: persistActiveSession,
    loadSavedSessions: loadSavedSessions,
    handleLoadDemo: handleLoadDemo,
    handleAnalyzeSubmit: handleAnalyzeSubmit,
    handleResumeSession: handleResumeSession,
    handleNewSession: handleNewSession,
    handleRescanSubmit: handleRescanSubmit,
    handleImportSessionText: handleImportSessionText,
    ERROR_COPY: ERROR_COPY
  };

  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.RoomRescueApp = exported;

  var isNode = typeof process !== 'undefined' && Boolean(process.versions && process.versions.node);
  if (!isNode && typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { initApp(); });
    } else {
      initApp();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
