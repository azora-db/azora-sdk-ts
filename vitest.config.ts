import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string): string => fileURLToPath(new URL(`./src/${p}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '#tcp': src('platform/tcp.node.ts'),
      '#aead': src('platform/aead.node.ts'),
      // The packages from source (the units CLI imports the client by name).
      '@azora-db/client': src('index.ts'),
      '@azora-db/units/tools': fileURLToPath(new URL('./packages/units/src/tools.ts', import.meta.url)),
      '@azora-db/units': fileURLToPath(new URL('./packages/units/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
})
