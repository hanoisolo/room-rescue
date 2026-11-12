(function (root) {
  'use strict';

  var core = (typeof module === 'object' && module.exports) ? require('./core.js') : root.RoomRescueCore;
  var api = (typeof module === 'object' && module.exports) ? require('./api.js') : root.RoomRescueApi;
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
    API_ERROR: 'Mistral returned an error. Try again in a moment.'
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
      var row = el(doc, 'div', 'action-step');
      row.setAttribute('data-step-id', step.step_id);

      var box = el(doc, 'input');
      box.setAttribute('type', 'checkbox');
      box.setAttribute('data-step-id', step.step_id);
      box.checked = Boolean(state.checked && state.checked[step.step_id]);
      if (box.checked) row.classList.add('is-done');

      row.appendChild(box);
      row.appendChild(el(doc, 'p', 'action-text', step.action));
      row.appendChild(el(doc, 'span', 'action-meta', step.estimated_minutes + ' min · ' + step.priority));
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
    if (total) total.textContent = plan.total_estimated_minutes ? plan.total_estimated_minutes + ' min' : '—';

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

  function handleLoadDemo(ctx) {
    var doc = ctx.document;
    var fixture = demo.getDemoFixture();
    // Invalidate any in-flight analysis so a late response cannot overwrite the demo.
    ctx.state.requestId += 1;
    ctx.state.checked = {};
    ctx.state.lastImageDataUrl = fixture.imageDataUrl;

    var progress = doc.getElementById('progress-panel');
    if (progress) progress.hidden = true;
    var analyzeBtn = doc.getElementById('analyze-btn');
    if (analyzeBtn) analyzeBtn.disabled = false;

    renderStatusBanner(doc, { code: 'demo' });
    renderAnalysisResult(doc, fixture.plan, fixture.imageDataUrl, ctx.state);
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
      if (progress) progress.hidden = true;
      if (analyzeBtn) analyzeBtn.disabled = false;
    }

    var downscale = ctx.downscaleImpl || api.downscaleImageFile;
    var imagePromise = file
      ? Promise.resolve().then(function () { return downscale(file, ctx.downscaleDeps); }).then(function (result) { return result.dataUrl; })
      : Promise.resolve('');

    return imagePromise.then(function (dataUrl) {
      if (dataUrl) ctx.state.lastImageDataUrl = dataUrl;
      return api.analyzeRoomPhoto({
        imageDataUrl: dataUrl,
        mistralKey: mistralKey,
        roomHint: roomHint,
        fetchImpl: ctx.fetch,
        onStage: function (stage) { setStage(doc, stage); }
      });
    }).then(function (plan) {
      if (requestId !== ctx.state.requestId) return plan;
      settle();
      ctx.state.checked = {};

      var mode = plan.meta && plan.meta.grounding_mode;
      if (mode === 'vision_only_ocr_empty') renderStatusBanner(doc, { code: 'vision_only_ocr_empty' });
      else if (mode === 'vision_only_ocr_unavailable') renderStatusBanner(doc, { code: 'vision_only_ocr_unavailable' });
      else renderStatusBanner(doc, { code: 'success' });

      renderAnalysisResult(doc, plan, ctx.state.lastImageDataUrl, ctx.state);
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
      fetch: env.fetch,
      downscaleImpl: env.downscaleImpl,
      downscaleDeps: env.downscaleDeps,
      state: { checked: {}, lastImageDataUrl: '', selectedFile: null, requestId: 0 }
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
      });
    }

    return ctx;
  }

  var exported = {
    initApp: initApp,
    renderStatusBanner: renderStatusBanner,
    renderAnalysisResult: renderAnalysisResult,
    updateChecklistProgress: updateChecklistProgress,
    handleLoadDemo: handleLoadDemo,
    handleAnalyzeSubmit: handleAnalyzeSubmit,
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
