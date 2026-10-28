/**
 * CLEARANCE_TABLE v2: planning defaults for incident-clearance times.
 * These are rough planning defaults, not official statistics — the Muse
 * Wonder agent starts from them and adjusts with cited evidence.
 * Browser-safe: no node imports.
 */

export interface PlanningDefault {
  lowMin: number;
  likelyMin: number;
  highMin: number;
}

export interface ClearanceEstimate {
  /** Human label, e.g. "45–75 min (planning default)" or "work zone, ongoing". */
  label: string;
  loMin: number | null;
  hiMin: number | null;
  midpointMin: number | null;
  likelyMin: number | null;
}

type StageRow = [number, number, number];
type TypeTable = Record<string, StageRow>;

const TABLE: Record<string, TypeTable> = {
  crash: {
    no_responders: [40, 55, 75],
    responders_on_scene: [25, 35, 45],
    tow_in_progress: [10, 15, 25],
    clearing: [5, 7, 10],
    cleared: [0, 0, 0],
  },
  fire: {
    no_responders: [30, 45, 60],
    responders_on_scene: [20, 30, 40],
    tow_in_progress: [10, 15, 25],
    clearing: [5, 7, 10],
    cleared: [0, 0, 0],
  },
  police_activity: {
    no_responders: [15, 25, 40],
    responders_on_scene: [10, 20, 30],
    tow_in_progress: [10, 15, 20],
    clearing: [5, 7, 10],
    cleared: [0, 0, 0],
  },
  stalled_vehicle: {
    no_responders: [15, 25, 40],
    responders_on_scene: [10, 15, 25],
    tow_in_progress: [5, 10, 15],
    clearing: [3, 5, 8],
    cleared: [0, 0, 0],
  },
  debris: {
    no_responders: [15, 25, 40],
    responders_on_scene: [10, 15, 25],
    tow_in_progress: [5, 10, 15],
    clearing: [3, 5, 8],
    cleared: [0, 0, 0],
  },
  other: {
    no_responders: [20, 30, 45],
    responders_on_scene: [15, 25, 35],
    tow_in_progress: [10, 15, 20],
    clearing: [5, 7, 10],
    cleared: [0, 0, 0],
  },
};

function tableFor(type: string): TypeTable {
  if (
    type === 'crash' ||
    type === 'fire' ||
    type === 'police_activity' ||
    type === 'stalled_vehicle' ||
    type === 'debris'
  ) {
    return TABLE[type];
  }
  return TABLE.other;
}

/** Planning default for a type + stage, with severity scaling. Never null. */
export function planningDefault(
  type: string,
  stage: string,
  severity: string | null,
): PlanningDefault {
  const table = tableFor(type);
  const row = table[stage] ?? table.no_responders;
  let [lowMin, likelyMin, highMin] = row;
  if (severity === 'severe') {
    lowMin = Math.round(lowMin * 1.3);
    likelyMin = Math.round(likelyMin * 1.3);
    highMin = Math.round(highMin * 1.3);
  } else if (severity === 'minor') {
    lowMin = Math.round(lowMin * 0.7);
    likelyMin = Math.round(likelyMin * 0.7);
    highMin = Math.round(highMin * 0.7);
  }
  return { lowMin, likelyMin, highMin };
}

export function clearanceEstimate(
  type: string,
  stage: string,
  severity: string | null,
): ClearanceEstimate {
  if (type === 'construction') {
    return { label: 'work zone, ongoing', loMin: null, hiMin: null, midpointMin: null, likelyMin: null };
  }
  const { lowMin, likelyMin, highMin } = planningDefault(type, stage, severity);
  if (lowMin === 0 && highMin === 0) {
    return { label: 'cleared', loMin: 0, hiMin: 0, midpointMin: 0, likelyMin: 0 };
  }
  return {
    label: `${lowMin}–${highMin} min (planning default)`,
    loMin: lowMin,
    hiMin: highMin,
    midpointMin: (lowMin + highMin) / 2,
    likelyMin,
  };
}
