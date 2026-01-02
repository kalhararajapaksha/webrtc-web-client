/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // Required for Docker optimization
  // WebRTC requires HTTPS in production, but HTTP is fine for local testing
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Permissions-Policy',
            value: 'camera=*, microphone=*, display-capture=*',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;








