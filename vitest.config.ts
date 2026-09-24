import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * The app validates its env at import time and exits if anything is missing, so
 * any test touching a module that (even indirectly) imports the logger or config
 * would die before running. `tsx --env-file` does this for the app; do the same
 * for tests rather than keeping modules artificially import-free.
 */
function loadEnvFile(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(new URL('./.env', import.meta.url), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')];
        })
        .filter(([key]) => key),
    );
  } catch {
    return {}; // no .env (CI) — tests that need one will say so
  }
}

// Mirror the tsconfig "@/*" → "src/*" path alias so tests import like the app does.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: loadEnvFile(),
  },
});
