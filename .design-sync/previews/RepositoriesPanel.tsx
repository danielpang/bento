import { RepositoriesPanel } from "@bento/web";
import { Frame, client } from "./_fixtures.js";

/**
 * The checkouts a project spans, each its own card: the name, the path,
 * and the two commands that tell a sandbox how to build and check it.
 */
export function TwoRepositories() {
  return (
    <Frame height={620}>
      <RepositoriesPanel client={client} projectId="prj1" onClose={() => {}} />
    </Frame>
  );
}
