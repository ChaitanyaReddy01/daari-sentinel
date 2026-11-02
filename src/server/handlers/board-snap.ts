import { BOARD_SNAP_METERS, inCorridor, snapToRoad } from '@/lib/board';
import { jsonError } from '@/lib/clips';

/**
 * Preview road-snapping for the post map: is this point on a major road?
 * Read-only over the committed snapshot ($0, no quota).
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return jsonError('Query needs numeric lat and lng.', 400);
  }
  if (!inCorridor(lat, lng)) {
    return Response.json({ ok: false, reason: 'outside' as const });
  }
  const snap = snapToRoad(lat, lng);
  if (!snap) {
    return Response.json({ ok: false, reason: 'offroad' as const, snapMeters: BOARD_SNAP_METERS });
  }
  return Response.json({
    ok: true,
    lat: snap.lat,
    lng: snap.lng,
    road: snap.road,
    distM: Math.round(snap.distM),
  });
}
