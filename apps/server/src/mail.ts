import nodemailer from "nodemailer";
import type { Env } from "./env.js";
import { anchor, html, renderEmail, renderText } from "./email-layout.js";

export interface Message {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** Describes where mail goes, for startup output and diagnostics. */
  readonly description: string;
  send(message: Message): Promise<void>;
}

/**
 * Writes messages to the log instead of sending them.
 *
 * Used when no SMTP server is configured, which is the normal case for a
 * laptop or a small self-hosted install. An invitation still works: the
 * link is in the log, ready to pass to the person by hand. Failing the
 * invitation instead would be worse, since the record is already created.
 */
export class LoggingMailer implements Mailer {
  readonly description = "logging (no SMTP configured)";

  async send(message: Message): Promise<void> {
    console.log(`[mail] to=${message.to} subject=${message.subject}\n${message.text}`);
  }
}

export class SmtpMailer implements Mailer {
  readonly description: string;
  private transport: nodemailer.Transporter;

  constructor(
    private from: string,
    options: { host: string; port: number; secure: boolean; user?: string | undefined; password?: string | undefined },
  ) {
    this.description = `smtp ${options.host}:${options.port}`;
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      // Implicit TLS on 465; other ports upgrade with STARTTLS.
      secure: options.secure,
      ...(options.user && options.password ? { auth: { user: options.user, pass: options.password } } : {}),
    });
  }

  async send(message: Message): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  }
}

export function createMailer(env: Env): Mailer {
  if (!env.SMTP_HOST) return new LoggingMailer();
  return new SmtpMailer(env.BENTO_MAIL_FROM, {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
  });
}

export interface InvitationEmailInput {
  email: string;
  organizationName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  expiresInDays: number;
  /** Base URL of the console, for the footer link. */
  appUrl: string;
}

/**
 * The invitation message. Plain text carries everything that matters, so
 * a client that refuses HTML still gets a usable link.
 */
export function invitationMessage(input: InvitationEmailInput): Message {
  const subject = `${input.inviterName} invited you to ${input.organizationName} on Bento`;
  const note = `The link expires in ${input.expiresInDays} days. If you were not expecting this, you can ignore it.`;
  const footerNote = "You are receiving this because someone invited you to a team on Bento.";

  const text = renderText({
    lines: [
      `${input.inviterName} invited you to join ${input.organizationName} on Bento as a ${input.role}.`,
      "",
      "Accept the invitation:",
      input.acceptUrl,
      "",
      `The link expires in ${input.expiresInDays} days.`,
      "If you were not expecting this, you can ignore it.",
    ],
    footerNote,
    appUrl: input.appUrl,
  });

  const body = renderEmail({
    appUrl: input.appUrl,
    preheader: `Join ${input.organizationName} as a ${input.role}.`,
    heading: `${input.inviterName} invited you to ${input.organizationName}`,
    paragraphs: [
      html`You have been invited to join <strong>${input.organizationName}</strong> on Bento as a ${input.role}.`,
      "Bento runs coding agents on a board your team shares, one agent to a card, with every run and every review in the open.",
    ],
    action: { label: "Accept the invitation", url: input.acceptUrl },
    note,
    footerNote,
  });

  return { to: input.email, subject, text, html: body };
}

export interface ContactEmailInput {
  to: string;
  kind: "issue" | "feature";
  message: string;
  senderName: string;
  senderEmail: string;
  /** Base URL of the console, for the footer link. */
  appUrl: string;
}

/**
 * A contact form submission, delivered to the operator's inbox. The
 * sender's address is in the body because the mail comes from the
 * server's own from address, and a report nobody can reply to is a
 * report that goes unanswered.
 */
export function contactMessage(input: ContactEmailInput): Message {
  const label = input.kind === "issue" ? "Issue report" : "Feature request";
  const subject = `[Bento] ${label} from ${input.senderEmail}`;
  const footerNote = "You are receiving this because this address is set as the contact for this Bento server.";

  const text = renderText({
    lines: [
      `${label} from ${input.senderName} (${input.senderEmail}):`,
      "",
      input.message,
    ],
    footerNote,
    appUrl: input.appUrl,
  });

  const body = renderEmail({
    appUrl: input.appUrl,
    preheader: `${input.senderName} sent a ${input.kind === "issue" ? "report" : "request"}.`,
    heading: `${label} from ${input.senderName}`,
    paragraphs: [
      html`Sent by ${input.senderName}, ` + anchor(`mailto:${input.senderEmail}`, input.senderEmail) + ". Reply to that address to reach them.",
    ],
    quote: input.message,
    footerNote,
  });

  return { to: input.to, subject, text, html: body };
}

export interface LinkEmailInput {
  email: string;
  url: string;
  expiresInHours: number;
  /** Base URL of the console, for the footer link. */
  appUrl: string;
}

/**
 * The verification message.
 *
 * Sent before an account can sign in, so it has to explain why it
 * arrived and what happens next; a bare link from a product nobody has
 * used yet reads as phishing.
 */
export function verificationMessage(input: LinkEmailInput): Message {
  const subject = "Confirm your email for Bento";
  const note = `The link expires in ${input.expiresInHours} hours. If you did not create a Bento account, you can ignore this.`;
  const footerNote = "You are receiving this because this address was used to create a Bento account.";

  const text = renderText({
    lines: [
      "Confirm this address to finish setting up your Bento account.",
      "",
      input.url,
      "",
      `The link expires in ${input.expiresInHours} hours.`,
      "If you did not create a Bento account, you can ignore this.",
    ],
    footerNote,
    appUrl: input.appUrl,
  });

  const body = renderEmail({
    appUrl: input.appUrl,
    preheader: "One click and your Bento account is ready.",
    heading: "Confirm your email",
    paragraphs: ["Confirm this address to finish setting up your Bento account."],
    action: { label: "Confirm my email", url: input.url },
    note,
    footerNote,
  });

  return { to: input.email, subject, text, html: body };
}

/**
 * The password reset message. Says plainly that ignoring it changes
 * nothing, because the most common reader of this email is someone who
 * did not ask for it.
 */
export function passwordResetMessage(input: LinkEmailInput): Message {
  const subject = "Reset your Bento password";
  const note = `The link expires in ${input.expiresInHours} hours. If this was not you, ignore this email and your password stays as it is.`;
  const footerNote = "You are receiving this because a password reset was requested for this address.";

  const text = renderText({
    lines: [
      "Someone asked to reset the password for this Bento account.",
      "",
      "Choose a new password:",
      input.url,
      "",
      `The link expires in ${input.expiresInHours} hours.`,
      "If this was not you, ignore this email. Your password stays as it is.",
    ],
    footerNote,
    appUrl: input.appUrl,
  });

  const body = renderEmail({
    appUrl: input.appUrl,
    preheader: "Choose a new password for your Bento account.",
    heading: "Reset your password",
    paragraphs: ["Someone asked to reset the password for this Bento account."],
    action: { label: "Choose a new password", url: input.url },
    note,
    footerNote,
  });

  return { to: input.email, subject, text, html: body };
}

/**
 * The account deletion confirmation. Deleting is irreversible and
 * takes the person's work with it, so the email states the
 * consequence rather than only carrying a link.
 */
export function deleteAccountMessage(input: LinkEmailInput): Message {
  const subject = "Confirm deleting your Bento account";
  const note = `The link expires in ${input.expiresInHours} hours. If this was not you, ignore this email and nothing happens.`;
  const footerNote = "You are receiving this because account deletion was requested for this address.";

  const text = renderText({
    lines: [
      "You asked to delete your Bento account.",
      "",
      "This removes your sign in and your membership of every team. Boards owned by a team you share stay with that team.",
      "",
      "Confirm the deletion:",
      input.url,
      "",
      `The link expires in ${input.expiresInHours} hours.`,
      "If this was not you, ignore this email and nothing happens.",
    ],
    footerNote,
    appUrl: input.appUrl,
  });

  const body = renderEmail({
    appUrl: input.appUrl,
    preheader: "This cannot be undone once you confirm.",
    heading: "Confirm deleting your account",
    paragraphs: [
      "You asked to delete your Bento account.",
      "This removes your sign in and your membership of every team. Boards owned by a team you share stay with that team.",
    ],
    action: { label: "Confirm the deletion", url: input.url },
    note,
    footerNote,
  });

  return { to: input.email, subject, text, html: body };
}

export interface NoticeEmailInput {
  to: string;
  subject: string;
  /** The line clients show beside the subject in the inbox list. */
  preheader: string;
  heading: string;
  /** Plain copy, one string per paragraph. Escaped, never markup. */
  paragraphs: string[];
  action?: { label: string; url: string };
  note?: string;
  footerNote: string;
  /** Base URL of the console, for the footer link. */
  appUrl: string;
}

/**
 * A notice from the deployment extension, in the same envelope as the
 * rest of Bento's mail.
 *
 * The cloud module lives in another repository and knows nothing about
 * the layout, so it hands over copy and this builds both halves of the
 * message from it. Copy rather than markup on purpose: everything it
 * passes is escaped on the way in, and the plain text is derived from
 * the same paragraphs, so the two halves cannot drift apart.
 */
export function noticeMessage(input: NoticeEmailInput): Message {
  const text = renderText({
    lines: [
      ...input.paragraphs.flatMap((paragraph, i) => (i === 0 ? [paragraph] : ["", paragraph])),
      ...(input.action ? ["", `${input.action.label}:`, input.action.url] : []),
      ...(input.note ? ["", input.note] : []),
    ],
    footerNote: input.footerNote,
    appUrl: input.appUrl,
  });

  const body = renderEmail({
    appUrl: input.appUrl,
    preheader: input.preheader,
    heading: input.heading,
    paragraphs: input.paragraphs.map((paragraph) => html`${paragraph}`),
    ...(input.action ? { action: input.action } : {}),
    ...(input.note ? { note: input.note } : {}),
    footerNote: input.footerNote,
  });

  return { to: input.to, subject: input.subject, text, html: body };
}
