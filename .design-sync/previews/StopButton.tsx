import { StopButton } from "@bento/web";
import { Surface } from "./_fixtures.js";

/** Beside the composer input while the agent works: icon only, accessible name intact. */
export function Active() {
  return (
    <Surface>
      <form className="composer" onSubmit={(e) => e.preventDefault()}>
        <input
          className="input composer-input"
          defaultValue=""
          placeholder="Message the agent"
          aria-label="Message the agent"
          readOnly
        />
        <StopButton disabled={false} onClick={() => {}} />
        <button className="btn btn-primary" type="submit" disabled>
          Send
        </button>
      </form>
      <p className="muted composer-hint">Delivered while the agent is working.</p>
    </Surface>
  );
}

/** Mid cancellation: the click already landed and the control waits for the run to stop. */
export function Disabled() {
  return (
    <Surface>
      <form className="composer" onSubmit={(e) => e.preventDefault()}>
        <input
          className="input composer-input"
          defaultValue=""
          placeholder="Message the agent"
          aria-label="Message the agent"
          readOnly
          disabled
        />
        <StopButton disabled onClick={() => {}} />
        <button className="btn btn-primary" type="submit" disabled>
          Send
        </button>
      </form>
      <p className="muted composer-hint">Delivered while the agent is working.</p>
    </Surface>
  );
}
