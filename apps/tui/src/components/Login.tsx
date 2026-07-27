import { useEffect, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { DeviceFlow, type DeviceCodeResponse } from "@bento/api-client";

/**
 * Device flow login, the shape CLIs use: show a short code, the user
 * approves it in a browser, we poll until a token comes back.
 *
 * Failures stay on this screen with keys bound. A login that ends in a
 * red line and no way forward leaves Ctrl-C as the only exit, and the
 * commonest causes (a wrong address, a code left too long) are both
 * fixed by trying again.
 */
export function Login({
  baseUrl,
  notice,
  onToken,
  onQuit,
}: {
  baseUrl: string;
  /** Why sign in is being asked for, when something else decided it. */
  notice?: string;
  onToken: (token: string) => void;
  onQuit: () => void;
}) {
  const [code, setCode] = useState<DeviceCodeResponse | null>(null);
  const [error, setError] = useState("");
  /** Bumped by r, which abandons the current flow and starts another. */
  const [attempt, setAttempt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const { isRawModeSupported } = useStdin();

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setCode(null);
    setError("");
    const flow = new DeviceFlow({
      baseUrl,
      clientId: "bento-tui",
      signal: controller.signal,
      onPrompt: (issued) => {
        if (cancelled) return;
        setCode(issued);
        setSecondsLeft(issued.expires_in);
      },
    });
    void flow
      .login()
      .then((token) => {
        if (!cancelled) onToken(token);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [baseUrl, attempt]);

  // The code has a deadline the server chose, and nothing said so: a
  // person who stepped away came back to a code that would never be
  // accepted and no hint that starting again was the fix.
  useEffect(() => {
    if (!code || error) return;
    const timer = setInterval(() => setSecondsLeft((left) => Math.max(0, left - 1)), 1000);
    return () => clearInterval(timer);
  }, [code, error]);

  useInput(
    (input) => {
      if (input === "r") setAttempt((n) => n + 1);
      if (input === "q") onQuit();
    },
    // Must be a real boolean: Ink only honours isActive when it is
    // strictly false, and isRawModeSupported is undefined without a TTY.
    { isActive: isRawModeSupported === true },
  );

  const keys = isRawModeSupported ? "r try again · q quit" : "no terminal input available: press Ctrl-C to quit";

  if (error) {
    const { cause, fix } = explain(error, baseUrl);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} paddingY={1}>
        <Text bold color="red">
          Could not sign in to {baseUrl}
        </Text>
        <Text color="gray">{cause}</Text>
        <Text>{fix}</Text>
        <Box marginTop={1}>
          <Text color="gray">{keys}</Text>
        </Box>
      </Box>
    );
  }

  if (!code) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {notice && <Text color="yellow">{notice}</Text>}
        <Text color="gray">Requesting a login code from {baseUrl}...</Text>
        <Text color="gray">{keys}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} paddingY={1} paddingX={1}>
      {notice && <Text color="yellow">{notice}</Text>}
      <Text>Open this page to sign in:</Text>
      <Text color="magenta">{code.verification_uri_complete ?? code.verification_uri}</Text>
      <Box>
        <Text>Then enter the code: </Text>
        <Text bold color="cyan">
          {code.user_code}
        </Text>
      </Box>
      <Text color={secondsLeft === 0 ? "yellow" : "gray"}>
        {secondsLeft === 0
          ? "This code has expired. Press r for a fresh one."
          : `Waiting for approval. This code expires in ${countdown(secondsLeft)}.`}
      </Text>
      <Text color="gray">{keys}</Text>
    </Box>
  );
}

/** mm:ss, which reads faster than a count of seconds. */
function countdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What went wrong, and the thing to do about it. */
function explain(error: string, baseUrl: string): { cause: string; fix: string } {
  const lower = error.toLowerCase();
  if (lower.includes("denied")) {
    return {
      cause: "The code was rejected in the browser.",
      fix: "Press r for a new code, and approve it with the account that owns this board.",
    };
  }
  if (lower.includes("expired") || lower.includes("timed out")) {
    return {
      cause: "The code was not approved before it expired.",
      fix: "Press r for a fresh code, then approve it in the browser.",
    };
  }
  if (lower.includes("fetch failed") || lower.includes("econnrefused") || lower.includes("enotfound")) {
    return {
      cause: `${baseUrl} could not be reached.`,
      fix: "Check the address and that the server is running, then press r.",
    };
  }
  return { cause: error, fix: "Press r to try again." };
}
