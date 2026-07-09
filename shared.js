(function () {
  const VIDEO_EXTENSIONS = [
    '.mp4',
    '.webm',
    '.ogg',
    '.mov',
    '.avi',
    '.mkv',
    '.flv',
    '.m4v',
    '.3gp'
  ];

  const STREAM_PATTERNS = ['.m3u8', '.m3u', '.mpd'];
  const SEGMENT_EXTENSIONS = ['.ts', '.m4s', '.cmfv', '.cmfa'];
  const VOLATILE_MEDIA_QUERY_PARAMS = new Set([
    'range',
    'rn',
    'rbuf',
    'redirect_counter'
  ]);

  const VIDEO_MIME_TYPES = [
    'video/',
    'application/mp4',
    'application/octet-stream',
    'binary/octet-stream',
    'application/x-mpegurl',
    'application/vnd.apple.mpegurl',
    'application/dash+xml',
    'application/x-mpegurl',
    'application/vnd.ms-sstr+xml'
  ];

  const HLS_MIME_TYPES = [
    'application/x-mpegurl',
    'application/vnd.apple.mpegurl',
    'audio/mpegurl',
    'audio/x-mpegurl'
  ];

  const DASH_MIME_TYPES = ['application/dash+xml', 'application/vnd.ms-sstr+xml'];

  const MEDIA_HOST_HINTS = [
    'googlevideo.com',
    'youtube.com',
    'tiktokcdn.com',
    'tiktokv.com',
    'muscdn.com',
    'byteoversea.com',
    'twimg.com',
    'x.com',
    'twitter.com',
    'fbcdn.net',
    'fbsbx.com',
    'facebook.com',
    'cdninstagram.com',
    'instagram.com',
    'threads.net',
    'vimeocdn.com',
    'vimeo.com',
    'dmcdn.net',
    'dailymotion.com',
    'v.redd.it',
    'redditmedia.com',
    'twitch.tv',
    'ttvnw.net',
    'cloudfront.net',
    'akamaized.net',
    'brightcove.com',
    'jwplayer.com'
  ];

  const MEDIA_PATH_HINTS = [
    'video',
    'videoplayback',
    'playback',
    'mime=video',
    'mime_type=video',
    'mp4',
    'webm',
    'm3u8',
    'mpd',
    'hls',
    'dash',
    'vod',
    'manifest',
    'playlist',
    'amplify_video',
    'ext_tw_video',
    '/pu/vid/',
    'fbcdn',
    'progressive',
    'story_video',
    'reel'
  ];

  const MAX_LOGS = 120;
  const MAX_VIDEOS_PER_TAB = 200;

  function sanitizeText(value, maxLen = 240) {
    const input = typeof value === 'string' ? value : String(value ?? '');
    const cleaned = input.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLen) return cleaned;
    return `${cleaned.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  function isHttpUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function normalizeUrl(url) {
    if (!isHttpUrl(url)) return null;

    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }

  function hostMatches(hostname, hints = MEDIA_HOST_HINTS) {
    const host = String(hostname || '').toLowerCase();
    return hints.some((hint) => host === hint || host.endsWith(`.${hint}`));
  }

  function lowerUrlParts(url) {
    const parsed = new URL(url);
    return {
      parsed,
      hostname: parsed.hostname.toLowerCase(),
      path: parsed.pathname.toLowerCase(),
      query: parsed.search.toLowerCase(),
      full: parsed.toString().toLowerCase()
    };
  }

  function isTikTokVideo(url) {
    const lower = String(url || '').toLowerCase();
    return (
      lower.includes('tiktokcdn.com') ||
      lower.includes('tiktok.com/video') ||
      lower.includes('v16-webapp') ||
      lower.includes('v19-webapp') ||
      lower.includes('v26-webapp') ||
      lower.includes('muscdn.com') ||
      (lower.includes('tiktok.com') && lower.includes('mime_type=video'))
    );
  }

  function isHlsUrl(url, contentType = '') {
    if (!isHttpUrl(url)) return false;
    const type = String(contentType || '').toLowerCase();
    if (HLS_MIME_TYPES.some((mime) => type.includes(mime))) return true;

    try {
      const { path, query } = lowerUrlParts(url);
      return path.endsWith('.m3u8') || path.endsWith('.m3u') || query.includes('.m3u8') || query.includes('.m3u');
    } catch {
      return false;
    }
  }

  function isDashUrl(url, contentType = '') {
    if (!isHttpUrl(url)) return false;
    const type = String(contentType || '').toLowerCase();
    if (DASH_MIME_TYPES.some((mime) => type.includes(mime))) return true;

    try {
      const { path, query } = lowerUrlParts(url);
      return path.endsWith('.mpd') || query.includes('.mpd');
    } catch {
      return false;
    }
  }

  function isSegmentUrl(url, contentType = '') {
    if (!isHttpUrl(url)) return false;
    const type = String(contentType || '').toLowerCase();

    if (type.includes('video/mp2t') || type.includes('iso.segment')) return true;

    try {
      const { path, query } = lowerUrlParts(url);
      return SEGMENT_EXTENSIONS.some((ext) => path.endsWith(ext) || query.includes(ext));
    } catch {
      return false;
    }
  }

  function isLikelyMediaUrl(url, contentType = '') {
    if (!isHttpUrl(url)) return false;
    const type = String(contentType || '').toLowerCase();
    const genericBinary = type.includes('application/octet-stream') || type.includes('binary/octet-stream');

    if (type && !genericBinary && VIDEO_MIME_TYPES.some((mime) => type.includes(mime))) return true;

    try {
      const { hostname, full } = lowerUrlParts(url);
      if (VIDEO_EXTENSIONS.some((ext) => full.includes(ext))) return true;
      if (STREAM_PATTERNS.some((ext) => full.includes(ext))) return true;
      if (SEGMENT_EXTENSIONS.some((ext) => full.includes(ext))) return true;
      return hostMatches(hostname) && MEDIA_PATH_HINTS.some((hint) => full.includes(hint));
    } catch {
      return false;
    }
  }

  function detectVideoKind(url, contentType = '') {
    if (!isHttpUrl(url)) return null;

    try {
      const { path, query, hostname, full } = lowerUrlParts(url);
      const type = String(contentType || '').toLowerCase();

      if (isHlsUrl(url, type) || isDashUrl(url, type)) return 'stream';
      if (isSegmentUrl(url, type)) return 'segment';
      if (VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext) || query.includes(ext))) return 'video';

      if (type && type.includes('video/')) return 'video';
      if (type && type.includes('application/mp4')) return 'video';

      if (hostMatches(hostname) && MEDIA_PATH_HINTS.some((hint) => full.includes(hint))) {
        return STREAM_PATTERNS.some((ext) => full.includes(ext)) ? 'stream' : 'video';
      }

      if (isTikTokVideo(url)) return 'video';
      return null;
    } catch {
      return null;
    }
  }

  function needsRecording(url, kind = '') {
    if (kind === 'recording' || kind === 'segment') return true;
    if (isDashUrl(url)) return true;

    try {
      const parsed = new URL(url);
      return parsed.hostname.includes('googlevideo.com');
    } catch {
      return false;
    }
  }

  function getYouTubeFilename(url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.includes('googlevideo.com')) return null;

      const mime = parsed.searchParams.get('mime') || '';
      const itag = parsed.searchParams.get('itag') || 'unknown';
      const ext = (mime.split('/')[1] || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
      return `youtube_itag${itag}.${ext}`;
    } catch {
      return null;
    }
  }

  function inferExtension(url, contentType = '', kind = 'video') {
    const type = String(contentType || '').toLowerCase();

    if (isHlsUrl(url, type)) return 'ts';
    if (isDashUrl(url, type)) return 'mp4';
    if (type.includes('webm')) return 'webm';
    if (type.includes('mp4')) return 'mp4';
    if (type.includes('ogg')) return 'ogg';

    try {
      const { path, query } = lowerUrlParts(url);
      const match = [...VIDEO_EXTENSIONS, ...STREAM_PATTERNS, ...SEGMENT_EXTENSIONS]
        .find((ext) => path.endsWith(ext) || query.includes(ext));
      if (match) {
        const ext = match.slice(1);
        return ext === 'm3u8' || ext === 'm3u' ? 'ts' : ext;
      }
    } catch {}

    return kind === 'stream' ? 'ts' : 'mp4';
  }

  function safeFilename(name, fallbackBase = 'video', fallbackExt = 'mp4') {
    const raw = sanitizeText(name || '', 180)
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .replace(/\.+$/, '')
      .trim();

    const fallback = `${fallbackBase}_${Date.now()}.${fallbackExt}`;
    if (!raw) return fallback;
    if (/\.[a-z0-9]{2,5}$/i.test(raw)) return raw;
    return `${raw}.${fallbackExt}`;
  }

  function getFilename(url, contentType = '', kind = 'video') {
    const ytName = getYouTubeFilename(url);
    if (ytName) return ytName;

    try {
      const parsed = new URL(url);
      const last = parsed.pathname.split('/').pop();
      const ext = inferExtension(url, contentType, kind);
      if (last && last.includes('.')) return safeFilename(decodeURIComponent(last), 'video', ext);
      const host = parsed.hostname.replace(/^www\./, '').split('.')[0] || 'video';
      return safeFilename(`${host}_${Date.now()}`, 'video', ext);
    } catch {
      return safeFilename('', 'video', 'mp4');
    }

    return safeFilename('', 'video', 'mp4');
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function parseSizeBytes(value) {
    if (Number.isFinite(value) && value > 0) return value;

    const match = String(value || '').match(/^([\d.]+)\s*(GB|MB|KB|B)$/i);
    if (!match) return 0;

    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return 0;

    const unit = match[2].toUpperCase();
    if (unit === 'GB') return amount * 1024 * 1024 * 1024;
    if (unit === 'MB') return amount * 1024 * 1024;
    if (unit === 'KB') return amount * 1024;
    return amount;
  }

  function isLikelyAdvertisementUrl(url) {
    if (!isHttpUrl(url)) return false;

    try {
      const { path, query } = lowerUrlParts(url);
      return /(?:^|[\/_.?=&-])(adserver|ads?|advert(?:ising)?|promo(?:tion)?|preroll|midroll|postroll|sponsor(?:ed)?|tracking|analytics|beacon|pixel)(?:$|[\/_.?=&-])/.test(`${path}?${query}`);
    } catch {
      return false;
    }
  }

  function getCandidateRelevance(candidate = {}) {
    const url = String(candidate.url || '');
    const lowerUrl = url.toLowerCase();
    const contentType = String(candidate.contentType || '').toLowerCase();
    const kind = String(candidate.kind || 'video').toLowerCase();
    const sources = Array.isArray(candidate.sources)
      ? candidate.sources.map((source) => String(source || '').toLowerCase())
      : [String(candidate.source || '').toLowerCase()];
    const recordOnly = Boolean(candidate.recordOnly || kind === 'recording');
    const stream = kind === 'stream' || isHlsUrl(url, contentType) || isDashUrl(url, contentType);
    const segment = kind === 'segment' || isSegmentUrl(url, contentType);
    const advertisement = Boolean(candidate.isAdvertisement) || isLikelyAdvertisementUrl(url);
    const sizeBytes = parseSizeBytes(candidate.contentLength) || parseSizeBytes(candidate.size);
    const width = Math.max(0, Number(candidate.videoWidth) || 0);
    const height = Math.max(0, Number(candidate.videoHeight) || 0);
    const duration = Math.max(0, Number(candidate.duration) || 0);
    let score = 0;
    let label = 'Secundario';
    let className = 'tag';

    if (recordOnly) {
      score += 150;
      label = 'Grabacion';
      className = 'tag warn';
    } else if (kind === 'video') {
      score += 620;
      label = 'Descargable';
      className = 'tag primary';
    } else if (stream) {
      score += 430;
      label = 'Stream';
      className = 'tag stream';
    }

    if (candidate.isMain) {
      score += 720;
      label = 'Principal';
      className = 'tag warn';
    }

    if (candidate.isPlaying) {
      score += 380;
      label = 'Principal';
      className = 'tag warn';
    }

    if (candidate.visible) score += 100;
    if (candidate.frameId === 0) score += 35;
    if (sources.includes('dom') || sources.includes('injected')) score += 90;
    if (sources.includes('network')) score += 25;
    if (contentType.startsWith('video/') || contentType.includes('application/mp4')) score += 130;
    if (candidate.downloadMode === 'direct') score += 75;
    if (candidate.downloadMode === 'hls') score += 25;
    if (candidate.acceptRanges) score += 20;
    if (lowerUrl.includes('googlevideo.com') || lowerUrl.includes('videoplayback')) score += 40;

    const pixels = width * height;
    if (pixels >= 1280 * 720) score += 160;
    else if (pixels >= 640 * 360) score += 105;
    else if (pixels >= 320 * 180) score += 55;
    else if (pixels > 0) score += 15;

    if (duration >= 90) score += 55;
    else if (duration >= 30) score += 30;

    if (sizeBytes > 0) {
      if (sizeBytes < 96 * 1024) score -= 340;
      else if (sizeBytes < 512 * 1024) score -= 120;
      else score += Math.min(Math.log2(sizeBytes / (1024 * 1024) + 1) * 45, 180);
    }

    if (contentType.startsWith('image/') || contentType.startsWith('audio/')) score -= 600;
    if (segment || lowerUrl.includes('segment')) score -= 1000;

    if (advertisement) {
      score -= 900;
      label = 'Anuncio';
      className = 'tag';
    } else if (segment) {
      label = 'Segmento';
      className = 'tag';
    }

    return { score, label, className };
  }

  function getVideoKey(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;

    try {
      const parsed = new URL(normalized);
      if (parsed.hostname.includes('googlevideo.com')) {
        const id = parsed.searchParams.get('id') || '';
        const itag = parsed.searchParams.get('itag') || '';
        if (id || itag) return `yt_${id}_${itag}`;
      }

      VOLATILE_MEDIA_QUERY_PARAMS.forEach((name) => parsed.searchParams.delete(name));
      parsed.searchParams.sort();
      return parsed.toString();
    } catch {
      return normalized;
    }
  }

  globalThis.VideoCatcherUtils = {
    DASH_MIME_TYPES,
    HLS_MIME_TYPES,
    MEDIA_HOST_HINTS,
    VIDEO_MIME_TYPES,
    MAX_LOGS,
    MAX_VIDEOS_PER_TAB,
    detectVideoKind,
    formatSize,
    getCandidateRelevance,
    getFilename,
    getVideoKey,
    hostMatches,
    inferExtension,
    isLikelyAdvertisementUrl,
    isDashUrl,
    isHlsUrl,
    isHttpUrl,
    isLikelyMediaUrl,
    isSegmentUrl,
    isTikTokVideo,
    needsRecording,
    normalizeUrl,
    parseSizeBytes,
    safeFilename,
    sanitizeText
  };
})();
