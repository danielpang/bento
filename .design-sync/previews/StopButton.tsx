import { StopButton } from "@bento/web";
import { Surface } from "./_fixtures.js";

/** Beside the composer input while the agent works: icon only, accessible name intact. */
export function Active() {
  return (
    <Surface>
      <form className="composer" onSubmit={(e) => e.preventDefault()}>
        <textarea
          className="input composer-input"
          rows={1}
          defaultValue=""
          placeholder="Send a message..."
          aria-label="Send a message"
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
        <textarea
          className="input composer-input"
          rows={1}
          defaultValue=""
          placeholder="Send a message..."
          aria-label="Send a message"
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
