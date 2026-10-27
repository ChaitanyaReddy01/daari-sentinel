# Daari Sentinel

## What it is

Daari Sentinel turns dashcam footage into early road-incident warnings: Meta models
detect road incidents (crashes, emergency vehicles, flooding, debris) in dashcam
video, and drivers behind get a reroute-or-stay alert before they reach the scene.

## Built during the hackathon

Meta Global AI Developer Hackathon, Oct 27 – Nov 4, 2026. All work below was
built during the hackathon window.

| Date   | What was built                              |
| ------ | ------------------------------------------- |
| Oct 27 | Project setup and SAM 3.1 perception lab    |
| Oct 27 | Verified: build, prep, cached analyze, overlay boxes, 390px layout (live SAM call pending a real API key) |
| Oct 27 | first live SAM 3.1 runs on real footage; concept list moved to plain objects, Muse Spark will judge incidents |
| Oct 27 | Muse Spark scene verdict with evidence cross-check (Day 2) |
| Oct 27 | footage set expanded to 19 clips with ground-truth labels and a first evaluation run |
| Oct 27 | I-95 live simulation with real AI incident reports (Day 3) |
| Oct 27 | driver experience — trip planning, advance warnings, stay/reroute/stop options (Day 3) |

Commit messages before this point say 'Day 1–3'; these were build steps, all completed on Oct 27, the first building day.

| Oct 27 | Step 4b: realistic jam delay, exit-based decide-by, named reroutes |
| Oct 27 | Step 4c: fix missing clip list on /sim |
| Oct 27 | Step 4d: fix map zoom with follow mode |

## Meta models used

- SAM 3.1 (`sam-3.1`) — open-vocabulary video segmentation and tracking. One
  short noun phrase per request (e.g. `crashed car`); tracked boxes are drawn
  over the playing clip in the Perception Lab.
- Muse Spark 1.3 (`muse-spark-1.3-contributor`) — watches the clip and returns
  a structured scene verdict (incident type, severity, responders, evidence
  timestamps), cross-checked against the SAM detections on the same clip.

## How to run

Prerequisites: Windows + PowerShell, Node >= 22.9, `ffmpeg` and `ffprobe` on
PATH (e.g. `winget install Gyan.FFmpeg`).

```powershell
npm install
Copy-Item .env.example .env.local   # then put your real key in .env.local
```

1. Drop a raw dashcam clip into `clips/raw/`.
2. Prep it (trims to 30 s, 10 fps, max 1280 px wide, faststart):
   ```powershell
   npx tsx scripts/prep-clip.ts <your-clip.mp4>
   # or prep everything in clips/raw/:
   npx tsx scripts/prep-clip.ts all
   ```
3. Start the app and open the lab:
   ```powershell
   npm run dev
   ```
   Open [http://localhost:3000/lab](http://localhost:3000/lab) in your browser,
   pick the clip, and click Analyze.

Costs: SAM 3.1 bills per video frame ($0.20 per 1,000 frames, minimum 50 frames
per request). Every real API call is appended to `data/ledger.jsonl`; uploads
and SAM results are cached under `data/cache/` so repeat runs are free.

## Footage credits

| Clip | Source URL | License |
| ---- | ---------- | ------- |
| crash-1.mp4 | https://www.pexels.com/video/aerial-shot-of-a-car-accident-on-a-highway-12753260/ | Pexels License |
| traffic-normal-1.mp4 | https://www.pexels.com/video/busy-urban-street-with-taxis-in-traffic-jam-36911808/ | Pexels License |
| traffic-cars-1.mp4 | https://www.pexels.com/video/an-aerial-view-of-a-busy-street-with-cars-and-people-19166351/ | Pexels License |
| traffic-cars-2.mp4 | https://www.pexels.com/video/an-aerial-view-of-a-city-street-with-cars-and-people-19166359/ | Pexels License |
| traffic-cars-3.mp4 | https://www.pexels.com/video/traffic-on-street-in-rush-hour-14552312/ | Pexels License |
| police-car-1.mp4 | https://www.pexels.com/video/aerial-nighttime-traffic-stop-with-police-lights-32538553/ | Pexels License |
| cars-with-police-1.mp4 | https://www.pexels.com/video/aerial-view-of-busy-atlanta-highway-at-night-33134648/ | Pexels License |
| car-police-tow-1.mp4 | https://pixabay.com/videos/car-accident-police-9781/ | Pixabay Content License |
| crowd-people-1.mp4 | https://www.pexels.com/video/bustling-street-market-aerial-view-35245798/ | Pexels License |
| car-tow-ambulance-police-1.mp4 | https://www.pexels.com/video/drone-footage-of-car-accident-at-an-intersection-4686100/ | Pexels License |
| car-accident-1.mp4 | https://www.pexels.com/video/17785830/ | Pexels License |
| dash-cam-car-1.mp4 | https://www.pexels.com/video/a-time-lapse-video-of-moving-cars-8996082/ | Pexels License |
| ambulance-fire-1.mp4 | https://www.pexels.com/video/a-fire-truck-and-police-vehicles-in-the-street-at-night-11387588/ | Pexels License |
| rd-construction-1.mp4 | https://www.pexels.com/video/moving-vehicles-on-a-highway-8597290/ | Pexels License |
| policecars-1.mp4 | https://www.pexels.com/video/aerial-view-of-police-operation-in-suburban-area-33930776/ | Pexels License |
| policecars-2.mp4 | https://www.pexels.com/video/aerial-view-of-police-activity-in-neighborhood-33930780/ | Pexels License |
| car-traffic-3.mp4 | https://www.pexels.com/video/an-aerial-view-of-a-highway-with-cars-on-it-19452742/ | Pexels License |
| road-work-2.mp4 | https://www.pexels.com/video/people-working-on-the-road-4430486/ | Pexels License |
| road-work-3.mp4 | https://www.pexels.com/video/a-road-with-construction-vehicles-and-traffic-cones-28001192/ | Pexels License |
