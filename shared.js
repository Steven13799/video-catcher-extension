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
      return normalized;
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
    getFilename,
    getVideoKey,
    hostMatches,
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
  };
})();
