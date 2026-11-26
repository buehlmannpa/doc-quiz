import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // ws und ioredis laufen ausschliesslich auf dem Server (WebSocket Endpunkt und Redis Subscriber).
  // Sie werden nicht gebündelt, sondern zur Laufzeit aus node_modules geladen.
  serverExternalPackages: ["ws", "ioredis", "pg"],
};

export default nextConfig;
