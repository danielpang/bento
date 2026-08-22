/**
 * Writes every email to disk so it can be opened in a browser.
 *
 * Emails are the one part of the product nobody sees while building
 * it: they are sent from a code path that needs SMTP, an invitation,
 * and a second account, and the reward for all that setup is one look
 * in one client. So this renders all of them from the same functions
 * the server calls, with no mailer and no database in the way.
 *
 *   pnpm --filter @bento/server preview:email
 *
 * A browser is not a mail client, so this proves layout and copy, not
 * that Outlook agrees. Send a real one before trusting a change to the
 * table structure.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  contactMessage,
  deleteAccountMessage,
  invitationMessage,
  noticeMessage,
  passwordResetMessage,
  verificationMessage,
  type Message,
} from "./mail.js";

const APP_URL = "https://bento.example.com";

const samples: { name: string; message: Message }[] = [
  {
    name: "invitation",
    message: invitationMessage({
      email: "teammate@example.com",
      organizationName: "Acme Robotics",
      inviterName: "Alice Nakamura",
      role: "member",
      acceptUrl: `${APP_URL}/accept-invitation?id=inv_9f3c1a7b2d4e`,
      expiresInDays: 7,
      appUrl: APP_URL,
    }),
  },
  {
    name: "verification",
    message: verificationMessage({
      email: "new@example.com",
      url: `${APP_URL}/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.sample`,
      expiresInHours: 24,
      appUrl: APP_URL,
    }),
  },
  {
    name: "password-reset",
    message: passwordResetMessage({
      email: "someone@example.com",
      url: `${APP_URL}/reset-password/2f8c4b6ae1d9`,
      expiresInHours: 24,
      appUrl: APP_URL,
    }),
  },
  {
    name: "delete-account",
    message: deleteAccountMessage({
      email: "someone@example.com",
      url: `${APP_URL}/api/auth/delete-user/callback?token=7c1e9a`,
      expiresInHours: 24,
      appUrl: APP_URL,
    }),
  },
  {
    /**
     * A notice from the cloud module. The copy for these lives in that
     * repository, so this is a representative one: what it is here for
     * is the envelope, which is this repository's.
     */
    name: "usage-notice",
    message: noticeMessage({
      to: "owner@acme.example",
      subject: "Bento: more than 90% of your agent hours are used",
      preheader: "Where you stand, with the rest of the period still to go.",
      heading: "More than 90% of your agent hours are used",
      paragraphs: [
        "Your team has used 23.4 of 25 agent hours for this period.",
        "Agents will stop when the allowance is used.",
        "Business includes 500 agent hours a period, for the whole team.",
      ],
      action: { label: "Upgrade to Business", url: `${APP_URL}/settings?tab=billing` },
      note: "You can also allow overage instead, so nothing stops and the difference is added to your next invoice.",
      footerNote: "You are receiving this because you are an owner or admin of this team on Bento.",
      appUrl: APP_URL,
    }),
  },
  {
    name: "contact",
    message: contactMessage({
      to: "support@example.com",
      kind: "issue",
      senderName: "Priya Raman",
      senderEmail: "priya@acme.example",
      message:
        "The gate on my review stage stays pending after the pull request is approved.\n\nIt happened on two cards this morning. Both were on the same branch, and running the stage again did not clear it.",
      appUrl: APP_URL,
    }),
  },
];

async function main(): Promise<void> {
  const outDir = path.join(process.cwd(), ".email-preview");
  await mkdir(outDir, { recursive: true });

  for (const sample of samples) {
    const { subject, html, text } = sample.message;
    await writeFile(path.join(outDir, `${sample.name}.html`), html ?? "", "utf8");
    // The plain text half is half the email, and the half that is
    // easiest to break without noticing.
    await writeFile(path.join(outDir, `${sample.name}.txt`), `Subject: ${subject}\n\n${text}\n`, "utf8");
    console.log(`${sample.name.padEnd(16)} ${subject}`);
  }

  console.log(`\nWrote ${samples.length} emails to ${outDir}`);
}

await main();
