# Evidence: incident detection

Source: [`data/eval/batch-report.md`](../../data/eval/batch-report.md) (2026-10-27),
Table 2 — verdict vs ground truth on 19 labeled clips.
Pipeline: SAM 3.1 object tracks + Muse Spark (`muse-spark-1.3-contributor`)
scene verdict, prompt version 3.

## Headline numbers

- **Incident detected: 19/19** — every clip's incident / no-incident call matches.
- **Type right: 18/19** at medium effort (19/19 at low effort — see
  [triage](triage.md); `/try` runs low, `/lab` and `/sim` keep medium).
- **Responders right: 72/76** (4 flags × 19 clips).
- **Zero false alarms on the 8 normal-traffic clips.**

## The 8 normal clips (all correctly cleared)

car-traffic-3, cars-with-police-1, crowd-people-1, dash-cam-car-1,
traffic-cars-1, traffic-cars-2, traffic-cars-3, traffic-normal-1.

## The misses (all disclosed in the report)

- Type: `ambulance-fire-1` — verdict `unknown`, label `police_activity`.
- Responders: `ambulance-fire-1` (ambulance flag) and
  `car-tow-ambulance-police-1` (police, ambulance, tow flags).

## Footage mix (from the footage itself, see README)

13 aerial, 3 traffic-cam, 3 dashcam. Most incident footage is aerial or
traffic-camera style stock video standing in for road cameras — see the
[honest limits](../README.md#honest-limitations).

## Re-running

The batch verdict pass is the recorded $1.21 run (see [costs](costs.md));
re-running it would spend real budget, so these numbers are quoted from the
committed report, not regenerated.
