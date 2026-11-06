import { defineConfig } from 'tsup';

// One file: the workspace packages go inside it, so that npm has a single package to install.
export default defineConfig({
  entry: ['src/bin.ts'],
  noExternal: ['@arricurdai/core', '@arricurdai/transcripts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
});
