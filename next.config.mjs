/** @type {import('next').NextConfig} */
const nextConfig = {
  // Verification builds/servers use NEXT_DIST_DIR=.next-verify so they never
  // touch the dev server's .next directory.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // The API function reads the committed snapshot at runtime (no video files
  // ship to production, so keep clips/ out of function traces).
  experimental: {
    outputFileTracingIncludes: {
      '/api/[...path]': ['./data/snapshot/**/*', './data/eval/**/*'],
    },
    outputFileTracingExcludes: {
      '/api/[...path]': ['./public/clips/**/*', './clips/**/*'],
    },
  },
};

export default nextConfig;
