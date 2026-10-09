/**
 * A run's sandbox provider in plain words, or null when the run does
 * not know it (an older run, or one whose machine was never made).
 *
 * Shown only to beta testers. The transcript and the run record never
 * name a provider, because which one is behind a card is Bento's
 * business and not the card's; this is the operator's view of the
 * same run, for telling a Fly sprite from a Modal fallback while
 * "auto" is being watched. A name this list does not know (a runner
 * may report its own) is shown as it came.
 */
export function sandboxProviderWords(provider: string | null | undefined): string | null {
  if (!provider) return null;
  switch (provider) {
    case "sprite":
      return "Fly sprite";
    case "modal":
      return "Modal";
    case "docker":
      return "Docker";
    case "local-process":
      return "Local process";
    default:
      return provider;
  }
}
