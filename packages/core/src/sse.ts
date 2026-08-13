/**
 * Incremental server-sent-events frame parser.
 *
 * One implementation, shared by the api-client's fetch transport and
 * the server's own e2e tests, because the previous two hand-rolled
 * copies had already diverged on whitespace handling: the tested
 * parser was not the shipped one, so the tests could pass against
 * framing the real client mishandled.
 *
 * Spec details that matter here: multiple `data:` lines in one frame
 * join with a newline, and exactly one leading space after the colon
 * is stripped. Everything streamed today is JSON.stringify output,
 * where neither case arises; this parser is correct anyway so the
 * first non-JSON payload does not get silently corrupted.
 */
export interface SseFrame {
  event: string;
  data: string;
  id: string;
}

export class SseParser {
  private buffer = "";

  /** Feed a decoded chunk; returns the frames it completed. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    // Walk with an index rather than re-slicing the buffer per frame:
    // per-token streaming means one read can carry hundreds of frames,
    // and repeated slicing would make a single read quadratic.
    let start = 0;
    let cut = this.buffer.indexOf("\n\n", start);
    while (cut >= 0) {
      frames.push(parseFrame(this.buffer.slice(start, cut)));
      start = cut + 2;
      cut = this.buffer.indexOf("\n\n", start);
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    return frames;
  }
}

function parseFrame(raw: string): SseFrame {
  let event = "message";
  let id = "";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = fieldValue(line, 6);
    else if (line.startsWith("data:")) data.push(fieldValue(line, 5));
    else if (line.startsWith("id:")) id = fieldValue(line, 3);
  }
  return { event, id, data: data.join("\n") };
}

/** The field's value: everything after the colon, minus one optional space. */
function fieldValue(line: string, afterColon: number): string {
  return line.startsWith(" ", afterColon) ? line.slice(afterColon + 1) : line.slice(afterColon);
}
