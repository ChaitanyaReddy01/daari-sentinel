# Evidence: the triage ladder

Source: [`data/eval/batch-report.md`](../../data/eval/batch-report.md),
"Triage ladder" section (2026-10-29, `npx tsx scripts/triage-eval.ts`).

## Quick look: 16/19, zero misses on incidents

The Level 1 quick look (one still, cheap Muse Spark model, low effort)
flags a clip `suspicious` or `clear`:

- **All 11 incident clips flagged suspicious — zero misses.**
- 3 normal clips over-flagged (the safe direction — they only cost an
  extra check, and the full verdict still clears them):
  - `crowd-people-1`: crowd near the road read as a hazard,
  - `traffic-cars-3` and `traffic-normal-1`: heavy but normal traffic
    read as stopped traffic.

## Verdict effort: low matches medium

| Effort | Incident | Type | Responders |
| ------ | -------- | ---- | ---------- |
| medium | 19/19 | 18/19 | 72/76 |
| low | 19/19 | 19/19 | 72/76 |

Low matches medium and fixes one type call, so `/try` verdicts run at low
effort. `/lab` and `/sim` keep medium (committed snapshot).

## Cost per driving hour: ~$0.33 (estimate)

Measured medians: quick look **$0.0002**, full check **$0.106**
($0.08 detect + $0.001 verdict + $0.025 assess — see
[`data/snapshot/triage-ladder.json`](../../data/snapshot/triage-ladder.json)).

Formula: 1 quick look/min → 60 looks/hour; full checks only on flags.
On the incident-heavy eval set (73.7% flagged) that is $4.70/hour; **at a
realistic 5% escalation rate it is $0.33/hour**.

Assumptions, stated plainly: one camera, one look per minute, 5% of looks
escalate, model prices as of 2026-10-27 (see [costs](costs.md)).

## Re-running

`npx tsx scripts/triage-eval.ts` — the recorded run cost $0.02
(20 quick looks + 19 low verdicts).
