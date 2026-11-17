# @capybara-hq/plugin-file-preview

Previews files from a conversation in the right panel. The plugin provides `file-preview@1` with
seven previewers; each is a sandboxed embed. Markdown, CSV / TSV and bitmap images stay with the
kernel's built-in previewers and are never claimed here.

## Previewers

| Previewer | Shows | Accepts (summary) |
|---|---|---|
| `code` | Source with line numbers, syntax-highlighted for the languages listed below, plain text otherwise | About 50 extensions (`ts`, `py`, `go`, `rs`, `java`, `sh`, `sql`, `json`, `yaml`, `toml`, `xml`, `css`, `vue`, `txt`, `log`, `env`, …) and MIME types such as `text/plain`, `application/json`, `text/x-python` |
| `zip` | The entry tree of an archive; open an entry in place, including a nested archive one level deep | `zip`, `jar`; `application/zip` |
| `sheet` | One tab per worksheet as a read-only grid | `xlsx`, `xlsm` |
| `docx` | The document converted to sanitized HTML | `docx` |
| `pdf` | Pages rendered lazily on canvases (no text selection) | `pdf` |
| `svg` | The image, shown only as `<img src="blob:…">` | `svg`; `image/svg+xml` |
| `html` | A static, sanitized rendering of the page, with a source mode (the code previewer) | `html`, `htm`; `text/html` |

The exact lists are in `src/previewers.ts`.

Code highlighting covers `ts` / `tsx`, `js` / `jsx` / `mjs` / `cjs`, `py`, `go`, `rs`, `java`, `kt`,
`swift`, `c` / `h`, `cpp` / `hpp`, `cs`, `rb`, `sh` / `bash` / `zsh`, `ps1`, `sql`, `json` / `jsonc`,
`yaml` / `yml`, `toml`, `ini`, `xml`, `css`, `scss`, `proto`, `log`, `env`, `dockerfile`, `makefile`
(and Dockerfile / Makefile entries inside an archive), and HTML in the html previewer's source
mode. Other accepted files (for example `vue`, `svelte`, `php`, `graphql`,
`lua`, `r`, `dart`, `scala`, `gradle`, `txt`) show as plain text.

Inside a zip, an entry is previewed by the previewer its extension selects; in addition `png`,
`jpg` / `jpeg`, `gif` and `webp` entries show as images and `md`, `csv` and `tsv` entries as text.
Bare names such as `Dockerfile` or `.env` do match inside archives (unlike files opened directly,
see below).

## Limits

- Every previewer: 20 MiB per file, and 20 s to read and paint the whole file; past that the
  preview shows a timeout.
- Code: the text is cut at 256 Ki UTF-16 units and 20 000 lines; the rest is not shown (a note says
  so). Highlighting that takes more than 8 s falls back to plain text.
- Zip: 10 000 entries, 100 MiB inflated per archive (counted across everything opened from it); an
  entry over 20 MiB cannot be previewed; archives nest one level.
- Spreadsheet: 100 000 rows by 200 columns, 2 million cells; 120 MiB per archive entry and 150 MiB
  in total.
- Document (docx): 50 MiB per archive entry and 100 MiB in total.
- For xlsx and docx both limits are checked against the sizes the archive's directory declares
  before parsing, and verified while inflating.
- PDF: each page has a 10 s budget (open, load, paint); a page that runs out shows an error and the
  worker is replaced.

## Security model

- Each previewer runs in a sandboxed embed with an opaque origin and no session cookies. Its CSP
  allows `connect-src 'self'` only, and the embed fetches nothing: the file arrives over the
  message bridge, and the embed's own scripts and data are loaded as modules.
- Parsing and rendering of untrusted formats run in workers started from `blob:` URLs.
- docx and HTML output goes through a sanitizer (DOMPurify plus the plugin's own rules) before it
  is shown. SVG is never sanitized or inserted as markup: it is shown only as an
  `<img src="blob:…">`, where it cannot run scripts or load anything.
- Links in previewed content are not clickable.
- Third-party licenses ship in `ui/THIRD-PARTY-LICENSES.txt` (and pdf.js's data licenses beside
  their files).

## Known limitations

- HTML is static: no scripts, no CDN resources, no external styles or images, no embedded audio or
  video. Running pages needs a separate content origin, which is a later project.
- Bare file names such as `Dockerfile`, `Makefile` and `.env` do not match files opened directly:
  previewers are chosen by extension or MIME type, and these names have none.
- Entries inside a zip are previewed regardless of the org's per-previewer settings (disabling a
  previewer only affects files opened directly).
- No audio, video or pptx. `xls` and `ods` are not supported. Zip64 archives are not supported.

## Building

The embeds are built from `ui-src/` into `ui/`, which is not committed:

```bash
pnpm build:ui
```

`ui/` is produced when the package is built for release and ships in the tarball (`files`).
