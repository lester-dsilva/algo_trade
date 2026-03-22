import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        proxyTimeout: 600000,  // 10 min — backtest-all over 200+ dates can take several minutes
        timeout: 600000,
      },
    },
  },
})
