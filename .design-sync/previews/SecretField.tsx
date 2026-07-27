import { useState } from "react";
import { SecretField } from "@bento/web";
import { Surface } from "./_fixtures.js";

/** The field as it appears with nothing typed yet. */
export function Empty() {
  const [value, setValue] = useState("");
  return (
    <Surface>
      <SecretField
      value={value}
      onChange={setValue}
      onSubmit={() => {}}
      label="GitHub token"
      placeholder="github_pat_..."
      submitLabel="Save token"
      />
    </Surface>
  );
}

/** Masked, which is what a pasted credential looks like before the eye. */
export function Masked() {
  const [value, setValue] = useState("github_pat_11ABCDE7Y0mK3nQr8sTuVw");
  return (
    <Surface>
      <SecretField
      value={value}
      onChange={setValue}
      onSubmit={() => {}}
      label="GitHub token"
      placeholder="github_pat_..."
      submitLabel="Replace token"
      />
    </Surface>
  );
}

/**
 * Not every value in this row is a secret. A base URL is configuration,
 * so it reads in plain text and offers no reveal.
 */
export function NotSecret() {
  const [value, setValue] = useState("https://openrouter.ai/api/v1");
  return (
    <Surface>
      <SecretField
      value={value}
      onChange={setValue}
      onSubmit={() => {}}
      label="Anthropic base URL"
      placeholder="https://openrouter.ai/api/v1"
      submitLabel="Save"
      secret={false}
      />
    </Surface>
  );
}

/** Mid-save: the button is out of action until the request settles. */
export function Saving() {
  return (
    <Surface>
      <SecretField
      value="sk-ant-api03-9Kd2..."
      onChange={() => {}}
      onSubmit={() => {}}
      label="Anthropic API key"
      placeholder="Paste the key"
      submitLabel="Save"
      busy
      />
    </Surface>
  );
}
