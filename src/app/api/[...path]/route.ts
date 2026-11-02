import { jsonError } from '@/lib/clips';
import * as board from '@/server/handlers/board';
import * as boardDelete from '@/server/handlers/board-delete';
import * as boardSnap from '@/server/handlers/board-snap';
import * as labAnalyze from '@/server/handlers/lab-analyze';
import * as labClips from '@/server/handlers/lab-clips';
import * as labResult from '@/server/handlers/lab-result';
import * as labStills from '@/server/handlers/lab-stills';
import * as labVerdict from '@/server/handlers/lab-verdict';
import * as simAssess from '@/server/handlers/sim-assess';
import * as simReport from '@/server/handlers/sim-report';
import * as simRoutes from '@/server/handlers/sim-routes';
import * as simStops from '@/server/handlers/sim-stops';
import * as simThumbnail from '@/server/handlers/sim-thumbnail';
import * as simTrip from '@/server/handlers/sim-trip';
import * as tryAssess from '@/server/handlers/try-assess';
import * as tryDetect from '@/server/handlers/try-detect';
import * as tryFinish from '@/server/handlers/try-finish';
import * as tryOwner from '@/server/handlers/try-owner';
import * as tryQuicklook from '@/server/handlers/try-quicklook';
import * as tryStart from '@/server/handlers/try-start';
import * as tryUploadToken from '@/server/handlers/try-upload-token';
import * as tryVerdict from '@/server/handlers/try-verdict';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Single API function (Vercel Hobby allows 12 per deployment; eleven
 * separate routes plus pages exceeded it). Dispatches by method + path to
 * the handler modules; every public URL is unchanged.
 */

type Handler = (req: Request) => Promise<Response>;

const ROUTES: Record<string, { GET?: Handler; POST?: Handler; DELETE?: Handler }> = {
  board,
  'board/snap': boardSnap,
  'lab/analyze': labAnalyze,
  'lab/clips': labClips,
  'lab/result': labResult,
  'lab/stills': labStills,
  'lab/verdict': labVerdict,
  'sim/assess': simAssess,
  'sim/report': simReport,
  'sim/routes': simRoutes,
  'sim/stops': simStops,
  'sim/thumbnail': simThumbnail,
  'sim/trip': simTrip,
  'try/assess': tryAssess,
  'try/detect': tryDetect,
  'try/finish': tryFinish,
  'try/owner': tryOwner,
  'try/quicklook': tryQuicklook,
  'try/start': tryStart,
  'try/upload-token': tryUploadToken,
  'try/verdict': tryVerdict,
};

async function dispatch(req: Request, segments: string[]): Promise<Response> {
  const key = segments.join('/');
  const route = ROUTES[key];
  if (route) {
    const fn =
      req.method === 'GET'
        ? route.GET
        : req.method === 'POST'
          ? route.POST
          : req.method === 'DELETE'
            ? route.DELETE
            : undefined;
    if (!fn) return jsonError(`Method ${req.method} not allowed for /api/${key}`, 405);
    return fn(req);
  }
  // Owner delete reads the id from the URL: DELETE /api/board/:id.
  if (segments[0] === 'board' && segments.length === 2) {
    if (req.method !== 'DELETE' || !boardDelete.DELETE) {
      return jsonError(`Method ${req.method} not allowed for /api/board/:id`, 405);
    }
    return boardDelete.DELETE(req);
  }
  return jsonError(`Unknown API path: /api/${key}`, 404);
}

export async function GET(
  req: Request,
  ctx: { params: { path: string[] } },
): Promise<Response> {
  return dispatch(req, ctx.params.path);
}

export async function POST(
  req: Request,
  ctx: { params: { path: string[] } },
): Promise<Response> {
  return dispatch(req, ctx.params.path);
}

export async function DELETE(
  req: Request,
  ctx: { params: { path: string[] } },
): Promise<Response> {
  return dispatch(req, ctx.params.path);
}
