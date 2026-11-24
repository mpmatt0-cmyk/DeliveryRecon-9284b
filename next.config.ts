import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  outputFileTracingExcludes: {
    '*': ['.data/**/*', '.netlify/**/*', '.git/**/*', 'tests/**/*'],
  },
};

export default nextConfig;
