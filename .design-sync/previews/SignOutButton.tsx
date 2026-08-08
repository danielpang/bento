import { SignOutButton } from "@bento/web";
import { Surface } from "./_fixtures.js";

function GearMark() {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false">
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect key={deg} x="7.05" y="0.6" width="1.9" height="3.6" rx="0.6" transform={`rotate(${deg} 8 8)`} />
      ))}
      <path
        fillRule="evenodd"
        d="M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm0 2.65a2.35 2.35 0 1 1 0 4.7 2.35 2.35 0 0 1 0-4.7Z"
      />
    </svg>
  );
}

/** The wide topbar's exit control: icon only, still named "Sign out" to assistive tech. */
export function Default() {
  return (
    <Surface>
      <nav className="topbar-actions" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <a className="btn btn-ghost settings-gear" aria-label="Settings" title="Settings" href="#settings">
          <GearMark />
        </a>
        <SignOutButton onClick={() => {}} />
      </nav>
    </Surface>
  );
}
