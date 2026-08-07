import { lazy, Suspense, useEffect, useState } from "react";
import type { BentoClient } from "@bento/api-client";
import { CHANGELOG, type ChangelogEntry } from "../changelog.js";
import { BottomBar } from "./BottomBar.js";
import { BrandLockup } from "./BrandLockup.js";

const ContactDialog = lazy(() => import("./ContactDialog.js").then((m) => ({ default: m.ContactDialog })));

/**
 * What has shipped, as a page.
 *
 * A document rather than an app screen: one column, dates down the
 * left, releases newest first, and nothing that needs a session to
 * read. Signed out visitors reach it too, which is why nothing here
 * fetches.
 *
 * Every release heading has an address, because the thing people
 * actually do with a changelog is point at one line of it in an issue.
 */
export function ChangelogPage({ client }: { client: BentoClient }) {
  const [contactOpen, setContactOpen] = useState(false);
  useHashScroll();

  return (
    <div className="app">
      <header className="topbar">
        <BrandLockup />
        <span className="topbar-spacer" />
        <a className="btn btn-ghost" href="/">
          Back to the board
        </a>
      </header>

      <main className="changelog">
        <header className="changelog-intro">
          <h1 className="changelog-title">Changelog</h1>
          <p className="changelog-lede">
            What has changed in Bento, newest first. Each release has its own link.
          </p>
        </header>

        {CHANGELOG.map((entry) => (
          <Release key={entry.id} entry={entry} />
        ))}
      </main>

      <BottomBar onContact={() => setContactOpen(true)} />
      <Suspense fallback={null}>
        {contactOpen && <ContactDialog client={client} onClose={() => setContactOpen(false)} />}
      </Suspense>
    </div>
  );
}

function Release({ entry }: { entry: ChangelogEntry }) {
  return (
    <article className="release" id={entry.id}>
      {/*
        The date rail. Its own column on a wide screen and sticky, so a
        long release keeps saying when it shipped while you read it; a
        line above the heading on a narrow one, where a 120px column
        would take a third of the width to hold eight characters.

        A <time> with a machine-readable datetime beside a rendering in
        the reader's own locale, rather than picking a side between
        08/07 and 07/08.
      */}
      <div className="release-rail">
        <time className="release-date" dateTime={entry.date}>
          {formatDate(entry.date)}
        </time>
      </div>

      <div className="release-body">
        <h2 className="release-title">
          {entry.title}
          <AnchorLink id={entry.id} label={entry.title} />
        </h2>
        {entry.summary && <p className="release-summary">{entry.summary}</p>}
        {entry.items.length > 0 && (
          <ul className="release-items">
            {entry.items.map((item) => (
              <li key={item.title} className="release-item">
                <h3 className="release-item-title">{item.title}</h3>
                <p className="release-item-body">{item.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

/**
 * The link on a heading.
 *
 * A real anchor, so the browser's own affordances work on it, and one
 * that also puts the absolute address on the clipboard: what somebody
 * wants after clicking this is the link in a message, not the page
 * scrolled to a place they were already looking at.
 *
 * The clipboard can refuse (an insecure origin, a denied permission),
 * and the navigation still happens, so a refusal costs nothing and is
 * not worth an error. The label only changes when the copy succeeded.
 */
function AnchorLink({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <a
      className="release-anchor"
      href={`#${id}`}
      aria-label={`Link to ${label}`}
      title={copied ? "Link copied" : "Copy link to this release"}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(`${window.location.origin}/changelog#${id}`)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      <span aria-hidden="true">{copied ? "copied" : "#"}</span>
    </a>
  );
}

/**
 * Bring the addressed release into view.
 *
 * The browser does this itself for a document it was handed whole, but
 * this page is rendered after the navigation: at the moment the engine
 * looks for the fragment there is a bare <div id="root"> and nothing
 * to find, so /changelog#board-navigation landed at the top and looked
 * like a broken link.
 *
 * The listener stays for the same reason in reverse: an in-page anchor
 * click only changes the hash, so once the element exists the browser
 * handles it, but arriving at a hash that names nothing (a renamed id
 * in an old issue) should leave the reader at the top of the page
 * rather than somewhere arbitrary, which is what happens by default.
 */
function useHashScroll() {
  useEffect(() => {
    const go = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      // getElementById rather than a selector: the hash is whatever was
      // in the address bar, and an id carrying a quote or a bracket is
      // a selector that throws rather than a link that finds nothing.
      document.getElementById(id)?.scrollIntoView({ behavior: "auto", block: "start" });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);
}

/**
 * The reader's locale, with a fallback to the ISO string. A date this
 * page cannot parse is still a date, and printing "Invalid Date" over
 * a release would be worse than printing 2026-08-07.
 */
function formatDate(iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
