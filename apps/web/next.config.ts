import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["incus-web.tootie.tv"],
  async rewrites() {
    return [
      {
        source: "/terminal/:path*",
        destination: "http://127.0.0.1:3001/:path*",
      },
    ];
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
