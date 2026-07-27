import { ProviderMark } from "@bento/web";
import { Surface } from "./_fixtures.js";

/**
 * The mark is a bare logo, so on its own it is a 14px image with no
 * label. These cards pair each one with the model string it was
 * resolved from — which is also how it appears in the console, always
 * next to the thing it qualifies.
 */
function Row({ cli, model }: { cli: string; model: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
      <ProviderMark cli={cli} model={model} />
      <span className="chip chip-clip" title={model}>
        {model}
      </span>
      <span className="muted" style={{ fontSize: 11 }}>
        {cli}
      </span>
    </div>
  );
}

/** One mark per provider a Bento agent can be pointed at. */
export function ByProvider() {
  return (
    <Surface>
      <div style={{ minWidth: 380 }}>
        <Row cli="claude-code" model="claude-opus-5" />
        <Row cli="codex" model="gpt-5-codex" />
        <Row cli="opencode" model="anthropic/claude-sonnet-5" />
        <Row cli="pi" model="openrouter/z-ai/glm-4.6" />
        <Row cli="cursor" model="claude-sonnet-5" />
      </div>
    </Surface>
  );
}

/**
 * In a chip the provider is already named in the text beside it, so the
 * mark drops its alt text and carries the logo alone.
 */
export function InAChip() {
  return (
    <Surface>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span className="chip">
          <ProviderMark cli="claude-code" model="claude-opus-5" decorative />
          Staff Engineer
        </span>
        <span className="chip">
          <ProviderMark cli="opencode" model="openrouter/openai/gpt-5.6-sol" decorative />
          Code Reviewer
        </span>
      </div>
    </Surface>
  );
}

/**
 * The fake agent resolves to no provider and renders nothing, which is
 * the honest answer: it bills no one. The row is what that looks like.
 */
export function NoProvider() {
  return (
    <Surface>
      <Row cli="fake" model="fake-1" />
    </Surface>
  );
}
