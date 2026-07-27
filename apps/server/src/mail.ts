import nodemailer from "nodemailer";
import type { Env } from "./env.js";

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
}

/**
 * The invitation message. Plain text carries everything that matters, so
 * a client that refuses HTML still gets a usable link.
 */
export function invitationMessage(input: InvitationEmailInput): Message {
  const subject = `${input.inviterName} invited you to ${input.organizationName} on Bento`;
  const text = [
    `${input.inviterName} invited you to join ${input.organizationName} on Bento as a ${input.role}.`,
    "",
    "Accept the invitation:",
    input.acceptUrl,
    "",
    `The link expires in ${input.expiresInDays} days.`,
    "If you were not expecting this, you can ignore it.",
  ].join("\n");

  const html = [
    `<p><strong>${escapeHtml(input.inviterName)}</strong> invited you to join`,
    `<strong>${escapeHtml(input.organizationName)}</strong> on Bento as a ${escapeHtml(input.role)}.</p>`,
    `<p><a href="${escapeHtml(input.acceptUrl)}">Accept the invitation</a></p>`,
    `<p>The link expires in ${input.expiresInDays} days. If you were not expecting this, you can ignore it.</p>`,
  ].join(" ");

  return { to: input.email, subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface LinkEmailInput {
  email: string;
  url: string;
  expiresInHours: number;
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
  const text = [
    "Confirm this address to finish setting up your Bento account.",
    "",
    input.url,
    "",
    `The link expires in ${input.expiresInHours} hours.`,
    "If you did not create a Bento account, you can ignore this.",
  ].join("\n");
  const html = [
    "<p>Confirm this address to finish setting up your Bento account.</p>",
    `<p><a href="${escapeHtml(input.url)}">Confirm my email</a></p>`,
    `<p>The link expires in ${input.expiresInHours} hours. If you did not create a Bento account, you can ignore this.</p>`,
  ].join(" ");
  return { to: input.email, subject, text, html };
}

/**
 * The password reset message. Says plainly that ignoring it changes
 * nothing, because the most common reader of this email is someone who
 * did not ask for it.
 */
export function passwordResetMessage(input: LinkEmailInput): Message {
  const subject = "Reset your Bento password";
  const text = [
    "Someone asked to reset the password for this Bento account.",
    "",
    "Choose a new password:",
    input.url,
    "",
    `The link expires in ${input.expiresInHours} hours.`,
    "If this was not you, ignore this email. Your password stays as it is.",
  ].join("\n");
  const html = [
    "<p>Someone asked to reset the password for this Bento account.</p>",
    `<p><a href="${escapeHtml(input.url)}">Choose a new password</a></p>`,
    `<p>The link expires in ${input.expiresInHours} hours. If this was not you, ignore this email and your password stays as it is.</p>`,
  ].join(" ");
  return { to: input.email, subject, text, html };
}

/**
 * The account deletion confirmation. Deleting is irreversible and
 * takes the person's work with it, so the email states the
 * consequence rather than only carrying a link.
 */
export function deleteAccountMessage(input: LinkEmailInput): Message {
  const subject = "Confirm deleting your Bento account";
  const text = [
    "You asked to delete your Bento account.",
    "",
    "This removes your sign in and your membership of every team. Boards owned by a team you share stay with that team.",
    "",
    "Confirm the deletion:",
    input.url,
    "",
    `The link expires in ${input.expiresInHours} hours.`,
    "If this was not you, ignore this email and nothing happens.",
  ].join("\n");
  const html = [
    "<p>You asked to delete your Bento account.</p>",
    "<p>This removes your sign in and your membership of every team. Boards owned by a team you share stay with that team.</p>",
    `<p><a href="${escapeHtml(input.url)}">Confirm the deletion</a></p>`,
    `<p>The link expires in ${input.expiresInHours} hours. If this was not you, ignore this email and nothing happens.</p>`,
  ].join(" ");
  return { to: input.email, subject, text, html };
}
