import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Tauri CLI supplies the selected target, including cross-architecture builds.
  define: { __BENTO_BUILD_ARCH__: JSON.stringify(process.env.TAURI_ENV_ARCH || '') },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
})
