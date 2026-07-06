import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// This app runs @didcid/keymaster IN THE BROWSER (the member signs KB requests with their own wallet),
// so it needs the Buffer global + the `buffer` package aliased — the archon.social / react-wallet recipe.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { buffer: 'buffer' } },
  optimizeDeps: { include: ['buffer'] },
  server: { port: 5176 },
});
