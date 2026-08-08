import { SignOutButton } from "@bento/web";
import { Surface } from "./_fixtures.js";

/** The wide topbar's exit control: icon only, still named "Sign out" to assistive tech. */
export function Default() {
  return (
    <Surface>
      <SignOutButton onClick={() => {}} />
    </Surface>
  );
}
