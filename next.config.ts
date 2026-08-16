import type { NextConfig } from 'next'

const config: NextConfig = {
  // Self-hosted on Coolify: build a standalone server bundle so the runtime
  // image does not need node_modules or a package manager.
  output: 'standalone',
  poweredByHeader: false,
}

export default config
