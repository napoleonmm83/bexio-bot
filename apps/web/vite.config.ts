import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// Load .env.local from the repo root into process.env.
// Single source of truth for DATABASE_URL, BEXIO_*, DISCORD_WEBHOOK_URL.
// Vite's `envDir` only feeds import.meta.env, not server-side process.env.
const envDir = resolve(import.meta.dirname, '..', '..');
for (const fileName of ['.env', '.env.local']) {
  const envFile = resolve(envDir, fileName);
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!match) continue;
      const key = match[1]!;
      let value = match[2]!;
      // Strip optional surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Don't override if already set (CI / shell env wins)
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

export default defineConfig({
  plugins: [sveltekit()],
  envDir,
  server: {
    port: 5173,
    strictPort: true,
  },
});
