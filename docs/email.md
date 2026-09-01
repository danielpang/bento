# Email

Bento sends five emails of its own and addresses a sixth for the deployment extension. Four of the five are multi mode only, because local mode has one auto-provisioned user and no sign in. The contact form works in either mode, as long as `BENTO_CONTACT_EMAIL` is set.

| Email | Sent when | Built in |
|---|---|---|
| Invitation | Someone is invited to a team | `mail.ts` `invitationMessage` |
| Verification | An account is created | `mail.ts` `verificationMessage` |
| Password reset | A reset is requested | `mail.ts` `passwordResetMessage` |
| Delete account | Account deletion is requested | `mail.ts` `deleteAccountMessage` |
| Contact | The in-app contact form is submitted | `mail.ts` `contactMessage` |
| Notice | The cloud module warns a team about its usage | `mail.ts` `noticeMessage`, with the copy from the cloud module |

They all go through the layout in `apps/server/src/email-layout.ts`: a dark header band carrying the mark and the wordmark, a white card, a centred action button, and a centred footer with one link back and a line saying why the mail arrived.

![The invitation email](email/invitation.png)

## Mail from the cloud module

Plans and billing live in a separate repository. The usage warnings it sends are the only mail a customer gets that Bento did not write. The layout still belongs here, because it is built from the console's own colour tokens and a second copy of the table markup would have to be kept in step.

The seam therefore carries copy, not markup. `server.ts` hands the module a `notify` function. The module supplies a subject, a heading, paragraphs, and one action, and `noticeMessage` puts them in the same envelope as everything above. Every value is escaped on the way in, and the plain text half is built from the same paragraphs, so the two cannot drift apart.

`notify` is optional on the module's side, because nothing type checks across two repositories. A host too old to have it still gets the warning, as plain text.

## Previewing

```bash
pnpm --filter @bento/server preview:email
```

That writes every email, HTML and plain text, to `apps/server/.email-preview/`. Open the `.html` files in a browser. It renders through the same functions the server calls, so there is nothing to keep in sync.

A browser is not a mail client. The preview shows layout and copy, but not what Outlook will do. Send a real message before trusting a change to the table structure.

## Why it looks the way it does

**Tables and inline styles.** Email has no stylesheet and no cascade worth relying on, and Outlook still renders through Word.

**No remote images.** The mark is drawn from table cells with background colours, so it shows up with images blocked, which is the default in most clients. A self-hosted install also needs no public URL to serve a logo from. Outlook drops the rounded corners and shows squares, which still reads as the mark.

**No web fonts.** Geist never loads in mail, so the stack starts at the system UI font.

**Light only, and declared as such** with `color-scheme` and `supported-color-schemes`. A client that inverts an already dark design usually produces something neither theme intended. The colours are the light theme tokens from `apps/web/src/styles.css`.

**Both halves carry the link.** A client that refuses HTML still has to end up with a working link, so every message builds its text body deliberately rather than stripping tags out of the HTML.

**Values are escaped by default.** Body fragments are built with the `html` tagged template from `email-layout.ts`, which escapes everything it interpolates. An organization named after a script tag cannot write markup into someone else's inbox.

## Adding an email

Add a builder to `mail.ts` that returns a `Message`, and give it:

- `preheader`, the line clients show beside the subject. Without one they use the first words of the body, so every account email in a list starts with the same sentence.
- `footerNote`, one line saying why the mail arrived.
- `appUrl`, the base URL of the console, which the footer link is built from. Both call sites derive it from `BETTER_AUTH_URL`.

Then add a sample to `email-preview.ts` and look at it.
