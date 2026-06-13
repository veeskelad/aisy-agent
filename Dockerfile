# Aisy harness — runtime image (ADR-0035).
# Build-from-source, not pinned prebuilt binaries: native deps (better-sqlite3)
# are compiled against this image's actual Node/ABI to avoid the GLIBC/ABI
# mismatch failure class.

# --- build stage ---------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# build toolchain for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

# --- runtime stage -------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg for the voice (Whisper) path; runtime only, no compilers
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
COPY --from=build /app /app

# Memory tree + secrets are mounted at runtime, never baked in (git-ignored).
VOLUME ["/data"]
ENV AISY_MEMORY_ROOT=/data/memory

# `aisy` resolves via the package bin once the bin adapters are wired (v0.2).
ENTRYPOINT ["pnpm", "--filter", "@aisy/core", "exec", "aisy"]
CMD ["doctor"]
