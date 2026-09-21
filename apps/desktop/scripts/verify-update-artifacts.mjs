import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import provider from "electron-updater/out/providers/Provider.js";
import { releaseVersion } from "../../../scripts/release-version.mjs";

export async function verifyUpdateArtifacts(directory, tag) {
  const version = releaseVersion(tag);
  const file = path.join(directory, "latest-mac.yml");
  // Parse using the same library that ships in Bento, including its YAML rules.
  const info = provider.parseUpdateInfo(await readFile(file, "utf8"), file, pathToFileURL(file));
  assert.equal(info.version, version, "The updater and CLI must use the release tag");
  const expected = ["arm64", "x64"].flatMap(arch => ["zip", "dmg"].map(ext => `Bento-${version}-${arch}.${ext}`));
  assert.deepEqual(info.files.map(entry => entry.url).sort(), expected.sort(), "The update feed must contain both architectures");
  for (const entry of info.files) {
    const artifact = path.join(directory, entry.url);
    assert.equal((await stat(artifact)).size, entry.size, `Wrong size: ${entry.url}`);
    const hash = createHash("sha512");
    for await (const bytes of createReadStream(artifact)) hash.update(bytes);
    assert.equal(hash.digest("base64"), entry.sha512, `Wrong updater checksum: ${entry.url}`);
    assert.ok((await stat(`${artifact}.blockmap`)).size > 0, `Missing blockmap: ${entry.url}`);
  }
  console.log(`Verified macOS update metadata, artifacts, and blockmaps for ${tag} (arm64 and x64).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyUpdateArtifacts(path.resolve(process.argv[2] ?? "release-dist/desktop"), process.argv[3]);
}
