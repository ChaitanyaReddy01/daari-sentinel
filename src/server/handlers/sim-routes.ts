import { errMessage, jsonError } from '@/lib/clips';
import { getSimRoutes } from '@/lib/routes';

/** Cached MAIN + DETOUR routes for the sim. The server key never leaves here. */
export async function GET(): Promise<Response> {
  try {
    const routes = await getSimRoutes();
    return Response.json(routes);
  } catch (err) {
    return jsonError(errMessage(err), 500);
  }
}
