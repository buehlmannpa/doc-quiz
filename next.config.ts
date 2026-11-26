import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // ws und ioredis laufen ausschliesslich auf dem Server (WebSocket Endpunkt und Redis Subscriber).
  // Sie werden nicht gebündelt, sondern zur Laufzeit aus node_modules geladen.
  serverExternalPackages: ["ws", "ioredis", "pg"],
  // Die Systemseite wendet Migrationen an und liest dafür die SQL Dateien aus dem Ordner drizzle.
  // Ohne diese Angabe würde Vercel den Ordner nicht in die Funktion packen.
  outputFileTracingIncludes: {
    "/admin/system": ["./drizzle/**/*"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Keine Seite dieser App soll in einem fremden Rahmen erscheinen.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
