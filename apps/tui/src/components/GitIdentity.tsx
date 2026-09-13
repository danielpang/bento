import { useEffect, useState } from "react";
import { Box, Text, useStdin } from "ink";
import type { BentoClient } from "@bento/api-client";
import { useKeyboardInput } from "../mouse.js";
import { terminalText } from "../terminal.js";
import { MouseButton } from "./MouseControls.js";
import { Form } from "./Form.js";

/** Both fields belong to one draft and are written together only on Save. */
export function GitIdentity({ client, onClose }: { client: BentoClient; onClose: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { isRawModeSupported } = useStdin();
  useEffect(() => {
    let cancelled = false;
    setError("");
    void client
      .getMachineSettings()
      .then((settings) => {
        if (cancelled) return;
        setName(settings.gitAuthorName ?? "");
        setEmail(settings.gitAuthorEmail ?? "");
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  useKeyboardInput(
    (input, key) => {
      if (key.escape) onClose();
      else if (input === "r" && error) setAttempt((n) => n + 1);
    },
    { isActive: !loaded && isRawModeSupported === true },
  );

  if (!loaded)
    return (
      <Box flexDirection="column">
        <Text>{error ? terminalText(error) : "Loading Git identity…"}</Text>
        {error && <MouseButton label="Retry" onClick={() => setAttempt((n) => n + 1)} />}
        <MouseButton label="Cancel" onClick={onClose} />
      </Box>
    );
  return (
    <Form
      title="Git identity"
      fields={[
        {
          id: "gitAuthorName",
          label: "Author name",
          value: name,
          maxLength: 200,
          placeholder: "Use Git configuration",
        },
        {
          id: "gitAuthorEmail",
          label: "Author email",
          value: email,
          maxLength: 320,
          placeholder: "Use Git configuration",
        },
      ]}
      description="Used for agent commits. Blank fields use this machine's Git configuration."
      successMessage="Git identity saved."
      onCancel={onClose}
      onSubmit={async ({ gitAuthorName = "", gitAuthorEmail = "" }) => {
        await client.setGitIdentity({
          gitAuthorName: gitAuthorName.trim(),
          gitAuthorEmail: gitAuthorEmail.trim(),
        });
      }}
    />
  );
}
