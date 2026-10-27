import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/**
 * Key-free helpers for prepped clips. This module never touches the Meta API,
 * so cached reads and clip listings work without MODEL_API_KEY.
 */

/** A prepped clip name: no slashes, no dots, no traversal. */
export const ClipName = z
  .string()
  .min(1, 'clip is required')
  .max(80, 'clip name is too long')
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, 'clip must be a prepped clip name');

export const ConceptName = z
  .string()
  .trim()
  .min(1, 'concept must be a non-empty noun phrase')
  .max(80, 'concept is too long (one short noun phrase)')
  .regex(/^[^\n\r]+$/, 'concept must be a single line');

export function preppedDir(): string {
  return path.join(process.cwd(), 'public', 'clips', 'prepped');
}

export function preppedVideoPath(clip: string): string {
  return path.join(preppedDir(), `${clip}.mp4`);
}

export function preppedMetaPath(clip: string): string {
  return path.join(preppedDir(), `${clip}.json`);
}

export interface PreppedClip {
  name: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  sizeBytes: number;
}

interface ClipMetaFile {
  frameCount?: unknown;
  fps?: unknown;
  width?: unknown;
  height?: unknown;
}

function isPreppedClipMeta(value: unknown): value is Required<ClipMetaFile> & {
  frameCount: number;
  fps: number;
  width: number;
  height: number;
} {
  if (!value || typeof value !== 'object') return false;
  const v = value as ClipMetaFile;
  return (
    typeof v.frameCount === 'number' &&
    Number.isFinite(v.frameCount) &&
    typeof v.fps === 'number' &&
    Number.isFinite(v.fps) &&
    typeof v.width === 'number' &&
    Number.isFinite(v.width) &&
    typeof v.height === 'number' &&
    Number.isFinite(v.height)
  );
}

export function loadPreppedClip(clip: string): PreppedClip | null {
  try {
    const raw = fs.readFileSync(preppedMetaPath(clip), 'utf8');
    const metaFile: unknown = JSON.parse(raw);
    if (!isPreppedClipMeta(metaFile)) return null;
    const stat = fs.statSync(preppedVideoPath(clip));
    if (!stat.isFile()) return null;
    return {
      name: clip,
      frameCount: metaFile.frameCount,
      fps: metaFile.fps,
      width: metaFile.width,
      height: metaFile.height,
      sizeBytes: stat.size,
    };
  } catch {
    return null;
  }
}

export function listPreppedClips(): PreppedClip[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(preppedDir());
  } catch {
    return [];
  }
  const clips: PreppedClip[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    const clip = loadPreppedClip(path.basename(entry, '.json'));
    if (clip) clips.push(clip);
  }
  clips.sort((a, b) => a.name.localeCompare(b.name));
  return clips;
}

/** SHA-256 hex of a file's bytes. The hash keys every cache entry. */
export function hashFile(localPath: string): string {
  const bytes = fs.readFileSync(localPath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export function errMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Unexpected server error';
}
