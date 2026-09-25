import { providerForProfile } from "@bento/core";

/**
 * The logo of the provider an agent runs against.
 *
 * Which company is about to be billed is the fastest thing to read off
 * a mark and the slowest to read off a model string, so the mark goes
 * wherever an agent is named. The fake agent resolves to no provider
 * and renders nothing, which is the honest answer: it bills no one.
 */
export function ProviderMark({
  cli,
  model,
  decorative = false,
}: {
  cli: string;
  model: string;
  /** True where the provider's name is already beside it in text. */
  decorative?: boolean;
}) {
  const provider = providerForProfile(cli, model);
  if (!provider?.logo) return null;
  return (
    <img
      className="provider-logo"
      src={provider.logo}
      alt={decorative ? "" : provider.name}
      aria-hidden={decorative || undefined}
      title={provider.name}
    />
  );
}
