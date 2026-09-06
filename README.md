# intervio-backend

Express + TypeScript API for Intervio. Modular monolith, one service.

## Stack
TypeScript · Express 5 · Prisma + PostgreSQL · Redis (ioredis) · Zod · JWT auth (access + refresh with rotation) · Pino. Runs TS directly via `tsx` (no build step for the MVP).

## Local setup
```bash
cp .env.example .env          # then fill in secrets as needed
docker compose up -d          # Postgres + Redis
npm install
npm run prisma:generate
npm run prisma:migrate        # creates the users table
npm run dev                   # http://localhost:4000
```

Health check: `GET /health` → `{ status, db, redis }`.

## Auth endpoints
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | email + password (+ optional name) |
| POST | `/auth/login` | email + password |
| POST | `/auth/refresh` | rotates the refresh token |
| POST | `/auth/logout` | revokes the refresh token |
| GET | `/auth/me` | current user (requires auth cookie) |
| GET | `/auth/google` | Google OAuth (only if configured) |
| GET | `/auth/google/callback` | OAuth callback → redirects to the app |

Access + refresh tokens are httpOnly cookies. Refresh jtis are tracked in Redis so they can be
rotated and revoked; reuse of a rotated token revokes all of that user's sessions.

## Structure
```
src/
  main.ts        Express bootstrap + health check
  config/        Zod-validated env
  common/        errors, logger, http handlers, auth guard
  contracts/     ⭐ source of truth shared with the frontend
  auth/          jwt + google oauth + refresh rotation
  db/            prisma client, redis, repositories
  storage/       Cloudflare R2 (S3-compatible) client
prisma/          schema + migrations
```
