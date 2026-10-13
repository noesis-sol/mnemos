// Builds small, valid PDF files in memory for the PDF tests: one page per
// entry of `pages`, each a list of lines drawn in Helvetica (Latin-1 text
// only). No top-level side effects: node --test also runs this file, as a
// file with no tests.

/**
 * @param {string[][]} pages lines of text, per page
 * @param {{ encrypt?: boolean, brokenXref?: boolean }} [options]
 *   encrypt: a Standard security handler whose user password is not empty,
 *   so the file cannot be opened without one. brokenXref: every xref offset
 *   is wrong, which pdf.js recovers from with warnings.
 * @returns {Uint8Array}
 */
export function makePdf(pages, { encrypt = false, brokenXref = false } = {}) {
  const objects = [];
  const add = (body) => objects.push(body);
  add(null); // 1: catalog
  add(null); // 2: page tree
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"); // 3
  const kids = [];
  const escape = (text) => text.replace(/[\\()]/g, (c) => `\\${c}`);
  for (const lines of pages) {
    const content = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${escape(l)}) Tj T*`).join(" ")} ET`;
    const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
          `/Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const security = encrypt
    ? add(`<< /Filter /Standard /V 1 /R 2 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> /P -4 >>`)
    : undefined;

  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = Buffer.byteLength(out, "latin1");
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return brokenXref ? offset + 7 : offset;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  const id = `<${"01".repeat(16)}>`;
  const encryption = security ? ` /Encrypt ${security} 0 R /ID [${id} ${id}]` : "";
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
