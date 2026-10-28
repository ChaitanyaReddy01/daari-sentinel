import urls from '../../data/snapshot/clip-urls.json';

/**
 * Where the browser loads display clips from. Blob in production
 * (NEXT_PUBLIC_CLIPS_SOURCE=blob), local /clips/... paths in dev.
 * Client-safe: the URL map is bundled at build time.
 */

interface ClipUrls {
  clips: Record<string, string>;
  thumbs: Record<string, Record<string, string>>;
  maxSec: Record<string, number>;
}

const URLS = urls as ClipUrls;

export function blobClipsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CLIPS_SOURCE === 'blob';
}

/** Display video URL for a clip (always a blurred copy). */
export function clipVideoUrl(clip: string): string {
  if (blobClipsEnabled()) {
    const u = URLS.clips[clip];
    if (u) return u;
  }
  return `/clips/blurred/${encodeURIComponent(clip)}.mp4`;
}

/** Evidence thumbnail URL for a clip + second. */
export function clipThumbUrl(clip: string, second: number): string {
  if (blobClipsEnabled()) {
    const max = URLS.maxSec[clip] ?? 0;
    const sec = Math.min(Math.max(0, Math.floor(second)), max);
    const u = URLS.thumbs[clip]?.[String(sec)];
    if (u) return u;
  }
  return `/api/sim/thumbnail?clip=${encodeURIComponent(clip)}&second=${second}`;
}
