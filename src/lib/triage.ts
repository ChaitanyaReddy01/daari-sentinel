/**
 * Triage ladder rules (Levels 1–3). Pure decisions shared by /try, /sim and
 * the evaluation: cheap checks first, map updates only on real changes.
 * Key-free: no API calls, no caches, safe to import anywhere.
 */

/** Minutes after which a report forces a fresh Level 3 assessment. */
export const REASSESS_AFTER_MIN = 5;
/** A pass "over" an incident is within this distance of it. */
export const PASS_RADIUS_M = 500;
/** Consecutive clear passes that clear an incident without Level 3. */
export const CLEAR_PASSES_TO_CLEAR = 2;

/**
 * Level 3 runs only for a new incident, a stage change, or a stale
 * assessment. Otherwise the report attaches without a new assessment.
 */
export function shouldRunLevel3(args: {
  isNewIncident: boolean;
  stageChanged: boolean;
  minutesSinceAssessment: number | null;
}): boolean {
  if (args.isNewIncident) return true;
  if (args.stageChanged) return true;
  if (args.minutesSinceAssessment === null) return true;
  return args.minutesSinceAssessment > REASSESS_AFTER_MIN;
}

/** A pin is created only on a confirmed new incident. */
export function shouldCreatePin(confirmedNewIncident: boolean): boolean {
  return confirmedNewIncident;
}

/** A pin updates only on a stage change or a new clearance range. */
export function shouldUpdatePin(args: {
  stageChanged: boolean;
  newClearanceRange: boolean;
}): boolean {
  return args.stageChanged || args.newClearanceRange;
}

/** Clear-pass counter: a clear pass adds one, any other report resets it. */
export function nextClearCount(current: number, isClearPass: boolean): number {
  return isClearPass ? current + 1 : 0;
}

/** Cleared by evidence once enough consecutive clear passes arrive. */
export function isClearedByEvidence(clearCount: number): boolean {
  return clearCount >= CLEAR_PASSES_TO_CLEAR;
}

/** A camera pass counts "over" an incident inside the pass radius. */
export function isPassOverIncident(distanceM: number): boolean {
  return distanceM <= PASS_RADIUS_M;
}

/** Ladder spend from counts and cached per-call costs. */
export function estimateLadderCost(
  counts: { quicklooks: number; escalated: number },
  unitCosts: { quicklook: number; fullCheck: number },
): number {
  return counts.quicklooks * unitCosts.quicklook + counts.escalated * unitCosts.fullCheck;
}
