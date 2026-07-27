import { DiffReview } from "@bento/web";
import { Surface, changes } from "./_fixtures.js";

/**
 * What the agent committed, per repository, with each line quotable so
 * a question can point at the code it is about.
 */
export function Committed() {
  return (
    <Surface>
      <DiffReview changes={changes} onQuote={() => {}} />
    </Surface>
  );
}
