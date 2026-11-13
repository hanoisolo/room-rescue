(function (root) {
  'use strict';

  var storage = (typeof module === 'object' && module.exports) ? require('./storage.js') : root.RoomRescueStorage;

  var EXPORT_VERSION = 1;

  function exportError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  function asText(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  function minutesOf(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n);
  }

  // A plain Markdown checklist pastes straight into Notes, Notion, or Obsidian,
  // which is what people actually use when they walk into the room.
  function formatPlanAsMarkdown(plan, checkedMap) {
    var source = plan && typeof plan === 'object' ? plan : {};
    var checked = checkedMap && typeof checkedMap === 'object' ? checkedMap : {};
    var steps = Array.isArray(source.action_plan) ? source.action_plan : [];
    var lines = [];

    lines.push('# Room Rescue — ' + asText(source.room_type, 'Room'));
    lines.push('');

    var stats = [];
    if (asText(source.clutter_level, '')) stats.push('Clutter level: ' + source.clutter_level);
    var total = 0;
    for (var i = 0; i < steps.length; i++) total += minutesOf(steps[i] && steps[i].estimated_minutes);
    if (steps.length) stats.push('Total effort: ' + total + ' min');
    if (stats.length) {
      lines.push(stats.join(' · '));
      lines.push('');
    }

    if (asText(source.summary, '')) {
      lines.push('## Summary');
      lines.push(source.summary);
      lines.push('');
    }

    var quickWin = source.quick_win && typeof source.quick_win === 'object' ? source.quick_win : null;
    if (quickWin && asText(quickWin.title, '')) {
      lines.push('## Start here — your 5-minute win');
      var quickMinutes = minutesOf(quickWin.estimated_minutes);
      lines.push('- ' + quickWin.title + (quickMinutes ? ' (' + quickMinutes + ' min)' : ''));
      if (asText(quickWin.why_first, '')) lines.push('  ' + quickWin.why_first);
      lines.push('');
    }

    lines.push('## Checklist');
    if (!steps.length) {
      lines.push('- [ ] No action steps were returned.');
    } else {
      for (var j = 0; j < steps.length; j++) {
        var step = steps[j] || {};
        var id = typeof step.step_id === 'string' ? step.step_id : '';
        var box = id && checked[id] ? '- [x]' : '- [ ]';
        var meta = [];
        var stepMinutes = minutesOf(step.estimated_minutes);
        if (stepMinutes) meta.push(stepMinutes + ' min');
        if (asText(step.priority, '')) meta.push(step.priority);
        lines.push(box + ' ' + asText(step.action, 'Untitled step') + (meta.length ? ' (' + meta.join(' · ') + ')' : ''));
      }
    }
    lines.push('');

    var zones = Array.isArray(source.zones) ? source.zones : [];
    if (zones.length) {
      lines.push('## Zones');
      for (var k = 0; k < zones.length; k++) {
        var zone = zones[k] || {};
        var priority = asText(zone.priority, '');
        lines.push('### ' + asText(zone.name, 'Zone ' + (k + 1)) + (priority ? ' — ' + priority : ''));
        if (asText(zone.observation, '')) lines.push(zone.observation);
        if (asText(zone.goal_state, '')) lines.push('Goal: ' + zone.goal_state);
        lines.push('');
      }
    }

    var items = Array.isArray(source.items) ? source.items : [];
    if (items.length) {
      lines.push('## Items to deal with');
      for (var m = 0; m < items.length; m++) {
        var item = items[m] || {};
        var disposition = asText(item.disposition, '').replace(/_/g, ' ');
        var suggestion = asText(item.suggestion, '');
        lines.push('- **' + asText(item.name, 'Unnamed item') + '**' +
          (disposition ? ' — ' + disposition : '') +
          (suggestion ? ': ' + suggestion : ''));
      }
      lines.push('');
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function serializeSessionForExport(session) {
    var valid = storage.validateSessionObject(session);
    return JSON.stringify({
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      session: valid
    }, null, 2);
  }

  function parseImportedSessionJson(jsonText) {
    if (typeof jsonText !== 'string' || !jsonText.trim()) {
      throw exportError('INVALID_IMPORT', 'That file is empty.');
    }

    var parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw exportError('INVALID_IMPORT', 'That file is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw exportError('INVALID_IMPORT', 'That file does not contain a room session.');
    }

    var candidate = parsed;
    if (Object.prototype.hasOwnProperty.call(parsed, 'session')) {
      if (parsed.version !== undefined && parsed.version !== EXPORT_VERSION) {
        throw exportError('INVALID_IMPORT', 'That file was exported by a different version of Room Rescue.');
      }
      candidate = parsed.session;
    }

    try {
      return storage.validateSessionObject(candidate);
    } catch (err) {
      throw exportError('INVALID_IMPORT', 'That file does not contain a valid room session.');
    }
  }

  function resolveClipboard(clipboardImpl) {
    if (clipboardImpl) return clipboardImpl;
    if (typeof navigator !== 'undefined' && navigator && navigator.clipboard) return navigator.clipboard;
    return null;
  }

  function copyTextToClipboard(text, clipboardImpl) {
    var clipboard = resolveClipboard(clipboardImpl);
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      return Promise.reject(exportError('CLIPBOARD_UNAVAILABLE', 'This browser cannot copy to the clipboard.'));
    }
    return Promise.resolve()
      .then(function () { return clipboard.writeText(String(text)); })
      .then(function () { return true; })
      .catch(function (err) {
        if (err && err.code) throw err;
        throw exportError('CLIPBOARD_UNAVAILABLE', 'The clipboard refused the copy.');
      });
  }

  function downloadTextFile(filename, content, mimeType, env) {
    var source = env || {};
    if (typeof source.downloadImpl === 'function') {
      source.downloadImpl(filename, content, mimeType);
      return true;
    }
    if (typeof document === 'undefined' || typeof Blob === 'undefined' ||
        typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return false;
    }

    var blob = new Blob([content], { type: mimeType || 'text/plain' });
    var href = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = href;
    link.download = filename;
    if (typeof link.click === 'function') link.click();
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(href);
    return true;
  }

  var api = {
    EXPORT_VERSION: EXPORT_VERSION,
    formatPlanAsMarkdown: formatPlanAsMarkdown,
    serializeSessionForExport: serializeSessionForExport,
    parseImportedSessionJson: parseImportedSessionJson,
    copyTextToClipboard: copyTextToClipboard,
    downloadTextFile: downloadTextFile
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RoomRescueExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
