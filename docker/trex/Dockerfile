# TREX image: node, the head lockfiles' dependencies, and Chromium. No source tree is in it.
# Build context = the head package and lock files plus docker/trex (see ensureImage in scripts/trex/env.mjs).
# Base image digests are read by envDigests() in env.mjs for report.envDigest. Update them together with compose.yml.
# No "syntax=" line: it would pull an unpinned frontend image. The engine's own frontend supports RUN --network=none.
# No secret is mounted: no step reads .trex/.env.build (npm ci uses the public registry).
FROM node:22@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd

WORKDIR /app

# The context is small, so one COPY works even when an old SHA lacks a lockfile or apps/agentic-os.
COPY . /ctx
RUN set -eux; \
    mkdir -p /app/apps/agentic-os; \
    for dir in . apps/agentic-os; do \
      for file in package.json package-lock.json; do \
        if [ -f "/ctx/$dir/$file" ]; then cp "/ctx/$dir/$file" "/app/$dir/$file"; fi; \
      done; \
    done; \
    rm -rf /ctx

# Scripts are off while installing. They run in the next step, which has no network.
RUN set -eux; \
    for dir in . apps/agentic-os; do \
      if [ -f "$dir/package-lock.json" ]; then (cd "$dir" && npm ci --ignore-scripts); fi; \
    done

RUN --network=none npm rebuild
RUN --network=none if [ -f apps/agentic-os/package-lock.json ]; then cd apps/agentic-os && npm rebuild; fi

RUN npx playwright install --with-deps chromium
