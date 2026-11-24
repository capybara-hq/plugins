# @capybara-hq/plugin-google

## 0.1.0-rc.3

### Patch Changes

- 6cb229b: Connector template descriptions in English and Chinese (`{ en, zh }`, plugin-sdk 0.1.0-rc.65), so a
  deployment shows each template's description in the page language.
- fd77b82: The deployment config is marked platform-only (unified plugin config, core#720): this plugin has no
  org-bound entry, so an org never overrides its fields.

## 0.1.0-rc.2

### Patch Changes

- 19123cd: Connector-template setup guides name their templates as `templates: [...]` (plugin-sdk
  0.1.0-rc.60 replaced the single `template` key).

## 0.1.0-rc.1

### Minor Changes

- 08b152a: Google Workspace (Gmail, Drive, Calendar, Sheets, Docs, Slides) and BigQuery connector templates on connector-mcp, each with a setup guide; needs kernel 0.1.0-rc.68 or newer
