# Evidence: the incident agent

Source: `npx tsx scripts/agent-check.ts` (**7/7 PASS**) — three scenarios
over cached clip data, plus the recorded run quoted below.

## Scenario A — one crash, four camera reports

clips: `crash-1` (t+0) → `car-tow-ambulance-police-1` (t+12, oncoming) →
`car-police-tow-1` (t+25) → `dash-cam-car-1` (t+40, oncoming).

Recorded assessments (Muse Wonder, cached):

- A1: no responders yet, **55–95 min (likely 72, low)** — "Limited
  evidence from one report only."
- A2: responders on scene, **27–46 min (likely 36, medium)**.
- A3: tow working, **6–15 min (likely 10, high)**.
- A4: road clear, 0 min.

Stages never go backward across the sequence, ending `cleared`; the
likely time narrows **72 → 36 → 10 min** as cameras pass.

## Scenario B — one night report

`ambulance-fire-1` alone: **low confidence and a wider range**
(10–45 min, likely 25) than a clear day report — one report is not
enough to be sure.

## Scenario C — conflicting reports

`tow_in_progress` followed by `no_responders`: the **guard keeps the
stage from moving backward** and notes the conflict instead of trusting
the newer report blindly.

## The 7 checks

A1 width ≤ 45 min · A3 width ≤ 20 min · A3 likely ≤ 20 min ·
A ends cleared · B1 confidence low · guard holds the stage ·
guard notes the conflict.

## Re-running

`npm run test:agent` — uses cached results ($0); it asks before spending
if fresh Wonder calls would top $1.
