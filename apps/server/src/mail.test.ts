import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contactMessage,
  deleteAccountMessage,
  invitationMessage,
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
