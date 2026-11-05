# Host-agnostic image. Runs TypeScript directly via tsx (no build step for the MVP).
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Install deps (including prisma CLI, needed for `prisma generate` + migrations).
COPY package.json package-lock.json* ./
# --include=dev: the app runs TS via tsx and generates its client with the prisma
# CLI — both devDependencies, which NODE_ENV=production would otherwise skip.
RUN npm ci --include=dev

# App source + generated Prisma client.
COPY . .
RUN npx prisma generate

EXPOSE 4000
# Apply pending migrations, then boot.
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
