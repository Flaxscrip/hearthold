import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Thin client — no Keymaster in the browser, so no Buffer/crypto polyfill needed.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
});
