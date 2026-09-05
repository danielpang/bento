import { createElement, type ReactNode } from "react";

/**
 * Split text so https URLs become their own pieces. Trailing sentence
 * punctuation stays out of the href, because the status page advice
 * ends in a URL followed by nothing, but other errors can end in one
 * followed by a period.
 */
export function splitErrorLinks(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  const pattern = /https?:\/\/[^\s<>"'()]+/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const href = raw.replace(/[.,;:]+$/, "");
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: href, href });
    cursor = start + href.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

/** Inline nodes: URLs render as links that leave the console. */
export function linkifiedError(text: string): ReactNode[] {
  return splitErrorLinks(text).map((part, i) =>
    part.href
      ? createElement(
          "a",
          { key: i, href: part.href, target: "_blank", rel: "noreferrer noopener" },
          part.text,
        )
      : part.text,
  );
}
