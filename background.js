importScripts('shared.js');

const {
  MAX_LOGS,
  MAX_VIDEOS_PER_TAB,
  VIDEO_MIME_TYPES,
  detectVideoKind,
  formatSize,
  getFilename,
  getVideoKey,
  inferExtension,
  isDashUrl,
  isHlsUrl,
  isHttpUrl,
  isLikelyMediaUrl,
  isSegmentUrl,
  isTikTokVideo,
  needsRecording,
  normalizeUrl,
  safeFilename,
  sanitizeText
} = globalThis.VideoCatcherUtils;

const detectedVideos = Object.create(null);
const recordingState = Object.create(null);
const requestHeaderCache = Object.create(null);

let logsCache = null;

function loadLogs(callback) {
  if (logsCache) {
    callback(logsCache);
    return;
  }

  chrome.storage.local.get('vc_logs', (data) => {
    logsCache = Array.isArray(data.vc_logs) ? data.vc_logs : [];
    callback(logsCache);
  });
}

function vcLog(level, source, message) {
  const entry = {
    t: Date.now(),
    level: sanitizeText(level || 'info', 16),
    source: sanitizeText(source || 'bg', 16),
    msg: sanitizeText(message, 260)
  };

  loadLogs((logs) => {
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    chrome.storage.local.set({ vc_logs: logs });
  });
}

function setBadge(tabId) {
  const count = Object.keys(detectedVideos[tabId] || {}).length;
  chrome.action.setBadgeText({ text: count ? String(count) : '', tabId });
  if (count) {
    chrome.action.setBadgeBackgroundColor({ color: '#2F7DDE', tabId });
  }
}

function persistVideos(tabId) {
  const videos = Object.values(detectedVideos[tabId] || {}).sort((a, b) => b.timestamp - a.timestamp);
  chrome.storage.local.set({ [`tab_${tabId}`]: videos });
  setBadge(tabId);
}

function getRefererFromDetails(details) {
  return [details.documentUrl, details.originUrl, details.initiator]
    .find((value) => isHttpUrl(value)) || '';
}

function getPageUrlFromDetails(details) {
  return [details.documentUrl, details.originUrl, details.initiator]
    .find((value) => isHttpUrl(value)) || '';
}

function sanitizeDownloadHeaders(headers = [], referer = '') {
  const allowed = new Set(['referer', 'origin', 'accept', 'accept-language']);
  const output = [];
  const seen = new Set();

  headers.forEach((header) => {
    const name = String(header.name || '').toLowerCase();
    const value = String(header.value || '');
    if (!allowed.has(name) || !value || seen.has(name)) return;
    output.push({ name: header.name, value });
    seen.add(name);
  });

  if (referer && !seen.has('referer')) {
    output.unshift({ name: 'Referer', value: referer });
  }

  return output;
}

async function fetchSize(url) {
  if (!isHttpUrl(url)) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      credentials: 'omit',
      signal: controller.signal
    });

    const header = response.headers.get('content-length');
    return header ? Number.parseInt(header, 10) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function trimVideos(tabId) {
  const entries = Object.entries(detectedVideos[tabId] || {});
  if (entries.length <= MAX_VIDEOS_PER_TAB) return;

  entries
    .sort((a, b) => a[1].timestamp - b[1].timestamp)
    .slice(0, entries.length - MAX_VIDEOS_PER_TAB)
    .forEach(([key]) => delete detectedVideos[tabId][key]);
}

function addRecordingCandidate(tabId, pageUrl, reason = 'Video detectado en la pagina') {
  if (!Number.isInteger(tabId) || tabId < 0 || !isHttpUrl(pageUrl)) return;

  upsertVideo(tabId, pageUrl, 'recording', '', pageUrl, {
    recordOnly: true,
    isMain: true,
    source: 'recording-candidate',
    reason
  });
}

function upsertVideo(tabId, url, kind, contentType, referer = '', options = {}) {
  if (!Number.isInteger(tabId) || tabId < 0 || !isHttpUrl(url)) return;

  const normalizedUrl = normalizeUrl(url);
  const key = options.recordOnly ? `record_${tabId}_${normalizedUrl}` : getVideoKey(normalizedUrl);
  if (!normalizedUrl || !key) return;

  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.hostname.includes('googlevideo.com') && !parsed.searchParams.has('itag')) return;
  } catch {
    return;
  }

  if (!detectedVideos[tabId]) detectedVideos[tabId] = Object.create(null);

  const current = detectedVideos[tabId][key];
  const finalKind = kind || 'video';
  const finalFilename = options.filename || getFilename(normalizedUrl, contentType, finalKind);
  const finalHeaders = sanitizeDownloadHeaders(options.requestHeaders || current?.requestHeaders || [], referer);
  const entry = current || {
    url: normalizedUrl,
    filename: finalFilename,
    kind: finalKind,
    contentType: sanitizeText(contentType, 80),
    timestamp: Date.now(),
    size: null,
    referer: isHttpUrl(referer) ? referer : '',
    requestHeaders: finalHeaders,
    needsRecording: Boolean(options.recordOnly || needsRecording(normalizedUrl, finalKind)),
    recordOnly: Boolean(options.recordOnly),
    source: options.source || 'network',
    reason: sanitizeText(options.reason || '', 160),
    isMain: false,
    downloadMode: isHlsUrl(normalizedUrl, contentType) ? 'hls' : 'direct'
  };

  entry.url = normalizedUrl;
  entry.kind = finalKind || entry.kind;
  entry.contentType = sanitizeText(contentType || entry.contentType || '', 80);
  entry.referer = isHttpUrl(referer) ? referer : entry.referer || '';
  entry.requestHeaders = finalHeaders.length ? finalHeaders : entry.requestHeaders || [];
  entry.isMain = Boolean(options.isMain || entry.isMain);
  entry.recordOnly = Boolean(options.recordOnly || entry.recordOnly);
  entry.needsRecording = Boolean(entry.recordOnly || needsRecording(normalizedUrl, entry.kind));
  entry.source = options.source || entry.source || 'network';
  entry.reason = sanitizeText(options.reason || entry.reason || '', 160);
  entry.downloadMode = isHlsUrl(normalizedUrl, entry.contentType) ? 'hls' : entry.downloadMode || 'direct';
  if (options.size && !entry.size) entry.size = options.size;
  if (!current) entry.timestamp = Date.now();

  detectedVideos[tabId][key] = entry;
  trimVideos(tabId);
  persistVideos(tabId);

  if (!current) {
    vcLog('ok', 'bg', `Video detectado: ${entry.kind} ${entry.filename}`);
  }

  if (entry.kind !== 'stream' && entry.kind !== 'recording' && !entry.size && !entry.needsRecording) {
    fetchSize(entry.url).then((bytes) => {
      const formatted = formatSize(bytes);
      if (!formatted) return;

      const fresh = detectedVideos[tabId]?.[key];
      if (!fresh || fresh.size) return;

      fresh.size = formatted;
      persistVideos(tabId);
      vcLog('info', 'bg', `Tamano detectado: ${fresh.filename} ${formatted}`);
    });
  }
}

function updateSizeFromHeaders(tabId, url, contentLength) {
  const key = getVideoKey(url);
  const formatted = formatSize(Number.parseInt(contentLength, 10));
  if (!key || !formatted || !detectedVideos[tabId]?.[key]) return;

  const entry = detectedVideos[tabId][key];
  if (!entry.size) {
    entry.size = formatted;
    persistVideos(tabId);
  }
}

function clearTabState(tabId, options = {}) {
  delete detectedVideos[tabId];
  if (!options.keepRecording) delete recordingState[tabId];
  Object.keys(requestHeaderCache)
    .filter((key) => key.startsWith(`${tabId}:`))
    .forEach((key) => delete requestHeaderCache[key]);
  chrome.storage.local.remove(`tab_${tabId}`);
  chrome.action.setBadgeText({ text: '', tabId });
}

function getActiveTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    callback(tabs[0] || null);
  });
}

function downloadViaChrome(url, filename, referer, requestHeaders, callback) {
  chrome.downloads.download(
    {
      url,
      filename: safeFilename(filename, 'video', 'mp4'),
      saveAs: true,
      headers: sanitizeDownloadHeaders(requestHeaders, referer)
    },
    (downloadId) => {
      if (!chrome.runtime.lastError && downloadId) {
        callback({ ok: true, downloadId, mode: 'downloads' });
        return;
      }

      callback({
        ok: false,
        error: chrome.runtime.lastError?.message || 'download failed'
      });
    }
  );
}

function downloadViaContent(tabId, action, payload, callback) {
  chrome.tabs.sendMessage(
    tabId,
    { action, ...payload },
    (response) => {
      if (!chrome.runtime.lastError && response?.ok) {
        callback({ ok: true, mode: 'content' });
        return;
      }

      callback({
        ok: false,
        error: response?.error || chrome.runtime.lastError?.message || 'content download failed'
      });
    }
  );
}

function cacheRequestHeaders(details) {
  if (details.tabId < 0 || !isHttpUrl(details.url)) return;

  const kind = detectVideoKind(details.url) || (isLikelyMediaUrl(details.url) ? 'video' : null);
  if (!kind) return;

  const key = getVideoKey(details.url);
  if (!key) return;

  requestHeaderCache[`${details.tabId}:${key}`] = {
    headers: sanitizeDownloadHeaders(details.requestHeaders || [], getRefererFromDetails(details)),
    pageUrl: getPageUrlFromDetails(details),
    t: Date.now()
  };
}

function getCachedRequest(tabId, url) {
  const key = getVideoKey(url);
  if (!key) return null;

  const cached = requestHeaderCache[`${tabId}:${key}`];
  if (!cached) return null;

  if (Date.now() - cached.t > 10 * 60 * 1000) {
    delete requestHeaderCache[`${tabId}:${key}`];
    return null;
  }

  return cached;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  cacheRequestHeaders,
  { urls: ['http://*/*', 'https://*/*'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !isHttpUrl(details.url)) return;

    const referer = getRefererFromDetails(details);

    if (details.type === 'main_frame' && isTikTokVideo(details.url)) {
      upsertVideo(details.tabId, details.url, 'video', '', referer);
      return;
    }

    if (!['xmlhttprequest', 'media', 'other', 'object'].includes(details.type)) return;

    const kind = detectVideoKind(details.url);
    if (!kind) return;

    if (kind === 'segment') {
      addRecordingCandidate(details.tabId, getPageUrlFromDetails(details), 'Segmentos de video detectados');
      return;
    }

    const cached = getCachedRequest(details.tabId, details.url);
    upsertVideo(details.tabId, details.url, kind, '', referer, {
      requestHeaders: cached?.headers || []
    });
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || !isHttpUrl(details.url)) return;

    if ([301, 302, 303, 307, 308].includes(details.statusCode) && isTikTokVideo(details.url)) {
      const location = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'location')?.value;
      if (location) {
        const targetUrl = new URL(location, details.url).toString();
        upsertVideo(details.tabId, targetUrl, 'video', '', getRefererFromDetails(details));
      }
      return;
    }

    const contentType = (
      details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-type')?.value || ''
    ).toLowerCase();
    const contentLength = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-length')?.value;

    const kind = detectVideoKind(details.url, contentType);
    if (!kind) return;
    if (!VIDEO_MIME_TYPES.some((prefix) => contentType.includes(prefix)) && !isLikelyMediaUrl(details.url, contentType)) return;
    if (kind === 'video' && !isTikTokVideo(details.url) && contentLength && Number.parseInt(contentLength, 10) < 100000) return;

    if (kind === 'segment') {
      addRecordingCandidate(details.tabId, getPageUrlFromDetails(details), 'Segmentos de video detectados');
      return;
    }

    const cached = getCachedRequest(details.tabId, details.url);
    upsertVideo(details.tabId, details.url, kind, contentType, getRefererFromDetails(details), {
      requestHeaders: cached?.headers || [],
      size: formatSize(Number.parseInt(contentLength || '', 10))
    });

    if (contentLength) {
      updateSizeFromHeaders(details.tabId, normalizeUrl(details.url), contentLength);
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders']
);

chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId === 0) clearTabState(details.tabId);
  },
  { url: [{ schemes: ['http', 'https'] }] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'vcLog') {
    vcLog(message.level || 'info', message.source || 'content', message.msg || '');
    return;
  }

  if (message.action === 'getVideos') {
    getActiveTab((tab) => {
      if (!tab) {
        sendResponse({ videos: [] });
        return;
      }

      chrome.storage.local.get(`tab_${tab.id}`, (data) => {
        sendResponse({ videos: data[`tab_${tab.id}`] || [] });
      });
    });
    return true;
  }

  if (message.action === 'addVideosFromDom') {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId) || !Array.isArray(message.videos)) return;

    message.videos.forEach((video) => {
      const url = normalizeUrl(video.url);
      if (!url) return;

      if (video.recordOnly) {
        upsertVideo(tabId, url, 'recording', '', url, {
          recordOnly: true,
          isMain: Boolean(video.isMain),
          filename: video.filename,
          source: video.source || 'dom',
          reason: video.reason || 'Video reproducible detectado'
        });
        return;
      }

      const kind = detectVideoKind(url, video.contentType || '') || video.kind || 'video';
      if (!kind || kind === 'segment') {
        addRecordingCandidate(tabId, sender.tab?.url || url, 'Segmentos de video detectados');
        return;
      }

      upsertVideo(tabId, url, kind, video.contentType || '', '', {
        isMain: Boolean(video.isMain)
      });
    });
    return;
  }

  if (message.action === 'clearVideos') {
    const explicitTabId = Number.isInteger(message.tabId) ? message.tabId : null;
    if (explicitTabId !== null) {
      clearTabState(explicitTabId, { keepRecording: true });
      sendResponse({ ok: true });
      return true;
    }

    getActiveTab((tab) => {
      if (tab) clearTabState(tab.id, { keepRecording: true });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'downloadVideo') {
    const url = normalizeUrl(message.url);
    const fallbackExt = inferExtension(message.url || '', message.contentType || '', message.kind || 'video');
    const filename = safeFilename(message.filename, 'video', fallbackExt);
    const referer = isHttpUrl(message.referer) ? message.referer : '';
    const tabId = Number.isInteger(message.tabId)
      ? message.tabId
      : Number.isInteger(sender.tab?.id)
        ? sender.tab.id
        : null;
    const requestHeaders = sanitizeDownloadHeaders(message.requestHeaders || [], referer);

    if (!url) {
      sendResponse({ ok: false, error: 'invalid url' });
      return true;
    }

    if (message.recordOnly || isDashUrl(url, message.contentType || '')) {
      sendResponse({ ok: false, error: 'Este recurso requiere grabacion; no expone un archivo directo descargable.' });
      return true;
    }

    vcLog('info', 'bg', `Descarga iniciada: ${filename}`);

    if (isHlsUrl(url, message.contentType || '')) {
      if (tabId === null) {
        sendResponse({ ok: false, error: 'missing tabId for HLS download' });
        return;
      }

      downloadViaContent(
        tabId,
        'downloadHls',
        {
          url,
          filename,
          referer,
          requestHeaders
        },
        (hlsResult) => {
          if (hlsResult.ok) {
            vcLog('ok', 'bg', `Descarga HLS OK: ${filename}`);
            sendResponse(hlsResult);
            return;
          }

          vcLog('error', 'bg', `Descarga HLS fallida: ${hlsResult.error}`);
          sendResponse(hlsResult);
        }
      );
      return true;
    }

    downloadViaChrome(url, filename, referer, requestHeaders, (downloadResult) => {
      if (downloadResult.ok) {
        vcLog('ok', 'bg', `Descarga OK via chrome.downloads: ${filename}`);
        sendResponse(downloadResult);
        return;
      }

      if (tabId === null) {
        vcLog('error', 'bg', `Descarga fallida: ${downloadResult.error}`);
        sendResponse(downloadResult);
        return;
      }

      vcLog('warn', 'bg', `chrome.downloads fallo, usando fetch del content script`);
      downloadViaContent(tabId, 'fetchAndDownload', { url, filename, referer, requestHeaders }, (fallbackResult) => {
        if (fallbackResult.ok) {
          vcLog('ok', 'bg', `Descarga OK via content script: ${filename}`);
          sendResponse(fallbackResult);
          return;
        }

        vcLog('error', 'bg', `Descarga fallida: ${fallbackResult.error}`);
        sendResponse(fallbackResult);
      });
    });

    return true;
  }

  if (message.action === 'startRecording') {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : null;
    if (tabId === null) {
      sendResponse({ ok: false, error: 'missing tabId' });
      return true;
    }

    const filename = safeFilename(message.filename, 'video_recording', 'webm');
    recordingState[tabId] = {
      isRecording: true,
      progress: 0,
      elapsed: 0,
      filename
    };

    vcLog('info', 'bg', `Grabacion iniciada: ${filename}`);

    chrome.tabs.sendMessage(tabId, { action: 'startRecording', filename }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        delete recordingState[tabId];
        const error = response?.error || chrome.runtime.lastError?.message || 'recording failed';
        vcLog('error', 'bg', `Error al iniciar grabacion: ${error}`);
        sendResponse({ ok: false, error });
        return;
      }

      vcLog('ok', 'bg', 'MediaRecorder activo');
      sendResponse({ ok: true });
    });

    return true;
  }

  if (message.action === 'stopRecording') {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : null;
    if (tabId === null) {
      sendResponse({ ok: false, error: 'missing tabId' });
      return true;
    }

    chrome.tabs.sendMessage(tabId, { action: 'stopRecording' }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'recordingProgress') {
    const tabId = sender.tab?.id;
    if (Number.isInteger(tabId) && recordingState[tabId]) {
      recordingState[tabId].progress = Number(message.progress) || 0;
      recordingState[tabId].elapsed = Number(message.elapsed) || 0;
    }
    return;
  }

  if (message.action === 'recordingDone') {
    const tabId = sender.tab?.id;
    if (Number.isInteger(tabId)) delete recordingState[tabId];
    return;
  }

  if (message.action === 'getRecordingState') {
    getActiveTab((tab) => {
      sendResponse(tab ? recordingState[tab.id] || null : null);
    });
    return true;
  }
});
