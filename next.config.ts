import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
  reloadOnOnline: false,
});

const nextConfig: NextConfig = {
  output: "standalone",
  reactCompiler: true,
};

export default withSerwist(nextConfig);