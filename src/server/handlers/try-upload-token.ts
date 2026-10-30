import { handleUpload } from '@vercel/blob/client';

import { jsonError } from '@/lib/clips';
import { clientIpFrom } from '@/lib/ratelimit';
import {
  assertTryBudget,
  assertTryEnabled,
  assertTryQuota,
  isOwnerRequest,
  TryClientError,
  tryPublicError,
} from '@/lib/try-limits';

/**
 * Client-upload token route: the video body never touches our server.
 * Every failure returns clear JSON (never a crash), so the client can show
 * the server's real message instead of the blob SDK's generic one.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return jsonError('File uploads are not configured.', 500);
  }
  try {
    const result = await handleUpload({
      body: body as Parameters<typeof handleUpload>[0]['body'],
      request: req,
      token,
      onBeforeGenerateToken: async (pathname) => {
        assertTryEnabled();
        await assertTryBudget();
        await assertTryQuota(clientIpFrom(req), isOwnerRequest(req));
        if (!pathname.startsWith('tries/')) {
          throw new TryClientError('Uploads must live under tries/.');
        }
        return {
          allowedContentTypes: ['video/mp4', 'video/quicktime'],
          maximumSizeInBytes: 50 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
      // Completion needs no server work: the client drives /api/try/finish.
      onUploadCompleted: async () => {},
    });
    return Response.json(result);
  } catch (err) {
    const pub = tryPublicError(err);
    return jsonError(pub.message, pub.status);
  }
}
