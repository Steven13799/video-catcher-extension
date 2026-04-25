(function () {
  if (window.__vcInjected) return;
  window.__vcInjected = true;

  const seenUrls = new Set();

  function detectKind(url) {
    const lower = String(url || '').toLowerCase();
    if (!/^https?:/.test(lower)) return null;

    if (
      lower.includes('.m3u8') ||
      lower.includes('.m3u') ||
      lower.includes('.mpd')
    ) {
      return 'stream';
    }

    if (
      lower.includes('googlevideo.com') ||
      lower.includes('videoplayback') ||
      lower.includes('itag=') ||
      lower.includes('.mp4') ||
      lower.includes('.webm') ||
      lower.includes('.mov') ||
      lower.includes('.mkv') ||
      lower.includes('.ogg') ||
      lower.includes('tiktokcdn.com') ||
      lower.includes('tiktok.com/video') ||
      lower.includes('v16-webapp') ||
      lower.includes('v19-webapp') ||
      lower.includes('v26-webapp') ||
      lower.includes('muscdn.com')
    ) {
      return 'video';
    }

    return null;
  }

  function emit(url, isMain) {
    const kind = detectKind(url);
    if (!kind) return;

    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    if (seenUrls.size > 600) seenUrls.clear();

    window.dispatchEvent(
      new CustomEvent('__vc_video_found', {
        detail: {
          url,
          kind,
          isMain: Boolean(isMain)
        }
      })
    );
  }

  function emitRecordable(reason, isMain) {
    window.dispatchEvent(
      new CustomEvent('__vc_video_found', {
        detail: {
          recordOnly: true,
          reason,
          isMain: Boolean(isMain)
        }
      })
    );
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function') return;

    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        const request = args[0];
        const url = request instanceof Request ? request.url : String(request);
        emit(url, false);
      } catch {}

      const result = Reflect.apply(originalFetch, this, args);
      result.then((response) => {
        try {
          if (response?.url) emit(response.url, false);
        } catch {}
      }).catch(() => {});
      return result;
    };
  }

  function patchXhr() {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        emit(String(url), false);
        this.addEventListener('load', () => {
          try {
            if (this.responseURL) emit(this.responseURL, false);
          } catch {}
        }, { once: true });
      } catch {}

      return Reflect.apply(originalOpen, this, arguments);
    };
  }

  function patchMediaProperty(target, propertyName, mainResolver) {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, propertyName);
    if (!descriptor?.set || !descriptor.configurable) return;

    Object.defineProperty(target, propertyName, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        return descriptor.get ? descriptor.get.call(this) : undefined;
      },
      set(value) {
        try {
          if (typeof value === 'string') {
            if (/^https?:/i.test(value)) emit(value, mainResolver(this));
            else if (/^(blob|mediastream):/i.test(value)) emitRecordable('Video blob/MSE detectado', mainResolver(this));
          }
        } catch {}

        return descriptor.set.call(this, value);
      }
    });
  }

  function patchSetAttribute() {
    const originalSetAttribute = Element.prototype.setAttribute;

    Element.prototype.setAttribute = function (name, value) {
      try {
        const attr = String(name || '').toLowerCase();
        if (
          attr === 'src' &&
          typeof value === 'string' &&
          (this.tagName === 'VIDEO' || this.tagName === 'SOURCE')
        ) {
          const isMain = this.tagName === 'VIDEO' && (!this.paused || this.currentTime > 0);
          if (/^https?:/i.test(value)) emit(value, isMain);
          else if (/^(blob|mediastream):/i.test(value)) emitRecordable('Video blob/MSE detectado', isMain);
        }
      } catch {}

      return Reflect.apply(originalSetAttribute, this, arguments);
    };
  }

  function patchSrcObject() {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (!descriptor?.set || !descriptor.configurable) return;

    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        return descriptor.get ? descriptor.get.call(this) : undefined;
      },
      set(value) {
        try {
          if (value) emitRecordable('MediaStream detectado', !this.paused || this.currentTime > 0);
        } catch {}

        return descriptor.set.call(this, value);
      }
    });
  }

  function observePerformance() {
    try {
      performance.getEntriesByType('resource').forEach((entry) => emit(entry.name, false));
      if (!('PerformanceObserver' in window)) return;

      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => emit(entry.name, false));
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {}
  }

  patchFetch();
  patchXhr();
  patchMediaProperty(HTMLMediaElement.prototype, 'src', (element) => !element.paused || element.currentTime > 0);
  patchMediaProperty(typeof HTMLSourceElement !== 'undefined' ? HTMLSourceElement.prototype : null, 'src', () => false);
  patchSrcObject();
  patchSetAttribute();
  observePerformance();
})();
