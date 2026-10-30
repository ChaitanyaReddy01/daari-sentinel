import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';
import { parseImageStream, recordsOfKind } from '@meta-sam/parser';

import { jsonError } from '@/lib/clips';
import { meta } from '@/lib/meta';
import { clientIpFrom } from '@/lib/ratelimit';
import { SAM_MODEL } from '@/lib/sam';
import { STILLS_PRICE_PER_IMAGE } from '@/lib/stills';
import {
  assertTryBudget,
  tryAdvance,
  tryPublicError,
  tryGet,
  tryLedger,
  tryLoad,
} from '@/lib/try-limits';
import {
  TRY_DETECT_CONCEPTS,
  TRY_SENSITIVE_CONCEPTS,
  type TryBox,
  type TryDetectData,
} from './try-shared';

const Still = z.object({
  index: z.number().int().min(0).max(3),
  seconds: z.number().min(0).max(30),
  width: z.number().int().min(16).max(1280),
  height: z.number().int().min(16).max(1280),
  jpegBase64: z.string().min(100).max(3_000_000),
});

const Body = z.object({ tryId: z.string().min(1).max(64), stills: z.array(Still).length(4) });

/** Boxes kept per concept per still (counts stay exact). */
const BOX_CAP = 200;
/** SAM calls in flight at once (40 total in 4 waves, fits in maxDuration). */
const PARALLEL = 10;

function safeTryId(tryId: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(tryId)) throw new Error('Bad tryId.');
  return tryId;
}

async function detectOne(
  fileId: string,
  concept: string,
): Promise<{ count: number; boxes: TryBox[] }> {
  const message = {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: concept },
      { type: 'input_image', file_id: fileId },
    ],
  };
  const events = await meta.responses.create({
    model: SAM_MODEL,
    input: [message] as unknown as Parameters<typeof meta.responses.create>[0]['input'],
    stream: true,
    metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
  });
  const result = await parseImageStream(events).finalResult;
  const recs = recordsOfKind(result.records, 'box');
  const ids = new Set(recs.map((b) => b.objectId));
  return {
    count: ids.size,
    boxes: recs.slice(0, BOX_CAP).map((b) => ({
      x1: b.left,
      y1: b.top,
      x2: b.right,
      y2: b.bottom,
      id: b.objectId,
      c: b.confidence ?? null,
    })),
  };
}

/** SAM 3.1 image mode over the 4 client stills × (8 object + 2 privacy) concepts. */
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
  const { tryId, stills } = parsed.data;

  try {
    const ip = clientIpFrom(req);
    const st = await tryLoad(tryId, ip);
    if (st.step > 0) {
      // Idempotent retry: never bill twice.
      const stored = JSON.parse(await tryGet(tryId, 'detectJson')) as TryDetectData;
      return Response.json({
        stills: stored.stills,
        cost: st.cost,
        replay: true,
      });
    }
    await assertTryBudget();

    const tag = safeTryId(tryId);
    const tmpPaths: string[] = [];
    try {
      for (const s of stills) {
        const p = path.join(os.tmpdir(), `try-${tag}-${s.index}.jpg`);
        fs.writeFileSync(p, Buffer.from(s.jpegBase64, 'base64'));
        tmpPaths.push(p);
      }
      const fileIds: string[] = [];
      for (const p of tmpPaths) {
        const file = await meta.files.create({
          purpose: 'user_data',
          file: fs.createReadStream(p),
        });
        fileIds.push(file.id);
      }
      const jobs: { stillIdx: number; concept: string }[] = [];
      for (let i = 0; i < stills.length; i += 1) {
        for (const concept of [...TRY_DETECT_CONCEPTS, ...TRY_SENSITIVE_CONCEPTS]) {
          jobs.push({ stillIdx: i, concept });
        }
      }
      const data: TryDetectData = {
        stills: stills.map((s) => ({
          index: s.index,
          seconds: s.seconds,
          width: s.width,
          height: s.height,
          counts: {},
          boxes: {},
        })),
      };
      for (let at = 0; at < jobs.length; at += PARALLEL) {
        const chunk = jobs.slice(at, at + PARALLEL);
        const outs = await Promise.all(
          chunk.map((j) => detectOne(fileIds[j.stillIdx], j.concept)),
        );
        chunk.forEach((j, k) => {
          data.stills[j.stillIdx].counts[j.concept] = outs[k].count;
          data.stills[j.stillIdx].boxes[j.concept] = outs[k].boxes;
        });
      }
      const estUSD = jobs.length * STILLS_PRICE_PER_IMAGE;
      const cost = await tryLedger({
        tryId,
        kind: 'try-detect',
        model: SAM_MODEL,
        detail: `${jobs.length} images`,
        estUSD,
      });
      await tryAdvance(tryId, 0, { detectJson: JSON.stringify(data) });
      return Response.json({ stills: data.stills, cost });
    } finally {
      for (const p of tmpPaths) {
        try {
          fs.unlinkSync(p);
        } catch {
          // Best effort.
        }
      }
    }
  } catch (err) {
    const pub = tryPublicError(err);
    return jsonError(pub.message, pub.status);
  }
}
