# Evidence: privacy

## What is blurred

Faces and license plates — SAM 3.1 `face` / `license plate` boxes,
padded 20% on each side and unioned over ±1 frame so nothing flickers
through. Source: `scripts/blur-clips.ts` header ("Models keep analyzing
the unblurred prepped clips; people only ever see blurred").

## Where

- Demo clips: blurred display copies in `public/clips/blurred/` (H.264 +
  faststart); the sim, evidence player and thumbnails serve these, never
  the prepped originals (`src/lib/clips.ts`: "People see this; models
  see prepped").
- Your uploads: stills are blurred in the browser before they are shown
  (`/try` results), using the same committed face/plate boxes.
- Community posts: at most 2 blurred stills (≤ 80 KB each), verdict
  subset plus clearance range only — no IPs, no try IDs, `Cache-Control:
  no-store` (README "Community board", `src/lib/board.ts`).

## Uploads are deleted

`/api/try/finish` deletes the try's blob (`src/server/handlers/
try-finish.ts`: "Delete the try's blob and close it out"), and starting
a try sweeps any try blobs older than 1 hour
(`src/server/handlers/try-start.ts`).
