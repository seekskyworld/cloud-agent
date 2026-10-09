FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.6.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE NOTICE THIRD_PARTY_NOTICES.txt ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY apps apps
COPY packages packages
COPY adapters adapters
COPY modules modules
COPY scripts scripts
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/dist dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations migrations
COPY --chown=node:node LICENSE NOTICE THIRD_PARTY_NOTICES.txt ./
RUN mkdir -p /app/files && chown node:node /app/files
USER node
EXPOSE 3100
CMD ["node","dist/apps/api/main.js"]
