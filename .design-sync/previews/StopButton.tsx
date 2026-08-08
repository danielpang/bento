import { StopButton } from "@bento/web";
import { Surface } from "./_fixtures.js";

/** Beside the composer input while the agent works: icon only, accessible name intact. */
export function Active() {
  return (
    <Surface>
      <StopButton disabled={false} onClick={() => {}} />
    </Surface>
  );
}

/** Mid cancellation: the click already landed and the control waits for the run to stop. */
export function Disabled() {
  return (
    <Surface>
      <StopButton disabled onClick={() => {}} />
    </Surface>
  );
}
