import { z } from 'zod';

import { del } from '@vercel/blob';

import { errMessage, jsonError } from '@/lib/clips';
import { clientIpFrom } from '@/lib/ratelimit';
import { tryErrorStatus, tryFinishState } from '@/lib/try-limits';

const Body = z.object({ tryId: z.string().min(1).max(64) });

/** Delete the try's blob and close it out. */
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

  try {
    const st = await tryFinishState(parsed.data.tryId, clientIpFrom(req));
    try {
      const url = new URL(st.blobUrl);
      if (url.hostname.endsWith('.blob.vercel-storage.com') && url.pathname.includes('/tries/')) {
        await del(st.blobUrl);
      }
    } catch (err) {
      console.warn(`[try-finish] blob delete failed: ${errMessage(err)}`);
    }
    return Response.json({ cost: st.cost });
  } catch (err) {
    return jsonError(errMessage(err), tryErrorStatus(err));
  }
}
