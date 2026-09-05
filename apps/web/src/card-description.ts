/**
 * The two decisions the drawer's Description section makes about a
 * card's brief: whether there is a section at all, and whether it opens
 * cut off.
 *
 * Their own module because the text is not the console's: it comes from
 * the create dialog, from a Linear import (issue body plus the issue
 * URL), or from Slack ("Created from Slack: <permalink>"), so blank,
 * multi line and very long are all ordinary inputs rather than edge
 * cases, and the rules are worth testing without rendering a drawer.
 */

/**
 * Whether a card carries a description worth a section.
 *
 * Whitespace only counts as empty. The create dialog calls the field
 * optional and a title-only card is normal, so an empty one must grow
 * no panel at all: a bordered box holding one stray newline reads as a
 * drawer that failed to load rather than as a card nobody briefed.
 */
export function hasDescription(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trim().length > 0;
}

/**
 * The description as it is shown: the stored text word for word, with
 * only the whitespace around it dropped. The line breaks inside it are
 * the author's paragraphs, and Linear bodies are full of them, so they
 * survive to the screen.
 */
export function descriptionText(text: string | null | undefined): string {
  return (text ?? "").trim();
}

/**
 * How much description opens unclamped, in lines and in characters.
 *
 * Both, because they catch different shapes: twenty short lines and one
 * pasted paragraph are each too tall for a panel that sits above the
 * buttons. The numbers track the CSS clamp on `.card-description`,
 * which counts the lines the browser drew rather than the ones in the
 * text; they only have to agree closely enough that the toggle never
 * appears over text that was never cut.
 */
const CLAMP_LINES = 12;
const CLAMP_CHARS = 900;

/** Whether the description opens clamped, behind a Show more toggle. */
export function needsClamp(text: string | null | undefined): boolean {
  const body = descriptionText(text);
  if (body.length === 0) return false;
  return body.length > CLAMP_CHARS || body.split("\n").length > CLAMP_LINES;
}
