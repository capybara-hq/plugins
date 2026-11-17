import { zipSync } from "fflate";

/** A 1x1 transparent PNG. */
export const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const enc = (s: string) => new TextEncoder().encode(s);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const para = (text: string, style?: string, extra = "") =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` +
  `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

const IMAGE =
  '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/>' +
  '<wp:docPr id="1" name="Picture 1" descr="a pixel"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
  '<pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill>' +
  "<pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>";

/** Zips a document body (WordprocessingML) into a minimal .docx. */
export function docx(body: string, opts: { image?: boolean } = {}): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": enc(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": enc(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/_rels/document.xml.rels": enc(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
        '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
        '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/page" TargetMode="External"/>' +
        "</Relationships>",
    ),
    "word/styles.xml": enc(
      `<?xml version="1.0" encoding="UTF-8"?><w:styles ${NS}>` +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
    ),
    "word/numbering.xml": enc(
      `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${NS}>` +
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>' +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
    ),
    "word/document.xml": enc(
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
    ),
  };
  if (opts.image !== false) files["word/media/image1.png"] = PNG;
  const zipped = zipSync(files);
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}

const bullet = (text: string) =>
  para(text, undefined, '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');

const cell = (text: string) => `<w:tc>${para(text)}</w:tc>`;

/** Heading, paragraph, two bullets, a 2x2 table and an embedded png. */
export function fullDocx(): ArrayBuffer {
  return docx(
    para("Quarterly Report", "Heading1") +
      para("Body paragraph text") +
      bullet("first item") +
      bullet("second item") +
      `<w:tbl><w:tr>${cell("A1")}${cell("B1")}</w:tr><w:tr>${cell("A2")}${cell("B2")}</w:tr></w:tbl>` +
      IMAGE,
  );
}

/** Literal `<script>` text and a hyperlink. */
export function hostileDocx(): ArrayBuffer {
  return docx(
    para("<script>alert(1)</script>") +
      '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>click me</w:t></w:r></w:hyperlink></w:p>',
  );
}

/** A valid package whose body has no content. */
export function blankDocx(): ArrayBuffer {
  return docx("");
}

/** Zip-looking bytes that are not a docx. */
export function corruptDocx(): ArrayBuffer {
  return enc("PK\u0003\u0004 this is not really a zip archive").buffer as ArrayBuffer;
}
