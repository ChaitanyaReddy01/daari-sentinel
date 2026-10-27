/** @type {import('next').NextConfig} */
const nextConfig = {
  // Verification builds/servers use NEXT_DIST_DIR=.next-verify so they never
  // touch the dev server's .next directory.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
