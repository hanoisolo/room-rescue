(function (root) {
  'use strict';

  // Pinned endpoints and model ids. Verified against the live API surface.
  var MISTRAL_OCR_ENDPOINT = 'https://api.mistral.ai/v1/ocr';
  var MISTRAL_CHAT_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
  var MISTRAL_OCR_MODEL = 'mistral-ocr-4';
  var MISTRAL_VISION_MODEL = 'mistral-large-4';

  // Image budget. Longest edge keeps a phone photo inside a sane request size.
  var IMAGE_MAX_EDGE_PX = 1568;
  var IMAGE_JPEG_QUALITY = 0.85;
  var IMAGE_JPEG_FALLBACK_QUALITY = 0.65;
  var MAX_RAW_FILE_BYTES = 26214400;
  var MAX_PAYLOAD_BYTES = 4194304;
  var MAX_OCR_CHARS = 4000;

  var STORAGE_KEY_NAME = 'room_rescue_mistral_credential';
  var LARGE4_TEMPERATURE = 0.2;

  var PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };
  var CLUTTER_LEVELS = ['light', 'moderate', 'heavy', 'overwhelming'];
  var PRIORITIES = ['high', 'medium', 'low'];
  var DISPOSITIONS = ['keep_in_place', 'relocate', 'contain', 'donate', 'recycle_trash'];
  var ITEM_SOURCES = ['vision', 'vision_and_ocr'];

  var ROOM_RESCUE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['room_type', 'clutter_level', 'summary', 'quick_win', 'zones', 'items', 'action_plan'],
    properties: {
      room_type: { type: 'string' },
      clutter_level: { type: 'string', enum: CLUTTER_LEVELS },
      summary: { type: 'string' },
      quick_win: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'estimated_minutes', 'why_first'],
        properties: {
          title: { type: 'string' },
          estimated_minutes: { type: 'integer' },
          why_first: { type: 'string' }
        }
      },
      zones: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'name', 'observation', 'priority', 'goal_state'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            observation: { type: 'string' },
            priority: { type: 'string', enum: PRIORITIES },
            goal_state: { type: 'string' }
          }
        }
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'zone_id', 'category', 'disposition', 'source', 'suggestion'],
          properties: {
            name: { type: 'string' },
            zone_id: { type: 'string' },
            category: { type: 'string' },
            disposition: { type: 'string', enum: DISPOSITIONS },
            source: { type: 'string', enum: ITEM_SOURCES },
            suggestion: { type: 'string' }
          }
        }
      },
      action_plan: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['step_id', 'zone_id', 'action', 'priority', 'impact', 'estimated_minutes'],
          properties: {
            step_id: { type: 'string' },
            zone_id: { type: 'string' },
            action: { type: 'string' },
            priority: { type: 'string', enum: PRIORITIES },
            impact: { type: 'string', enum: PRIORITIES },
            estimated_minutes: { type: 'integer' }
          }
        }
      }
    }
  };

  var JSON_CONTRACT_TEXT = [
    'Respond with a single JSON object and nothing else. No prose, no code fences.',
    'Required keys:',
    'room_type (string), clutter_level (one of light|moderate|heavy|overwhelming), summary (string),',
    'quick_win (object: title, estimated_minutes integer, why_first),',
    'zones (array of objects: id, name, observation, priority high|medium|low, goal_state),',
    'items (array of objects: name, zone_id, category, disposition keep_in_place|relocate|contain|donate|recycle_trash, source vision|vision_and_ocr, suggestion),',
    'action_plan (array of objects: step_id, zone_id, action, priority high|medium|low, impact high|medium|low, estimated_minutes integer).'
  ].join(' ');

  function coreError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function asText(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  function asEnum(value, allowed, fallback) {
    return allowed.indexOf(value) === -1 ? fallback : value;
  }

  function asMinutes(value, fallback) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
    var n = Number(value);
    if (!isFinite(n) || n < 0) return fallback;
    return Math.round(n);
  }

  function weightOf(value) {
    return PRIORITY_WEIGHT[value] || 0;
  }

  // --- Image sizing -------------------------------------------------------

  function computeDownscaleDimensions(width, height, maxEdge) {
    var limit = isFiniteNumber(maxEdge) && maxEdge > 0 ? maxEdge : IMAGE_MAX_EDGE_PX;
    if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
      throw coreError('UNSUPPORTED_IMAGE', 'Image dimensions must be positive finite numbers, received ' + width + 'x' + height + '.');
    }
    var longest = Math.max(width, height);
    if (longest <= limit) {
      return { width: Math.round(width), height: Math.round(height), wasDownscaled: false };
    }
    var scale = limit / longest;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      wasDownscaled: true
    };
  }

  function estimateDataUrlBytes(dataUrl) {
    if (typeof dataUrl !== 'string') {
      throw coreError('UNSUPPORTED_IMAGE', 'The image payload must be a string.');
    }
    var comma = dataUrl.indexOf(',');
    if (comma === -1) {
      throw coreError('UNSUPPORTED_IMAGE', 'The image payload is not a valid data URL.');
    }
    var payload = dataUrl.slice(comma + 1);
    var padding = 0;
    if (payload.slice(-2) === '==') padding = 2;
    else if (payload.slice(-1) === '=') padding = 1;
    return Math.floor((payload.length * 3) / 4) - padding;
  }

  function validateImagePayload(dataUrl, maxBytes) {
    var ceiling = isFiniteNumber(maxBytes) && maxBytes > 0 ? maxBytes : MAX_PAYLOAD_BYTES;
    if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) {
      throw coreError('UNSUPPORTED_IMAGE', 'The room photo must be a JPEG, PNG, or WebP image.');
    }
    var bytes = estimateDataUrlBytes(dataUrl);
    if (bytes > ceiling) {
      throw coreError('IMAGE_TOO_LARGE', 'The processed photo is ' + Math.round(bytes / 1024) + ' KB, above the ' + Math.round(ceiling / 1024) + ' KB limit.');
    }
    return { bytes: bytes, ok: true };
  }

  // --- OCR 4 (supplementary grounding channel) ----------------------------

  function buildOcrRequest(imageDataUrl) {
    if (typeof imageDataUrl !== 'string' || imageDataUrl.indexOf('data:image/') !== 0) {
      throw coreError('UNSUPPORTED_IMAGE', 'The room photo must be a JPEG, PNG, or WebP image.');
    }
    return {
      model: MISTRAL_OCR_MODEL,
      document: { type: 'image_url', image_url: imageDataUrl },
      include_blocks: true,
      confidence_scores_granularity: 'page'
    };
  }

  function cleanOcrText(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    var withoutImages = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    var lines = withoutImages.split(/\r?\n/);
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+/g, ' ').trim();
      if (!line) continue;
      // Keep only lines carrying real content. This drops table dividers and
      // leftover markdown structure (#, ***, >, ___) that would otherwise make
      // a textless photo look like it had readable labels.
      if (!/[0-9A-Za-z\u00C0-\uFFFF]/.test(line)) continue;
      kept.push(line);
    }
    return kept.join('\n');
  }

  function readPageConfidence(page) {
    if (!page || typeof page !== 'object') return null;
    var scores = page.confidence_scores;
    if (!scores || typeof scores !== 'object') return null;
    var keys = ['average_page_confidence_score', 'page_confidence_score', 'average'];
    for (var i = 0; i < keys.length; i++) {
      if (isFiniteNumber(scores[keys[i]])) return scores[keys[i]];
    }
    return null;
  }

  function normalizeOcrResult(ocrResponse, maxChars) {
    var budget = isFiniteNumber(maxChars) && maxChars > 0 ? maxChars : MAX_OCR_CHARS;
    var empty = { hasText: false, status: 'ocr_empty', cleanedText: '', lineCount: 0, pageConfidence: null };
    if (!ocrResponse || typeof ocrResponse !== 'object') return empty;
    var pages = Array.isArray(ocrResponse.pages) ? ocrResponse.pages : [];
    if (pages.length === 0) return empty;

    var chunks = [];
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      if (page && typeof page.markdown === 'string' && page.markdown) chunks.push(page.markdown);
    }

    var cleaned = cleanOcrText(chunks.join('\n'));
    if (cleaned.length > budget) cleaned = cleaned.slice(0, budget).trim();
    var lines = cleaned ? cleaned.split('\n') : [];

    return {
      hasText: cleaned.length > 0,
      status: cleaned.length > 0 ? 'ocr_grounded' : 'ocr_empty',
      cleanedText: cleaned,
      lineCount: lines.length,
      pageConfidence: readPageConfidence(pages[0])
    };
  }

  // --- Large 4 (primary vision channel) -----------------------------------

  function escapeForPrompt(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function buildVisionPrompt(ocrSummary, roomHint, mode) {
    var parts = [];
    parts.push('You are a professional home organizer analyzing a photograph of a room.');
    parts.push('Inspect the room image directly. Identify the zones (surfaces, storage areas, floor areas), the clutter density, and the specific items creating visual noise.');
    parts.push('Room context supplied by the user: ' + roomHint);
    parts.push('Return at most 6 zones, 12 items, and 8 action_plan steps. Keep every text field to 1-2 concise sentences.');
    parts.push('Duration and realism rules for estimated_minutes:');
    parts.push('- Estimate realistic physical execution time in whole minutes, not padded 5- or 10-minute blocks.');
    parts.push('- 1-2 min: relocating a single object, shelving a small stack of books, tossing obvious trash, or placing an already-labelled box onto an open shelf.');
    parts.push('- 3-5 min: clearing a small surface into a staging bin, coiling 2-4 cables, or wiping down a cleared area.');
    parts.push('- 10-20 min: high-cognitive-load work that involves reading, sorting, or keep-or-toss decisions across a pile of loose papers or mixed containers.');
    parts.push('- Never round a step up to 5 or 10 minutes to look tidy. An action that takes under a minute is 1 minute.');

    if (ocrSummary.hasText && ocrSummary.cleanedText) {
      parts.push('<ocr_detected_labels status="grounded">');
      parts.push(escapeForPrompt(ocrSummary.cleanedText));
      parts.push('</ocr_detected_labels>');
      parts.push('The labels above were read from the photograph. Use them to name specific items, and set source to "vision_and_ocr" for any item you can tie to a label.');
      parts.push('Respect those labels: when a detected label already names a container (for example "TAX DOCS 2023"), quote that label in the step and do not tell the user to label that container again.');
    } else {
      parts.push('<ocr_detected_labels status="none">');
      parts.push('No readable text was detected in this photograph. Rely entirely on direct visual inspection of the image. Do not invent or guess printed labels, brand names, or text you cannot actually see.');
      parts.push('</ocr_detected_labels>');
    }

    if (mode === 'json_object') parts.push(JSON_CONTRACT_TEXT);
    return parts.join('\n');
  }

  function buildLarge4Request(imageDataUrl, ocrSummary, roomHint, options) {
    var opts = options || {};
    var mode = opts.responseFormatMode === 'json_object' ? 'json_object' : 'json_schema';
    if (typeof imageDataUrl !== 'string' || imageDataUrl.indexOf('data:image/') !== 0) {
      throw coreError('UNSUPPORTED_IMAGE', 'The room photo must be a JPEG, PNG, or WebP image.');
    }

    var summary = ocrSummary && typeof ocrSummary === 'object'
      ? ocrSummary
      : { hasText: false, status: 'ocr_empty', cleanedText: '', lineCount: 0, pageConfidence: null };
    var hint = asText(roomHint, 'Auto-detect the room type from the image.');

    return {
      model: MISTRAL_VISION_MODEL,
      temperature: LARGE4_TEMPERATURE,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: imageDataUrl },
            { type: 'text', text: buildVisionPrompt(summary, hint, mode) }
          ]
        }
      ],
      response_format: mode === 'json_object'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'room_rescue_plan', strict: true, schema: ROOM_RESCUE_SCHEMA } }
    };
  }

  // --- Response handling --------------------------------------------------

  function extractAssistantText(chatResponse) {
    if (!chatResponse || typeof chatResponse !== 'object') {
      throw coreError('PARSE_ERROR', 'The model returned an empty response.');
    }
    var choices = chatResponse.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw coreError('PARSE_ERROR', 'The model response contained no choices.');
    }
    var message = choices[0] && choices[0].message;
    if (!message || typeof message !== 'object') {
      throw coreError('PARSE_ERROR', 'The model response contained no message.');
    }
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      var out = [];
      for (var i = 0; i < message.content.length; i++) {
        var part = message.content[i];
        if (part && typeof part.text === 'string') out.push(part.text);
      }
      if (out.length) return out.join('');
    }
    throw coreError('PARSE_ERROR', 'The model response contained no text content.');
  }

  function parseTolerantJson(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      throw coreError('PARSE_ERROR', 'The model returned an empty response.');
    }
    var text = rawText.trim();

    // Fast path: the model already returned clean JSON. Repairing before this
    // check would corrupt valid strings that happen to contain ``` or ",}".
    try {
      var direct = JSON.parse(text);
      if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
    } catch (err) { /* fall through to repair */ }

    var candidate = text;
    var fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) candidate = fence[1].trim();

    var start = candidate.indexOf('{');
    var end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw coreError('PARSE_ERROR', 'The model response did not contain a JSON object.');
    }
    var sliced = candidate.slice(start, end + 1);

    try {
      return JSON.parse(sliced);
    } catch (err) { /* fall through to comma repair */ }

    try {
      return JSON.parse(sliced.replace(/,\s*([}\]])/g, '$1'));
    } catch (err) {
      throw coreError('PARSE_ERROR', 'The model response could not be parsed as JSON.');
    }
  }

  // --- Ranking and normalization -----------------------------------------

  function rankZones(zones) {
    var list = Array.isArray(zones) ? zones.slice() : [];
    list.sort(function (a, b) {
      var delta = weightOf(b && b.priority) - weightOf(a && a.priority);
      if (delta !== 0) return delta;
      var left = String((a && a.name) || '');
      var right = String((b && b.name) || '');
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return list;
  }

  function minutesForRank(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
      return Number.MAX_SAFE_INTEGER;
    }
    var n = Number(value);
    if (!isFinite(n) || n < 0) return Number.MAX_SAFE_INTEGER;
    return n;
  }

  function rankActionPlan(actions) {
    var list = Array.isArray(actions) ? actions.slice() : [];
    list.sort(function (a, b) {
      var delta = weightOf(b && b.priority) - weightOf(a && a.priority);
      if (delta !== 0) return delta;
      delta = weightOf(b && b.impact) - weightOf(a && a.impact);
      if (delta !== 0) return delta;
      return minutesForRank(a && a.estimated_minutes) - minutesForRank(b && b.estimated_minutes);
    });
    return list;
  }

  function normalizeZones(zones) {
    var list = Array.isArray(zones) ? zones : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var zone = list[i];
      if (!zone || typeof zone !== 'object') continue;
      out.push({
        id: asText(zone.id, 'zone_' + (i + 1)),
        name: asText(zone.name, 'Zone ' + (i + 1)),
        observation: asText(zone.observation, ''),
        priority: asEnum(zone.priority, PRIORITIES, 'medium'),
        goal_state: asText(zone.goal_state, '')
      });
    }
    return out;
  }

  function normalizeItems(items, hasOcrText) {
    var list = Array.isArray(items) ? items : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      out.push({
        name: asText(item.name, 'Unnamed item'),
        zone_id: asText(item.zone_id, ''),
        category: asText(item.category, 'general'),
        disposition: asEnum(item.disposition, DISPOSITIONS, 'relocate'),
        // Without OCR text there is nothing to tie an item to, so the label-read
        // badge must never appear under a "no text found" banner.
        source: hasOcrText ? asEnum(item.source, ITEM_SOURCES, 'vision') : 'vision',
        suggestion: asText(item.suggestion, '')
      });
    }
    return out;
  }

  function normalizeActions(actions) {
    var list = Array.isArray(actions) ? actions : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var step = list[i];
      if (!step || typeof step !== 'object') continue;
      out.push({
        step_id: asText(step.step_id, 'step_' + (i + 1)),
        zone_id: asText(step.zone_id, ''),
        action: asText(step.action, ''),
        priority: asEnum(step.priority, PRIORITIES, 'medium'),
        impact: asEnum(step.impact, PRIORITIES, 'medium'),
        estimated_minutes: asMinutes(step.estimated_minutes, 10)
      });
    }
    return out;
  }

  function normalizeQuickWin(quickWin) {
    var source = quickWin && typeof quickWin === 'object' ? quickWin : {};
    return {
      title: asText(source.title, 'Clear one visible surface'),
      estimated_minutes: asMinutes(source.estimated_minutes, 5),
      why_first: asText(source.why_first, 'A cleared surface makes the whole room feel different immediately.')
    };
  }

  function normalizeAndRankPlan(rawPlan, ocrSummary, options) {
    var opts = options || {};
    var plan = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
    var summary = ocrSummary && typeof ocrSummary === 'object'
      ? ocrSummary
      : { hasText: false, status: 'ocr_empty', cleanedText: '', lineCount: 0, pageConfidence: null };

    var actions = normalizeActions(plan.action_plan);
    var total = 0;
    for (var i = 0; i < actions.length; i++) {
      if (isFiniteNumber(actions[i].estimated_minutes)) total += actions[i].estimated_minutes;
    }

    var groundingMode;
    if (opts.isDemo) groundingMode = 'demo_fixture';
    else if (summary.status === 'ocr_unavailable') groundingMode = 'vision_only_ocr_unavailable';
    else if (summary.hasText) groundingMode = 'vision_plus_ocr';
    else groundingMode = 'vision_only_ocr_empty';

    return {
      room_type: asText(plan.room_type, 'Room'),
      clutter_level: asEnum(plan.clutter_level, CLUTTER_LEVELS, 'moderate'),
      summary: asText(plan.summary, ''),
      quick_win: normalizeQuickWin(plan.quick_win),
      zones: rankZones(normalizeZones(plan.zones)),
      items: normalizeItems(plan.items, Boolean(summary.hasText)),
      action_plan: rankActionPlan(actions),
      total_estimated_minutes: total,
      meta: {
        grounding_mode: groundingMode,
        ocr_status: asText(summary.status, 'ocr_empty'),
        ocr_text: typeof summary.cleanedText === 'string' ? summary.cleanedText : '',
        ocr_line_count: isFiniteNumber(summary.lineCount) ? summary.lineCount : 0,
        ocr_page_confidence: isFiniteNumber(summary.pageConfidence) ? summary.pageConfidence : null,
        is_demo: Boolean(opts.isDemo)
      }
    };
  }

  var api = {
    MISTRAL_OCR_ENDPOINT: MISTRAL_OCR_ENDPOINT,
    MISTRAL_CHAT_ENDPOINT: MISTRAL_CHAT_ENDPOINT,
    MISTRAL_OCR_MODEL: MISTRAL_OCR_MODEL,
    MISTRAL_VISION_MODEL: MISTRAL_VISION_MODEL,
    IMAGE_MAX_EDGE_PX: IMAGE_MAX_EDGE_PX,
    IMAGE_JPEG_QUALITY: IMAGE_JPEG_QUALITY,
    IMAGE_JPEG_FALLBACK_QUALITY: IMAGE_JPEG_FALLBACK_QUALITY,
    MAX_RAW_FILE_BYTES: MAX_RAW_FILE_BYTES,
    MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
    MAX_OCR_CHARS: MAX_OCR_CHARS,
    STORAGE_KEY_NAME: STORAGE_KEY_NAME,
    LARGE4_TEMPERATURE: LARGE4_TEMPERATURE,
    ROOM_RESCUE_SCHEMA: ROOM_RESCUE_SCHEMA,
    computeDownscaleDimensions: computeDownscaleDimensions,
    estimateDataUrlBytes: estimateDataUrlBytes,
    validateImagePayload: validateImagePayload,
    buildOcrRequest: buildOcrRequest,
    cleanOcrText: cleanOcrText,
    normalizeOcrResult: normalizeOcrResult,
    buildLarge4Request: buildLarge4Request,
    extractAssistantText: extractAssistantText,
    parseTolerantJson: parseTolerantJson,
    rankZones: rankZones,
    rankActionPlan: rankActionPlan,
    normalizeAndRankPlan: normalizeAndRankPlan
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RoomRescueCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
