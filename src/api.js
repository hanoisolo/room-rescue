(function (root) {
  'use strict';

  var core = (typeof module === 'object' && module.exports) ? require('./core.js') : root.RoomRescueCore;

  var ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

  class RoomRescueError extends Error {
    constructor(code, userMessage, status, cause) {
      super(userMessage);
      this.name = 'RoomRescueError';
      this.code = code;
      this.userMessage = userMessage;
      this.status = typeof status === 'number' ? status : null;
      if (cause) this.cause = cause;
    }
  }

  function defaultFetch(url, init) {
    if (typeof fetch !== 'function') {
      return Promise.reject(new RoomRescueError('NETWORK_ERROR', 'This browser cannot reach the Mistral API.'));
    }
    return fetch(url, init);
  }

  function safeFetch(doFetch, url, init) {
    return Promise.resolve()
      .then(function () { return doFetch(url, init); })
      .catch(function (err) {
        if (err instanceof RoomRescueError) throw err;
        throw new RoomRescueError('NETWORK_ERROR', 'Could not reach the Mistral API. Check your connection and try again.', null, err);
      });
  }

  function resolveStorage(storage) {
    if (storage) return storage;
    if (typeof localStorage !== 'undefined') return localStorage;
    return null;
  }

  function loadMistralKey(storage) {
    var store = resolveStorage(storage);
    if (!store) return '';
    try {
      var value = store.getItem(core.STORAGE_KEY_NAME);
      return typeof value === 'string' ? value : '';
    } catch (err) {
      return '';
    }
  }

  function saveMistralKey(key, storage) {
    var trimmed = typeof key === 'string' ? key.trim() : '';
    if (!trimmed) {
      throw new RoomRescueError('MISSING_KEY', 'Paste your Mistral API key first.');
    }
    var store = resolveStorage(storage);
    if (store) {
      try { store.setItem(core.STORAGE_KEY_NAME, trimmed); } catch (err) { /* storage may be unavailable */ }
    }
    return trimmed;
  }

  function clearMistralKey(storage) {
    var store = resolveStorage(storage);
    if (store) {
      try { store.removeItem(core.STORAGE_KEY_NAME); } catch (err) { /* storage may be unavailable */ }
    }
    return '';
  }

  function validateRawFile(file, maxRawBytes) {
    var ceiling = typeof maxRawBytes === 'number' && maxRawBytes > 0 ? maxRawBytes : core.MAX_RAW_FILE_BYTES;
    if (!file || typeof file !== 'object') {
      throw new RoomRescueError('UNSUPPORTED_IMAGE', 'Choose a photo of the room first.');
    }
    var type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
    if (ALLOWED_MIME.indexOf(type) === -1) {
      throw new RoomRescueError('UNSUPPORTED_IMAGE', 'That file type is not supported. Use a JPEG, PNG, or WebP photo.');
    }
    var size = Number(file.size);
    if (isFinite(size) && size > ceiling) {
      throw new RoomRescueError('IMAGE_TOO_LARGE', 'That photo is ' + Math.round(size / 1048576) + ' MB. Use one under ' + Math.round(ceiling / 1048576) + ' MB.');
    }
    return { type: type, size: isFinite(size) ? size : 0 };
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      if (typeof FileReader === 'undefined') {
        reject(new RoomRescueError('UNSUPPORTED_IMAGE', 'This browser cannot read local files.'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(new RoomRescueError('UNSUPPORTED_IMAGE', 'That photo could not be read. Try another file.')); };
      reader.readAsDataURL(file);
    });
  }

  function createImageElement(dataUrl) {
    return new Promise(function (resolve, reject) {
      if (typeof Image === 'undefined') {
        reject(new RoomRescueError('UNSUPPORTED_IMAGE', 'This browser cannot decode images.'));
        return;
      }
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new RoomRescueError('UNSUPPORTED_IMAGE', 'That photo could not be decoded. Try a JPEG, PNG, or WebP file.')); };
      image.src = dataUrl;
    });
  }

  function createCanvasElement(width, height) {
    if (typeof document === 'undefined') {
      throw new RoomRescueError('UNSUPPORTED_IMAGE', 'This browser cannot resize images.');
    }
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function downscaleImageFile(file, envDeps) {
    var deps = envDeps || {};
    var readFile = deps.readFile || readFileAsDataUrl;
    var createImage = deps.createImage || createImageElement;
    var createCanvas = deps.createCanvas || createCanvasElement;
    var maxEdge = deps.maxEdge || core.IMAGE_MAX_EDGE_PX;
    var quality = typeof deps.quality === 'number' ? deps.quality : core.IMAGE_JPEG_QUALITY;
    var fallbackQuality = typeof deps.fallbackQuality === 'number' ? deps.fallbackQuality : core.IMAGE_JPEG_FALLBACK_QUALITY;
    var maxBytes = deps.maxBytes || core.MAX_PAYLOAD_BYTES;
    var maxRawBytes = deps.maxRawBytes || core.MAX_RAW_FILE_BYTES;

    return Promise.resolve()
      .then(function () {
        // Reject the wrong type or an oversized file before FileReader touches it.
        validateRawFile(file, maxRawBytes);
        return readFile(file);
      })
      .then(function (sourceDataUrl) {
      return Promise.resolve(createImage(sourceDataUrl)).then(function (image) {
        var dims = core.computeDownscaleDimensions(image.width, image.height, maxEdge);
        var canvas = createCanvas(dims.width, dims.height);
        var context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, dims.width, dims.height);
        context.drawImage(image, 0, 0, dims.width, dims.height);

        var dataUrl = canvas.toDataURL('image/jpeg', quality);
        try {
          core.validateImagePayload(dataUrl, maxBytes);
        } catch (err) {
          dataUrl = canvas.toDataURL('image/jpeg', fallbackQuality);
          core.validateImagePayload(dataUrl, maxBytes);
        }

        return {
          dataUrl: dataUrl,
          width: dims.width,
          height: dims.height,
          wasDownscaled: dims.wasDownscaled
        };
      });
    });
  }

  function extractErrorMessage(body) {
    if (!body || typeof body !== 'object') return '';
    if (typeof body.message === 'string' && body.message) return body.message;
    if (body.error && typeof body.error.message === 'string' && body.error.message) return body.error.message;
    return '';
  }

  function mapHttpError(status, responseBody, retryAfterHeader) {
    var detail = extractErrorMessage(responseBody);
    if (status === 401 || status === 403) {
      return new RoomRescueError('AUTH_INVALID', 'Mistral rejected that API key. Check it in your Mistral console and paste it again.', status);
    }
    if (status === 429) {
      var wait = retryAfterHeader ? ' Try again in ' + retryAfterHeader + ' seconds.' : ' Wait a moment and try again.';
      return new RoomRescueError('RATE_LIMITED', 'Mistral is rate limiting this key.' + wait, status);
    }
    return new RoomRescueError('API_ERROR', 'Mistral returned an error' + (detail ? ': ' + detail : '.'), status);
  }

  function readJsonResponse(response) {
    var status = response && typeof response.status === 'number' ? response.status : 0;
    var retryAfter = null;
    if (response && response.headers && typeof response.headers.get === 'function') {
      retryAfter = response.headers.get('retry-after');
    }
    return Promise.resolve()
      .then(function () { return response.json(); })
      .catch(function () { return null; })
      .then(function (body) {
        if (!response || response.ok === false || status >= 400) {
          throw mapHttpError(status, body, retryAfter);
        }
        return body;
      });
  }

  function authHeaders(mistralKey) {
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + mistralKey
    };
  }

  function callMistralOcr(imageDataUrl, mistralKey, fetchImpl) {
    if (!mistralKey) {
      return Promise.reject(new RoomRescueError('MISSING_KEY', 'Paste your Mistral API key to analyze a room.'));
    }
    var doFetch = fetchImpl || defaultFetch;
    var body = core.buildOcrRequest(imageDataUrl);
    return safeFetch(doFetch, core.MISTRAL_OCR_ENDPOINT, {
      method: 'POST',
      headers: authHeaders(mistralKey),
      body: JSON.stringify(body)
    }).then(readJsonResponse);
  }

  function callMistralLarge4(imageDataUrl, ocrSummary, roomHint, mistralKey, fetchImpl) {
    if (!mistralKey) {
      return Promise.reject(new RoomRescueError('MISSING_KEY', 'Paste your Mistral API key to analyze a room.'));
    }
    var doFetch = fetchImpl || defaultFetch;

    function send(mode) {
      var body = core.buildLarge4Request(imageDataUrl, ocrSummary, roomHint, { responseFormatMode: mode });
      return safeFetch(doFetch, core.MISTRAL_CHAT_ENDPOINT, {
        method: 'POST',
        headers: authHeaders(mistralKey),
        body: JSON.stringify(body)
      }).then(readJsonResponse).catch(function (err) {
        var schemaRejected = err instanceof RoomRescueError && (err.status === 400 || err.status === 422);
        if (mode === 'json_schema' && schemaRejected) return send('json_object');
        throw err;
      });
    }

    return send('json_schema');
  }

  function analyzeRoomPhoto(options) {
    var opts = options || {};
    var mistralKey = opts.mistralKey;
    var fetchImpl = opts.fetchImpl;
    var onStage = typeof opts.onStage === 'function' ? opts.onStage : function () {};
    var downscaleImpl = opts.downscaleImpl || downscaleImageFile;
    var maxPayloadBytes = typeof opts.maxPayloadBytes === 'number' && opts.maxPayloadBytes > 0
      ? opts.maxPayloadBytes
      : core.MAX_PAYLOAD_BYTES;

    if (!mistralKey) {
      return Promise.reject(new RoomRescueError('MISSING_KEY', 'Paste your Mistral API key to analyze a room.'));
    }

    var imagePromise;
    if (typeof opts.imageDataUrl === 'string' && opts.imageDataUrl) {
      imagePromise = Promise.resolve({ dataUrl: opts.imageDataUrl, wasDownscaled: false });
    } else if (opts.file) {
      onStage('downscaling');
      imagePromise = Promise.resolve()
        .then(function () {
          validateRawFile(opts.file, opts.maxRawBytes);
          return downscaleImpl(opts.file, opts.downscaleDeps);
        })
        .then(function (result) {
          return { dataUrl: result.dataUrl, wasDownscaled: Boolean(result.wasDownscaled) };
        });
    } else {
      return Promise.reject(new RoomRescueError('UNSUPPORTED_IMAGE', 'Choose a photo of the room first.'));
    }

    return imagePromise.then(function (image) {
      core.validateImagePayload(image.dataUrl, maxPayloadBytes);
      onStage('ocr');

      return callMistralOcr(image.dataUrl, mistralKey, fetchImpl)
        .then(function (ocrResponse) { return core.normalizeOcrResult(ocrResponse); })
        .catch(function (err) {
          var fatal = err instanceof RoomRescueError &&
            (err.code === 'AUTH_INVALID' || err.code === 'RATE_LIMITED' || err.code === 'NETWORK_ERROR' || err.code === 'MISSING_KEY');
          if (fatal) throw err;
          return { hasText: false, status: 'ocr_unavailable', cleanedText: '', lineCount: 0, pageConfidence: null };
        })
        .then(function (ocrSummary) {
          onStage('vision');
          return callMistralLarge4(image.dataUrl, ocrSummary, opts.roomHint, mistralKey, fetchImpl)
            .then(function (chatResponse) {
              var text = core.extractAssistantText(chatResponse);
              var raw = core.parseTolerantJson(text);
              onStage('done');
              return core.normalizeAndRankPlan(raw, ocrSummary, { isDemo: false });
            });
        });
    });
  }

  var api = {
    RoomRescueError: RoomRescueError,
    loadMistralKey: loadMistralKey,
    saveMistralKey: saveMistralKey,
    clearMistralKey: clearMistralKey,
    validateRawFile: validateRawFile,
    downscaleImageFile: downscaleImageFile,
    mapHttpError: mapHttpError,
    callMistralOcr: callMistralOcr,
    callMistralLarge4: callMistralLarge4,
    analyzeRoomPhoto: analyzeRoomPhoto
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RoomRescueApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
