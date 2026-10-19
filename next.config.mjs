import { withBotId } from 'botid/next/config'

/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ['libfx'],
  turbopack: { root: import.meta.dirname },
  // The DESIGN.md catalog is read from disk when a new chat picks one.
  outputFileTracingIncludes: { '/api/prompt': ['./lib/design-md/*.md'] },
  env: {
    NEXT_PUBLIC_FX0_FREE_PROMPTS: process.env.FX0_FREE_PROMPTS === '1' ? '1' : '0',
  },
}

export default withBotId(nextConfig)
