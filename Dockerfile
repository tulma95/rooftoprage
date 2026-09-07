# syntax=docker/dockerfile:1
# Browser assets and compiled server JavaScript are architecture-independent.
# Run the compiler and timing-sensitive multiplayer tests natively.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY tests ./tests
COPY index.html vite.config.ts tsconfig.json tsconfig.server.json ./
RUN npm run typecheck && npm test && npm run build

FROM node:24-alpine3.24 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Alpine's shared-library Node package is smaller than the official Node binary.
# npm and Yarn stay in the build stages. Keep the runtime on the same Node major.
FROM alpine:3.24 AS runtime
RUN apk add --no-cache 'nodejs~24' \
  && addgroup -g 1000 node \
  && adduser -u 1000 -G node -D node
ENV NODE_ENV=production SERVER_PORT=2567
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.SERVER_PORT + '/health', {signal: AbortSignal.timeout(4000)}).then(r => {if (!r.ok) process.exit(1)}).catch(() => process.exit(1))"
CMD ["node", "dist-server/server/index.js"]
