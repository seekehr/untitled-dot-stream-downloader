import { chromium, type Page } from 'playwright';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { download, safeName, storagePath, tag, parallel } from './download.ts';

type Track = {
  id: string; title?: string; artist_name?: string; audio_url?: string;
  file_type?: string; can_download_track?: boolean; artwork_url?: string;
};
type Project = { title: string; artist_name?: string; artwork_url?: string };
type ProjectData = { project: Project; tracks: Track[] };

async function api<T>(page: Page, path: string): Promise<T> {
  return await page.evaluate(async path => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`untitled API: HTTP ${response.status}. Retry with --login to sign in and accept the invite.`);
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('Sign in or finish the browser challenge, then retry.');
    }
    return response.json();
  }, path) as T;
}

async function signedUrl(page: Page, url: string): Promise<string> {
  const location = storagePath(url);
  if (!location) return url;
  const { bucket, key } = location;
  const result = await api<{ url: string }>(page,
    `/api/storage/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}/signedUrl?durationInSeconds=3600&download=true`);
  return result.url;
}

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'config.json' },
    track: { type: 'string', multiple: true },
    list: { type: 'boolean' },
    login: { type: 'boolean' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: npm start -- [--login] [--list] [--track 1 --track 3] [--config config.json]\nPrompts for an optional invite URL, then the project URL.');
    return;
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const inviteInput = (await input.question('Invite URL (optional, press Enter to skip): ')).trim();
    const projectInput = (await input.question('Project URL: ')).trim();
    const parseUrl = (value: string) => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'untitled.stream') throw new Error('Use an https://untitled.stream URL.');
      return url;
    };
    const inviteUrl = inviteInput ? parseUrl(inviteInput) : undefined;
    const url = parseUrl(projectInput);
    const slug = url.pathname.match(/^\/library\/project\/([^/]+)\/?$/)?.[1];
    if (!slug) throw new Error('Project URL must be https://untitled.stream/library/project/PROJECT_SLUG.');
    let config: { output?: string; chromeEndpoint?: string; concurrency?: number } = {};
    try { config = JSON.parse(await readFile(values.config!, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const concurrency = config.concurrency ?? 6;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('concurrency must be an integer from 1 to 16.');
    const expandHome = (path: string) => path.replace(/^~(?=[/\\]|$)/, homedir());
    console.log('Connecting to your running Chrome. Approve its debugging connection prompt if shown.');
    const browser = await chromium.connectOverCDP(config.chromeEndpoint ?? 'chrome', { timeout: 120_000, noDefaults: true })
      .catch(() => { throw new Error('Could not connect. Open your regular Chrome (144+), enable chrome://inspect/#remote-debugging, retry, and approve its connection prompt.'); });
    const context = browser.contexts()[0];
    if (!context) { await browser.close(); throw new Error('Chrome has no available browser context.'); }
    let page: Page | undefined;
    try {
      page = await context.newPage();
      const projectPage = page;
      if (inviteUrl) {
        await page.goto(inviteUrl.href, { waitUntil: 'domcontentloaded' });
        await input.question('Sign in and accept the invite in the browser. Press Enter here when ready. ');
      }
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      if (values.login && !inviteUrl) {
        await input.question('Sign in to access the project in the browser. Press Enter here when ready. ');
      }
      if (new URL(page.url()).hostname !== 'untitled.stream') throw new Error('Finish signing in to untitled.stream, then retry.');
      const data = await api<ProjectData>(page, `/project?slug=${encodeURIComponent(slug)}&tracks=true`);
      if (!data.project || !Array.isArray(data.tracks)) throw new Error('Project unavailable. Retry with --login to sign in and accept its invite.');
      for (const [index, track] of data.tracks.entries()) {
        console.log(`${index + 1}. ${track.title || 'Untitled'}${track.can_download_track ? '' : ' (download unavailable)'}`);
      }
      if (values.list) return;
      const selectors = values.track ?? [];
      for (const selector of selectors) {
        if (!data.tracks.some((track, i) => selector === String(i + 1) || selector === track.id)) {
          throw new Error(`Unknown track: ${selector}. Use --list to see track numbers.`);
        }
      }
      const selected = data.tracks.map((track, index) => ({ track, index }))
        .filter(({ track, index }) => !selectors.length || selectors.includes(String(index + 1)) || selectors.includes(track.id));
      if (!selected.length) throw new Error('No tracks returned for this project.');
      const folder = resolve(expandHome((config.output ?? '~/Music/{projectName}').replaceAll('{projectName}', safeName(data.project.title))));
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'project.json'), JSON.stringify(data, null, 2));
      const covers = new Map<string, Promise<string>>();
      function saveCover(url: string, name: string): Promise<string> {
        if (covers.has(url)) return covers.get(url)!;
        const pending = (async () => {
          const extension = extname(new URL(url).pathname).slice(1).toLowerCase();
          if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension)) throw new Error('Unrecognized artwork format.');
          const file = join(folder, `${name}.${extension}`);
          await download(await signedUrl(projectPage, url), file);
          return file;
        })();
        covers.set(url, pending);
        return pending;
      }
      const projectCover = data.project.artwork_url ? await saveCover(data.project.artwork_url, 'cover') : undefined;
      let failed = 0;
      const filenames = new Set<string>();
      console.log(`Downloading up to ${concurrency} tracks in parallel.`);
      await parallel(selected, concurrency, async ({ track, index }) => {
        try {
          if (!track.can_download_track || !track.audio_url) throw new Error('Download not permitted or original audio unavailable.');
          const audioUrl = track.audio_url;
          const extension = (track.file_type || extname(new URL(audioUrl).pathname).slice(1)).replace(/^\./, '').toLowerCase();
          if (!/^[a-z0-9]{1,10}$/.test(extension)) throw new Error('Unrecognized audio extension.');
          const title = safeName(track.title || 'Untitled');
          let filename = `${title}.${extension}`;
          for (let suffix = 2; filenames.has(filename.toLowerCase()); suffix++) filename = `${title} (${suffix}).${extension}`;
          filenames.add(filename.toLowerCase());
          const file = join(folder, filename);
          try { await access(file); throw new Error('File already exists; move it before retrying.'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const cover = track.artwork_url ? await saveCover(track.artwork_url, `${filename}-cover`) : projectCover;
          await download(await signedUrl(projectPage, audioUrl), file);
          await tag(file, extension, {
            title: track.title ?? '', album: data.project.title,
            artist: track.artist_name || data.project.artist_name || '',
            track: `${index + 1}/${data.tracks.length}`,
          }, cover);
          console.log(`Saved ${file}`);
        } catch (error) {
          failed++;
          console.error(`${track.title || track.id}: ${(error as Error).message}`);
        }
      });
      if (failed) throw new Error(`${failed} track(s) failed. Originals already downloaded are kept if tagging fails.`);
      console.log(`Done: ${folder}`);
    } finally {
      await page?.close().catch(() => {});
      await browser.close();
    }
  } finally {
    input.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
