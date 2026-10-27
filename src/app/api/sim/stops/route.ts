import { z } from 'zod';

import { errMessage, jsonError } from '@/lib/clips';
import { searchStops } from '@/lib/places';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

/** Nearby gas / rest / coffee stops, computed server-side and cached. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = Query.safeParse({ lat: url.searchParams.get('lat'), lng: url.searchParams.get('lng') });
  if (!parsed.success) {
    return jsonError(`Invalid query: ${parsed.error.issues.map((i) => i.message).join('; ')}`, 400);
  }
  try {
    const stops = await searchStops(parsed.data.lat, parsed.data.lng);
    return Response.json({ stops });
  } catch (err) {
    return jsonError(errMessage(err), 500);
  }
}
