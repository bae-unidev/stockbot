/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@stockbot/core'],
  webpack: (config) => {
    // @stockbot/core 는 TS ESM(.js 확장자 import) → webpack 이 .ts 로 해석하도록.
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};
export default nextConfig;
