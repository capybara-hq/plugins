# Capybara 沙箱出站代理镜像（部署配置 egressProxyImage，默认标签 capybara-sandbox-egress:latest）：
#   docker build -t capybara-sandbox-egress:latest plugins/sandbox-docker/egress-proxy
# 多架构：docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/capybara-sandbox-egress:<tag> \
#   --push plugins/sandbox-docker/egress-proxy
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

COPY proxy.mjs /app/proxy.mjs
USER node
EXPOSE 3128
CMD ["node", "/app/proxy.mjs"]
