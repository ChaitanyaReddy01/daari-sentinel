import { deleteBoardIncident } from '@/lib/board';
import { jsonError } from '@/lib/clips';
import { isOwnerRequest, tryPublicError } from '@/lib/try-limits';

/** Owner delete: remove a board incident immediately. Id from the URL path. */
export async function DELETE(req: Request): Promise<Response> {
  try {
    if (!isOwnerRequest(req)) {
      return jsonError('Owner only.', 403);
    }
    const id = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) {
      return jsonError('Bad board id.', 400);
    }
    const deleted = await deleteBoardIncident(id);
    if (!deleted) return jsonError('Not on the board.', 404);
    return Response.json({ deleted: true });
  } catch (err) {
    const pub = tryPublicError(err);
    return jsonError(pub.message, pub.status);
  }
}
