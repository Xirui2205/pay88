# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e
FROM ${NODE_IMAGE} AS build
ARG APP
ARG VITE_API_BASE_URL=/v1
ARG VITE_BUILD_REVISION=local
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_BUILD_REVISION=${VITE_BUILD_REVISION}
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/merchant/package.json apps/merchant/package.json
COPY apps/checkout/package.json apps/checkout/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY integrations/openclaw-telebirr/package.json integrations/openclaw-telebirr/package.json
COPY sdk/node/package.json sdk/node/package.json
COPY tools/webhook-receiver/package.json tools/webhook-receiver/package.json
RUN case "${APP}" in admin|merchant|checkout) ;; *) echo "APP must be admin, merchant, or checkout" >&2; exit 64 ;; esac

# Keep the cache mount on its own instruction; Docker cannot attach a mount in
# the middle of the shell validation above.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace "@telebirr/${APP}"

COPY apps/${APP} apps/${APP}
COPY output/pdf /manuals
RUN npm -w @telebirr/${APP} run build && cp -R apps/${APP}/dist /out

FROM nginxinc/nginx-unprivileged:1.29.4-alpine@sha256:a6c4f61f456b85b8fdf7ec7ab28cc3e299440e6fb4a9dea520e5fd8fd440025e AS runtime
COPY infra/docker/nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out /usr/share/nginx/html
COPY --from=build /manuals /usr/share/nginx/html/manuals
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
