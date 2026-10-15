import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Compression would buffer the `/api/events` stream; this app only ever serves 127.0.0.1.
  compress: false,
};

export default config;
