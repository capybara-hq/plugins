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
# - one image for every tier (sandbox dev tiers spec §8): what limits a tier is the policy, not missing
#   binaries. It carries Node 22 (official tarball, SHA256 pinned per architecture), pnpm (global, so
#   `pnpm -v` works offline), yarn through corepack shims, ssh / nc / socat, a C toolchain, the
#   Chromium runtime libraries (no browser binary: Playwright downloads its own into
#   PLAYWRIGHT_BROWSERS_PATH), CJK fonts, and the published ssh host keys of github.com, gitlab.com
#   and bitbucket.org in /etc/ssh/ssh_known_hosts;
# - the root file system is read-only at run time and the user is non-root: everything a tool writes
#   goes under /workspace (the workspace volume, kept with the device) or /tmp. Package caches,
#   corepack downloads and browsers go to /workspace/.cache (pnpm can hard-link from there into
#   node_modules), `npm install -g` to npm_config_prefix=/workspace/.cache/npm-global (its bin is on
#   PATH), and the pnpm versions selected by a project's packageManager field to pnpm's home under
#   HOME (/workspace/.local/share/pnpm). The corepack shims are symlinks made at build time.
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

# ssh host keys of the common git hosts, so `git clone git@github.com:…` through the dev tier's SOCKS
# proxy does not stop at "Host key verification failed". Copied from the hosts' own publications
# (fetched 2026-11-12): GitHub https://api.github.com/meta (ssh_keys; also
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints),
# GitLab https://docs.gitlab.com/user/gitlab_com/#ssh-known_hosts-entries, Bitbucket
# https://bitbucket.org/site/ssh. Update them here when a host rotates its keys.
RUN printf '%s\n' \
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
  'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=' \
  'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=' \
  'gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf' \
  'gitlab.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFSMqzJeV9rUzU4kWitGjeR4PWSa29SPqJ1fVkhtj3Hw9xjLVXVYrU9QlYWrOLXBpQ6KWjbjTDTdDkoohFzgbEY=' \
  'gitlab.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9' \
  'bitbucket.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO' \
  'bitbucket.org ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=' \
  'bitbucket.org ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e86EG2qOCsIsD1Xw0xSeiPDlCr7kq97NLmMbpKTX6Esc30NuoqEEHCuc7yWtwp8dI76EEEB1VqY9QJq6vk+aySyboD5QF61I/1WeTwu+deCbgKMGbUijeXhtfbxSxm6JwGrXrhBdofTsbKRUsrN1WoNgUa8uqN1Vx6WAJw1JHPhglEGGHea6QICwJOAr/6mrui/oB7pkaWKHj3z7d1IC4KWLtY47elvjbaTlkN04Kc/5LFEirorGYVbt15kAUlqGM65pk6ZBxtaO3+30LVlORZkxOh+LKL/BvbZ/iRNhItLqNyieoQj/uh/7Iv4uyH/cV/0b4WDSd3DptigWq84lJubb9t/DnZlrJazxyDCulTmKdOR7vs9gMTo+uoIrPSb8ScTtvw65+odKAlBj59dhnVp9zd7QUojOpXlL62Aw56U4oO+FALuevvMjiWeavKhJqlR7i5n9srYcrNV7ttmDw7kf/97P5zauIhxcjX+xHv4M=' \
  > /etc/ssh/ssh_known_hosts \
  && chmod 0644 /etc/ssh/ssh_known_hosts

ENV HOME=/workspace \
  LANG=C.UTF-8 \
  COREPACK_HOME=/workspace/.cache/corepack \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  XDG_CACHE_HOME=/workspace/.cache \
  npm_config_cache=/workspace/.cache/npm \
  npm_config_prefix=/workspace/.cache/npm-global \
  PATH=/workspace/.cache/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
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
