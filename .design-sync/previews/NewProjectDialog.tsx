import { NewProjectDialog } from "@bento/web";
import { client } from "./_fixtures.js";

/** The first thing a new install does: point Bento at a checkout. */
export function Empty() {
  return <NewProjectDialog client={client} onClose={() => {}} onSubmit={() => {}} />;
}
