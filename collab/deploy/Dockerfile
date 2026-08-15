# Single deployable: API + built UI. Build context is the collab/ workspace root.
FROM node:22-bookworm-slim AS build
WORKDIR /srv
COPY package.json package-lock.json ./
COPY contracts ./contracts
COPY server ./server
COPY web ./web
COPY tsconfig.base.json ./
RUN npm ci && npm run build

FROM node:22-bookworm-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build /srv /srv
ENV COLLAB_STATIC_DIR=/srv/web/dist
EXPOSE 8787
USER node
CMD ["node", "server/dist/index.js"]
