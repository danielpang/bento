import { stripVTControlCharacters } from "node:util";

/** Native selection bypasses application mouse reporting in Warp. */
export function terminalSelectionHint(): string {
  if (process.env.TERM_PROGRAM !== "WarpTerminal") return "";
  return `Shift-drag to select · ${process.platform === "darwin" ? "Cmd+C" : "Ctrl+Shift+C"} to copy`;
}

/** Agent output is untrusted, including terminal escapes and OSC links. */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function matchesSearch(value: string, query: string): boolean {
  const text = value.normalize("NFKD").toLowerCase();
  const squash = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");
  const squashed = squash(text);
  const terms = query
    .normalize("NFKD")
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => /[\p{L}\p{N}]/u.test(term));
  return terms.every((term) => text.includes(term) || squashed.includes(squash(term)));
}

/** Wrap before paging so no part of a long line disappears off-screen. */
export function wrapLines(lines: string[], width: number): string[] {
  const limit = Math.max(8, width);
  return lines.flatMap((line) =>
    terminalText(line)
      .replace(/\t/g, "    ")
      .split("\n")
      .flatMap((part) => {
        const chars = Array.from(part);
        if (!chars.length) return [""];
        const result: string[] = [];
        // Two columns per code point is a conservative budget for wide glyphs.
        let row = "";
        let used = 0;
        for (const char of chars) {
          const size = (char.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
          if (used + size > limit) {
            result.push(row);
            row = "";
            used = 0;
          }
          row += char;
          used += size;
        }
        result.push(row);
        return result;
      }),
  );
}
