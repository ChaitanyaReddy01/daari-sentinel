/**
 * CLEARANCE_TABLE v1: rough incident-clearance ranges by type and stage.
 * Clearly an estimate — Prompt 5 replaces this with the Muse Wonder agent.
 * Browser-safe: no node imports.
 */

export interface ClearanceEstimate {
  /** Human label, e.g. "45–75 min (estimate)" or "work zone, ongoing". */
  label: string;
  loMin: number | null;
  hiMin: number | null;
  midpointMin: number | null;
}

type StageRow = [number, number];
type TypeTable = Record<string, StageRow>;

const TABLE: Record<string, TypeTable> = {
  crash: {
    no_responders: [45, 75],
    responders_on_scene: [30, 50],
    tow_in_progress: [10, 25],
    clearing: [5, 10],
    cleared: [0, 0],
  },
  police_activity: {
    no_responders: [15, 40],
    responders_on_scene: [10, 30],
    tow_in_progress: [10, 20],
    clearing: [5, 10],
    cleared: [0, 0],
  },
  fire: {
    no_responders: [30, 60],
    responders_on_scene: [20, 40],
    tow_in_progress: [10, 25],
    clearing: [5, 10],
    cleared: [0, 0],
  },
  other: {
    no_responders: [20, 45],
    responders_on_scene: [15, 30],
    tow_in_progress: [10, 20],
    clearing: [5, 10],
    cleared: [0, 0],
  },
};

function tableFor(type: string): TypeTable {
  if (type === 'crash' || type === 'police_activity' || type === 'fire') return TABLE[type];
  return TABLE.other;
}

export function clearanceEstimate(
  type: string,
  stage: string,
  severity: string | null,
): ClearanceEstimate {
  if (type === 'construction') {
    return { label: 'work zone, ongoing', loMin: null, hiMin: null, midpointMin: null };
  }
  const table = tableFor(type);
  const row = table[stage] ?? table.no_responders;
  let [lo, hi] = row;
  if (severity === 'severe') {
    lo = Math.round(lo * 1.5);
    hi = Math.round(hi * 1.5);
  } else if (severity === 'minor') {
    lo = Math.round(lo * 0.7);
    hi = Math.round(hi * 0.7);
  }
  if (lo === 0 && hi === 0) {
    return { label: 'cleared', loMin: 0, hiMin: 0, midpointMin: 0 };
  }
  const mid = (lo + hi) / 2;
  return { label: `${lo}–${hi} min (estimate)`, loMin: lo, hiMin: hi, midpointMin: mid };
}
