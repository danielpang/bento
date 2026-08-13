# Email

Bento sends five emails. Four of them exist only in multi mode, since local mode has one auto-provisioned user and no sign in; the contact form is the exception and works in either mode, as long as `BENTO_CONTACT_EMAIL` is set.

| Email | Sent when | Built in |
|---|---|---|
| Invitation | Someone is invited to a team | `mail.ts` `invitationMessage` |
| Verification | An account is created | `mail.ts` `verificationMessage` |
| Password reset | A reset is requested | `mail.ts` `passwordResetMessage` |
| Delete account | Account deletion is requested | `mail.ts` `deleteAccountMessage` |
| Contact | The in-app contact form is submitted | `mail.ts` `contactMessage` |

They all go through the layout in `apps/server/src/email-layout.ts`: a dark header band carrying the mark and the wordmark, a white card, a centred action button, and a centred footer with one link back and a line saying why the mail arrived.

![The invitation email](email/invitation.png)

## Previewing

```bash
pnpm --filter @bento/server preview:email
```

That writes every email, HTML and plain text, to `apps/server/.email-preview/`. Open the `.html` files in a browser. It renders through the same functions the server calls, so there is nothing to keep in sync.

A browser is not a mail client. The preview proves layout and copy; it does not prove that Outlook agrees. Send a real one before trusting a change to the table structure.

## Why it looks the way it does

**Tables and inline styles.** There is no stylesheet in email and no cascade worth relying on, and Outlook still renders through Word.

**No remote images.** The mark is drawn from table cells with background colours, so it appears with images blocked, which is the default in most clients. It also means a self-hosted install needs no public URL to serve a logo from. Outlook drops the rounded corners and shows squares, which still reads as the mark.

**No web fonts.** Geist never loads in mail, so the stack starts at the system UI font.

**Light only, and declared as such** with `color-scheme` and `supported-color-schemes`. A client that inverts an already dark design tends to produce something neither theme intended. The colours are the light theme tokens from `apps/web/src/styles.css`.

**Both halves carry the link.** Plain text is not a fallback nobody reads: a client that refuses HTML has to end up with a working link, so every message builds its text body deliberately rather than stripping tags out of the HTML.

**Values are escaped by default.** Body fragments are built with the `html` tagged template from `email-layout.ts`, which escapes everything it interpolates. An organization named after a script tag is not a way to write markup into someone else's inbox.

## Adding an email

Add a builder to `mail.ts` that returns a `Message`, and give it:

- `preheader`, the line clients show beside the subject. Without one they pull the first words of the body, so every account email in a list would start with the same sentence.
- `footerNote`, one line saying why the mail arrived.
- `appUrl`, the base URL of the console, which the footer link is built from. Both call sites derive it from `BETTER_AUTH_URL`.

Then add a sample to `email-preview.ts` and look at it.
