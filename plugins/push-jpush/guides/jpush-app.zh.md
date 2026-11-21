# 连接极光推送

{{pluginName}} {{pluginVersion}} 通过极光推送向 Android 应用发送推送通知。极光经它自己的通道投递，应用集成了厂商通道时，也经华为、荣耀、小米、OPPO、vivo 通道投递。每条通知都按服务类消息发送（极光 `classification: 1`）。

1. 在极光控制台打开 Android 应用集成的那个应用，从应用设置中复制 **AppKey** 和 **Master Secret**。
2. 把它们保存到本页面的 `appKey` 和 `masterSecret`，并在 `applicationIds` 中列出使用这个极光应用的各个构建的 Android 应用 ID（包名）。
3. 如果极光应用开启了 IP 白名单，把本部署的出口 IP 加进去。

::check jpush-credentials 极光推送接受这组 AppKey 和 Master Secret

## 厂商通道

各厂商自行判断一条通知是否属于服务类消息。请先向厂商申请消息分类，再填写厂商给出的值（都可不填）：

- **小米：** `xiaomi.channelId`（私信通道）和 `xiaomi.templateId`。
- **OPPO：** `oppo.channelId`、`oppo.category` 和 `oppo.notifyLevel`（1、2 或 16，需同时填写分类）。
- **vivo：** `vivo.category`，模板消息另填 `vivo.templateId`。
- **华为：** `huawei.category`（需要华为的自分类权益）。华为和荣耀的重要级别固定为 `NORMAL`。

小米或 vivo 的模板须声明变量 `title` 和 `body`，由通知的标题和正文填充。
