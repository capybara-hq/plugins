# Capybara sandbox egress proxy image (deployment config egressProxyImage, default tag
# capybara-sandbox-egress:latest). Env: MODE open-public | allowlist, ALLOW_HOSTS (allowlist),
# PORT (3128), SOCKS_PORT (1080), CONFIG_FILE (/config/allow.json, the instance's volume), CONTROL_SOCKET
# (/run/egress/control.sock, on a tmpfs).
#   docker build -t capybara-sandbox-egress:latest plugins/device-docker/egress-proxy
# Multi-arch: docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/capybara-sandbox-egress:<tag> \
#   --push plugins/device-docker/egress-proxy
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

COPY proxy.mjs /app/proxy.mjs
# /config: the mount point of the instance's config volume, owned by node so a new named volume
# inherits it; /run/egress: the mount point of the control socket's tmpfs.
RUN mkdir -p /config /run/egress && chown node:node /config /run/egress && chmod 0700 /config /run/egress
# the provider gives an instance the in-place list control only when its proxy image says so
# (version 2: every apply carries the kernel's fence token; FENCE is the create-time token)
LABEL dev.capybara.sandbox.egress-control="2"
USER node
EXPOSE 3128 1080
CMD ["node", "/app/proxy.mjs"]
