# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

FROM ${NODE_IMAGE} AS manifests
WORKDIR /workspace

# npm validates the complete workspace graph against package-lock.json even
# when an install is filtered to API workspaces, so keep every manifest here.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/merchant/package.json apps/merchant/package.json
COPY apps/checkout/package.json apps/checkout/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY integrations/openclaw-telebirr/package.json integrations/openclaw-telebirr/package.json
COPY sdk/node/package.json sdk/node/package.json
COPY tools/webhook-receiver/package.json tools/webhook-receiver/package.json

FROM manifests AS build
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace @telebirr/api --workspace @telebirr/contracts
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm -w @telebirr/contracts run build \
    && npm -w @telebirr/api run build

FROM manifests AS production-dependencies
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --workspace @telebirr/api --workspace @telebirr/contracts \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG BUILD_REVISION=unknown
ARG BUILD_VERSION=0.0.0-dev
ARG BUILD_SOURCE=unknown
LABEL org.opencontainers.image.title="Telebirr P2P API" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.source="${BUILD_SOURCE}"
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    PORT=3000
WORKDIR /workspace
RUN groupadd --system --gid 10001 telebirr \
    && useradd --system --uid 10001 --gid telebirr --home-dir /nonexistent --shell /usr/sbin/nologin telebirr
COPY --from=production-dependencies --chown=telebirr:telebirr /workspace/node_modules ./node_modules
# Prisma Client is generated during the build; production installs deliberately
# omit the Prisma CLI, so copy only the generated engine/client artifacts.
COPY --from=build --chown=telebirr:telebirr /workspace/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=telebirr:telebirr /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=telebirr:telebirr /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=telebirr:telebirr /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=telebirr:telebirr /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=telebirr:telebirr /workspace/apps/api/prisma ./apps/api/prisma
COPY --chown=telebirr:telebirr docs/openapi/telebirr-p2p-v1.yaml ./docs/openapi/telebirr-p2p-v1.yaml
USER telebirr
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]

# Run this target exactly once for each release before replacing API replicas.
# It intentionally contains build dependencies, including the pinned Prisma CLI,
# but is never used as a long-running service.
FROM build AS migration
ENV NODE_ENV=production
USER node
CMD ["npm", "-w", "@telebirr/api", "run", "prisma:deploy"]
