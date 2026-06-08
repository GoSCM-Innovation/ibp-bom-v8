import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Local dev: serve the UI with `npm run dev` and the serverless functions with
    // `vercel dev --listen 3002` — /api/* is proxied there. (Opening the page from
    // vercel dev directly broke with Vite 8: its catch-all rewrite feeds index.html
    // into vite's import analysis.) Production on Vercel is unaffected.
    proxy: { '/api': 'http://localhost:3002' },
  },
})
