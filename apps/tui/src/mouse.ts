import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Box,
  measureElement,
  useInput,
  useIsScreenReaderEnabled,
  useStdin,
  useStdout,
  useWindowSize,
  type DOMElement,
} from "ink";

export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
export type MouseEvent = {
  x: number;
  y: number;
  kind: "click" | "release" | "up" | "down" | "left" | "right";
};
export type MouseTarget = { cardId?: string; laneId?: string };
export type MouseBindings = {
  target: (id: string, target: MouseTarget) => (node: DOMElement | null) => void;
};

/** Ink strips the initial Escape before delivering CSI input. Coordinates are terminal cells, one-based. */
export function parseMouse(input: string): MouseEvent | null {
  const match = /^(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (!match) return null;
  const [button, x, y] = match.slice(1, 4).map(Number) as [number, number, number];
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < 1 || button > 127) return null;
  if (button & (8 | 16 | 32)) return null; // Alt, Ctrl, or motion: never activate a card.
  if (button & 64) {
    if (match[4] !== "M") return null;
    const code = button & 3;
    const horizontal = (button & 4) !== 0 || code >= 2;
    return { x: x - 1, y: y - 1, kind: horizontal ? (code % 2 ? "right" : "left") : code ? "down" : "up" };
  }
  if (button !== 0) return null; // Only an unmodified left click.
  return { x: x - 1, y: y - 1, kind: match[4] === "M" ? "click" : "release" };
}

/** Late mouse releases must not become menu queries or editor text after the board closes. */
export const isMouseInput = (input: string) => /^(?:\x1b)?\[</.test(input);
export function useKeyboardInput(
  handler: Parameters<typeof useInput>[0],
  options?: Parameters<typeof useInput>[1],
) {
  useInput((input, key) => {
    if (!isMouseInput(input)) handler(input, key);
  }, options);
}

export function createClickTracker() {
  let previous: { id: string; x: number; y: number; at: number } | null = null;
  return {
    reset() {
      previous = null;
    },
    click(id: string, event: MouseEvent, now = Date.now()) {
      const double =
        previous?.id === id &&
        now - previous.at <= 400 &&
        Math.abs(previous.x - event.x) <= 1 &&
        Math.abs(previous.y - event.y) <= 1;
      previous = double ? null : { id, x: event.x, y: event.y, at: now };
      return double;
    },
  };
}

export type PointerEvent = MouseEvent & { column: number; row: number; width: number; height: number };
export type MouseHandlers = {
  onClick?: (event: PointerEvent) => void;
  onDoubleClick?: (event: PointerEvent) => void;
  onScroll?: (event: PointerEvent) => void;
  priority?: number;
};
type Target = { node: DOMElement; handlers: MouseHandlers };
const MouseContext = createContext<Map<string, Target> | null>(null);
const MouseSuspension = createContext<() => () => void>(() => () => {});

/** Give inherited terminal applications their own input until they return. */
export const useSuspendMouse = () => useContext(MouseSuspension);

/** One dispatcher chooses the most specific mounted control. Nested controls never both activate. */
export function MouseProvider({ children, enabled }: { children: ReactNode; enabled?: boolean }) {
  const root = useRef<DOMElement | null>(null);
  const targets = useRef(new Map<string, Target>());
  const clicks = useRef(createClickTracker());
  const suspended = useRef(false);
  const lastActivation = useRef<{ id: string; x: number; y: number; at: number } | null>(null);
  const { stdout } = useStdout();
  const { rows } = useWindowSize();
  const { isRawModeSupported } = useStdin();
  const screenReader = useIsScreenReaderEnabled();
  const active =
    enabled ??
    (isRawModeSupported === true &&
      stdout.isTTY === true &&
      !screenReader &&
      !process.env.CI &&
      process.env.TERM !== "dumb");
  useEffect(() => {
    if (!active) return;
    stdout.write(ENABLE_MOUSE);
    const disable = () => {
      if (!stdout.destroyed) stdout.write(DISABLE_MOUSE);
    };
    process.once("exit", disable);
    return () => {
      process.removeListener("exit", disable);
      disable();
    };
  }, [active, stdout]);
  useInput(
    (input) => {
      if (suspended.current) return;
      if (!isMouseInput(input)) {
        clicks.current.reset();
        lastActivation.current = null;
        return;
      }
      const event = parseMouse(input);
      if (!event) {
        clicks.current.reset();
        return;
      }
      if (event.kind === "release" || !root.current) return;
      const rootHeight = measureElement(root.current).height;
      // Ink scrolls overflowing frames upward. Match only the cells still visible on screen.
      const scroll = Math.max(0, rootHeight - rows);
      const hits = [...targets.current.entries()]
        .flatMap(([id, target]) => {
          const rect = measureElement(target.node);
          const y = rect.y - scroll;
          const handles =
            event.kind === "click"
              ? target.handlers.onClick || target.handlers.onDoubleClick
              : target.handlers.onScroll;
          if (
            !handles ||
            event.x < rect.x ||
            event.x >= rect.x + rect.width ||
            event.y < y ||
            event.y >= y + rect.height
          )
            return [];
          return [{ id, target, rect: { ...rect, y } }];
        })
        .sort(
          (a, b) =>
            (b.target.handlers.priority ?? 0) - (a.target.handlers.priority ?? 0) ||
            a.rect.width * a.rect.height - b.rect.width * b.rect.height,
        );
      const hit = hits[0];
      if (!hit) {
        clicks.current.reset();
        return;
      }
      const pointer = {
        ...event,
        column: event.x - hit.rect.x,
        row: event.y - hit.rect.y,
        width: hit.rect.width,
        height: hit.rect.height,
      };
      if (event.kind !== "click") {
        clicks.current.reset();
        lastActivation.current = null;
        hit.target.handlers.onScroll?.(pointer);
        return;
      }
      const last = lastActivation.current;
      // A second press in a double-click must not fall through to a new screen or confirmation.
      if (
        last &&
        last.id !== hit.id &&
        Date.now() - last.at <= 400 &&
        Math.abs(last.x - event.x) <= 1 &&
        Math.abs(last.y - event.y) <= 1
      )
        return;
      lastActivation.current = { id: hit.id, x: event.x, y: event.y, at: Date.now() };
      if (clicks.current.click(hit.id, event) && hit.target.handlers.onDoubleClick)
        hit.target.handlers.onDoubleClick(pointer);
      else hit.target.handlers.onClick?.(pointer);
    },
    { isActive: active },
  );
  const suspend = () => {
    suspended.current = true;
    if (active) stdout.write(DISABLE_MOUSE);
    return () => {
      suspended.current = false;
      clicks.current.reset();
      lastActivation.current = null;
      if (active && !stdout.destroyed) stdout.write(ENABLE_MOUSE);
    };
  };
  return createElement(
    MouseContext.Provider,
    { value: targets.current },
    createElement(
      MouseSuspension.Provider,
      { value: suspend },
      createElement(Box, { ref: root, flexDirection: "column" }, children),
    ),
  );
}

export function useMouseTarget(handlers: MouseHandlers, enabled = true) {
  const targets = useContext(MouseContext);
  const id = useId();
  return (node: DOMElement | null) => {
    if (node && enabled) targets?.set(id, { node, handlers });
    else targets?.delete(id);
  };
}

export function useBoardMouse({
  enabled,
  onSelect,
  onOpen,
  onScroll,
}: {
  enabled: boolean;
  root: RefObject<DOMElement | null>;
  onSelect: (target: MouseTarget) => void;
  onOpen: (target: MouseTarget) => void;
  onScroll: (target: MouseTarget, direction: "up" | "down" | "left" | "right") => void;
}): MouseBindings {
  const targets = useContext(MouseContext);
  const prefix = useId();
  return {
    target: (id, target) => (node) => {
      const key = `${prefix}:${id}`;
      if (!node || !enabled) {
        targets?.delete(key);
        return;
      }
      targets?.set(key, {
        node,
        handlers: {
          priority: target.cardId ? 1 : 0,
          onClick: () => onSelect(target),
          ...(target.cardId ? { onDoubleClick: () => onOpen(target) } : {}),
          onScroll: (event) => {
            if (event.kind !== "click" && event.kind !== "release") onScroll(target, event.kind);
          },
        },
      });
    },
  };
}
