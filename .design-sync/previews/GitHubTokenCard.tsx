import { GitHubTokenCard } from "@bento/web";
import { Surface, client } from "./_fixtures.js";

/**
 * The GitHub section of Settings: the token that lets Bento push a
 * branch and open the pull request, plus the one switch that decides
 * what rides along in it.
 */
export function Saved() {
  return (
    <Surface>
      <div style={{ maxWidth: 640 }}>
        <GitHubTokenCard client={client} />
      </div>
    </Surface>
  );
}
