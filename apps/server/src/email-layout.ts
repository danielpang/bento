/**
 * The shared look of every Bento email.
 *
 * Mail clients are not browsers. There is no stylesheet, no cascade
 * worth relying on, and Outlook still renders through Word. So the
 * layout is tables with inline styles, which is the only thing that
 * survives everywhere.
 *
 * Two constraints shaped the rest of it:
 *
 * 1. No remote images. The mark is built from table cells, so it draws
 *    with images blocked (the default in most clients) and on a
 *    self-hosted install that has no public URL to serve a logo from.
 *    Outlook drops the rounded corners and shows squares, which still
 *    reads as the mark.
 * 2. No web fonts. Geist never loads in mail, so the stack starts at
 *    the system UI font rather than pretending otherwise.
 *
 * Colors are the light theme tokens from the console (apps/web/src/
 * styles.css), so an email looks like the product it came from. Light
 * only, and declared as such: a client that inverts an already dark
 * design tends to produce something neither theme intended.
 */

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace";

const CANVAS = "#f2f1ed";
const CARD = "#ffffff";
const CARD_LINE = "#e3dfd4";
const HEADER = "#0e0d0b";
const HEADER_TEXT = "#ededed";
const TEXT = "#1d1a14";
const TEXT_DIM = "#5b564c";
const TEXT_FAINT = "#8b867c";
const BRAND = "#b34a00";

/** The mark's own palette, fixed in both themes so it reads on any plate. */
const PLATE = "#12161e";
const PLATE_LINE = "#39414f";
const COMPARTMENT = "#3a4353";
const ORANGE = "#f97316";
const BLUE = "#3e77e8";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Builds a fragment with every interpolated value escaped.
 *
 * Escaping is the default here rather than something each caller has
 * to remember, which is how an organization named after a script tag
 * stops being a way to write markup into someone else's inbox.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, part, i) => {
    if (i === 0) return part;
    return out + escapeHtml(String(values[i - 1] ?? "")) + part;
  }, "");
}

export interface EmailLink {
  label: string;
  url: string;
}

export interface EmailLayoutInput {
  /** Base URL of the console, without a trailing slash. */
  appUrl: string;
  /** The line clients show beside the subject in the inbox list. */
  preheader: string;
  heading: string;
  /** Fragments built with the `html` template, one paragraph each. */
  paragraphs: string[];
  /** Text someone else wrote, set apart so it cannot be read as ours. */
  quote?: string;
  /** The one thing to do. Rendered as a button and as a copyable link. */
  action?: EmailLink;
  /** Closing line under the action, smaller and dimmer than the body. */
  note?: string;
  /** Why this arrived, printed under the footer link. */
  footerNote: string;
}

/**
 * One link back, and only one.
 *
 * An invitation reaches people who have never signed in, so anything
 * deeper than the front door is a link to a sign in form for an
 * account they do not have yet.
 */
export function footerLinks(appUrl: string): EmailLink[] {
  return [{ label: "Open Bento", url: appUrl }];
}

export function renderEmail(input: EmailLayoutInput): string {
  const links = footerLinks(input.appUrl);

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${escapeHtml(input.heading)}</title>`,
    "</head>",
    `<body style="margin:0;padding:0;background:${CANVAS};-webkit-font-smoothing:antialiased;">`,
    preheader(input.preheader),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};">`,
    '<tr><td align="center" style="padding:32px 16px;">',
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;">',
    `<tr><td style="background:${CARD};border:1px solid ${CARD_LINE};border-radius:10px;overflow:hidden;">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    header(),
    body(input),
    "</table>",
    "</td></tr>",
    footer(links, input.footerNote),
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Hidden text clients show after the subject in the inbox list.
 *
 * Without it they pull the first words of the body, so every account
 * email in a list would start with the same sentence.
 */
function preheader(text: string): string {
  return (
    '<div style="display:none;font-size:1px;color:' +
    CANVAS +
    ';line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">' +
    escapeHtml(text) +
    "</div>"
  );
}

function header(): string {
  return [
    `<tr><td style="background:${HEADER};padding:20px 32px;">`,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
    `<td style="padding-right:12px;">${mark()}</td>`,
    `<td style="font-family:${SANS};font-size:19px;font-weight:700;letter-spacing:-0.01em;color:${HEADER_TEXT};">bento</td>`,
    "</tr></table>",
    "</td></tr>",
  ].join("\n");
}

/**
 * The bento mark, drawn as table cells: a plate holding four
 * compartments. Same geometry as assets/brand/logo.svg, scaled to 40px.
 */
function mark(): string {
  const cell = (w: number, h: number, color: string) =>
    `<td width="${w}" height="${h}" style="width:${w}px;height:${h}px;background:${color};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>`;
  const gap = (w: number) => `<td width="${w}" style="width:${w}px;font-size:0;line-height:0;">&nbsp;</td>`;

  return [
    `<table role="presentation" width="40" cellpadding="0" cellspacing="0" border="0" style="width:40px;background:${PLATE};border:1px solid ${PLATE_LINE};border-radius:9px;">`,
    '<tr><td style="padding:6px;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">',
    `<tr>${cell(16, 16, ORANGE)}${gap(3)}${cell(9, 16, COMPARTMENT)}</tr>`,
    '<tr><td colspan="3" height="3" style="height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>',
    `<tr>${cell(9, 9, COMPARTMENT)}${gap(3)}${cell(16, 9, BLUE)}</tr>`,
    "</table>",
    "</td></tr>",
    "</table>",
  ].join("\n");
}

function body(input: EmailLayoutInput): string {
  const parts = [
    '<tr><td style="padding:32px;">',
    `<h1 style="margin:0 0 16px;font-family:${SANS};font-size:20px;line-height:1.3;font-weight:600;color:${TEXT};">${escapeHtml(input.heading)}</h1>`,
  ];

  for (const paragraph of input.paragraphs) {
    parts.push(
      `<p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.6;color:${TEXT_DIM};">${paragraph}</p>`,
    );
  }

  if (input.quote) parts.push(quote(input.quote));
  if (input.action) parts.push(button(input.action), fallbackLink(input.action.url));
  if (input.note) {
    parts.push(
      `<p style="margin:20px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${TEXT_FAINT};">${escapeHtml(input.note)}</p>`,
    );
  }

  parts.push("</td></tr>");
  return parts.join("\n");
}

/**
 * Verbatim text from a person, in a panel of its own.
 *
 * Line breaks are the only formatting kept: whoever typed it used them
 * to separate steps, and a report reflowed into one block is harder to
 * act on than the one that was written.
 */
function quote(text: string): string {
  const lines = escapeHtml(text).split("\n").join("<br>");
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0;background:#faf9f6;border:1px solid ${CARD_LINE};border-left:3px solid ${BRAND};border-radius:6px;"><tr>`,
    `<td style="padding:16px 18px;font-family:${SANS};font-size:14px;line-height:1.65;color:${TEXT};">${lines}</td>`,
    "</tr></table>",
  ].join("\n");
}

/** An anchor in the body copy, styled like the rest of the email. */
export function anchor(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="color:${BRAND};text-decoration:underline;">${escapeHtml(label)}</a>`;
}

/**
 * Centred, and centred with the align attribute as well as the margin:
 * Outlook ignores `margin:auto` on a table, so the attribute is what
 * actually does the work there.
 */
function button(action: EmailLink): string {
  return [
    '<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:22px auto 0;"><tr>',
    `<td align="center" bgcolor="${BRAND}" style="border-radius:6px;">`,
    `<a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 24px;font-family:${SANS};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(action.label)}</a>`,
    "</td></tr></table>",
  ].join("\n");
}

/**
 * The same destination as the button, in full.
 *
 * Some clients strip the button, some people would rather read where a
 * link goes before they follow it, and both cases end with a person
 * copying the address by hand.
 */
function fallbackLink(url: string): string {
  return [
    `<p style="margin:20px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${TEXT_FAINT};">`,
    "If the button does not work, paste this into your browser:",
    "</p>",
    `<p style="margin:6px 0 0;font-family:${MONO};font-size:12px;line-height:1.5;word-break:break-all;">`,
    `<a href="${escapeHtml(url)}" style="color:${BRAND};text-decoration:none;">${escapeHtml(url)}</a>`,
    "</p>",
  ].join("\n");
}

function footer(links: EmailLink[], note: string): string {
  const rendered = links
    .map(
      (link) =>
        `<a href="${escapeHtml(link.url)}" style="color:${TEXT_FAINT};text-decoration:none;">${escapeHtml(link.label)}</a>`,
    )
    .join(`<span style="color:#c9c3b6;"> &nbsp;&middot;&nbsp; </span>`);

  // align as well as text-align: the attribute is what older clients read.
  return [
    '<tr><td align="center" style="padding:20px 8px 0;text-align:center;">',
    `<p style="margin:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.5;color:${TEXT_FAINT};text-align:center;">${rendered}</p>`,
    `<p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.5;color:#a09a8e;text-align:center;">${escapeHtml(note)}</p>`,
    "</td></tr>",
  ].join("\n");
}

export interface EmailTextInput {
  /** The message itself. Links belong on their own line, unindented. */
  lines: string[];
  footerNote: string;
  appUrl: string;
}

/**
 * The plain text half, which carries everything that matters on its
 * own: a client that refuses HTML still has to produce a working link.
 */
export function renderText(input: EmailTextInput): string {
  const footer = footerLinks(input.appUrl).map((link) => `${link.label}: ${link.url}`);
  return [...input.lines, "", input.footerNote, "", ...footer].join("\n");
}
