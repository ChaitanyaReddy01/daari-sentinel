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

## Meta models used

- SAM 3.1 (`sam-3.1`) — open-vocabulary video segmentation and tracking. One
  short noun phrase per request (e.g. `crashed car`); tracked boxes are drawn
  over the playing clip in the Perception Lab.

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
