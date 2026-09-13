import { pathToFileURL } from "node:url";

export function releaseVersion(tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag ?? "")) {
    throw new Error("Use a version tag such as v1.2.3 or v1.2.3-rc.1.");
  }
  return tag.slice(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(releaseVersion(process.argv[2]));
}
