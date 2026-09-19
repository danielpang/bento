import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal.js";

export interface Command { id: string; label: string; hint?: string; run: () => void }

export function CommandMenu({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const matches = commands.filter((command) => command.label.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const choose = (command: Command) => { onClose(); command.run(); };
  return <Modal title="Find a card or action" onClose={onClose} actions={<span className="command-help">↑ ↓ to navigate · Enter to open · Esc to close</span>}>
    <input ref={input} className="input" type="search" aria-label="Find a card or action" placeholder="Search cards and actions…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); list.current?.querySelector("button")?.focus(); }
      if (event.key === "Enter" && matches[0]) { event.preventDefault(); choose(matches[0]); }
    }} />
    <div className="command-results" ref={list} onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = Array.from(list.current?.querySelectorAll("button") ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowUp" && index === 0) input.current?.focus();
      else buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }}>
      {matches.map((command) => <button className="command-result" key={command.id} onClick={() => choose(command)}><span>{command.label}</span>{command.hint && <kbd>{command.hint}</kbd>}</button>)}
      {matches.length === 0 && <p className="muted" role="status">No matching cards or actions.</p>}
    </div>
  </Modal>;
}
