import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No Keymaster in the browser — the member signs in with their own wallet via challenge/response, so
// no Buffer/crypto polyfill is needed here. Keys never touch the portal.
export default defineConfig({
  plugins: [react()],
  server: { port: 5176 },
});
