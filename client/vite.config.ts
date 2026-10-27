import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      // Uploaded media lives on the API server; without this, <img> and
      // <video> tags 404 in dev (the dev server has no /uploads route).
      '/uploads': 'http://localhost:4000',
    },
  },
})
