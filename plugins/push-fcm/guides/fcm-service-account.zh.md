# 连接 Firebase Cloud Messaging

{{pluginName}} 通过 FCM HTTP v1 接口向 Capybara Android 应用发送推送通知，以你的 Firebase 项目里的
Google 服务账号身份登录。

1. 在 [Firebase 控制台](https://console.firebase.google.com/) 打开包含你的 Android 应用的项目
   （或新建一个项目，并用应用 ID 添加应用）。
2. 打开 **项目设置 → Cloud Messaging**，确认 **Firebase Cloud Messaging API (V1)** 已启用。
3. 打开 **项目设置 → 服务账号**，选择 **生成新的私钥**。浏览器会下载一个 JSON 密钥文件；它是凭据，请妥善保管。
4. 在本页把整个文件粘贴到 **服务账号密钥（JSON）**（`serviceAccount`），并在 `applicationIds` 里列出应用构建时使用的
   Android 应用 ID，然后保存。

密钥加密保存，之后不再显示。轮换密钥时，先生成新密钥并在这里保存，再到 Google Cloud 控制台删除旧密钥。

::check fcm-credentials Google 接受这个服务账号密钥
