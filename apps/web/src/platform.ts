/**
 * Whether the keyboard in front of the person has a Command key.
 *
 * Decides how a shortcut is written ("Cmd+Enter" or "Ctrl+Enter") and
 * nothing else. `navigator.userAgentData.platform` is the modern
 * answer and `navigator.platform` the one every browser still gives;
 * iPhones and iPads count, because their keyboards carry Command too.
 */
export function isApplePlatform(
  nav: { platform?: string; userAgentData?: { platform?: string } | null } = navigator,
): boolean {
  const platform = nav.userAgentData?.platform || nav.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The key that, with Enter, sends: "Cmd" on Apple keyboards, "Ctrl" elsewhere. */
export function sendModifierName(apple: boolean = isApplePlatform()): string {
  return apple ? "Cmd" : "Ctrl";
}
