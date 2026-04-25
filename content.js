const {
  detectVideoKind,
  inferExtension,
  isHlsUrl,
  isHttpUrl,
  isLikelyMediaUrl,
  normalizeUrl,
  safeFilename,
  sanitizeText
} = globalThis.VideoCatcherUtils;

const previewStorage = chrome.storage.session || chrome.storage.local;
const DOM_SCAN_DELAY_MS = 180;
const PREVIEW_MAX_BYTES = 1024 * 1024;

let activeRecorder = null;
let recordedChunks = [];
let recordingStart = null;
let progressTimer = null;

const reportedDomUrls = new Set();
const reportedRecordOnlyUrls = new Set();
const scannedScripts = new WeakSet();
let pendingScanNodes = new Set();
let scanTimer = null;
let observerStarted = false;
let performanceObserverStarted = false;

function vcLog(level, message) {
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({
      action: 'vcLog',
      level,
      source: 'content',
      msg: sanitizeText(message, 240)
    });
  } catch {}
}

function storageSet(key, value) {
  return new Promise((resolve) => previewStorage.set({ [key]: value }, resolve));
}

function storageRemove(key) {
  return new Promise((resolve) => previewStorage.remove(key, resolve));
}

async function fetchPreviewChunk(url, referer) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    referrer: referer || location.href,
    referrerPolicy: 'strict-origin-when-cross-origin',
    headers: {
      Range: `bytes=0-${PREVIEW_MAX_BYTES - 1}`
    }
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}`);
  }

  const blob = await response.blob();
  const limitedBlob = blob.size > PREVIEW_MAX_BYTES ? blob.slice(0, PREVIEW_MAX_BYTES, blob.type) : blob;

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('preview read failed'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(limitedBlob);
  });
}

function fetchWithReferrer(url, options = {}) {
  return fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    referrer: options.referer || location.href,
    referrerPolicy: 'strict-origin-when-cross-origin',
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });
}

function downloadBlob(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
}

async function fetchTextResource(url, referer) {
  const response = await fetchWithReferrer(url, { referer });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchBlobResource(url, referer) {
  const response = await fetchWithReferrer(url, { referer });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

function parseHlsAttributes(value) {
  const attrs = {};
  String(value || '').replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi, (match, key, rawValue) => {
    attrs[key.toUpperCase()] = rawValue.replace(/^"|"$/g, '');
    return match;
  });
  return attrs;
}

function resolveHlsUrl(value, baseUrl) {
  return new URL(value.trim().replace(/^"|"$/g, ''), baseUrl).toString();
}

function selectHlsPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;

    const attrs = parseHlsAttributes(lines[index].slice('#EXT-X-STREAM-INF:'.length));
    const nextLine = lines.slice(index + 1).find((line) => line && !line.startsWith('#'));
    if (!nextLine) continue;

    variants.push({
      url: resolveHlsUrl(nextLine, baseUrl),
      bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0)
    });
  }

  if (!variants.length) return null;
  return variants.sort((left, right) => right.bandwidth - left.bandwidth)[0].url;
}

function parseHlsSegments(text, baseUrl) {
  const encrypted = text
    .split(/\r?\n/)
    .some((line) => line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/i.test(line));

  if (encrypted) {
    throw new Error('HLS cifrado no soportado');
  }

  const segments = [];
  const mapLine = text.split(/\r?\n/).find((line) => line.startsWith('#EXT-X-MAP:'));

  if (mapLine) {
    const attrs = parseHlsAttributes(mapLine.slice('#EXT-X-MAP:'.length));
    if (attrs.URI) segments.push(resolveHlsUrl(attrs.URI, baseUrl));
  }

  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    segments.push(resolveHlsUrl(line, baseUrl));
  });

  return {
    segments,
    outputExt: mapLine ? 'mp4' : 'ts'
  };
}

async function downloadHls(url, filename, referer) {
  let playlistUrl = url;
  let playlistText = await fetchTextResource(playlistUrl, referer);
  const selectedVariant = selectHlsPlaylist(playlistText, playlistUrl);

  if (selectedVariant) {
    playlistUrl = selectedVariant;
    playlistText = await fetchTextResource(playlistUrl, referer);
  }

  const { segments, outputExt } = parseHlsSegments(playlistText, playlistUrl);
  if (!segments.length) throw new Error('Playlist HLS sin segmentos');

  const parts = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (index % 25 === 0) vcLog('info', `HLS: descargando segmento ${index + 1}/${segments.length}`);
    parts.push(await fetchBlobResource(segments[index], referer));
  }

  const type = outputExt === 'mp4' ? 'video/mp4' : 'video/mp2t';
  const baseName = String(filename || 'video').replace(/\.[^.]+$/, '');
  downloadBlob(new Blob(parts, { type }), safeFilename(baseName, 'video', outputExt));
}

function findMainVideo() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (!videos.length) return null;

  return videos.sort((left, right) => {
    const score = (video) =>
      (!video.paused ? 1000 : 0) +
      ((video.currentTime || 0) > 0 ? 100 : 0) +
      (video.videoWidth || 0) +
      (video.clientWidth || 0);
    return score(right) - score(left);
  })[0];
}

async function fixWebMDuration(blob, durationMs) {
  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    function readVint(position) {
      let firstByte = bytes[position];
      let mask = 0x80;
      let width = 1;

      while (width <= 8 && !(firstByte & mask)) {
        mask >>= 1;
        width += 1;
      }

      let value = firstByte ^ mask;
      for (let index = 1; index < width; index += 1) value = (value * 256) + bytes[position + index];
      return { value, width };
    }

    function encodeVint(value, width) {
      const output = new Uint8Array(width);
      const marker = 1 << (8 - width);
      let rest = value;

      for (let index = width - 1; index > 0; index -= 1) {
        output[index] = rest & 0xff;
        rest >>>= 8;
      }

      output[0] = rest | marker;
      return output;
    }

    function findSequence(pattern, from, to) {
      outer: for (let index = from; index <= to - pattern.length; index += 1) {
        for (let offset = 0; offset < pattern.length; offset += 1) {
          if (bytes[index + offset] !== pattern[offset]) continue outer;
        }
        return index;
      }
      return -1;
    }

    const limit = Math.min(bytes.length, 8000);
    const durationPosition = findSequence([0x44, 0x89], 0, limit);

    if (durationPosition >= 0) {
      const size = readVint(durationPosition + 2);
      if (size.value === 8) {
        new DataView(buffer).setFloat64(durationPosition + 2 + size.width, durationMs, false);
        return new Blob([buffer], { type: blob.type });
      }
    }

    const infoPosition = findSequence([0x15, 0x49, 0xa9, 0x66], 0, limit);
    if (infoPosition < 0) return blob;

    const infoSize = readVint(infoPosition + 4);
    const updatedInfoSize = encodeVint(infoSize.value + 11, infoSize.width);
    const durationElement = new Uint8Array(11);

    durationElement[0] = 0x44;
    durationElement[1] = 0x89;
    durationElement[2] = 0x88;
    new DataView(durationElement.buffer).setFloat64(3, durationMs, false);

    const insertAt = infoPosition + 4 + infoSize.width;

    return new Blob(
      [
        buffer.slice(0, infoPosition + 4),
        updatedInfoSize,
        durationElement,
        buffer.slice(insertAt)
      ],
      { type: blob.type }
    );
  } catch (error) {
    vcLog('warn', `No se pudo corregir la duracion del WebM: ${error.message}`);
    return blob;
  }
}

function sendDomVideos(videos) {
  if (!videos.length) return;

  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ action: 'addVideosFromDom', videos });
  } catch {}
}

function pushRecordingCandidate(results, reason = 'Video reproducible detectado', isMain = true) {
  const pageUrl = normalizeUrl(location.href);
  if (!pageUrl || reportedRecordOnlyUrls.has(pageUrl)) return;

  reportedRecordOnlyUrls.add(pageUrl);
  results.push({
    url: pageUrl,
    kind: 'recording',
    recordOnly: true,
    isMain,
    filename: sanitizeText(document.title || 'video_recording', 120),
    source: 'dom',
    reason
  });
}

function pushResult(results, url, kind, isMain = false) {
  const normalized = normalizeUrl(url);
  const detectedKind = detectVideoKind(normalized) || kind;
  if (!normalized || !detectedKind || reportedDomUrls.has(normalized)) return;

  if (detectedKind === 'segment') {
    pushRecordingCandidate(results, 'Segmentos de video detectados', isMain);
    return;
  }

  if (reportedDomUrls.size > 2000) reportedDomUrls.clear();
  reportedDomUrls.add(normalized);
  results.push({ url: normalized, kind: detectedKind, isMain: Boolean(isMain) });
}

function collectFromVideo(video, results) {
  const sources = [video.currentSrc, video.src];
  video.querySelectorAll('source[src]').forEach((source) => sources.push(source.src));

  const isMain = !video.paused || (video.currentTime || 0) > 0;
  let foundHttpSource = false;

  sources.filter(Boolean).forEach((source) => {
    if (!isHttpUrl(source)) {
      if (/^(blob|mediastream):/i.test(source)) pushRecordingCandidate(results, 'Video blob/MSE detectado', isMain);
      return;
    }

    foundHttpSource = true;
    pushResult(results, source, 'video', isMain);
  });

  if (!foundHttpSource && (video.srcObject || video.readyState > 0 || video.videoWidth || video.clientWidth > 240)) {
    pushRecordingCandidate(results, 'Video sin URL directa detectado', isMain);
  }
}

function collectFromAnchor(anchor, results) {
  const href = anchor.href;
  const kind = detectVideoKind(href);
  if (!href || !kind) return;
  pushResult(results, href, kind, false);
}

function collectFromAttributes(element, results) {
  if (!element.attributes) return;

  Array.from(element.attributes).forEach((attr) => {
    if (!/src|href|url|video|media|content/i.test(attr.name)) return;
    extractMediaUrlsFromText(attr.value).forEach((url) => pushResult(results, url, detectVideoKind(url) || 'video', false));
  });
}

function normalizeEscapedUrl(rawUrl) {
  return rawUrl
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/[),.;]+$/g, '');
}

function extractMediaUrlsFromText(text) {
  const input = String(text || '');
  if (!input || input.length > 800000) return [];

  const urls = new Set();
  const re = /https?:\\?\/\\?\/(?:[^\s"'<>]|\\\/)+/gi;
  let match;

  while ((match = re.exec(input))) {
    const url = normalizeEscapedUrl(match[0]);
    if (isLikelyMediaUrl(url) || detectVideoKind(url)) urls.add(url);
    if (urls.size > 80) break;
  }

  return [...urls];
}

function collectFromScript(script, results) {
  if (scannedScripts.has(script)) return;
  scannedScripts.add(script);

  const text = script.textContent || '';
  extractMediaUrlsFromText(text).forEach((url) => pushResult(results, url, detectVideoKind(url) || 'video', false));
}

function scanNode(node, results) {
  if (!node) return;

  if (node.nodeType === Node.DOCUMENT_NODE) {
    scanNode(node.documentElement, results);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const element = node;
  if (element.matches?.('video')) collectFromVideo(element, results);
  if (element.matches?.('a[href]')) collectFromAnchor(element, results);
  if (element.matches?.('script:not([src])')) collectFromScript(element, results);
  collectFromAttributes(element, results);

  element.querySelectorAll?.('video').forEach((video) => collectFromVideo(video, results));
  element.querySelectorAll?.('a[href]').forEach((anchor) => collectFromAnchor(anchor, results));
  element.querySelectorAll?.('script:not([src])').forEach((script) => collectFromScript(script, results));
  element.querySelectorAll?.('[src],[href],[data-src],[data-url],[data-video-url],[data-video],[content]')
    .forEach((child) => collectFromAttributes(child, results));
}

function scanPerformanceEntries(results) {
  performance.getEntriesByType('resource').forEach((entry) => {
    const url = entry.name;
    const kind = detectVideoKind(url) || (isLikelyMediaUrl(url) ? 'video' : null);
    if (!kind) return;
    pushResult(results, url, kind, false);
  });
}

function flushQueuedScan() {
  scanTimer = null;
  const results = [];

  if (!pendingScanNodes.size) {
    scanNode(document, results);
  } else {
    pendingScanNodes.forEach((node) => scanNode(node, results));
  }

  scanPerformanceEntries(results);

  pendingScanNodes = new Set();
  sendDomVideos(results);
}

function scheduleScan(node) {
  if (node) pendingScanNodes.add(node);
  if (scanTimer) return;
  scanTimer = setTimeout(flushQueuedScan, DOM_SCAN_DELAY_MS);
}

function startDetection() {
  scheduleScan(document);

  const target = document.body || document.documentElement;
  if (!target) {
    setTimeout(startDetection, 250);
    return;
  }

  if (observerStarted) return;
  observerStarted = true;

  const observer = new MutationObserver((mutations) => {
    try {
      if (!chrome.runtime?.id) {
        observer.disconnect();
        return;
      }

      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes') {
          scheduleScan(mutation.target);
        }

        mutation.addedNodes.forEach((node) => scheduleScan(node));
      });
    } catch {
      observer.disconnect();
    }
  });

  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href']
  });

  if (!performanceObserverStarted && 'PerformanceObserver' in window) {
    performanceObserverStarted = true;
    try {
      const performanceObserver = new PerformanceObserver((list) => {
        const results = [];
        list.getEntries().forEach((entry) => {
          const kind = detectVideoKind(entry.name) || (isLikelyMediaUrl(entry.name) ? 'video' : null);
          if (kind) pushResult(results, entry.name, kind, false);
        });
        sendDomVideos(results);
      });
      performanceObserver.observe({ type: 'resource', buffered: true });
    } catch {}
  }
}

function startRecordingProgress(video) {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (!activeRecorder || activeRecorder.state === 'inactive') return;

    const elapsed = Date.now() - recordingStart;
    const duration = Number(video.duration || 0);
    const progress = duration > 0 ? Math.min((video.currentTime / duration) * 100, 99.5) : 0;

    try {
      chrome.runtime.sendMessage({
        action: 'recordingProgress',
        progress,
        elapsed
      });
    } catch {}
  }, 1000);
}

function stopRecordingProgress() {
  clearInterval(progressTimer);
  progressTimer = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchVideoChunk') {
    const requestId = sanitizeText(message.requestId, 64);
    const previewKey = `vc_preview_${requestId}`;

    if (!requestId || !isHttpUrl(message.url)) {
      sendResponse({ ok: false, error: 'invalid request' });
      return true;
    }

    (async () => {
      try {
        await storageRemove(previewKey);
        const dataUrl = await fetchPreviewChunk(message.url, message.referer || '');
        await storageSet(previewKey, dataUrl);
        vcLog('info', `Preview listo para ${requestId}`);
        sendResponse({ ok: true, storageKey: previewKey });
      } catch (error) {
        vcLog('warn', `Preview fallo: ${error.message}`);
        sendResponse({ ok: false, error: error.message });
      }
    })();

    return true;
  }

  if (message.action === 'fetchAndDownload') {
    if (!isHttpUrl(message.url)) {
      sendResponse({ ok: false, error: 'invalid url' });
      return true;
    }

    fetch(message.url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      referrer: message.referer || location.href,
      referrerPolicy: 'strict-origin-when-cross-origin'
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = safeFilename(message.filename, 'video', 'mp4');
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message.action === 'downloadHls') {
    if (!isHttpUrl(message.url) || !isHlsUrl(message.url)) {
      sendResponse({ ok: false, error: 'invalid HLS url' });
      return true;
    }

    downloadHls(message.url, message.filename, message.referer || '')
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message.action === 'startRecording') {
    if (activeRecorder && activeRecorder.state !== 'inactive') {
      sendResponse({ ok: false, error: 'Ya hay una grabacion en curso' });
      return true;
    }

    const video = findMainVideo();
    if (!video) {
      sendResponse({ ok: false, error: 'No se encontro un elemento <video> activo' });
      return true;
    }

    try {
      const capture = video.captureStream || video.mozCaptureStream;
      if (!capture) throw new Error('El navegador no soporta captureStream para este video');
      const stream = capture.call(video);
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((value) =>
        MediaRecorder.isTypeSupported(value)
      ) || 'video/webm';

      recordedChunks = [];
      recordingStart = Date.now();
      activeRecorder = new MediaRecorder(stream, { mimeType });

      startRecordingProgress(video);

      activeRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunks.push(event.data);
      };

      activeRecorder.onerror = (event) => {
        vcLog('error', `MediaRecorder error: ${event.error?.message || 'unknown error'}`);
      };

      activeRecorder.onstop = async () => {
        stopRecordingProgress();

        const durationMs = Date.now() - recordingStart;
        let blob = new Blob(recordedChunks, { type: mimeType });
        blob = await fixWebMDuration(blob, durationMs);

        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        const baseName = String(message.filename || 'video_recording').replace(/\.[^.]+$/, '');

        anchor.href = blobUrl;
        anchor.download = safeFilename(baseName, 'video_recording', 'webm');
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

        activeRecorder = null;
        recordedChunks = [];

        try {
          chrome.runtime.sendMessage({ action: 'recordingDone' });
        } catch {}
      };

      activeRecorder.start(1000);
      sendResponse({ ok: true });
    } catch (error) {
      stopRecordingProgress();
      sendResponse({ ok: false, error: error.message });
    }

    return true;
  }

  if (message.action === 'stopRecording') {
    if (activeRecorder && activeRecorder.state !== 'inactive') {
      activeRecorder.stop();
    }

    stopRecordingProgress();
    sendResponse({ ok: true });
    return true;
  }
});

window.addEventListener('__vc_video_found', (event) => {
  const detail = event.detail || {};
  if (detail.recordOnly) {
    sendDomVideos([{
      url: normalizeUrl(location.href),
      kind: 'recording',
      recordOnly: true,
      isMain: Boolean(detail.isMain),
      filename: sanitizeText(document.title || 'video_recording', 120),
      source: 'injected',
      reason: detail.reason || 'Video sin URL directa detectado'
    }]);
    return;
  }

  const url = normalizeUrl(detail.url);
  const kind = detectVideoKind(url) || event.detail?.kind || 'video';
  if (!url || !kind) return;
  sendDomVideos([{ url, kind, isMain: Boolean(detail.isMain) }]);
});

window.addEventListener('load', startDetection, { once: true });
setTimeout(startDetection, 1200);
