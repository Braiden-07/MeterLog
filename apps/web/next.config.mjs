/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @meterlog/shared is published as TypeScript source, not a build artifact,
  // so Next must compile it rather than treat it as an opaque dependency.
  transpilePackages: ['@meterlog/shared'],
};

export default nextConfig;
