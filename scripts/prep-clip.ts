/**
 * Prep raw dashcam clips for the SAM 3.1 perception lab.
 *
 * Usage:
 *   npx tsx scripts/prep-clip.ts <input.mp4>   # one file from clips/raw/
 *   npx tsx scripts/prep-clip.ts all           # every video file in clips/raw/
 *
 * Reads from clips/raw/, writes the prepped clip to
 * public/clips/prepped/<name>.mp4 plus a <name>.json sidecar with the frame
 * count, fps, width and height.
 *
 * Why this shape: SAM 3.1 bills per video frame ($0.20 per 1,000 frames,
 * minimum 50 frames per request). 10 fps cuts cost ~3x vs the 30 fps most
 * dashcams record. +faststart avoids server-side remuxing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RAW_DIR = path.join(ROOT, 'clips', 'raw');
const OUT_DIR = path.join(ROOT, 'public', 'clips', 'prepped');
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);

function fail(message: string): never {
  console.error(`prep-clip: ${message}`);
  process.exit(1);
}

function checkTool(tool: 'ffmpeg' | 'ffprobe'): void {
  try {
    execFileSync(tool, ['-version'], { stdio: 'ignore' });
  } catch {
    fail(
      `${tool} was not found on PATH. Install it first (Windows: winget install Gyan.FFmpeg), then re-run.`,
    );
  }
}

function prepOne(inputPath: string): void {
  const stem = path.basename(inputPath, path.extname(inputPath));
  const outVideo = path.join(OUT_DIR, `${stem}.mp4`);
  const outMeta = path.join(OUT_DIR, `${stem}.json`);

  console.log(`prep-clip: ${path.basename(inputPath)} -> ${path.basename(outVideo)}`);
  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inputPath,
        '-t',
        '30',
        '-vf',
        "fps=10,scale='min(1280,iw)':-2",
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-movflags',
        '+faststart',
        outVideo,
      ],
      { stdio: 'inherit' },
    );
  } catch {
    fail(`ffmpeg failed on ${inputPath} (see output above).`);
  }

  let probe: {
    streams?: Array<{
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      nb_read_frames?: string;
      duration?: string;
    }>;
  };
  try {
    const raw = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,avg_frame_rate,nb_read_frames,duration',
        '-of',
        'json',
        outVideo,
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    probe = JSON.parse(raw) as typeof probe;
  } catch {
    fail(`ffprobe failed on ${outVideo}.`);
  }

  const stream = probe.streams?.[0];
  if (!stream || typeof stream.width !== 'number' || typeof stream.height !== 'number') {
    fail(`ffprobe found no video stream in ${outVideo}.`);
  }
  const [num, den] = (stream.avg_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;
  let frameCount = Number(stream.nb_read_frames ?? NaN);
  if (!Number.isFinite(frameCount) || frameCount <= 0) {
    // Fallback for containers that do not report a frame count.
    frameCount = Math.round(Number(stream.duration ?? 0) * fps);
  }
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(frameCount) || frameCount <= 0) {
    fail(`could not determine fps/frame count for ${outVideo}.`);
  }

  const metaFile = { name: stem, frameCount, fps, width: stream.width, height: stream.height };
  fs.writeFileSync(outMeta, JSON.stringify(metaFile, null, 2));
  console.log(
    `prep-clip: wrote ${path.basename(outMeta)} ` +
      `(${frameCount} frames, ${fps} fps, ${stream.width}x${stream.height})`,
  );
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) fail('usage: npx tsx scripts/prep-clip.ts <input.mp4 | all>');
  checkTool('ffmpeg');
  checkTool('ffprobe');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (arg === 'all') {
    if (!fs.existsSync(RAW_DIR)) fail(`raw clips directory not found: ${RAW_DIR}`);
    const files = fs
      .readdirSync(RAW_DIR)
      .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
    if (files.length === 0) fail(`no video files found in ${RAW_DIR}`);
    for (const f of files) prepOne(path.join(RAW_DIR, f));
    return;
  }

  // Accept a bare name ("crash"), a file name ("crash.mp4"), or a path.
  const candidate =
    path.isAbsolute(arg) || arg.includes('/') || arg.includes('\\')
      ? arg
      : path.join(RAW_DIR, arg);
  const withExt =
    fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : `${candidate}.mp4`;
  if (!fs.existsSync(withExt) || !fs.statSync(withExt).isFile()) {
    fail(`input not found: ${arg} (looked in ${RAW_DIR})`);
  }
  prepOne(withExt);
}

main();
