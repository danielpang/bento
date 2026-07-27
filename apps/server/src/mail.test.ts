import { test } from "node:test";
import assert from "node:assert/strict";
import { invitationMessage, createMailer, LoggingMailer } from "./mail.js";
import { loadEnv } from "./env.js";

test("the invitation carries the link in plain text and html", () => {
  const message = invitationMessage({
    email: "teammate@example.com",
    organizationName: "Acme Robotics",
    inviterName: "Alice",
    role: "member",
    acceptUrl: "https://bento.example.com/accept-invitation?id=inv_123",
    expiresInDays: 7,
  });

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
  });
  assert.doesNotMatch(message.html ?? "", /<script>/);
  assert.match(message.html ?? "", /&lt;script&gt;/);
  assert.match(message.html ?? "", /Mallory &amp; Co/);
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
