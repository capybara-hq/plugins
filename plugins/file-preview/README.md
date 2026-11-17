# @capybara-hq/plugin-file-preview

Previews files from a conversation in the right panel. The plugin provides `file-preview@1` with
seven previewers; each is a sandboxed embed. Markdown, CSV / TSV and bitmap images stay with the
kernel's built-in previewers and are never claimed here.

## Previewers

| Previewer | Shows | Accepts (summary) |
|---|---|---|
| `code` | Syntax-highlighted source with line numbers | About 50 extensions (`ts`, `py`, `go`, `rs`, `java`, `sh`, `sql`, `json`, `yaml`, `toml`, `xml`, `css`, `vue`, `txt`, `log`, `env`, …) and MIME types such as `text/plain`, `application/json`, `text/x-python` |
| `zip` | The entry tree of an archive; open an entry in place, including a nested archive one level deep | `zip`, `jar`; `application/zip` |
| `sheet` | One tab per worksheet as a read-only grid | `xlsx`, `xlsm` |
| `docx` | The document converted to sanitized HTML | `docx` |
| `pdf` | Pages rendered lazily on canvases, with text selection | `pdf` |
| `svg` | The image after sanitizing | `svg`; `image/svg+xml` |
| `html` | A static, sanitized rendering of the page | `html`, `htm`; `text/html` |

The exact lists are in `src/previewers.ts`.

## Limits

- Every previewer: 20 MiB per file.
- Code: the first 256 KiB are highlighted, the rest is shown as plain text; at most 20 000 lines.
- Zip: 10 000 entries, 100 MiB inflated per archive (counted across everything opened from it); an
  entry over 20 MiB cannot be previewed; archives nest one level.
- Spreadsheet: 100 000 rows by 200 columns, 2 million cells; the archive is checked at 120 MiB
  (declared) and 150 MiB (inflated).
- Document (docx): 50 MiB declared and 100 MiB inflated.
- PDF: each page has a 10 s budget (open, load, paint); a page that runs out shows an error and the
  worker is replaced.

## Security model

- Each previewer runs in a sandboxed embed whose CSP allows no network access.
- Parsing and rendering of untrusted formats run in workers started from `blob:` URLs.
- docx, SVG and HTML output goes through a sanitizer (DOMPurify) before it is shown.
- Links in previewed content are not clickable.

## Known limitations

- HTML is static: no scripts, no CDN resources, no external styles or images. Running pages needs a
  separate content origin, which is a later project.
- Bare file names such as `Dockerfile`, `Makefile` and `.env` do not match: previewers are chosen
  by extension or MIME type, and these names have none.
- Entries inside a zip are previewed regardless of the org's per-previewer settings (disabling a
  previewer only affects files opened directly).
- No audio, video or pptx. `xls` and `ods` are not supported. Zip64 archives are not supported.

## Building

The embeds are built from `ui-src/` into `ui/`, which is not committed:

```bash
pnpm build:ui
```

`ui/` is produced when the package is built for release and ships in the tarball (`files`).
