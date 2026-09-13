FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npx tsc --noEmit --project tsconfig.json && npx vite build
RUN npm prune --omit=dev --ignore-scripts
FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src ./src
COPY scripts/admin.ts ./scripts/admin.ts
RUN chgrp -R 0 /app && chmod -R g=u /app
USER 1001
EXPOSE 8443
CMD ["node","--import","tsx","src/server/main.ts"]
