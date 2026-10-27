import { open, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

export function safeName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120).replace(/[. ]+$/g, '') || 'untitled';
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
}

export function storagePath(url: string): { bucket: string; key: string } | null {
  const match = new URL(url).pathname.match(/^\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?([^/]+)\/(.+)$/);
  return match ? { bucket: decodeURIComponent(match[1]), key: decodeURIComponent(match[2]) } : null;
}

export async function parallel<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('concurrency must be an integer from 1 to 16.');
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  });
  const results = await Promise.allSettled(workers);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

// A failed transfer never leaves a final filename containing partial audio.
export async function download(url: string, destination: string): Promise<void> {
  const temporary = `${destination}.part`;
  let ownsTemporary = false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const handle = await open(temporary, 'wx');
    ownsTemporary = true;
    await pipeline(Readable.fromWeb(response.body as unknown as ReadableStream), handle.createWriteStream());
    await rename(temporary, destination);
  } finally {
    if (ownsTemporary) await rm(temporary, { force: true });
  }
}

export async function tag(file: string, extension: string, metadata: Record<string, string>, cover?: string): Promise<void> {
  // These containers support embedded cover images. Other formats retain original
  // tags and use the separately saved cover and complete JSON metadata.
  if (!['mp3', 'flac', 'm4a', 'mp4', 'aiff', 'aif'].includes(extension)) return;
  const output = `${file}.tagged.${extension}`;
  const args = ['-nostdin', '-v', 'error', '-i', file];
  if (cover) args.push('-i', cover);
  args.push('-map', '0:a', '-map_metadata', '0', '-c:a', 'copy');
  if (cover) args.push('-map', '1:v:0', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
  else args.push('-map', '0:v?', '-c:v', 'copy');
  for (const [key, value] of Object.entries(metadata)) if (value) args.push('-metadata', `${key}=${value}`);
  if (extension === 'mp3') args.push('-id3v2_version', '3');
  args.push(output);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg as unknown as string, args, { windowsHide: true });
      let error = '';
      child.stderr.on('data', chunk => { error += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Tagging failed: ${error.trim()}`)));
    });
    await rename(output, file);
  } finally {
    await rm(output, { force: true });
  }
}
