/**
 * Copies text to the clipboard, through the Clipboard API where the
 * origin has it and the old selection command where it does not.
 *
 * A local server is reached over plain http, where browsers withhold
 * `navigator.clipboard`, and a browser can expose the API and still
 * refuse this origin. The fallback selects the text in a field nobody
 * sees and asks the document to copy it, which every browser still
 * honours. Rejects when neither worked, so a button can say so.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection command.
    }
  }

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  try {
    field.focus();
    field.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard access was denied");
  } finally {
    field.remove();
    previousFocus?.focus();
  }
}
