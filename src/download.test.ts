import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { safeName, storagePath, download, tag, parallel } from './download.ts';
import { chromeFetch } from './browser.ts';
import type { CDPSession } from 'playwright';

test('Chrome transport streams binary WAV bytes exactly and releases its resource', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'untitled-wav-'));
  const wav = execFileSync(ffmpeg as unknown as string, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.01', '-f', 'wav', '-'], { windowsHide: true });
  const chunks = [wav.subarray(0, 17), wav.subarray(17, 51), wav.subarray(51)];
  let closed = 0;
  let detached = 0;
  const session = {
    async send(method: string, params: Record<string, unknown>) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'project' } } };
      if (method === 'Network.loadNetworkResource') {
        assert.deepEqual(params.options, { disableCache: true, includeCredentials: true });
        return { resource: { success: true, httpStatusCode: 200, stream: 'audio' } };
      }
      if (method === 'IO.read') return { data: chunks.shift()!.toString('base64'), base64Encoded: true, eof: chunks.length === 0 };
      if (method === 'IO.close') { closed++; return {}; }
      throw new Error(`Unexpected command: ${method}`);
    },
    async detach() { detached++; },
  } as unknown as CDPSession;
  try {
    const file = join(directory, 'Song.wav');
    await download('https://example.com/audio.wav', file, { fetch: url => chromeFetch(session, url) });
    assert.deepEqual(await readFile(file), wav);
    assert.equal(closed, 1);
    assert.equal(detached, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Chrome HTTP denial reports the transport and cleans up its session', async () => {
  let detached = false;
  const session = {
    async send(method: string) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'project' } } };
      return { resource: { success: false, httpStatusCode: 403 } };
    },
    async detach() { detached = true; },
  } as unknown as CDPSession;
  await assert.rejects(chromeFetch(session, 'https://example.com/audio.wav'), /Chrome file download failed: HTTP 403/);
  assert.ok(detached);
});

test('untrusted names stay within one filesystem component', () => {
  for (const name of ['../album', 'a/b\\c', 'CON', 'NUL.mp3', '...', 'a: b?']) {
    const safe = safeName(name);
    assert.ok(safe && !/[<>:"/\\|?*]/.test(safe) && !/[. ]$/.test(safe));
    assert.ok(!/^(con|nul)(\.|$)/i.test(safe));
  }
});

test('storage URLs retain bucket and decoded object key', () => {
  assert.deepEqual(storagePath('https://sb.untitled.stream/storage/v1/object/private-audio/user/a%20b.wav'), {
    bucket: 'private-audio', key: 'user/a b.wav',
  });
  assert.deepEqual(storagePath('https://sb.untitled.stream/storage/v1/object/sign/private-project-art/user/cover.png?token=x'), {
    bucket: 'private-project-art', key: 'user/cover.png',
  });
  assert.equal(storagePath('https://example.com/cover.png'), null);
});

test('streams exact bytes and removes incomplete transfers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'untitled-test-'));
  const bytes = Buffer.from([0, 255, 1, 2, 3]);
  const server = createServer((request, response) => {
    if (request.url === '/bad') {
      response.writeHead(200, { 'Content-Length': '100' });
      response.write(bytes);
      setImmediate(() => response.destroy());
    } else response.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const file = join(directory, 'audio.mp3');
    await download(`http://127.0.0.1:${address.port}/`, file);
    assert.deepEqual(await readFile(file), bytes);
    await assert.rejects(download(`http://127.0.0.1:${address.port}/bad`, join(directory, 'failed.mp3'), { retries: 0 }));
    assert.deepEqual(await readdir(directory), ['audio.mp3']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('retries refresh URLs and headers, recover interrupted files, and stop at the limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'untitled-retry-'));
  const hits = new Map<string, number>();
  const tokens: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const count = (hits.get(url.pathname) ?? 0) + 1;
    hits.set(url.pathname, count);
    if (url.pathname === '/recover') {
      tokens.push(url.searchParams.get('token')!);
      assert.equal(request.headers.cookie, 'session=example');
      response.writeHead([403, 429, 503, 200][Math.min(count - 1, 3)], { 'Retry-After': '0' });
    } else if (url.pathname === '/partial' && count === 1) {
      response.writeHead(200, { 'Content-Length': '100' });
      response.write('partial');
      setImmediate(() => response.destroy());
      return;
    } else if (url.pathname === '/forbidden') response.writeHead(403);
    else if (url.pathname === '/missing') response.writeHead(404);
    response.end('complete');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    let refreshes = 0;
    await download(async () => ({ url: `${base}/recover?token=${++refreshes}`, headers: { Cookie: 'session=example' } }), join(directory, 'recovered.mp3'), { delayMs: 0 });
    assert.deepEqual(tokens, ['1', '2', '3', '4']);
    assert.equal(await readFile(join(directory, 'recovered.mp3'), 'utf8'), 'complete');
    await download(`${base}/partial`, join(directory, 'partial.mp3'), { delayMs: 0 });
    assert.equal(await readFile(join(directory, 'partial.mp3'), 'utf8'), 'complete');
    await assert.rejects(download(`${base}/forbidden`, join(directory, 'forbidden.mp3'), { retries: 2, delayMs: 0 }), /403/);
    assert.equal(hits.get('/forbidden'), 3);
    await assert.rejects(download(`${base}/missing`, join(directory, 'missing.mp3'), { delayMs: 0 }), /404/);
    assert.equal(hits.get('/missing'), 1);
    assert.deepEqual((await readdir(directory)).sort(), ['partial.mp3', 'recovered.mp3']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('parallel downloads overlap, respect the limit, and keep files separate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'untitled-parallel-'));
  let active = 0;
  let peak = 0;
  const server = createServer((request, response) => {
    peak = Math.max(peak, ++active);
    setTimeout(() => { active--; response.end(request.url); }, 20);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const items = Array.from({ length: 8 }, (_, i) => i);
  try {
    await parallel(items, 3, i => download(`http://127.0.0.1:${port}/${i}`, join(directory, `${i}.mp3`)));
    assert.equal(peak, 3);
    for (const i of items) assert.equal(await readFile(join(directory, `${i}.mp3`), 'utf8'), `/${i}`);
    assert.equal((await readdir(directory)).length, items.length);
    await assert.rejects(parallel(items, 0, async () => {}), /concurrency/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('embeds cover and tags, preserving audio and existing metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'untitled-tags-'));
  const run = (...args: string[]) => execFileSync(ffmpeg as unknown as string, ['-v', 'error', ...args], { windowsHide: true });
  try {
    const file = join(directory, 'track.mp3');
    const cover = join(directory, 'cover.jpg');
    run('-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-metadata', 'comment=keep me', file);
    run('-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', cover);
    const before = run('-i', file, '-map', '0:a', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-');
    await tag(file, 'mp3', { title: 'Song', album: 'Project', artist: 'Artist', track: '1/2' }, cover);
    const after = run('-i', file, '-map', '0:a', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-');
    assert.deepEqual(after, before);
    const metadata = run('-i', file, '-f', 'ffmetadata', '-').toString();
    for (const value of ['title=Song', 'album=Project', 'artist=Artist', 'comment=keep me', 'track=1/2']) assert.ok(metadata.includes(value), metadata);
    const image = run('-i', file, '-map', '0:v', '-c:v', 'copy', '-f', 'image2pipe', '-');
    assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
