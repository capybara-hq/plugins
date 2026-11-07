# Capybara 对话沙箱镜像：Docker 插件与 E2B 模板共用这一份。
#
# 构建（标签与内核配置 sandbox.image 的默认值 capybara-sandbox:latest 一致）：
#   docker build -t capybara-sandbox:latest plugins/sandbox-docker/image
# 多架构（amd64 + arm64）推到镜像仓库：
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t <registry>/capybara-sandbox:<tag> --push plugins/sandbox-docker/image
# 发布：.github/workflows/images.yml 在 plugins/sandbox-docker 的版本变更合入 main 后，构建并推送
#   ghcr.io/capybara-hq/capybara-sandbox:<插件版本>（出站代理镜像 capybara-sandbox-egress 同理）。
#
# 约定（插件依赖这些，改动时一并改插件）：
# - 以非 root 用户 sandbox（uid / gid 1000）运行，HOME 与工作目录是 /workspace（插件挂持久卷）；
# - /skills 归 root，插件只读挂载；/opt/capybara 归 root 且 0700：插件以 root 经 /opt/capybara/skills
#   （同一个卷的可写挂载）写入技能，沙箱用户进不去；
# - 内核的工具要用 GNU find（-print0）、GNU grep（--null、-e … --）、coreutils、sh / bash；
#   插件中止命令要用 setsid（util-linux）与 pkill（procps）。
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates coreutils curl file findutils git grep jq less procps python3 \
    python3-pip python3-venv unzip util-linux xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 sandbox \
  && useradd --uid 1000 --gid 1000 --home-dir /workspace --no-create-home --shell /bin/bash sandbox \
  && mkdir -p /workspace /skills /opt/capybara/skills \
  && chown 1000:1000 /workspace \
  && chmod 0755 /skills /opt/capybara/skills \
  && chmod 0700 /opt/capybara

ENV HOME=/workspace \
  LANG=C.UTF-8 \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  PYTHONDONTWRITEBYTECODE=1

USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
