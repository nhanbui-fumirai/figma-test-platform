import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // a second dev server (another port, e.g. for an e2e check) needs its own build folder: NEXT_DIST_DIR=.next-e2e
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // the api is called directly from the browser (NEXT_PUBLIC_API_URL): uploads and SSE are not proxied
};

export default config;
