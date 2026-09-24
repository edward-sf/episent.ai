import { defineConfig } from 'vite';

// Builds the dashboard frontend into the directory wrangler.dashboard.jsonc serves.
export default defineConfig({
  root: 'src/dashboard/web',
  build: {
    outDir: '../../../dist/dashboard',
    emptyOutDir: true,
  },
});
