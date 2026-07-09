import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadUtils() {
  const filePath = path.resolve(process.cwd(), 'shared.js');
  const source = await fs.readFile(filePath, 'utf8');
  const context = {
    URL,
    globalThis: {}
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'shared.js' });
  return context.globalThis.VideoCatcherUtils;
}

async function run() {
  const utils = await loadUtils();

  assert.equal(utils.detectVideoKind('https://cdn.example.com/video.mp4'), 'video');
  assert.equal(utils.detectVideoKind('https://cdn.example.com/master.m3u8'), 'stream');
  assert.equal(utils.detectVideoKind('https://cdn.example.com/live.mpd'), 'stream');
  assert.equal(utils.detectVideoKind('https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/file'), 'video');
  assert.equal(utils.detectVideoKind('https://cdn.example.com/chunk0001.m4s'), 'segment');
  assert.equal(utils.isLikelyMediaUrl('https://scontent.xx.fbcdn.net/v/t42.1790-2/video.mp4'), true);
  assert.equal(utils.isHlsUrl('https://example.com/playlist.m3u8'), true);
  assert.equal(utils.needsRecording('https://example.com/manifest.mpd', 'stream'), true);
  assert.equal(utils.safeFilename('bad:name?.mp4', 'video', 'mp4'), 'bad_name_.mp4');

  const youtubeUrl = 'https://r1---sn.googlevideo.com/videoplayback?id=abc123&itag=18&range=1-2';
  assert.equal(utils.getVideoKey(youtubeUrl), 'yt_abc123_18');

  const rangeStart = 'https://cdn.example.com/video.mp4?token=abc&range=0-1048575';
  const rangeNext = 'https://cdn.example.com/video.mp4?range=1048576-2097151&token=abc';
  assert.equal(utils.getVideoKey(rangeStart), utils.getVideoKey(rangeNext));

  const mainVideo = {
    url: 'https://cdn.example.com/media/program.mp4',
    kind: 'video',
    contentType: 'video/mp4',
    contentLength: 24 * 1024 * 1024,
    isMain: true,
    isPlaying: true,
    visible: true,
    videoWidth: 1280,
    videoHeight: 720,
    duration: 90,
    sources: ['network', 'dom'],
    downloadMode: 'direct',
    acceptRanges: true,
    frameId: 0
  };
  const adVideo = {
    url: 'https://ads.example.com/preroll/advertisement.mp4',
    kind: 'video',
    contentType: 'video/mp4',
    contentLength: 3 * 1024 * 1024,
    source: 'network',
    downloadMode: 'direct'
  };
  const recordingFallback = {
    url: 'https://example.com/watch/123',
    kind: 'recording',
    recordOnly: true,
    isMain: false,
    source: 'dom'
  };

  assert.equal(utils.isLikelyAdvertisementUrl(adVideo.url), true);
  assert.equal(utils.getCandidateRelevance(adVideo).label, 'Anuncio');
  assert.ok(utils.getCandidateRelevance(mainVideo).score > utils.getCandidateRelevance(adVideo).score);
  assert.ok(utils.getCandidateRelevance(mainVideo).score > utils.getCandidateRelevance(recordingFallback).score);

  assert.equal(utils.sanitizeText('a\u0000b\tc', 10), 'a b c');
  assert.equal(utils.sanitizeText('abcdefghijk', 8), 'abcde...');

  console.log('video-utils: ok');
}

run().catch((error) => {
  console.error('video-utils: fail');
  console.error(error);
  process.exitCode = 1;
});
