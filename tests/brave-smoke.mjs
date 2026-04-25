import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const EXTENSION_DIR = process.cwd();
const BRAVE_PATHS = [
  process.env.BRAVE_PATH,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  path.join(os.homedir(), 'AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe')
].filter(Boolean);

function findBravePath() {
  for (const candidate of BRAVE_PATHS) {
    try {
      return candidate;
    } catch {}
  }
  return BRAVE_PATHS[0];
}

function createFixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`
<!doctype html>
<html>
<head><title>Video Catcher fixture</title></head>
<body>
  <video id="direct" src="/media/from-dom.webm" muted></video>
  <video id="blob-video" muted></video>
  <script type="application/json" id="state">
    {"media":"https:\\/\\/video.twimg.com\\/ext_tw_video\\/123\\/pu\\/vid\\/720x720\\/clip.mp4?tag=12"}
  </script>
  <script>
    fetch('/media/direct.mp4').catch(() => {});
    fetch('/media/master.m3u8').catch(() => {});
    const blob = new Blob(['fixture'], { type: 'video/mp4' });
    document.getElementById('blob-video').src = URL.createObjectURL(blob);
  </script>
</body>
</html>`);
      return;
    }

    if (url.pathname === '/media/direct.mp4') {
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': '150000'
      });
      response.end(Buffer.alloc(150000, 0));
      return;
    }

    if (url.pathname === '/media/from-dom.webm') {
      response.writeHead(200, {
        'content-type': 'video/webm',
        'content-length': '150000'
      });
      response.end(Buffer.alloc(150000, 0));
      return;
    }

    if (url.pathname === '/media/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nsegment0.ts\n#EXT-X-ENDLIST\n');
      return;
    }

    if (url.pathname === '/media/segment0.ts') {
      response.writeHead(200, { 'content-type': 'video/mp2t' });
      response.end(Buffer.alloc(1024, 0));
      return;
    }

    response.writeHead(404);
    response.end('not found');
  });

  return server;
}

async function getFreePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  return port;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function waitForJson(url, predicate, timeoutMs = 12000) {
  const started = Date.now();
  let lastValue = null;

  while (Date.now() - started < timeoutMs) {
    try {
      lastValue = await fetchJson(url);
      if (predicate(lastValue)) return lastValue;
    } catch {}
    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}; last value: ${JSON.stringify(lastValue)}`);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];

    this.webSocket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) {
        this.events.push(message);
        return;
      }

      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }

  async ready() {
    while (this.webSocket.readyState === WebSocket.CONNECTING) await delay(25);
  }

  async send(method, params = {}) {
    await this.ready();
    const id = this.nextId++;
    this.webSocket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.webSocket.close();
  }
}

async function waitForProcess(child, timeoutMs = 5000) {
  let timeoutId;
  return Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => {
      timeoutId = setTimeout(resolve, timeoutMs);
    })
  ]).finally(() => clearTimeout(timeoutId));
}

async function stopBraveTree(child, userDataDir) {
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }

  if (child.pid) {
    await waitForProcess(spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }), 5000);
  }

  const escapedUserDataDir = userDataDir.replace(/'/g, "''");
  await waitForProcess(spawn('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "name = 'brave.exe'" | Where-Object { $_.CommandLine -like '*${escapedUserDataDir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  ], { stdio: 'ignore' }), 5000);
}

async function waitForEvent(client, predicate, timeoutMs = 8000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const event = client.events.find(predicate);
    if (event) return event;
    await delay(100);
  }

  throw new Error('Timed out waiting for CDP event');
}

async function run() {
  const bravePath = findBravePath();
  const server = createFixtureServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const port = server.address().port;
  const remotePort = await getFreePort();
  const userDataDir = path.join(os.tmpdir(), `video-catcher-brave-${Date.now()}`);
  const pageUrl = `http://127.0.0.1:${port}/`;

  const brave = spawn(bravePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    pageUrl
  ], { stdio: 'ignore' });

  try {
    await waitForJson(`http://127.0.0.1:${remotePort}/json/version`, Boolean);
    const targets = await waitForJson(
      `http://127.0.0.1:${remotePort}/json/list`,
      (items) => items.some((item) => item.type === 'page' && item.url === pageUrl),
      15000
    );

    const pageTarget = targets.find((item) => item.type === 'page' && item.url === pageUrl);
    assert.ok(pageTarget, 'fixture page target should exist');

    await delay(2500);

    const client = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    const contextEvent = await waitForEvent(
      client,
      (event) => event.method === 'Runtime.executionContextCreated' &&
        event.params?.context?.origin?.startsWith('chrome-extension://')
    );
    const contextId = contextEvent.params.context.id;

    const result = await client.send('Runtime.evaluate', {
      expression: `new Promise((resolve) => chrome.runtime.sendMessage({ action: 'getVideos' }, resolve))`,
      contextId,
      awaitPromise: true,
      returnByValue: true
    });

    const videos = result.result.value?.videos || [];
    const urls = videos.map((video) => video.url).join('\n');

    assert.ok(videos.some((video) => video.kind === 'video' && video.url.includes('/media/direct.mp4')), urls);
    assert.ok(videos.some((video) => video.kind === 'stream' && video.url.includes('/media/master.m3u8')), urls);
    assert.ok(videos.some((video) => video.url.includes('video.twimg.com')), urls);
    assert.ok(videos.some((video) => video.recordOnly), JSON.stringify(videos, null, 2));

    const nativeStatusResult = await client.send('Runtime.evaluate', {
      expression: `
        new Promise((resolve) => chrome.runtime.sendMessage(
          { action: 'getNativeStatus' },
          (response) => resolve(response || { ok: false, error: chrome.runtime.lastError?.message })
        ))
      `,
      contextId,
      awaitPromise: true,
      returnByValue: true
    });

    assert.equal(nativeStatusResult.result.value?.ok, true, JSON.stringify(nativeStatusResult.result.value));
    assert.equal(typeof nativeStatusResult.result.value?.state, 'object');

    if (process.env.VC_CHECK_NATIVE === '1') {
      const nativeCheckResult = await client.send('Runtime.evaluate', {
        expression: `
          new Promise((resolve) => chrome.runtime.sendMessage(
            { action: 'checkNativeHost' },
            (response) => resolve(response || { ok: false, error: chrome.runtime.lastError?.message })
          ))
        `,
        contextId,
        awaitPromise: true,
        returnByValue: true
      });

      assert.equal(nativeCheckResult.result.value?.ok, true, JSON.stringify(nativeCheckResult.result.value));
      assert.equal(nativeCheckResult.result.value?.state?.tools?.ok, true, JSON.stringify(nativeCheckResult.result.value));
    }

    const hlsResult = await client.send('Runtime.evaluate', {
      expression: `
        new Promise((resolve) => chrome.runtime.sendMessage({
          action: 'downloadVideo',
          url: '${pageUrl}media/master.m3u8',
          filename: 'fixture.ts',
          kind: 'stream',
          contentType: 'application/vnd.apple.mpegurl',
          referer: '${pageUrl}'
        }, (response) => resolve(response || { ok: false, error: chrome.runtime.lastError?.message })))
      `,
      contextId,
      awaitPromise: true,
      returnByValue: true
    });

    assert.equal(hlsResult.result.value?.ok, true, JSON.stringify(hlsResult.result.value));
    client.close();

    console.log('brave-smoke: ok');
  } finally {
    await stopBraveTree(brave, userDataDir);
    server.close();
  }
}

run().catch((error) => {
  console.error('brave-smoke: fail');
  console.error(error);
  process.exitCode = 1;
});
