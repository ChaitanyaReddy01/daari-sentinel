/**
 * Shared display helpers. Browser-safe: no node imports, so /lab and
 * scripts can both use this module.
 */

/** SAM video tracking caps at 16 objects per frame. */
export const VIDEO_TRACKING_CAP = 16;

/**
 * A video object count for display. Exactly 16 means the cap censored the
 * count, so it renders as "16+".
 */
export function formatCount(n: number): string {
  return n === VIDEO_TRACKING_CAP ? '16+' : String(n);
}
