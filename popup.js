const {
  isHlsUrl,
  needsRecording,
  sanitizeText
} = globalThis.VideoCatcherUtils;

const previewStorage = chrome.storage.session || chrome.storage.local;

const elements = {
  loading: document.getElementById('state-loading'),
  empty: document.getElementById('state-empty'),
  list: document.getElementById('video-list'),
  footer: document.getElementById('footer'),
  count: document.getElementById('count-label'),
  clear: document.getElementById('btn-clear'),
  status: document.getElementById('status-banner'),
  debugToggle: document.getElementById('btn-debug-toggle'),
  debugPanel: document.getElementById('debug-panel'),
  debugEntries: document.getElementById('debug-entries'),
  debugCopy: document.getElementById('btn-debug-copy'),
  debugClear: document.getElementById('btn-debug-clear'),
  nativePanel: document.getElementById('native-panel'),
  nativeDot: document.getElementById('native-dot'),
  nativeStatusText: document.getElementById('native-status-text'),
  nativeToolsText: document.getElementById('native-tools-text'),
  nativeProgress: document.getElementById('native-progress'),
  nativeProgressBar: document.getElementById('native-progress-bar'),
  nativeProgressLine: document.getElementById('native-progress-line'),
  nativeCheck: document.getElementById('btn-native-check'),
  nativeCancel: document.getElementById('btn-native-cancel'),
  recordingBanner: document.getElementById('recording-banner'),
  recordingName: document.getElementById('recording-name'),
  recordingTime: document.getElementById('recording-time'),
  recordingProgress: document.getElementById('recording-progress'),
  stopRecording: document.getElementById('btn-stop-recording')
};

const state = {
  activeTabId: null,
  activeTabUrl: '',
  videos: [],
  debugVisible: false,
  debugLogs: [],
  activePreview: null,
  statusTimer: null,
  recordingPoll: null,
  nativePoll: null,
  nativeStatus: null,
  cookiePrefs: Object.create(null)
};

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve(response);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve(response);
    });
  });
}

function storageGet(key) {
  return new Promise((resolve) => previewStorage.get(key, (data) => resolve(data[key])));
}

function storageRemove(key) {
  return new Promise((resolve) => previewStorage.remove(key, resolve));
}

function localStorageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (data) => resolve(data[key])));
}

function localStorageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function showStatus(message, type = 'info', duration = 2600) {
  clearTimeout(state.statusTimer);
  elements.status.textContent = sanitizeText(message, 200);
  elements.status.className = `status visible ${type}`;

  if (duration > 0) {
    state.statusTimer = setTimeout(() => {
      elements.status.className = 'status';
      elements.status.textContent = '';
    }, duration);
  }
}

function formatShortUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname.length > 32 ? `...${parsed.pathname.slice(-32)}` : parsed.pathname;
    return `${host}${path}`;
  } catch {
    return sanitizeText(url, 60);
  }
}

function getFormatTag(video) {
  const decoded = decodeURIComponent(video.url || '').toLowerCase();

  if (video.kind === 'recording' || video.recordOnly) {
    return { label: 'REC', className: 'tag warn' };
  }

  if (video.kind === 'stream' || decoded.includes('.m3u8') || decoded.includes('.mpd')) {
    return { label: 'Stream', className: 'tag stream' };
  }

  if (decoded.includes('.webm') || decoded.includes('video/webm')) {
    return { label: 'WEBM', className: 'tag primary' };
  }

  if (decoded.includes('.mov')) {
    return { label: 'MOV', className: 'tag primary' };
  }

  if (decoded.includes('.mkv')) {
    return { label: 'MKV', className: 'tag primary' };
  }

  return { label: 'MP4', className: 'tag primary' };
}

function parseSizeScore(size) {
  const match = String(size || '').match(/^([\d.]+)\s*(GB|MB|KB|B)$/i);
  if (!match) return 0;

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;

  const unit = match[2].toUpperCase();
  if (unit === 'GB') return value * 1024 * 1024 * 1024;
  if (unit === 'MB') return value * 1024 * 1024;
  if (unit === 'KB') return value * 1024;
  return value;
}

function getRelevanceInfo(video) {
  const url = String(video.url || '').toLowerCase();
  const contentType = String(video.contentType || '').toLowerCase();
  let score = 0;
  let label = 'Secundario';
  let className = 'tag';

  if (video.isMain) {
    score += 1000;
    label = 'Principal';
    className = 'tag warn';
  }

  if (video.recordOnly || video.kind === 'recording') {
    score += 760;
    if (!video.isMain) {
      label = 'Pagina';
      className = 'tag warn';
    }
  } else if (video.kind === 'video') {
    score += 620;
    if (!video.isMain) {
      label = 'Descargable';
      className = 'tag primary';
    }
  } else if (video.kind === 'stream' || isHlsUrl(video.url, contentType) || url.includes('.mpd')) {
    score += 420;
    if (!video.isMain) {
      label = 'Stream';
      className = 'tag stream';
    }
  }

  if (video.needsRecording) score += 90;
  if (video.downloadMode === 'direct') score += 80;
  if (video.downloadMode === 'hls') score += 30;
  if (video.source === 'dom') score += 55;
  if (video.source === 'network') score += 20;
  if (url.includes('googlevideo.com') || url.includes('videoplayback')) score += 45;
  if (url.includes('segment') || video.kind === 'segment') score -= 300;

  score += Math.min(parseSizeScore(video.size) / (1024 * 1024), 240);
  score += Math.min(Number(video.timestamp) || 0, Date.now()) / 1e13;

  return { score, label, className };
}

function sortVideosByRelevance(videos) {
  return [...videos].sort((a, b) => {
    const relevanceDelta = getRelevanceInfo(b).score - getRelevanceInfo(a).score;
    if (Math.abs(relevanceDelta) > 0.0001) return relevanceDelta;
    return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
  });
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function createTag(label, className = 'tag') {
  const tag = document.createElement('span');
  tag.className = className;
  tag.textContent = label;
  return tag;
}

function createSvgIcon(name) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('class', 'icon-svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const specs = {
    video: [
      ['path', { d: 'M8 6.5v11l9-5.5-9-5.5Z', fill: 'currentColor' }],
      ['rect', { x: '3.5', y: '4.5', width: '17', height: '15', rx: '3.2', stroke: 'currentColor', 'stroke-width': '1.8' }]
    ],
    stream: [
      ['path', { d: 'M9.5 15.5a4.9 4.9 0 0 1 0-7', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }],
      ['path', { d: 'M6.4 18.6a9.3 9.3 0 0 1 0-13.2', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }],
      ['circle', { cx: '14.5', cy: '12', r: '2.7', fill: 'currentColor' }]
    ],
    recording: [
      ['circle', { cx: '12', cy: '12', r: '6.5', fill: 'currentColor' }],
      ['rect', { x: '4.5', y: '4.5', width: '15', height: '15', rx: '4', stroke: 'currentColor', 'stroke-width': '1.8', opacity: '0.45' }]
    ],
    stop: [
      ['rect', { x: '7', y: '7', width: '10', height: '10', rx: '2', fill: 'currentColor' }],
      ['circle', { cx: '12', cy: '12', r: '8', stroke: 'currentColor', 'stroke-width': '1.8', opacity: '0.45' }]
    ],
    download: [
      ['path', { d: 'M12 4v10', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' }],
      ['path', { d: 'm7.5 10 4.5 4.5L16.5 10', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
      ['path', { d: 'M5 19h14', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' }]
    ],
    pro: [
      ['path', { d: 'M13 2 5 13h6l-1 9 9-13h-6l1-7Z', fill: 'currentColor' }],
      ['path', { d: 'M18.5 4.5 20 3m-1.5 8.5L20 13m-13.5 5.5L5 20', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', opacity: '0.55' }]
    ],
    copy: [
      ['rect', { x: '8', y: '8', width: '10', height: '10', rx: '2', stroke: 'currentColor', 'stroke-width': '2' }],
      ['path', { d: 'M6 15H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }]
    ],
    preview: [
      ['path', { d: 'M3 12s3.4-6 9-6 9 6 9 6-3.4 6-9 6-9-6-9-6Z', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linejoin': 'round' }],
      ['circle', { cx: '12', cy: '12', r: '2.8', fill: 'currentColor' }]
    ],
    logs: [
      ['path', { d: 'M5 7h14M5 12h14M5 17h9', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }],
      ['circle', { cx: '3', cy: '7', r: '1', fill: 'currentColor' }],
      ['circle', { cx: '3', cy: '12', r: '1', fill: 'currentColor' }],
      ['circle', { cx: '3', cy: '17', r: '1', fill: 'currentColor' }]
    ],
    clear: [
      ['path', { d: 'M8 7h8', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }],
      ['path', { d: 'M10 7V5h4v2', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
      ['path', { d: 'M7 9l1 10h8l1-10', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]
    ]
  };

  (specs[name] || specs.video).forEach(([tagName, attrs]) => {
    const node = document.createElementNS(svgNs, tagName);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    svg.appendChild(node);
  });

  return svg;
}

function decorateButton(button, iconName) {
  const label = document.createElement('span');
  label.className = 'button-label';
  label.textContent = button.textContent;
  button.textContent = '';
  button.append(createSvgIcon(iconName), label);
}

function createButton(label, className, onClick, iconName = null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  const labelNode = document.createElement('span');
  labelNode.className = 'button-label';
  labelNode.textContent = label;
  if (iconName) button.append(createSvgIcon(iconName));
  button.appendChild(labelNode);
  button.addEventListener('click', onClick);
  return button;
}

function closePreview() {
  if (!state.activePreview) return;

  const { item, panel, video, error } = state.activePreview;
  panel.classList.remove('visible');
  error.classList.remove('visible');
  video.pause();
  video.removeAttribute('src');
  video.load();

  if (item) {
    item.classList.remove('active');
  }

  state.activePreview = null;
}

function createInlinePreview() {
  const panel = document.createElement('section');
  panel.className = 'preview item-preview';

  const head = document.createElement('div');
  head.className = 'preview-head';

  const title = document.createElement('span');
  title.textContent = 'Vista previa';

  const closeButton = createButton('Cerrar', 'ghost-btn', closePreview);

  const videoElement = document.createElement('video');
  videoElement.controls = true;
  videoElement.preload = 'metadata';

  const error = document.createElement('div');
  error.className = 'preview-error';
  error.textContent = 'No se pudo cargar la vista previa para este recurso.';

  head.append(title, closeButton);
  panel.append(head, videoElement, error);

  return { panel, video: videoElement, error };
}

async function openPreview(video, itemElement, previewNodes) {
  if (video.recordOnly) {
    showStatus('Este recurso no expone una URL directa; usa grabacion.', 'info');
    return;
  }

  if (state.activePreview?.item === itemElement && previewNodes.panel.classList.contains('visible')) {
    closePreview();
    return;
  }

  closePreview();

  state.activePreview = { item: itemElement, ...previewNodes };
  itemElement.classList.add('active');

  previewNodes.panel.classList.add('visible');
  previewNodes.error.classList.remove('visible');
  previewNodes.video.style.display = 'block';
  previewNodes.video.removeAttribute('src');
  previewNodes.video.load();

  const lowerUrl = String(video.url || '').toLowerCase();
  const needsFetchedPreview = lowerUrl.includes('tiktok') || needsRecording(video.url);

  function attachPreviewSource(source) {
    previewNodes.video.onerror = () => {
      previewNodes.video.style.display = 'none';
      previewNodes.error.classList.add('visible');
    };
    previewNodes.video.src = source;
    previewNodes.video.load();
  }

  if (!needsFetchedPreview || state.activeTabId === null) {
    attachPreviewSource(video.url);
    return;
  }

  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const response = await sendTabMessage(state.activeTabId, {
    action: 'fetchVideoChunk',
    url: video.url,
    referer: video.referer || '',
    requestId
  });

  if (!response?.ok || !response.storageKey) {
    attachPreviewSource(video.url);
    return;
  }

  const dataUrl = await storageGet(response.storageKey);
  await storageRemove(response.storageKey);

  if (!dataUrl || state.activePreview?.item !== itemElement) {
    attachPreviewSource(video.url);
    return;
  }

  attachPreviewSource(dataUrl);
}

function setListState(mode) {
  elements.loading.hidden = mode !== 'loading';
  elements.empty.hidden = mode !== 'empty';
  elements.list.hidden = mode !== 'list';
}

function renderFooter() {
  if (!state.videos.length) {
    elements.footer.textContent = 'La lista se limpia al navegar a otra pagina.';
    return;
  }

  const direct = state.videos.filter((video) => video.kind !== 'stream').length;
  const streams = state.videos.filter((video) => video.kind === 'stream').length;
  elements.footer.textContent = `${state.videos.length} recursos detectados - ${direct} directos - ${streams} streams`;
}

function getVideoHost(video) {
  const candidates = [state.activeTabUrl, video.referer, video.url];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.hostname.replace(/^www\./, '').toLowerCase();
      }
    } catch {}
  }
  return 'default';
}

async function loadCookiePrefs() {
  const prefs = await localStorageGet('vc_native_cookie_hosts');
  state.cookiePrefs = prefs && typeof prefs === 'object' ? prefs : Object.create(null);
}

async function setCookiePref(host, enabled) {
  state.cookiePrefs = { ...state.cookiePrefs, [host]: Boolean(enabled) };
  await localStorageSet({ vc_native_cookie_hosts: state.cookiePrefs });
}

function nativeToolsReady(status = state.nativeStatus) {
  return Boolean(status?.tools?.ok || (status?.tools?.ytDlp?.found && status?.tools?.ffmpeg?.found));
}

function renderNativeStatus(status) {
  state.nativeStatus = status || null;
  const activeJob = status?.activeJob || null;
  const progress = status?.lastProgress || null;
  const toolsReady = nativeToolsReady(status);

  elements.nativeDot.className = 'native-dot';
  if (activeJob) {
    elements.nativeDot.classList.add('busy');
  } else if (toolsReady) {
    elements.nativeDot.classList.add('ready');
  } else if (status?.connected || status?.installed) {
    elements.nativeDot.classList.add('warn');
  } else if (status?.lastError) {
    elements.nativeDot.classList.add('error');
  }

  if (activeJob) {
    elements.nativeStatusText.textContent = `Descargando: ${sanitizeText(activeJob.title || 'video', 120)}`;
  } else if (toolsReady) {
    elements.nativeStatusText.textContent = 'Host Pro listo para yt-dlp + ffmpeg.';
  } else if (status?.connected || status?.installed) {
    elements.nativeStatusText.textContent = status?.lastError || 'Host instalado, pero faltan herramientas.';
  } else {
    elements.nativeStatusText.textContent = status?.lastError || 'Host Pro no instalado o no verificado.';
  }

  if (status?.tools) {
    const missing = Array.isArray(status.tools.missing) ? status.tools.missing.join(', ') : '';
    elements.nativeToolsText.textContent = toolsReady
      ? 'Herramientas detectadas: yt-dlp y ffmpeg.'
      : `Faltan: ${missing || 'yt-dlp.exe / ffmpeg.exe'}.`;
  } else {
    elements.nativeToolsText.textContent = 'Usa Verificar Pro despues de instalar el host local.';
  }

  if (activeJob || progress?.line) {
    elements.nativeProgress.classList.add('visible');
    elements.nativeProgressLine.textContent = sanitizeText(progress?.line || 'Preparando descarga Pro...', 220);
    const percent = Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : 12;
    elements.nativeProgressBar.style.width = `${percent}%`;
  } else {
    elements.nativeProgress.classList.remove('visible');
    elements.nativeProgressLine.textContent = '';
    elements.nativeProgressBar.style.width = '0%';
  }

  elements.nativeCancel.hidden = !activeJob;
  elements.nativeCheck.disabled = Boolean(activeJob);

  if (activeJob) startNativePolling();
}

async function loadNativeStatus(forceCheck = false) {
  const response = await sendRuntimeMessage({ action: forceCheck ? 'checkNativeHost' : 'getNativeStatus' });
  renderNativeStatus(response?.state || null);
  return response;
}

function startNativePolling() {
  if (state.nativePoll) return;
  state.nativePoll = setInterval(async () => {
    const response = await loadNativeStatus(false);
    if (!response?.state?.activeJob) {
      clearInterval(state.nativePoll);
      state.nativePoll = null;
    }
  }, 1000);
}

async function startNativeDownload(video, useCookies) {
  const check = nativeToolsReady() ? { ok: true } : await loadNativeStatus(true);
  if (!nativeToolsReady(check?.state || state.nativeStatus)) {
    showStatus('Instala o verifica el host Pro con yt-dlp y ffmpeg antes de usar esta descarga.', 'error', 4200);
    return;
  }

  const response = await sendRuntimeMessage({
    action: 'downloadWithNative',
    url: video.url,
    pageUrl: state.activeTabUrl || video.referer || video.url,
    filename: video.filename,
    kind: video.kind,
    contentType: video.contentType || '',
    recordOnly: Boolean(video.recordOnly),
    referer: video.referer || state.activeTabUrl || '',
    requestHeaders: video.requestHeaders || [],
    tabId: state.activeTabId,
    useCookies: Boolean(useCookies),
    cookiesBrowser: 'brave',
    preferPageUrl: true
  });

  renderNativeStatus(response?.state || state.nativeStatus);

  if (response?.ok) {
    showStatus('Descarga Pro iniciada con yt-dlp.', 'ok');
    startNativePolling();
  } else {
    showStatus(`No se pudo iniciar Pro: ${response?.error || 'error'}`, 'error', 4800);
  }
}

function renderList(videos) {
  state.videos = sortVideosByRelevance(Array.isArray(videos) ? videos : []);
  elements.count.textContent = state.videos.length ? `(${state.videos.length})` : '';
  clearNode(elements.list);
  closePreview();

  if (!state.videos.length) {
    setListState('empty');
    renderFooter();
    return;
  }

  setListState('list');

  state.videos.forEach((video) => {
    const item = document.createElement('article');
    item.className = 'item';

    const head = document.createElement('div');
    head.className = 'item-head';

    const icon = document.createElement('div');
    const itemIconType = video.recordOnly ? 'recording' : video.kind === 'stream' ? 'stream' : 'video';
    icon.className = `item-icon ${itemIconType}`;
    icon.appendChild(createSvgIcon(itemIconType));

    const copy = document.createElement('div');
    copy.className = 'item-copy';
    const previewNodes = createInlinePreview();
    copy.addEventListener('click', () => openPreview(video, item, previewNodes));

    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = sanitizeText(video.filename || 'video', 140);
    name.title = video.filename || '';

    const url = document.createElement('div');
    url.className = 'item-url';
    url.textContent = formatShortUrl(video.url);
    url.title = video.url || '';

    copy.append(name, url);
    head.append(icon, copy);

    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';

    const formatTag = getFormatTag(video);
    const relevanceTag = getRelevanceInfo(video);
    metaRow.appendChild(createTag(relevanceTag.label, relevanceTag.className));
    metaRow.appendChild(createTag(formatTag.label, formatTag.className));

    if (video.size) metaRow.appendChild(createTag(video.size, 'tag'));
    if (video.needsRecording) metaRow.appendChild(createTag('Grabacion', 'tag warn'));

    const actionsRow = document.createElement('div');
    actionsRow.className = 'actions-row';

    const copyButton = createButton('Copiar URL', 'mini-btn', async () => {
      try {
        await navigator.clipboard.writeText(video.url);
        showStatus('URL copiada al portapapeles.', 'ok');
      } catch {
        showStatus('No se pudo copiar la URL.', 'error');
      }
    }, 'copy');

    const previewButton = createButton('Preview', 'mini-btn', () => openPreview(video, item, previewNodes), 'preview');
    previewButton.disabled = Boolean(video.recordOnly);

    let actionButton;

    if (video.needsRecording || video.recordOnly) {
      actionButton = createButton('Grabar', 'record-btn', async () => {
        if (state.activeTabId === null) return;
        actionButton.disabled = true;
        const response = await sendRuntimeMessage({
          action: 'startRecording',
          filename: video.filename,
          tabId: state.activeTabId
        });

        if (response?.ok) {
          showStatus('Grabacion iniciada.', 'ok');
          await loadRecordingState();
        } else {
          showStatus(`No se pudo iniciar la grabacion: ${response?.error || 'error'}`, 'error', 3600);
          actionButton.disabled = false;
        }
      }, 'recording');
    } else {
      const downloadLabel = video.kind === 'stream' && isHlsUrl(video.url, video.contentType || '')
        ? 'Descargar HLS'
        : video.kind === 'stream'
          ? 'Descargar stream'
          : 'Descargar';

      actionButton = createButton(downloadLabel, 'action-btn', async () => {
        actionButton.disabled = true;
        const response = await sendRuntimeMessage({
          action: 'downloadVideo',
          url: video.url,
          filename: video.filename,
          kind: video.kind,
          contentType: video.contentType || '',
          requestHeaders: video.requestHeaders || [],
          recordOnly: Boolean(video.recordOnly),
          referer: video.referer || '',
          tabId: state.activeTabId
        });

        if (response?.ok) {
          showStatus('Descarga iniciada.', 'ok');
        } else {
          showStatus(`No se pudo descargar: ${response?.error || 'error'}`, 'error', 3600);
          actionButton.disabled = false;
        }
      }, 'download');
    }

    const host = getVideoHost(video);
    const cookieToggle = document.createElement('label');
    cookieToggle.className = 'cookie-toggle';

    const cookieInput = document.createElement('input');
    cookieInput.type = 'checkbox';
    cookieInput.checked = Boolean(state.cookiePrefs[host]);
    cookieInput.addEventListener('change', async () => {
      await setCookiePref(host, cookieInput.checked);
      showStatus(
        cookieInput.checked
          ? `Cookies activadas para ${host}.`
          : `Cookies desactivadas para ${host}.`,
        'info'
      );
    });

    const cookieText = document.createElement('span');
    cookieText.textContent = 'Cookies';
    cookieToggle.title = `Permitir --cookies-from-browser brave para ${host}`;
    cookieToggle.append(cookieInput, cookieText);

    const proButton = createButton('Descargar Pro', 'pro-btn', async () => {
      proButton.disabled = true;
      await startNativeDownload(video, cookieInput.checked);
      proButton.disabled = false;
    }, 'pro');
    proButton.title = 'Usa yt-dlp + ffmpeg mediante el host local opcional.';
    proButton.disabled = Boolean(state.nativeStatus?.activeJob);

    actionsRow.append(copyButton, previewButton, actionButton, proButton, cookieToggle);
    item.append(head, metaRow, actionsRow, previewNodes.panel);
    elements.list.appendChild(item);
  });

  renderFooter();
}

function formatLogTime(timestamp) {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function renderLogs(logs) {
  state.debugLogs = Array.isArray(logs) ? logs : [];
  clearNode(elements.debugEntries);

  if (!state.debugLogs.length) {
    const empty = document.createElement('div');
    empty.className = 'debug-entry';

    const message = document.createElement('div');
    message.className = 'debug-msg';
    message.textContent = 'Sin logs todavia.';

    empty.append(document.createElement('span'), document.createElement('span'), message);
    elements.debugEntries.appendChild(empty);
    return;
  }

  state.debugLogs.forEach((entry) => {
    const row = document.createElement('div');
    row.className = `debug-entry ${sanitizeText(entry.level || 'info', 16)}`;

    const time = document.createElement('span');
    time.className = 'debug-time';
    time.textContent = formatLogTime(entry.t);

    const source = document.createElement('span');
    source.className = 'debug-source';
    source.textContent = sanitizeText(entry.source || 'bg', 12);

    const message = document.createElement('span');
    message.className = 'debug-msg';
    message.textContent = sanitizeText(entry.msg || '', 280);

    row.append(time, source, message);
    elements.debugEntries.appendChild(row);
  });
}

async function loadLogs() {
  const storage = await new Promise((resolve) => chrome.storage.local.get('vc_logs', resolve));
  renderLogs(storage.vc_logs || []);
}

function updateRecordingBanner(recordingState) {
  if (!recordingState?.isRecording) {
    elements.recordingBanner.classList.remove('visible');
    elements.recordingName.textContent = '';
    elements.recordingTime.textContent = '00:00';
    elements.recordingProgress.style.width = '0%';
    return;
  }

  elements.recordingBanner.classList.add('visible');
  elements.recordingName.textContent = sanitizeText(recordingState.filename || 'video_recording.webm', 120);
  elements.recordingProgress.style.width = `${Math.max(0, Math.min(100, recordingState.progress || 0))}%`;

  const seconds = Math.floor((recordingState.elapsed || 0) / 1000);
  const minutesPart = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secondsPart = String(seconds % 60).padStart(2, '0');
  elements.recordingTime.textContent = `${minutesPart}:${secondsPart}`;
}

function startRecordingPolling() {
  if (state.recordingPoll) return;
  state.recordingPoll = setInterval(loadRecordingState, 1000);
}

async function loadRecordingState() {
  const response = await sendRuntimeMessage({ action: 'getRecordingState' });
  updateRecordingBanner(response);

  if (response?.isRecording) {
    startRecordingPolling();
  } else if (state.recordingPoll) {
    clearInterval(state.recordingPoll);
    state.recordingPoll = null;
  }
}

async function loadVideos() {
  setListState('loading');
  const response = await sendRuntimeMessage({ action: 'getVideos' });
  renderList(response?.videos || []);
}

async function initialize() {
  const activeTab = await queryActiveTab();
  state.activeTabId = activeTab?.id ?? null;
  state.activeTabUrl = activeTab?.url || '';
  await loadCookiePrefs();
  await Promise.all([loadVideos(), loadRecordingState(), loadNativeStatus(false)]);
}

elements.clear.addEventListener('click', async () => {
  if (state.activeTabId === null) return;
  await sendRuntimeMessage({ action: 'clearVideos', tabId: state.activeTabId });
  renderList([]);
  showStatus('Lista limpiada para esta pestana.', 'ok');
});

elements.debugToggle.addEventListener('click', async () => {
  state.debugVisible = !state.debugVisible;
  elements.debugPanel.classList.toggle('visible', state.debugVisible);
  if (state.debugVisible) await loadLogs();
});

elements.debugClear.addEventListener('click', async () => {
  await new Promise((resolve) => chrome.storage.local.set({ vc_logs: [] }, resolve));
  renderLogs([]);
  showStatus('Logs limpiados.', 'ok');
});

elements.debugCopy.addEventListener('click', async () => {
  if (!state.debugLogs.length) return;

  const text = state.debugLogs
    .map((entry) => `${formatLogTime(entry.t)} [${entry.source}] [${entry.level}] ${entry.msg}`)
    .join('\n');

  try {
    await navigator.clipboard.writeText(text);
    showStatus('Logs copiados.', 'ok');
  } catch {
    showStatus('No se pudieron copiar los logs.', 'error');
  }
});

elements.stopRecording.addEventListener('click', async () => {
  if (state.activeTabId === null) return;
  await sendRuntimeMessage({ action: 'stopRecording', tabId: state.activeTabId });
  showStatus('Deteniendo grabacion...', 'info');
});

elements.nativeCheck.addEventListener('click', async () => {
  elements.nativeCheck.disabled = true;
  const response = await loadNativeStatus(true);
  elements.nativeCheck.disabled = Boolean(response?.state?.activeJob);

  if (nativeToolsReady(response?.state)) {
    showStatus('Host Pro verificado: yt-dlp y ffmpeg listos.', 'ok');
  } else {
    showStatus(response?.error || response?.state?.lastError || 'Host Pro no esta listo.', 'error', 4200);
  }
});

elements.nativeCancel.addEventListener('click', async () => {
  const response = await sendRuntimeMessage({
    action: 'cancelNativeDownload',
    jobId: state.nativeStatus?.activeJob?.id || null
  });
  renderNativeStatus(response?.state || state.nativeStatus);
  showStatus(response?.ok ? 'Cancelando descarga Pro...' : `No se pudo cancelar: ${response?.error || 'error'}`, response?.ok ? 'info' : 'error');
});

decorateButton(elements.debugToggle, 'logs');
decorateButton(elements.clear, 'clear');
decorateButton(elements.debugCopy, 'copy');
decorateButton(elements.debugClear, 'clear');
decorateButton(elements.stopRecording, 'stop');
decorateButton(elements.nativeCheck, 'pro');
decorateButton(elements.nativeCancel, 'stop');

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.vc_logs && state.debugVisible) {
    renderLogs(changes.vc_logs.newValue || []);
  }

  if (areaName !== 'local' || state.activeTabId === null) return;

  const tabKey = `tab_${state.activeTabId}`;
  if (changes[tabKey]) {
    renderList(changes[tabKey].newValue || []);
  }
});

window.addEventListener('beforeunload', () => {
  clearInterval(state.recordingPoll);
  clearInterval(state.nativePoll);
  clearTimeout(state.statusTimer);
});

initialize();
