import { errMessage, jsonError } from '@/lib/clips';
import { clientIpFrom } from '@/lib/ratelimit';
import { getSimRoutes } from '@/lib/routes';

/** Cached MAIN + DETOUR routes for the sim. The server key never leaves here. */
export async function GET(req: Request): Promise<Response> {
  try {
    const routes = await getSimRoutes(clientIpFrom(req));
    return Response.json(routes);
  } catch (err) {
    return jsonError(errMessage(err), 500);
  }
}
