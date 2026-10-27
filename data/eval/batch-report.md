# Batch evaluation report

Date: 2026-10-27
SAM model: sam-3.1 · Spark model: muse-spark-1.3-contributor · Prompt version: 2
Concepts (10): car, truck, police car, ambulance, fire truck, tow truck, person, traffic cone, construction vehicle, road barrier

## Table 1 — SAM objects per concept

| Clip | Frames | Size | Orient | car | truck | police car | ambulance | fire truck | tow truck | person | traffic cone | construction vehicle | road barrier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ambulance-fire-1 | 212 | 5.4MB | landscape | 0 | 4 | 3 | 2 | 1 | 3 | 2 | 0 | 5 | 2 |
| car-accident-1 | 211 | 5.0MB | landscape | 9 | 2 | 0 | 0 | 0 | 0 | 8 | 0 | 1 | 2 |
| car-police-tow-1 | 38 | 1.3MB | landscape | 3 | 2 | 3 | 1 | 1 | 2 | 6 | 0 | 0 | 0 |
| car-tow-ambulance-police-1 | 300 | 7.9MB | landscape | 16 | 9 | 0 | 0 | 2 | 2 | 6 | 0 | 2 | 0 |
| car-traffic-3 | 182 | 10.8MB | portrait | 16 | 16 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| cars-with-police-1 | 281 | 4.6MB | landscape | 16 | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| crash-1 | 241 | 1.1MB | landscape | 16 | 9 | 0 | 0 | 0 | 0 | 3 | 0 | 2 | 0 |
| crowd-people-1 | 217 | 21.3MB | portrait | 0 | 0 | 0 | 0 | 0 | 0 | 16 | 0 | 0 | 0 |
| dash-cam-car-1 | 228 | 21.9MB | landscape | 16 | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 5 |
| police-car-1 | 270 | 3.9MB | landscape | 7 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| policecars-1 | 224 | 5.8MB | landscape | 16 | 4 | 7 | 0 | 0 | 0 | 8 | 0 | 0 | 0 |
| policecars-2 | 131 | 4.6MB | landscape | 16 | 6 | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 |
| rd-construction-1 | 125 | 1.8MB | landscape | 16 | 8 | 0 | 0 | 0 | 1 | 0 | 0 | 6 | 3 |
| road-work-2 | 256 | 4.9MB | landscape | 16 | 6 | 1 | 1 | 0 | 2 | 7 | 15 | 4 | 0 |
| road-work-3 | 187 | 7.5MB | portrait | 16 | 10 | 0 | 0 | 0 | 0 | 8 | 16 | 4 | 0 |
| traffic-cars-1 | 300 | 6.1MB | landscape | 16 | 16 | 0 | 0 | 0 | 0 | 16 | 0 | 0 | 0 |
| traffic-cars-2 | 170 | 5.4MB | landscape | 16 | 14 | 0 | 0 | 0 | 0 | 16 | 0 | 0 | 0 |
| traffic-cars-3 | 173 | 3.8MB | landscape | 16 | 6 | 3 | 0 | 0 | 0 | 16 | 0 | 0 | 0 |
| traffic-normal-1 | 75 | 7.5MB | portrait | 6 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 |

## Table 2 — Verdict vs ground truth

| Clip | Incident | Type | Stage | Responders | Verdict summary |
| --- | --- | --- | --- | --- | --- |
| ambulance-fire-1 | ✓ true | ✗ V:police_activity L:unknown | responders_on_scene | P✓ A✗ F✓ T✓ | Emergency vehicles block lanes ahead at night; slow down and expect delays. |
| car-accident-1 | ✓ true | ✗ V:debris L:crash | no_responders | P✓ A✓ F✓ T✓ | Use caution ahead - burning hay bales on right shoulder with smoke, tractor and people stopped. |
| car-police-tow-1 | ✓ true | ✓ crash | tow_in_progress | P✓ A✗ F✗ T✓ | Crash at downtown intersection with tow in progress, expect delays. |
| car-tow-ambulance-police-1 | ✓ true | ✓ crash | responders_on_scene | P✗ A✗ F✗ T✓ | Fire crews block central intersection; expect delays and use caution through area. |
| car-traffic-3 | ✓ false | ✓ none | not_applicable | P✓ A✓ F✓ T✓ | Expect heavy traffic on right-side highway lanes; left side moving normally. |
| cars-with-police-1 | ✗ V:false L:true | ✗ V:none L:police_activity | not_applicable | P✗ A✓ F✓ T✓ | Nighttime heavy traffic but no crash; all lanes open, expect slowdowns. |
| crash-1 | ✓ true | ✓ crash | no_responders | P✓ A✓ F✓ T✓ | Truck crash blocking highway lanes ahead, expect delays and pass with caution. |
| crowd-people-1 | ✓ false | ✓ none | not_applicable | P✓ A✓ F✓ T✓ | Street completely blocked by huge market crowd, avoid area and use alternate route. |
| dash-cam-car-1 | ✓ false | ✓ none | not_applicable | P✓ A✓ F✓ T✓ | Traffic moving normally on multi-lane freeway, no crash or delays visible. |
| police-car-1 | ✓ true | ✓ police_activity | responders_on_scene | P✓ A✓ F✓ T✓ | Police stop on right shoulder ahead; move over and pass slowly with caution. |
| policecars-1 | ✓ true | ✓ police_activity | responders_on_scene | P✓ A✓ F✓ T✓ | Police activity blocking intersection ahead; avoid area and expect delays. |
| policecars-2 | ✓ true | ✓ police_activity | responders_on_scene | P✓ A✓ F✓ T✓ | Heavy police activity blocking residential streets by church, avoid area and expect delays. |
| rd-construction-1 | ✓ true | ✓ construction | not_applicable | P✓ A✓ F✓ T✓ | Expect delays for highway roadwork with lanes closed, proceed cautiously. |
| road-work-2 | ✓ true | ✓ construction | not_applicable | P✓ A✓ F✓ T✓ | Expect construction delays with roller and workers blocking center lanes. |
| road-work-3 | ✓ true | ✓ construction | not_applicable | P✓ A✓ F✓ T✓ | Center lanes closed for roadwork with heavy equipment; expect delays and use side lanes. |
| traffic-cars-1 | ✓ false | ✓ none | not_applicable | P✓ A✓ F✓ T✓ | Normal traffic flowing through busy market area, drive with caution for pedestrians. |
| traffic-cars-2 | ✓ false | ✓ none | not_applicable | P✓ A✓ F✓ T✓ | Busy market street with normal flowing traffic, expect congestion, no incident blocking road. |
| traffic-cars-3 | ✓ false | ✓ none | not_applicable | P✓ A✓ F✓ T✓ | Heavy congestion with slow cars and motorcycles; expect major delays. |
| traffic-normal-1 | ✓ false | ✓ none | not_applicable | P✓ A✓ F✓ T✓ | Slow moving taxi queue on wet narrow street ahead, allow extra time. |

## Totals

- Incident accuracy: 18/19
- Type accuracy: 16/19
- Responder accuracy: 69/76
- Batch spend (this run): $7.0496
- Ledger total spend: $7.8743

## Disagreeing clips

### ambulance-fire-1
Emergency vehicles block lanes ahead at night; slow down and expect delays.

### car-accident-1
Use caution ahead - burning hay bales on right shoulder with smoke, tractor and people stopped.

### car-police-tow-1
Crash at downtown intersection with tow in progress, expect delays.

### car-tow-ambulance-police-1
Fire crews block central intersection; expect delays and use caution through area.

### cars-with-police-1
Nighttime heavy traffic but no crash; all lanes open, expect slowdowns.

## Failures

None.
