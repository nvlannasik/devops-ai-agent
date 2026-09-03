# =============================================================================
# Build stage: compile TypeScript
# =============================================================================
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
# --ignore-scripts: esbuild has a postinstall that EXECS the binary it just wrote. Under QEMU
# emulation — any cross-arch build, e.g. linux/amd64 on an arm64 host — that exec races the
# write and dies with ETXTBSY. esbuild is here twice over (tsx depends on it, and the dashboard
# bundle calls it directly), and neither needs the script: the platform binary comes from an
# optionalDependency package, and `node scripts/build-client.mjs` was verified to run with the
# postinstall skipped. No dependency in this stage needs its install scripts.
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.client.json ./
COPY index.ts ./
COPY src/ ./src/
# The dashboard's topology map is a React Flow bundle, built by scripts/build-client.mjs into
# dist/public/ as the third step of `npm run build`. Nothing else here needs a bundler, and the
# runtime stage picks the output up for free because it already copies dist/ whole.
COPY scripts/ ./scripts/

RUN npm run build


# =============================================================================
# Download stage: ambil aws_signing_helper binary
# CATATAN: stage ini Alpine murni (no glibc), jadi JANGAN execute binary di sini
# Smoke test dipindah ke runtime stage setelah gcompat di-install.
# =============================================================================
FROM alpine:3.20 AS aws-tools

ARG TARGETARCH
ARG SIGNING_HELPER_VERSION=1.8.4

RUN apk add --no-cache curl && \
    case "$TARGETARCH" in \
      amd64) ARCH="X86_64" ;; \
      arm64) ARCH="Aarch64" ;; \
      *)     echo "Unsupported arch: $TARGETARCH" && exit 1 ;; \
    esac && \
    curl -fLo /aws_signing_helper \
      "https://rolesanywhere.amazonaws.com/releases/${SIGNING_HELPER_VERSION}/${ARCH}/Linux/Amzn2023/aws_signing_helper" && \
    chmod +x /aws_signing_helper


# =============================================================================
# Runtime stage
# =============================================================================
FROM node:24-alpine AS runtime

# gcompat: glibc compatibility layer untuk aws_signing_helper (glibc binary)
# openssl: untuk entrypoint.sh cek cert expiry
RUN apk add --no-cache gcompat openssl

WORKDIR /app

# Copy signing helper dari stage aws-tools
COPY --from=aws-tools /aws_signing_helper /usr/local/bin/aws_signing_helper

# Smoke test: gcompat sudah ada, binary harusnya bisa jalan
RUN /usr/local/bin/aws_signing_helper version

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy build output
COPY --from=builder /app/dist ./dist
COPY prompts/ ./prompts/
COPY migrations/ ./migrations/

EXPOSE 3000
EXPOSE 3001

# entrypoint.sh generate AWS config (AWS_CONFIG_FILE, default /tmp/aws/config —
# not ~/.aws: uid 1001 + read-only rootfs) dari env vars, lalu exec CMD
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]