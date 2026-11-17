---
"@capybara-hq/plugin-object-store-s3": patch
---

`uri(key)`: the object's unsigned canonical URI (`s3://<bucket>/<key>`), which the kernel puts in
model-visible text where it names a file the model cannot read. Also moves the plugin onto
`@capybara-hq/plugin-sdk` 0.1.0-rc.26, which carries the optional `ObjectStore.uri`.
