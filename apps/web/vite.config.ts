import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Stamps every icon URL in index.html with a hash of the file it points at.
 *
 * The icons live in `public/`, so their names carry no hash: `/favicon.svg`
 * is `/favicon.svg` forever, and the bytes behind it change silently. The
 * server already sets a short max-age on those names for exactly this
 * reason, but a short max-age is not what decides whether a favicon
 * updates. Browsers keep favicons in a store of their own, keyed by
 * origin, and consult it long past any max-age; Fly serves these with no
 * ETag and no Last-Modified, so there is not even a cheap revalidation to
 * fall back on. The result is a tab that keeps drawing an icon that was
 * replaced months ago, on a deployment serving the correct bytes the whole
 * time. That is not hypothetical: it is what the hosted console was doing.
 *
 * A changed file therefore has to mean a changed URL. `?v=<hash>` is the
 * whole mechanism, and it is what usebento.ai already gets for free from
 * Next, which fingerprints its icon links with a deployment id.
 *
 * Derived from the bytes rather than written by hand, because a version
 * somebody has to remember to bump is a version that will be wrong the
 * first time it matters. Replace an icon, rebuild, and the URL moves on
 * its own.
 */
function stampIcons(): Plugin {
  const publicDir = path.resolve(import.meta.dirname, "public");
  const hashes = new Map<string, string>();

  const version = (file: string): string | null => {
    const cached = hashes.get(file);
    if (cached !== undefined) return cached || null;
    try {
      const bytes = readFileSync(path.join(publicDir, file));
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
      hashes.set(file, hash);
      return hash;
    } catch {
      // A link to a file that is not there is a broken tag, not a build
      // failure to introduce here. Left exactly as written so it stays
      // as visible as it was.
      hashes.set(file, "");
      return null;
    }
  };

  return {
    name: "bento-stamp-icons",
    /*
     * The manifest's own icons, which index.html never names: they are
     * the ones an installed app draws, and a home screen holds a stale
     * icon far longer than a tab does. Rewritten in the build output
     * rather than at the source, so `public/site.webmanifest` stays a
     * file somebody can read.
     */
    writeBundle(options) {
      const dir = options.dir ?? path.resolve(import.meta.dirname, "dist");
      const manifest = path.join(dir, "site.webmanifest");
      let text: string;
      try {
        text = readFileSync(manifest, "utf8");
      } catch {
        return; // No manifest in this build; nothing to stamp.
      }
      const stamped = text.replace(/"src":\s*"\/([^"?#]+\.png)"/g, (whole, file: string) => {
        const hash = version(file);
        return hash ? `"src": "/${file}?v=${hash}"` : whole;
      });
      if (stamped !== text) writeFileSync(manifest, stamped);
    },
    transformIndexHtml: {
      // Before Vite rewrites asset URLs, so what is matched here is what
      // the file actually says.
      order: "pre",
      handler(html) {
        return html.replace(
          /(<link\b[^>]*\bhref=")\/([^"?#]+\.(?:svg|ico|png|webmanifest))(")/g,
          (whole, before: string, file: string, after: string) => {
            const hash = version(file);
            return hash ? `${before}/${file}?v=${hash}${after}` : whole;
          },
        );
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), stampIcons()],
  server: {
    port: 4401,
    proxy: {
      "/api": { target: "http://127.0.0.1:4400", changeOrigin: true },
    },
  },
});
