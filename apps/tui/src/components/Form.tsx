import { useRef, useState } from "react";
import { Box, Text, useStdin, useWindowSize } from "ink";
import { useKeyboardInput } from "../mouse.js";
import { terminalText } from "../terminal.js";
import { TextInput } from "./TextInput.js";
import { MouseActions, MouseButton } from "./MouseControls.js";
import { Navigator } from "./Navigator.js";
import stringWidth from "string-width";

export type FormValues = Record<string, string>;
export type FormField = {
  id: string;
  label: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  multiline?: boolean;
  mask?: boolean;
  options?: { value: string; label: string }[];
  when?: (values: FormValues) => boolean;
};
export type FormOptions = {
  description?: string;
  fullDescription?: boolean;
  submitLabel?: string;
  successMessage?: string;
};

/** Shared draft, focus, validation and explicit-submit behavior for terminal forms. */
export function Form({
  title,
  fields: allFields,
  initialValues,
  onValuesChange,
  onSubmit,
  onCancel,
  description,
  fullDescription = false,
  submitLabel = "Save",
  successMessage,
}: FormOptions & {
  title: string;
  fields: FormField[];
  initialValues?: FormValues;
  onValuesChange?: (values: FormValues) => void;
  onSubmit: (values: FormValues) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { rows, columns } = useWindowSize();
  const { isRawModeSupported } = useStdin();
  const [values, setValues] = useState<FormValues>(
    () => initialValues ?? Object.fromEntries(allFields.map((f) => [f.id, f.value ?? ""])),
  );
  const fields = allFields.filter((field) => !field.when || field.when(values));
  const [focus, setFocus] = useState(0);
  const [picker, setPicker] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);
  const windowStart = useRef(0);
  function change(id: string, value: string) {
    const next = { ...values, [id]: value };
    setValues(next);
    onValuesChange?.(next);
    setError("");
    setSaved(false);
  }
  async function submit() {
    if (pending.current) return;
    for (const [index, field] of fields.entries()) {
      const value = values[field.id] ?? "";
      if (field.required && !value.trim()) {
        setError(`${field.label} is required.`);
        setFocus(index);
        return;
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        setError(`${field.label} must be at most ${field.maxLength.toLocaleString("en-US")} characters.`);
        setFocus(index);
        return;
      }
    }
    pending.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await onSubmit({ ...values });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  useKeyboardInput(
    (input, key) => {
      if (busy || picker) return;
      const field = fields[focus];
      if (key.tab) setFocus((i) => (i + (key.shift ? fields.length + 1 : 1)) % (fields.length + 2));
      else if (key.ctrl && input === "s") void submit();
      else if (key.escape && (!field || field.options)) onCancel();
      else if (key.return && focus === fields.length) void submit();
      else if (key.return && focus === fields.length + 1) onCancel();
      else if (key.return && field?.options) setPicker(field.id);
      else if ((key.leftArrow || key.rightArrow) && field?.options?.length) {
        const at = field.options.findIndex((option) => option.value === values[field.id]);
        const next = (at + (key.leftArrow ? field.options.length - 1 : 1)) % field.options.length;
        change(field.id, field.options[next]!.value);
      }
    },
    { isActive: isRawModeSupported === true },
  );

  const activePicker = fields.find((field) => field.id === picker);
  if (activePicker?.options)
    return (
      <Navigator
        title={activePicker.label}
        choices={activePicker.options.map((option) => ({
          id: option.value,
          label: option.label,
          select: () => {
            change(activePicker.id, option.value);
            setPicker(null);
          },
        }))}
        onClose={() => setPicker(null)}
      />
    );

  const showDescription = Boolean(description);
  const descriptionRows =
    description && fullDescription
      ? terminalText(description)
          .split("\n")
          .reduce(
            (sum, line) => sum + Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, columns - 4))),
            0,
          )
      : Number(showDescription);
  const fixedRows = 6 + descriptionRows;
  const count = Math.min(fields.length, Math.max(1, Math.floor((rows - fixedRows - 1) / 2)));
  const selected = Math.min(focus, fields.length - 1);
  const first = Math.max(
    0,
    Math.min(
      selected < windowStart.current
        ? selected
        : selected >= windowStart.current + count
          ? selected - count + 1
          : windowStart.current,
      fields.length - count,
    ),
  );
  windowStart.current = first;
  const visible = fields.slice(first, first + count);
  const spacing = rows >= fixedRows + visible.length * 3 + 4 ? 1 : 0;
  const available = Math.max(
    0,
    rows - fixedRows - Number(count < fields.length) - visible.length * (2 + spacing),
  );
  const multilineCount = visible.filter((field) => field.multiline).length;
  const inputRows = Math.max(1, 1 + Math.floor(available / Math.max(1, multilineCount)));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        {terminalText(title)}
      </Text>
      {showDescription && (
        <Text dimColor wrap={fullDescription ? "hard" : "truncate-end"}>
          {terminalText(description!)}
        </Text>
      )}
      {visible.map((field, index) => {
        const at = first + index;
        return (
          <Box key={field.id} flexDirection="column" marginTop={spacing}>
            <Text color={focus === at ? "cyan" : "gray"} wrap="truncate-end">
              {terminalText(field.label)}
            </Text>
            {field.options ? (
              <MouseButton
                label={field.options.find((o) => o.value === values[field.id])?.label ?? "Choose…"}
                onClick={() => {
                  setFocus(at);
                  setPicker(field.id);
                }}
                disabled={busy}
              />
            ) : (
              <TextInput
                value={values[field.id] ?? ""}
                onChange={(value) => change(field.id, value)}
                isActive={!busy && focus === at}
                {...(!busy ? { onFocus: () => setFocus(at) } : {})}
                onSubmit={() => {
                  if (fields.length === 1) void submit();
                  else setFocus(at + 1);
                }}
                onCancel={onCancel}
                mask={field.mask ?? false}
                multiline={field.multiline ?? false}
                placeholder={field.placeholder ?? ""}
                {...(field.multiline ? { visibleRows: inputRows, initialCursor: "start" as const } : {})}
              />
            )}
          </Box>
        );
      })}
      {count < fields.length && (
        <Text dimColor>
          Fields {first + 1} to {first + count} of {fields.length} · Tab next
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        Tab switch{fields.some((f) => f.multiline) ? " · Ctrl+J newline" : ""} · Ctrl+S{" "}
        {submitLabel.toLowerCase()} · Esc cancel
      </Text>
      <MouseActions>
        {focus === fields.length && <Text color="cyan">›</Text>}
        <MouseButton
          label={submitLabel}
          onClick={() => {
            void submit();
          }}
          disabled={busy}
        />
        {focus === fields.length + 1 && <Text color="cyan">›</Text>}
        <MouseButton label="Cancel" onClick={onCancel} disabled={busy} />
      </MouseActions>
      {busy && <Text dimColor>Saving…</Text>}
      {saved && successMessage && <Text color="green">{successMessage}</Text>}
      {error && (
        <Text color="red" wrap="truncate-end">
          {terminalText(error)}
        </Text>
      )}
    </Box>
  );
}
