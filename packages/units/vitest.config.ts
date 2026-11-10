import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // The client from source: tests need no build.
      '@azora-db/client': root('src/index.ts'),
      '#tcp': root('src/platform/tcp.node.ts'),
      '#aead': root('src/platform/aead.node.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
})
