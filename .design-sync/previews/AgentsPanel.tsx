import { AgentsPanel } from "@bento/web";
import { Frame, client, profiles } from "./_fixtures.js";

/** The agents a board can run, and the keys they spend. */
export function Configured() {
  return (
    <Frame height={620}>
      <AgentsPanel client={client} profiles={profiles} onClose={() => {}} onChanged={() => {}} />
    </Frame>
  );
}

/** A fresh install, before anything has been paired. */
export function Empty() {
  return (
    <Frame height={620}>
      <AgentsPanel client={client} profiles={[]} onClose={() => {}} onChanged={() => {}} />
    </Frame>
  );
}
