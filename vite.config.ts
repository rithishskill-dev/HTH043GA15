import { defineConfig } from 'vite'

const apiPort = Number(process.env.PORT ?? 8787)

export default defineConfig({
  server: {
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
})
