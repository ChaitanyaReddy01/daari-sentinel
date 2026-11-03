# Evidence: costs

## Real spend for the whole build: $11.55

From `data/ledger.jsonl` (687 entries, every real API call, snapshot
Nov 2 — the ledger itself is a working file; this page records it):

| What | Spend |
| ---- | ----- |
| SAM 3.1 video tracking (13 concepts) | $10.18 |
| Muse Wonder incident agent | $0.89 |
| SAM 3.1 still counts | $0.43 |
| Muse Spark verdicts | $0.05 |
| Muse Spark quick looks | under $0.01 |
| **Total Meta spend** | **$11.55** |

Google Maps / Routes / Places calls sit in the ledger at $0.00
(unpriced there); production `/try` is capped separately ($2/day
budget, 3 tries per IP per day — `src/lib/try-limits.ts`).

## Per-call prices (code, as of 2026-10-27)

- SAM 3.1 video: $0.20 per 1,000 frames, min 50 frames per request
  (`src/lib/sam.ts`).
- SAM 3.1 stills: $0.0025 per image (`src/lib/stills.ts`).
- Muse Spark 1.3 contributor: $0.10 in / $0.002 cached / $0.20 out
  per 1M tokens (`src/lib/config.ts`).
- Muse Wonder 1.0: $4.00 in / $0.20 cached / $20.00 out per 1M tokens.

## Measured medians (evaluation)

Quick look $0.0002 · full check $0.106 ($0.08 detect + $0.001 verdict +
$0.025 assess) — see [triage](triage.md), whose $0.33/hour estimate is
built from these. Recorded one-off runs: batch verdict pass $1.21,
triage eval $0.02 ([detection](detection.md), [triage](triage.md)).

Demos replay the committed snapshot at $0 (`LIVE_CALLS` off by default;
production blocks live calls outright).
