import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://bexiobot:dev-only-change-in-prod@localhost:5433/bexiobot',
  },
  verbose: true,
  strict: true,
});
