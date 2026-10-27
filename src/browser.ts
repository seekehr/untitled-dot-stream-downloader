import type { CDPSession } from 'playwright';
import { HttpError } from './download.ts';

// Use Chrome's network stack and stream binary data in bounded chunks.
export async function chromeFetch(session: CDPSession, url: string): Promise<Response> {
  let stream: string | undefined;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { if (stream) await session.send('IO.close', { handle: stream }); }
    finally { await session.detach(); }
  }
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const { resource } = await session.send('Network.loadNetworkResource', {
      frameId: frameTree.frame.id, url,
      options: { disableCache: true, includeCredentials: true },
    });
    stream = resource.stream;
    const status = resource.httpStatusCode ?? 0;
    if (status < 200 || status >= 300) throw new HttpError(status || 502, null, 'Chrome file download');
    if (!resource.success || !stream) throw new Error('Chrome could not open the audio stream.');
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await session.send('IO.read', { handle: stream!, size: 1024 * 1024 });
          if (chunk.data) controller.enqueue(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
          if (chunk.eof) { await close(); controller.close(); }
        } catch (error) {
          await close().catch(() => {});
          controller.error(error);
        }
      },
      cancel: close,
    });
    return new Response(body, { status });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
