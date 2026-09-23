# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run embed

# Бинарник кросс-компилируется, поэтому под arm64 не нужна эмуляция.
FROM --platform=$BUILDPLATFORM oven/bun:1-debian AS bin
ARG TARGETARCH
WORKDIR /app
COPY --from=web /app ./
RUN bun build --compile --minify --target=bun-linux-$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64) \
      server/index.ts --outfile /out/animejoya \
 && mkdir -p /out/data /out/cache

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=bin /out/animejoya /usr/local/bin/animejoya
COPY --from=bin --chown=nonroot:nonroot /out/data /data
COPY --from=bin --chown=nonroot:nonroot /out/cache /cache
ENV ANIMEJOYA_HOST=0.0.0.0 \
    ANIMEJOYA_PORT=7788 \
    ANIMEJOYA_NO_OPEN=1 \
    ANIMEJOYA_CACHE=/cache \
    XDG_CONFIG_HOME=/data
VOLUME ["/data", "/cache"]
EXPOSE 7788
ENTRYPOINT ["/usr/local/bin/animejoya"]
