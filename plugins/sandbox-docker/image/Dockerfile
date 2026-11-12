# Capybara 对话沙箱镜像：Docker 插件与 E2B 模板共用这一份。
#
# Images are published by .github/workflows/images.yml as
#   ghcr.io/capybara-hq/capybara-sandbox:<plugin version>
# A local build is the offline route (then set the kernel's sandbox.image to the tag):
#   docker build -t capybara-sandbox:latest plugins/sandbox-docker/image
# 多架构（amd64 + arm64）推到镜像仓库：
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t <registry>/capybara-sandbox:<tag> --push plugins/sandbox-docker/image
# Published: .github/workflows/images.yml builds and pushes
#   ghcr.io/capybara-hq/capybara-sandbox:<plugin version> once a plugins/sandbox-docker version change
#   reaches main (the egress proxy image capybara-sandbox-egress likewise).
#
# 约定（插件依赖这些，改动时一并改插件）：
# - 以非 root 用户 sandbox（uid / gid 1000）运行，HOME 与工作目录是 /workspace（插件挂持久卷）；
# - /skills 归 root，插件只读挂载；/opt/capybara 归 root 且 0700：插件以 root 经 /opt/capybara/skills
#   （同一个卷的可写挂载）写入技能，沙箱用户进不去；
# - 内核的工具要用 GNU find（-print0）、GNU grep（--null、-e … --）、coreutils、sh / bash；
#   插件中止命令要用 setsid（util-linux）与 pkill（procps）、timeout 与 base64（coreutils）；
# - One image for every tier (sandbox dev tiers spec §8): what limits a tier is the policy, not missing
#   binaries. It carries Node 22 (official tarball, SHA256 pinned per architecture), pnpm (global, so
#   `pnpm -v` works offline) and yarn / corepack shims, ssh / nc / socat, a C toolchain, the Chromium
#   runtime libraries (no browser binary: Playwright downloads its own into PLAYWRIGHT_BROWSERS_PATH)
#   and CJK fonts;
# - the root file system is read-only at run time and the user is non-root: everything a tool writes
#   (package caches, corepack downloads, browsers) goes under /workspace/.cache (the workspace volume,
#   so it persists with the device and pnpm can hard-link into node_modules) or /tmp. Nothing here
#   needs a write anywhere else; the corepack shims are symlinks made at build time.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates coreutils curl file findutils git grep jq less procps python3 \
    python3-pip python3-venv unzip util-linux xz-utils \
    openssh-client netcat-openbsd socat build-essential pkg-config \
    fonts-liberation fonts-noto-cjk \
# Chromium runtime libraries: the set `playwright install-deps chromium` installs on Debian 13
# (trixie), pinned here so the image is reproducible and the install needs no root at run time.
    libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 \
    libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  && rm -rf /var/lib/apt/lists/*

# Node 22 LTS from nodejs.org, checked against the SHA256 of the release's SHASUMS256.txt
# (https://nodejs.org/dist/v22.23.5/SHASUMS256.txt). Bump version and both sums together.
ARG TARGETARCH
ARG NODE_VERSION=22.23.5
ARG NODE_SHA256_X64=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
ARG NODE_SHA256_ARM64=2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09
ARG PNPM_VERSION=10.34.9
RUN set -eu; \
  case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
    amd64) arch=x64; sha="$NODE_SHA256_X64" ;; \
    arm64) arch=arm64; sha="$NODE_SHA256_ARM64" ;; \
    *) echo "unsupported architecture" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
  echo "${sha}  /tmp/node.tar.xz" | sha256sum -c -; \
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'; \
  rm /tmp/node.tar.xz; \
  npm install -g "pnpm@${PNPM_VERSION}"; \
  corepack enable yarn; \
  npm cache clean --force; rm -rf /root/.npm

RUN groupadd --gid 1000 sandbox \
  && useradd --uid 1000 --gid 1000 --home-dir /workspace --no-create-home --shell /bin/bash sandbox \
  && mkdir -p /workspace /skills /opt/capybara/skills \
  && chown 1000:1000 /workspace \
  && chmod 0755 /skills /opt/capybara/skills \
  && chmod 0700 /opt/capybara

ENV HOME=/workspace \
  LANG=C.UTF-8 \
  COREPACK_HOME=/workspace/.cache/corepack \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  XDG_CACHE_HOME=/workspace/.cache \
  npm_config_cache=/workspace/.cache/npm \
  npm_config_store_dir=/workspace/.cache/pnpm-store \
  PIP_CACHE_DIR=/workspace/.cache/pip \
  UV_CACHE_DIR=/workspace/.cache/uv \
  CARGO_HOME=/workspace/.cache/cargo \
  GOMODCACHE=/workspace/.cache/go/mod \
  GOCACHE=/workspace/.cache/go/build \
  GRADLE_USER_HOME=/workspace/.cache/gradle \
  PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright \
  NODE_USE_ENV_PROXY=1 \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  PYTHONDONTWRITEBYTECODE=1

USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
