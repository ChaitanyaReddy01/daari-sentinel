import { z } from 'zod';

import { AgentAssessmentSchema } from '@/lib/agent-guard';
import { ClipName, errMessage, jsonError } from '@/lib/clips';

const ReportRef = z.object({
  reportId: z.string().min(1).max(40),
  clip: ClipName,
  direction: z.enum(['same', 'oncoming']),
  t: z.number().min(0),
});

const Body = z.object({
  reports: z.array(ReportRef).min(1).max(20),
  previousAssessment: AgentAssessmentSchema.nullable(),
});

/**
 * Assess one incident from its camera reports (Muse Wonder agent, cached).
 * Body reports are clip refs with sim timestamps; the server expands them
 * from cached verdict/SAM data only — never new SAM or verdict calls.
 */
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
  const { reports, previousAssessment } = parsed.data;

  try {
    const { assessIncident, buildReportInput, timeOfDayFromVerdict } = await import('@/lib/agent');
    const t0 = reports[0].t;
    const inputs = reports.map((r) =>
      buildReportInput({
        reportId: r.reportId,
        clip: r.clip,
        direction: r.direction,
        minutesSinceFirstReport: Math.max(0, (r.t - t0) / 60),
      }),
    );
    const lastT = reports[reports.length - 1].t;
    const prevT = reports.length > 1 ? reports[reports.length - 2].t : lastT;
    const { result, cached } = await assessIncident({
      reports: inputs,
      previousAssessment,
      minutesSinceLastReport: Math.max(0, (lastT - prevT) / 60),
      timeOfDay: timeOfDayFromVerdict(inputs[inputs.length - 1].verdict),
    });
    return Response.json({ stored: result, cached });
  } catch (err) {
    return jsonError(errMessage(err), 500);
  }
}
