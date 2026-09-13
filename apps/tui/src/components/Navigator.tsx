import { useKeyboardInput as useInput } from "../mouse.js";
import { useRef, useState } from "react";
import { Box, Text, useStdin, useWindowSize } from "ink";
import { TextInput } from "./TextInput.js";
import { useMouseTarget } from "../mouse.js";
import { MouseActions, MouseButton } from "./MouseControls.js";
import { openUrl } from "../open-url.js";
import { matchesSearch, terminalSelectionHint, terminalText, wrapLines } from "../terminal.js";
import { wrapConversationText } from "./conversation-layout.js";

export interface Choice {
  id: string;
  label: string;
  detail?: string;
  select: () => void;
}

/** Exact option names win over incidental substrings, such as OAuth in "No authentication". */
export function filterChoices(choices: Choice[], query: string): Choice[] {
  const normalize = (value: string) => value.normalize("NFKD").toLowerCase().trim();
  const needle = normalize(query);
  const rank = (label: string) => {
    const value = normalize(label);
    if (!needle || value === needle) return 0;
    if (value.startsWith(needle)) return 1;
    if (value.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return 2;
    return 3;
  };
  return choices
    .filter((choice) => matchesSearch(`${choice.label} ${choice.detail ?? ""}`, query))
    .sort((a, b) => rank(a.label) - rank(b.label));
}

export function Navigator({
  title,
  choices,
  onClose,
}: {
  title: string;
  choices: Choice[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const selected = useRef(0);
  const queryRef = useRef("");
  const { rows, columns } = useWindowSize();
  const { isRawModeSupported } = useStdin();
  const filtered = filterChoices(choices, query);
  const size = Math.max(1, rows - 11);
  const windowStart = useRef(0);
  const start = Math.max(
    0,
    Math.min(
      index < windowStart.current
        ? index
        : index >= windowStart.current + size
          ? index - size + 1
          : windowStart.current,
      filtered.length - size,
    ),
  );
  windowStart.current = start;
  function move(delta: number) {
    selected.current = Math.max(0, Math.min(filtered.length - 1, selected.current + delta));
    setIndex(selected.current);
  }
  const mouse = useMouseTarget({
    onScroll: (event) => {
      if (event.kind === "down" || event.kind === "up") move(event.kind === "down" ? 1 : -1);
    },
  });
  useInput(
    (input, key) => {
      const delta =
        key.downArrow || (key.ctrl && input === "n")
          ? 1
          : key.upArrow || (key.ctrl && input === "p")
            ? -1
            : key.pageDown
              ? size
              : key.pageUp
                ? -size
                : 0;
      if (delta) {
        move(delta);
      }
    },
    { isActive: isRawModeSupported === true },
  );
  return (
    <Box ref={mouse} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        {terminalText(title)}
      </Text>
      <TextInput
        value={query}
        onChange={(next) => {
          queryRef.current = next;
          setQuery(next);
          selected.current = 0;
          setIndex(0);
        }}
        onSubmit={() => filterChoices(choices, queryRef.current)[selected.current]?.select()}
        onCancel={onClose}
        placeholder="Type to filter…"
      />
      <Box flexDirection="column" marginY={1}>
        {filtered.slice(start, start + size).map((choice, i) => (
          <MenuChoice
            key={choice.id}
            onClick={() => {
              selected.current = start + i;
              setIndex(start + i);
              choice.select();
            }}
          >
            <Text wrap="truncate-end" {...(start + i === index ? { color: "cyan" } : {})}>
              {start + i === index ? "› " : "  "}
              {terminalText(choice.label)}
              {columns >= 95 && choice.detail ? <Text dimColor> {terminalText(choice.detail)}</Text> : null}
            </Text>
          </MenuChoice>
        ))}
        {!filtered.length && <Text dimColor>No matches. Try a different search.</Text>}
      </Box>
      <Text dimColor wrap="truncate-end">
        {columns < 65
          ? "↑/↓ select · Enter open · Esc back"
          : `↑/↓ select · Enter open · Esc back · ${filtered.length} results`}
      </Text>
      <MouseActions>
        <MouseButton label="Back" onClick={onClose} />
        <MouseButton
          label="Clear search"
          onClick={() => {
            queryRef.current = "";
            setQuery("");
            selected.current = 0;
            setIndex(0);
          }}
          disabled={!query}
        />
      </MouseActions>
    </Box>
  );
}

function MenuChoice({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const ref = useMouseTarget({ onClick, priority: 1 });
  return (
    <Box ref={ref} height={1}>
      {children}
    </Box>
  );
}

export function Reader({
  title,
  lines,
  onClose,
  follow = false,
  onMessage,
  document = false,
  actions = [],
  description,
}: {
  title: string;
  lines: string[];
  onClose: () => void;
  follow?: boolean;
  onMessage?: () => void;
  document?: boolean;
  description?: string;
  actions?: { label: string; onClick: () => void; disabled?: boolean }[];
}) {
  const { rows, columns } = useWindowSize();
  const { isRawModeSupported } = useStdin();
  const [offset, setOffset] = useState(0);
  const [following, setFollowing] = useState(follow);
  const [query, setQuery] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [linkError, setLinkError] = useState("");
  const link = lines.find((line) => /^https?:\/\/\S+$/.test(line.trim()))?.trim();
  const wrapped = document ? wrapConversationText(lines, columns - 6) : wrapLines(lines, columns - 6);
  const height = Math.max(1, rows - (onMessage ? 12 : 10) - (description ? 1 : 0) - (actions.length ? 2 : 0));
  const max = Math.max(0, wrapped.length - height);
  const top = following ? max : Math.min(offset, max);
  const scrollTop = useRef(top);
  scrollTop.current = top;
  function scroll(delta: number) {
    setFollowing(false);
    scrollTop.current = Math.max(0, Math.min(max, scrollTop.current + delta));
    setOffset(scrollTop.current);
  }
  const mouse = useMouseTarget({
    onScroll: (event) => {
      if (event.kind === "up" || event.kind === "down") scroll(event.kind === "up" ? -3 : 3);
    },
  });
  const nextMatch = (text: string, from: number) => {
    if (!text.trim()) return;
    for (let i = 0; i < wrapped.length; i++) {
      const at = (from + i) % wrapped.length;
      if (matchesSearch(wrapped[at]!, text)) {
        setFollowing(false);
        setOffset(at);
        break;
      }
    }
  };
  useInput(
    (input, key) => {
      if (query !== null) return;
      if (key.escape || input === "q") onClose();
      if (input === "c") onMessage?.();
      if (input === "/") setQuery(search);
      if (input === "n") nextMatch(search, top + 1);
      if (key.downArrow || input === "j") setOffset(Math.min(max, top + 1));
      if (key.upArrow || input === "k") {
        setFollowing(false);
        setOffset(Math.max(0, top - 1));
      }
      if (key.pageDown || input === " ") setOffset(Math.min(max, top + height));
      if (key.pageUp) {
        setFollowing(false);
        setOffset(Math.max(0, top - height));
      }
      if (key.home || input === "g") {
        setFollowing(false);
        setOffset(0);
      }
      if (key.end || input === "G") {
        setFollowing(follow);
        setOffset(max);
      }
    },
    { isActive: isRawModeSupported === true },
  );
  return (
    <Box ref={mouse} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold wrap="truncate-end">
        {terminalText(title)}
      </Text>
      {description && (
        <Text dimColor wrap="truncate-end">
          {description}
        </Text>
      )}
      <Box flexDirection="column" height={Math.min(height, Math.max(1, wrapped.length))}>
        {wrapped.slice(top, top + height).map((line, i) => (
          <Text
            key={top + i}
            {...(document && /^#{1,6} /.test(line) ? { bold: true, color: "cyan" } : {})}
            {...(line.startsWith("+") ? { color: "green" } : line.startsWith("-") ? { color: "red" } : {})}
          >
            {line || " "}
          </Text>
        ))}
        {!wrapped.length && <Text dimColor>Nothing here yet.</Text>}
      </Box>
      {query !== null ? (
        <TextInput
          value={query}
          onChange={setQuery}
          onSubmit={(text) => {
            setSearch(text);
            setQuery(null);
            nextMatch(text, 0);
          }}
          onCancel={() => setQuery(null)}
          placeholder="Find in this view"
          showActions
        />
      ) : (
        <Text dimColor wrap="truncate-end">
          ↑/↓ scroll · PgUp/PgDn · g/G first/last · / find · n next · Esc back
        </Text>
      )}
      {onMessage && (
        <Text dimColor>
          c message agent · {following ? "Following live output" : "Reading history. G follows output"}
        </Text>
      )}
      <Text dimColor wrap="truncate-end">
        {wrapped.length ? top + 1 : 0} to {Math.min(top + height, wrapped.length)} of {wrapped.length} lines
        {terminalSelectionHint() && ` · ${terminalSelectionHint()}`}
      </Text>
      {query === null && (
        <MouseActions>
          <MouseButton label="Back" onClick={onClose} />
          <MouseButton label="Find" onClick={() => setQuery(search)} />
          <MouseButton label="Next" onClick={() => nextMatch(search, top + 1)} disabled={!search} />
          <MouseButton
            label="Top"
            onClick={() => {
              setFollowing(false);
              setOffset(0);
            }}
          />
          <MouseButton
            label={follow ? "Follow" : "Bottom"}
            onClick={() => {
              setFollowing(follow);
              setOffset(max);
            }}
          />
          {onMessage && <MouseButton label="Message" onClick={onMessage} />}
          {link && (
            <MouseButton
              label="Open link"
              onClick={() => {
                void openUrl(link).catch((e: Error) => setLinkError(e.message));
              }}
            />
          )}
          {actions.map((action) => (
            <MouseButton
              key={action.label}
              label={action.label}
              onClick={action.onClick}
              disabled={action.disabled ?? false}
            />
          ))}
        </MouseActions>
      )}
      {linkError && (
        <Text color="yellow" wrap="truncate-end">
          {linkError}
        </Text>
      )}
    </Box>
  );
}
