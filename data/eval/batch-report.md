# Batch evaluation report

Date: 2026-10-27
SAM model: sam-3.1 · Spark model: muse-spark-1.3-contributor · Prompt version: 3
Concepts (11): car, truck, police car, ambulance, fire truck, tow truck, person, traffic cone, construction vehicle, road barrier, safety vest

## Table 1 — SAM objects per concept

| Clip | Frames | Size | Orient | car | truck | police car | ambulance | fire truck | tow truck | person | traffic cone | construction vehicle | road barrier | safety vest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ambulance-fire-1 | 212 | 5.4MB | landscape | 0 (stills: 0) | 4 (stills: 5) | 3 | 2 | 1 | 3 | 2 (stills: 1) | 0 | 5 | 2 | 0 |
| car-accident-1 | 211 | 5.0MB | landscape | 9 (stills: 6) | 2 (stills: 2) | 0 | 0 | 0 | 0 | 8 (stills: 6) | 0 | 1 | 2 | 0 |
| car-police-tow-1 | 38 | 1.3MB | landscape | 3 (stills: 4) | 2 (stills: 2) | 3 | 1 | 1 | 2 | 6 (stills: 6) | 0 | 0 | 0 | 0 |
| car-tow-ambulance-police-1 | 300 | 7.9MB | landscape | 16+ (stills: 49) | 9 (stills: 4) | 0 | 0 | 2 | 2 | 6 (stills: 5) | 0 | 2 | 0 | 0 |
| car-traffic-3 | 182 | 10.8MB | portrait | 16+ (stills: 78) | 16+ (stills: 3) | 0 | 0 | 0 | 0 | 2 (stills: 3) | 0 | 0 | 0 | 0 |
| cars-with-police-1 | 281 | 4.6MB | landscape | 16+ (stills: 70) | 16+ (stills: 3) | 0 | 0 | 0 | 0 | 0 (stills: 1) | 0 | 0 | 0 | 0 |
| crash-1 | 241 | 1.1MB | landscape | 16+ (stills: 6) | 9 (stills: 5) | 0 | 0 | 0 | 0 | 3 (stills: 4) | 0 | 2 | 0 | 0 |
| crowd-people-1 | 217 | 21.3MB | portrait | 0 (stills: 0) | 0 (stills: 0) | 0 | 0 | 0 | 0 | 16+ (stills: 37) | 0 | 0 | 0 | 0 |
| dash-cam-car-1 | 228 | 21.9MB | landscape | 16+ (stills: 21) | 16+ (stills: 0) | 0 | 0 | 0 | 0 | 0 (stills: 0) | 0 | 1 | 5 | 0 |
| police-car-1 | 270 | 3.9MB | landscape | 7 (stills: 4) | 0 (stills: 0) | 1 | 0 | 0 | 0 | 0 (stills: 0) | 0 | 0 | 0 | 0 |
| policecars-1 | 224 | 5.8MB | landscape | 16+ (stills: 26) | 4 (stills: 3) | 7 | 0 | 0 | 0 | 8 (stills: 7) | 0 | 0 | 0 | 0 |
| policecars-2 | 131 | 4.6MB | landscape | 16+ (stills: 33) | 6 (stills: 8) | 5 | 0 | 0 | 0 | 5 (stills: 4) | 0 | 0 | 0 | 0 |
| rd-construction-1 | 125 | 1.8MB | landscape | 16+ (stills: 43) | 8 (stills: 7) | 0 | 0 | 0 | 1 | 0 (stills: 1) | 0 | 6 | 3 | 0 |
| road-work-2 | 256 | 4.9MB | landscape | 16+ (stills: 5) | 6 (stills: 4) | 1 | 1 | 0 | 2 | 7 (stills: 5) | 15 | 4 | 0 | 6 |
| road-work-3 | 187 | 7.5MB | portrait | 16+ (stills: 24) | 10 (stills: 8) | 0 | 0 | 0 | 0 | 8 (stills: 6) | 16+ | 4 | 0 | 0 |
| traffic-cars-1 | 300 | 6.1MB | landscape | 16+ (stills: 66) | 16+ (stills: 16) | 0 | 0 | 0 | 0 | 16+ (stills: 33) | 0 | 0 | 0 | 0 |
| traffic-cars-2 | 170 | 5.4MB | landscape | 16+ (stills: 46) | 14 (stills: 9) | 0 | 0 | 0 | 0 | 16+ (stills: 28) | 0 | 0 | 0 | 0 |
| traffic-cars-3 | 173 | 3.8MB | landscape | 16+ (stills: 56) | 6 (stills: 6) | 3 | 0 | 0 | 0 | 16+ (stills: 67) | 0 | 0 | 0 | 0 |
| traffic-normal-1 | 75 | 7.5MB | portrait | 6 (stills: 6) | 0 (stills: 0) | 0 | 0 | 0 | 0 | 3 (stills: 0) | 0 | 0 | 0 | 0 |

Counts of 16+ hit the video tracking cap (max 16 objects per frame). "stills" = max true count over 3 still frames (image mode, no cap).

## Table 2 — Verdict vs ground truth

| Clip | Incident | Type | People | Stage | Responders | Verdict summary |
| --- | --- | --- | --- | --- | --- | --- |
| ambulance-fire-1 | ✓ true | ✗ V:unknown L:police_activity | 1 | responders_on_scene | P✓ A✗ F✓ T✓ | Emergency vehicles block highway lanes at night, expect delays and slow traffic. |
| car-accident-1 | ✓ true | ✓ fire | 8 | no_responders | P✓ A✓ F✓ T✓ | Large hay-bale fire on right shoulder ahead with debris in road, use caution. |
| car-police-tow-1 | ✓ true | ✓ crash | 2 | tow_in_progress | P✓ A✓ F✓ T✓ | Crash at intersection with tow in progress; expect delays and use caution. |
| car-tow-ambulance-police-1 | ✓ true | ✓ crash | 6 | responders_on_scene | P✗ A✗ F✓ T✗ | Fire trucks block part of intersection ahead; expect delays and use caution. |
| car-traffic-3 | ✓ false | ✓ none | 0 | not_applicable | P✓ A✓ F✓ T✓ | No incident; heavy congestion on one carriageway, light traffic on the other. |
| cars-with-police-1 | ✓ false | ✓ none | 0 | not_applicable | P✓ A✓ F✓ T✓ | No incident; heavy but normal nighttime highway traffic, all lanes moving. |
| crash-1 | ✓ true | ✓ crash | 3 | no_responders | P✓ A✓ F✓ T✓ | Multi-vehicle crash with overturned truck blocks lanes; debris ahead, expect delays. |
| crowd-people-1 | ✓ false | ✓ none | 1000 | not_applicable | P✓ A✓ F✓ T✓ | No incident; crowded market street full of pedestrians. |
| dash-cam-car-1 | ✓ false | ✓ none | 0 | not_applicable | P✓ A✓ F✓ T✓ | No incident; traffic flowing normally on multi-lane freeway under clear skies. |
| police-car-1 | ✓ true | ✓ police_activity | 0 | responders_on_scene | P✓ A✓ F✓ T✓ | Police traffic stop on right shoulder; pass with caution. |
| policecars-1 | ✓ true | ✓ police_activity | 5 | responders_on_scene | P✓ A✓ F✓ T✓ | Heavy police activity blocking intersection, expect full closure and use alternate route. |
| policecars-2 | ✓ true | ✓ police_activity | 5 | responders_on_scene | P✓ A✓ F✓ T✓ | Heavy police activity blocking residential intersection, expect closures and delays. |
| rd-construction-1 | ✓ true | ✓ construction | 0 | not_applicable | P✓ A✓ F✓ T✓ | Road work with paving operation; expect slow traffic in adjacent highway lanes. |
| road-work-2 | ✓ true | ✓ construction | 4 | no_responders | P✓ A✓ F✓ T✓ | Road work blocking center lanes with crew and equipment, pass slowly. |
| road-work-3 | ✓ true | ✓ construction | 0 | not_applicable | P✓ A✓ F✓ T✓ | Center lanes closed for roadwork with heavy equipment; expect delays and use open side lanes. |
| traffic-cars-1 | ✓ false | ✓ none | — | not_applicable | P✓ A✓ F✓ T✓ | No incident; busy market road with normal two-way traffic. |
| traffic-cars-2 | ✓ false | ✓ none | 0 | not_applicable | P✓ A✓ F✓ T✓ | No incident; busy but normal traffic through market town. |
| traffic-cars-3 | ✓ false | ✓ none | 0 | not_applicable | P✓ A✓ F✓ T✓ | Heavy congested traffic with cars and motorcycles, no incident visible. |
| traffic-normal-1 | ✓ false | ✓ none | 0 | not_applicable | P✓ A✓ F✓ T✓ | No incident; slow taxi queue on wet narrow city street in rain. |

## Totals

- Incident accuracy: 19/19
- Type accuracy: 18/19
- Responder accuracy: 72/76
- Batch spend (this run): $1.2103
- Ledger total spend: $9.0871

## Disagreeing clips

### ambulance-fire-1
Emergency vehicles block highway lanes at night, expect delays and slow traffic.

### car-tow-ambulance-police-1
Fire trucks block part of intersection ahead; expect delays and use caution.

## Failures

None.

## Triage ladder (Oct 29, `npx tsx scripts/triage-eval.ts`)

Level 1 quick look (Muse Spark contributor, low effort, one 45% still) vs the
incident label, per clip:

| Clip | Label incident | L1 flag | Reasons | Match |
| --- | --- | --- | --- | --- |
| ambulance-fire-1 | true | suspicious | responders,stopped_traffic | ✓ |
| car-accident-1 | true | suspicious | fire,crash,hazard | ✓ |
| car-police-tow-1 | true | suspicious | crash,responders | ✓ |
| car-tow-ambulance-police-1 | true | suspicious | responders | ✓ |
| car-traffic-3 | false | clear | — | ✓ |
| cars-with-police-1 | false | clear | — | ✓ |
| crash-1 | true | suspicious | crash,hazard | ✓ |
| crowd-people-1 | false | suspicious | hazard | ✗ |
| dash-cam-car-1 | false | clear | — | ✓ |
| police-car-1 | true | suspicious | responders | ✓ |
| policecars-1 | true | suspicious | responders,stopped_traffic | ✓ |
| policecars-2 | true | suspicious | responders,stopped_traffic | ✓ |
| rd-construction-1 | true | suspicious | work_zone | ✓ |
| road-work-2 | true | suspicious | work_zone | ✓ |
| road-work-3 | true | suspicious | work_zone,stopped_traffic | ✓ |
| traffic-cars-1 | false | clear | — | ✓ |
| traffic-cars-2 | false | clear | — | ✓ |
| traffic-cars-3 | false | suspicious | stopped_traffic | ✗ |
| traffic-normal-1 | false | suspicious | stopped_traffic | ✗ |

L1 accuracy: 16/19. All 11 incident clips flagged suspicious (zero misses).
The 3 misses are over-flags on normal clips: crowd-people-1 (crowd near the
road read as a hazard) and traffic-cars-3 + traffic-normal-1 (heavy but
normal traffic read as stopped_traffic).

Verdict reasoning effort, low vs medium (low cached separately, medium
results untouched):

| Effort | Incident | Type | Responders |
| --- | --- | --- | --- |
| medium | 19/19 | 18/19 | 72/76 |
| low | 19/19 | 19/19 | 72/76 |

Low matches medium on incident/responders and fixes one type call, so /try
verdicts run at low effort. /lab and /sim keep medium (committed snapshot).

Ladder economics (measured medians: quick look $0.000219, full check
$0.08 detect + $0.001 verdict + $0.025 assess = $0.106): escalation rate on
this incident-heavy set (11/19 incident) is 14/19 = 73.7%. Cost per hour at
1 quick look/min = 60×quicklook + 60×rate×full = $4.70 on this set; at a
realistic 5% escalation rate the same formula gives $0.33/hour.

Eval spend (this run): $0.02 (20 quick looks + 19 low verdicts).
