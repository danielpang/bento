import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contactMessage,
  deleteAccountMessage,
  invitationMessage,
  noticeMessage,
  passwordResetMessage,
  verificationMessage,
  createMailer,
  LoggingMailer,
} from "./mail.js";
import { html, renderEmail } from "./email-layout.js";
import { loadEnv } from "./env.js";

const APP_URL = "https://bento.example.com";

function invitation() {
  return invitationMessage({
    email: "teammate@example.com",
    organizationName: "Acme Robotics",
    inviterName: "Alice",
    role: "member",
    acceptUrl: "https://bento.example.com/accept-invitation?id=inv_123",
    expiresInDays: 7,
    appUrl: APP_URL,
  });
}

test("the invitation carries the link in plain text and html", () => {
  const message = invitation();

  assert.equal(message.to, "teammate@example.com");
  assert.match(message.subject, /Alice invited you to Acme Robotics/);
  // A client that refuses HTML still needs a usable link.
  assert.match(message.text, /https:\/\/bento\.example\.com\/accept-invitation\?id=inv_123/);
  assert.match(message.text, /expires in 7 days/);
  assert.match(message.html ?? "", /<a href="https:\/\/bento\.example\.com/);
});

test("invitation content is escaped so a name cannot inject markup", () => {
  const message = invitationMessage({
    email: "t@example.com",
    organizationName: '<script>alert("x")</script>',
    inviterName: "Mallory & Co",
    role: "admin",
    acceptUrl: "https://bento.example.com/accept-invitation?id=1",
    expiresInDays: 7,
    appUrl: APP_URL,
  });
  assert.doesNotMatch(message.html ?? "", /<script>/);
  assert.match(message.html ?? "", /&lt;script&gt;/);
  assert.match(message.html ?? "", /Mallory &amp; Co/);
});

test("the html template escapes every value it interpolates", () => {
  const name = '"><img src=x onerror=alert(1)>';
  const fragment = html`Hello <strong>${name}</strong>`;
  // The literal markup survives; the value does not become markup.
  assert.match(fragment, /<strong>/);
  assert.doesNotMatch(fragment, /<img/);
  assert.match(fragment, /&lt;img/);
  assert.match(fragment, /&quot;&gt;/);
});

test("a url with query parameters stays intact in the button href", () => {
  const message = verificationMessage({
    email: "new@example.com",
    // Two parameters, so the ampersand has to be escaped as an entity
    // rather than dropped or left to split the attribute.
    url: "https://bento.example.com/api/auth/verify-email?token=abc&callbackURL=/",
    expiresInHours: 24,
    appUrl: APP_URL,
  });
  assert.match(message.html ?? "", /token=abc&amp;callbackURL=\/"/);
  // Plain text is not markup, so it carries the raw address.
  assert.match(message.text, /token=abc&callbackURL=\//);
});

test("every email carries the header, the footer links, and the reason it arrived", () => {
  const messages = [
    invitation(),
    verificationMessage({ email: "a@b.co", url: `${APP_URL}/v`, expiresInHours: 24, appUrl: APP_URL }),
    passwordResetMessage({ email: "a@b.co", url: `${APP_URL}/r`, expiresInHours: 24, appUrl: APP_URL }),
    deleteAccountMessage({ email: "a@b.co", url: `${APP_URL}/d`, expiresInHours: 24, appUrl: APP_URL }),
    contactMessage({
      to: "ops@b.co",
      kind: "feature",
      message: "A dark board would help",
      senderName: "Sam",
      senderEmail: "sam@b.co",
      appUrl: APP_URL,
    }),
    notice(),
  ];

  for (const message of messages) {
    const body = message.html ?? "";
    assert.match(body, /^<!doctype html>/, `${message.subject} is a whole document`);
    // The wordmark, beside the mark drawn from table cells.
    assert.match(body, />bento</, `${message.subject} carries the header`);
    assert.match(body, /background:#0e0d0b/, `${message.subject} has the brand header band`);
    assert.match(body, new RegExp(`href="${APP_URL}"`), `${message.subject} links back to the console`);
    // Both halves say why the mail arrived, not only the html one.
    assert.match(body, /You are receiving this because/, `${message.subject} says why it arrived`);
    assert.match(message.text, /You are receiving this because/, `${message.subject} text says why it arrived`);
    assert.match(message.text, /Open Bento: https:\/\//, `${message.subject} text has footer links`);
  }
});

test("the footer carries one link back, centred", () => {
  const body = invitation().html ?? "";
  assert.match(body, /<td align="center"[^>]*>\s*<p[^>]*text-align:center;">.*Open Bento/s);
  // An invitation reaches people who have never signed in, so anything
  // deeper than the front door would only hand them a sign in form.
  assert.doesNotMatch(body, /Account settings|What changed/);
});

test("the mark and the wordmark are centred in the header band", () => {
  const body = invitation().html ?? "";
  assert.match(body, /<td align="center" style="background:#0e0d0b[^"]*text-align:center;">/);
  assert.match(body, /<table role="presentation" align="center"[^>]*margin:0 auto;"><tr>\s*<td style="padding-right:12px;">/);
});

test("the heading is centred and the body copy is not", () => {
  const body = invitation().html ?? "";
  assert.match(body, /<h1 [^>]*text-align:center;">Alice invited you to Acme Robotics<\/h1>/);
  // Paragraphs stay left: centred prose is harder to read once it
  // wraps, and these wrap.
  assert.doesNotMatch(body, /<p style="margin:0 0 14px;[^"]*text-align:center/);
});

test("the action button is centred, by attribute as well as by margin", () => {
  const body = invitation().html ?? "";
  // Outlook ignores margin:auto on a table, so the align attribute is
  // what centres it there. Both, or it is centred in half the clients.
  assert.match(body, /<table role="presentation" align="center"[^>]*margin:22px auto 0;"/);
});

test("no email depends on a remote image", () => {
  // Images are blocked by default in most clients, and a self-hosted
  // install has no public address to serve a logo from.
  const body = invitation().html ?? "";
  assert.doesNotMatch(body, /<img/);
});

test("the contact email keeps the line breaks the reporter typed", () => {
  const message = contactMessage({
    to: "ops@example.com",
    kind: "issue",
    message: "First line\nSecond line",
    senderName: "Priya",
    senderEmail: "priya@acme.example",
  appUrl: APP_URL,
  });
  assert.match(message.html ?? "", /First line<br>Second line/);
  assert.match(message.text, /First line\nSecond line/);
  // The mail comes from the server's own address, so replying has to
  // be possible from the body.
  assert.match(message.html ?? "", /mailto:priya@acme\.example/);
});

test("the preheader is hidden but present", () => {
  const body = renderEmail({
    appUrl: APP_URL,
    preheader: "Join Acme Robotics",
    heading: "Heading",
    paragraphs: ["Body"],
    footerNote: "You are receiving this because of a test.",
  });
  assert.match(body, /display:none;[^"]*">Join Acme Robotics</);
});

test("without SMTP configured, mail is logged rather than dropped", () => {
  const env = loadEnv({ BENTO_MODE: "multi" } as NodeJS.ProcessEnv);
  const mailer = createMailer(env);
  assert.ok(mailer instanceof LoggingMailer);
  assert.match(mailer.description, /no SMTP configured/);
});

test("SMTP configuration selects the smtp transport", () => {
  const env = loadEnv({
    BENTO_MODE: "multi",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "465",
  } as NodeJS.ProcessEnv);
  const mailer = createMailer(env);
  assert.match(mailer.description, /smtp smtp\.example\.com:465/);
});

function notice(paragraphs?: string[]) {
  return noticeMessage({
    to: "owner@acme.example",
    subject: "Bento: three quarters of your agent hours are used",
    preheader: "A heads up with the rest of the period still to go.",
    heading: "Three quarters of your agent hours are used",
    paragraphs: paragraphs ?? [
      "Your team has used 19 of 25 agent hours for this period.",
      "Nothing has changed yet; this is so the rest of the period is not a surprise.",
    ],
    action: { label: "See your usage", url: `${APP_URL}/settings?tab=billing` },
    footerNote: "You are receiving this because you are an owner or admin of this team on Bento.",
    appUrl: APP_URL,
  });
}

test("a notice arrives in the same envelope as the rest of the mail", () => {
  const message = notice();
  const body = message.html ?? "";

  assert.match(body, /Three quarters of your agent hours are used/);
  // The same header band and the same button as an invitation.
  assert.match(body, />bento</);
  assert.match(body, /href="https:\/\/bento\.example\.com\/settings\?tab=billing"/);
  assert.match(body, /See your usage/);

  // And the plain text half says the same thing, with the link.
  assert.match(message.text, /Your team has used 19 of 25 agent hours/);
  assert.match(message.text, /is not a surprise\./);
  assert.match(message.text, /https:\/\/bento\.example\.com\/settings\?tab=billing/);
});

test("a notice separates its paragraphs in both halves", () => {
  const message = notice(["First.", "Second."]);
  assert.match(message.text, /First\.\n\nSecond\./);
  assert.equal((message.html ?? "").match(/<p style="margin:0 0 14px/g)?.length, 2);
});

test("a notice carries copy, not markup", () => {
  // The cloud module is on the other side of a duck typed seam, and
  // what it sends is escaped here rather than trusted there.
  const message = notice(["<script>alert(1)</script>"]);
  assert.doesNotMatch(message.html ?? "", /<script>/);
  assert.match(message.html ?? "", /&lt;script&gt;/);
});
