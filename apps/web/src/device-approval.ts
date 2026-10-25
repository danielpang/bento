/** Keep authentication redirects on device approval, including the pending code. */
export function deviceApprovalCallbackUrl(code: string): string {
  return code ? `/device?${new URLSearchParams({ user_code: code })}` : "/device";
}
