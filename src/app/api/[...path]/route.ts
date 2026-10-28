import { jsonError } from '@/lib/clips';
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Single API function (Vercel Hobby allows 12 per deployment; eleven
 * separate routes plus pages exceeded it). Dispatches by method + path to
 * the handler modules; every public URL is unchanged.
 */

type Handler = (req: Request) => Promise<Response>;

const ROUTES: Record<string, { GET?: Handler; POST?: Handler }> = {
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
};

async function dispatch(req: Request, segments: string[]): Promise<Response> {
  const key = segments.join('/');
  const route = ROUTES[key];
  if (!route) return jsonError(`Unknown API path: /api/${key}`, 404);
  const fn = req.method === 'GET' ? route.GET : req.method === 'POST' ? route.POST : undefined;
  if (!fn) return jsonError(`Method ${req.method} not allowed for /api/${key}`, 405);
  return fn(req);
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
