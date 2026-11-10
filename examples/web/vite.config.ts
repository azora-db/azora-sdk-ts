import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// VITE_AZORA_WS_URL and VITE_AZORA_TOKEN come from ../.env, written by `pnpm dev:engine`.
export default defineConfig({
  plugins: [react()],
  envDir: '..',
  server: { port: 5183, strictPort: true },
})
