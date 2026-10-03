/**
 * Hand-made binary fixtures for the plan source tests: the smallest
 * valid PDF with text on one page, and a one pixel PNG. Written here
 * rather than checked in as files so a reader can see what is in them,
 * and so the PDF's text is the test's to choose.
 */

/** A one page PDF whose page shows these lines, one under the other. */
export function minimalPdf(lines: string[]): Buffer {
  const escaped = lines.map((line) => line.replace(/[\\()]/g, (c) => `\\${c}`));
  const text = ["BT /F1 18 Tf 50 740 Td", ...escaped.map((line, i) => `${i === 0 ? "" : "0 -28 Td "}(${line}) Tj`), "ET"].join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A PDF with a page and no text on it at all: what a scan looks like to an extractor. */
export function scannedPdf(): Buffer {
  return minimalPdf([]);
}

/** One transparent pixel. */
export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
