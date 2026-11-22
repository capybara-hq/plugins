---
"@capybara-hq/plugin-device-docker": patch
---

Moves to core R1 (`@capybara-hq/plugin-sdk` 0.1.0-rc.31, `@capybara-hq/testing` 0.1.0-rc.24). The
image restages the SDK's restricted runtime: `linux-sandbox.py`
(b17b714a445912508d5082598af42960df550387c4a73b379561af19b0b45c87) now mediates every write-capable
syscall in its seccomp broker against the SDK's mandatory write denies (shell startup files,
git-global, `.envrc`, `.npmrc`, editor and agent files, hook managers, only git's ordinary internals
inside `.git`) and is non-dumpable; `native-files.py`
(09a78c9bb7264ad6a1fe3b1aadd4c0f489192dc47c903c7fcc42fdf405590b42) refuses that set on roots marked
`denyWrites: true`. The provider's agent `capybara-operation.py`
(eb7217da155ff07842ad58333b88e5b8beecc209943e7987ef3b3c6e1fd74af3) marks its direct native roots of
a restricted scope and a restricted background output file `denyWrites: true`. The permission
conformance now also runs the mandatory-deny cases, the ordinary-git control and the same-uid
supervisor check (`inspect.outside`).
