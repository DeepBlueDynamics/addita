# syntax=docker/dockerfile:1
FROM node:24-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim

WORKDIR /app
RUN mkdir -p /data && chown -R node:node /data /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node presets ./presets

ENV NODE_ENV=production \
    ADDITA_HOST=0.0.0.0 \
    ADDITA_PORT=11345 \
    ADDITA_STDIO=false \
    ADDITA_DATA_DIR=/data

VOLUME /data
EXPOSE 11345
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.ADDITA_PORT || 11345) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/index.js"]
