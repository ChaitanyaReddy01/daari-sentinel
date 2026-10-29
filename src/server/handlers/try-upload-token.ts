import { handleUpload } from '@vercel/blob/client';

import { errMessage, jsonError } from '@/lib/clips';
import { assertTryBudget, assertTryEnabled, tryErrorStatus } from '@/lib/try-limits';

/** Client-upload token route: the video body never touches our server. */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }
  try {
    const result = await handleUpload({
      body: body as Parameters<typeof handleUpload>[0]['body'],
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        assertTryEnabled();
        await assertTryBudget();
        if (!pathname.startsWith('tries/')) {
          throw new Error('Uploads must live under tries/.');
        }
        return {
          allowedContentTypes: ['video/mp4', 'video/quicktime'],
          maximumSizeInBytes: 50 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
    });
    return Response.json(result);
  } catch (err) {
    return jsonError(errMessage(err), tryErrorStatus(err));
  }
}
