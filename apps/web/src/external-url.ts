/**
 * An address the console is willing to put in an `href`.
 *
 * Some of what the console links to was not written by the console.
 * A swarm's pull request row carries a url, and a swarm is a tree of
 * agents that read repositories, issue trackers and each other's
 * output all day: everything on that path is somewhere a prompt
 * injection can arrive, and a row is only ever as trustworthy as the
 * least trustworthy thing that wrote it.
 *
 * An `href` is not inert. `javascript:alert(document.cookie)` in an
 * anchor runs on the console's origin the moment somebody clicks it,
 * with the session that is open, which is the same boundary the
 * artifact rules protect: agent bytes never execute as the console.
 * `data:` and `blob:` are the same problem wearing a different scheme,
 * and `vbscript:` still runs in some embedded browsers.
 *
 * So the scheme is checked here, at the edge where the value enters
 * the console, rather than at each of the places that draw it. A
 * caller gets back an address it can link to, or null, and null is
 * drawn as text rather than as a link that goes nowhere.
 *
 * Allowed rather than denied, and parsed rather than pattern matched,
 * for the reason internalPath is: a parser answers what the browser
 * will actually do with the string, and a list of the schemes known to
 * be dangerous is a list that is one scheme out of date. Tabs,
 * newlines and case (`JaVaScRiPt:`) are all folded away before the
 * protocol is read, so none of them is a way past this.
 */
const LINKABLE_PROTOCOLS = new Set(["http:", "https:"]);

export function externalHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    // Absolute only: no base is passed, so a relative string throws
    // rather than resolving against whatever page is open. Nothing
    // that arrives here is meant to be a path on this origin.
    const url = new URL(raw);
    if (!LINKABLE_PROTOCOLS.has(url.protocol)) return null;
    // Rebuilt from the parsed parts, so what is returned is what was
    // checked rather than the raw string the parser folded.
    return url.toString();
  } catch {
    return null;
  }
}
