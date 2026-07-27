import { SettingsPage } from "@bento/web";
import { client } from "./_fixtures.js";

/** Appearance, GitHub, and (on a hosted deployment) team and billing. */
export function Appearance() {
  return (
    <div style={{ height: 640, overflow: "hidden" }}>
      <SettingsPage client={client} />
    </div>
  );
}
