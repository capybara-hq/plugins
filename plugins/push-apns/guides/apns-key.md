# Connect Apple Push Notification service

{{pluginName}} sends notifications to the Capybara iOS app through Apple Push Notification service
(APNs) with a token-based signing key. One key covers every app of your Apple Developer team.

## 1. Create a signing key

In the Apple Developer portal open **Certificates, Identifiers & Profiles → Keys**, add a key,
enable **Apple Push Notifications service (APNs)** and download the `.p8` file. Apple lets you
download it only once; keep it somewhere safe. Note the **Key ID** shown with the key and your
**Team ID** (top right of the portal, or **Membership details**).

## 2. Fill in the deployment config

Save these fields on this page:

```yaml title="Deployment config (push-apns)"
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

List every app build that should receive notifications. A build signed for development registers
sandbox tokens, which only `environment: sandbox` reaches.

Each delivery opens its own connection to APNs and closes it afterwards (no shared connection pool
across replicas). That suits notifications people trigger; a very high push volume pays a TLS
handshake per delivery.

## 3. Check the key

The check signs a provider token with the key and asks APNs about an all-zero device token: APNs
then verifies the key, key ID and team ID without delivering anything.

::check apns-credentials APNs accepts the signing key
