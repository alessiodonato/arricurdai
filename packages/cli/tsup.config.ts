import { defineConfig } from 'tsup';

// tsup builds the JavaScript only; tsc emits the declarations (see the build script).
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
});
