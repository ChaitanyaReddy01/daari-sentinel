import { z } from 'zod';

import { errMessage, jsonError } from '@/lib/clips';
import { getTrip, type TripRequest } from '@/lib/trip';

const LatLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const Address = z.object({ address: z.string().min(1).max(200) });
const PlaceRef = z.object({ placeId: z.string().min(1).max(200) });

const Body = z.object({
  origin: z.union([LatLng, Address]),
  destination: z.union([PlaceRef, LatLng, Address]),
  via: LatLng.optional(),
});

/** Trip route + alternatives, computed server-side and cached. */
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
    const trip = await getTrip(parsed.data as TripRequest);
    return Response.json(trip);
  } catch (err) {
    return jsonError(errMessage(err), 500);
  }
}
