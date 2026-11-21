# 连接 Apple 推送通知服务

{{pluginName}} 通过 Apple 推送通知服务（APNs）的令牌签名密钥，把通知发送到 Capybara iOS 应用。一个密钥覆盖你
Apple 开发者团队下的所有应用。

## 1. 创建签名密钥

在 Apple Developer 网站打开 **Certificates, Identifiers & Profiles → Keys**，新建密钥，勾选
**Apple Push Notifications service (APNs)**，下载 `.p8` 文件。Apple 只允许下载一次，请妥善保存。记下密钥旁显示的
**Key ID**，以及你的 **Team ID**（网站右上角，或 **Membership details**）。

## 2. 填写部署配置

在本页保存以下字段：

```yaml title="部署配置（push-apns）"
key: |              # the whole content of AuthKey_<KEY ID>.p8, BEGIN and END lines included
  -----BEGIN PRIVATE KEY-----
  ...
  -----END PRIVATE KEY-----
keyId: ABC123DEFG   # 10 characters
teamId: TEAM123456  # 10 characters
bundles:
  - bundleId: com.example.capybara   # the bundle id of your iOS app build
    environment: production          # sandbox for development builds from Xcode
```

列出每个需要接收通知的应用构建。以开发证书签名的构建注册的是 sandbox 令牌，只有 `environment: sandbox` 能送达。

## 3. 检查密钥

检查会用该密钥签出一个提供方令牌，并向 APNs 查询一个全零设备令牌：APNs 据此校验密钥、Key ID 与 Team ID，
不会投递任何内容。

::check apns-credentials APNs 接受该签名密钥
