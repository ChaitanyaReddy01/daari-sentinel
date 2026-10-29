import { z } from 'zod';

import { del, list } from '@vercel/blob';

import { errMessage, jsonError } from '@/lib/clips';
import { clientIpFrom } from '@/lib/ratelimit';
import { assertTryBudget, assertTryEnabled, tryCreate, tryErrorStatus } from '@/lib/try-limits';

const Body = z.object({
  blobUrl: z.string().url().max(500),
  fileName: z.string().min(1).max(200),
  durationSec: z.number().positive().max(30),
});

const STALE_MS = 60 * 60 * 1000;

function blobToken(): string {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error('BLOB_READ_WRITE_TOKEN is not set.');
  return t;
}

/** Start a guarded try; also sweeps tries/ blobs older than 1 hour. */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return jsonError(`Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`, 400);
  }
  const { blobUrl, fileName, durationSec } = parsed.data;
  let url: URL;
  try {
    url = new URL(blobUrl);
  } catch {
    return jsonError('blobUrl is not a valid URL.', 400);
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.blob.vercel-storage.com')) {
    return jsonError('blobUrl must be an https Vercel Blob URL.', 400);
  }
  if (!url.pathname.startsWith('/tries/') && !url.pathname.includes('/tries/')) {
    return jsonError('blobUrl must live under tries/.', 400);
  }

  try {
    assertTryEnabled();
    await assertTryBudget();
    // Best-effort sweep of orphaned try uploads (never fails the start).
    try {
      const token = blobToken();
      const now = Date.now();
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: 'tries/', cursor, token });
        for (const b of page.blobs) {
          if (now - new Date(b.uploadedAt).getTime() > STALE_MS) {
            await del(b.url, { token }).catch(() => {});
          }
        }
        cursor = page.cursor;
      } while (cursor);
    } catch (err) {
      console.warn(`[try-start] stale sweep failed: ${errMessage(err)}`);
    }
    const tryId = await tryCreate({
      ip: clientIpFrom(req),
      blobUrl,
      fileName,
      durationSec,
    });
    return Response.json({ tryId });
  } catch (err) {
    return jsonError(errMessage(err), tryErrorStatus(err));
  }
}
