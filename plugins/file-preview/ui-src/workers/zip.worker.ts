/** Worker side of the zip previewer: `list` reads the directory, `extract` inflates one entry. */
import type { ZipInput, ZipOutput } from "../shared/zip.js";
import { serve } from "./serve.js";
import { extractEntry, listEntries } from "./zip.logic.js";

// the guard keeps the module importable from a test in a plain node process
if (typeof self !== "undefined") {
  serve<ZipInput, ZipOutput>((input) => {
    if (input.op === "list") return { output: listEntries(input) };
    const output = extractEntry(input);
    return { output, transfer: [output.data] };
  });
}
