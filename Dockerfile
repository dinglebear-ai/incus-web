FROM node:22-alpine AS base

FROM base AS builder
WORKDIR /app
COPY package*.json ./
COPY apps/web/package*.json ./apps/web/
RUN npm install
COPY . .
WORKDIR /app/apps/web
RUN NODE_OPTIONS=--max-old-space-size=2048 npm run build || true

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=2048
ENV PORT=3090
ENV HOSTNAME="0.0.0.0"

EXPOSE 3090
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3090"]
