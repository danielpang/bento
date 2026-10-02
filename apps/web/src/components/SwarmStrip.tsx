import * as Menu from "@radix-ui/react-dropdown-menu";
import { CompletionRing } from "./CompletionRing.js";
import { swarmTone, swarmWords } from "../swarm/status.js";
import type { SwarmSummary } from "../swarm/types.js";

/**
 * A project's swarms in one switcher.
 *
 * The selected swarm keeps its completion ring in the trigger. The
 * menu puts creation first, then recent swarms and archived swarms.
 * Radix handles keyboard navigation, focus, and dismissing the menu.
 */
export function SwarmStrip({
  swarms,
  selectedId,
  completionFor,
  onSelect,
  onNew,
}: {
  swarms: SwarmSummary[];
  selectedId: string | null;
  /**
   * The open swarm's completion, as the page computed it. The list
   * endpoint sends its own for every other item; this keeps the switcher
   * and the header of the swarm you are actually looking at from
   * disagreeing by a poll.
   */
  completionFor?: (swarm: SwarmSummary) => number;
  onSelect: (swarmId: string) => void;
  onNew: () => void;
}) {
  const ordered = [...swarms].sort((a, b) => byCreation(b, a));
  const live = ordered.filter((swarm) => swarm.archivedAt === null);
  const archived = ordered.filter((swarm) => swarm.archivedAt !== null);
  const current = swarms.find((swarm) => swarm.id === selectedId);

  return (
    <div className="swarm-switcher">
      <Menu.Root>
        <Menu.Trigger className="swarm-switcher-trigger" aria-label={current ? `Switch swarm, current: ${current.name}` : "Choose a swarm"}>
          {current ? (
            <CompletionRing
              fraction={completionFor?.(current) ?? current.completion}
              size={16}
              stroke={2.5}
              tone={swarmTone(current.status)}
            />
          ) : (
            <span className="swarm-switcher-empty" aria-hidden="true" />
          )}
          <span className="swarm-switcher-name">{current?.name ?? "Choose a swarm"}</span>
          <span className="swarm-switcher-caret" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="picker-menu swarm-switcher-menu" align="start" sideOffset={6} data-portal-layer="">
            <Menu.Item className="picker-item swarm-switcher-create" onSelect={onNew}>
              <span className="swarm-switcher-plus" aria-hidden="true">+</span>
              <span className="picker-item-name">Create swarm</span>
            </Menu.Item>
            {swarms.length > 0 && <Menu.Separator className="picker-sep" />}
            {live.length > 0 && (
              <Menu.RadioGroup className="picker-group" value={selectedId ?? ""} onValueChange={onSelect}>
                <Menu.Label className="swarm-switcher-label">Swarms</Menu.Label>
                {live.map((swarm) => (
                  <SwarmItem key={swarm.id} swarm={swarm} completion={completionFor?.(swarm) ?? swarm.completion} />
                ))}
              </Menu.RadioGroup>
            )}
            {archived.length > 0 && (
              <>
                {live.length > 0 && <Menu.Separator className="picker-sep" />}
                <Menu.RadioGroup className="picker-group" value={selectedId ?? ""} onValueChange={onSelect}>
                  <Menu.Label className="swarm-switcher-label">Archived</Menu.Label>
                  {archived.map((swarm) => (
                    <SwarmItem key={swarm.id} swarm={swarm} completion={completionFor?.(swarm) ?? swarm.completion} />
                  ))}
                </Menu.RadioGroup>
              </>
            )}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

function byCreation(a: SwarmSummary, b: SwarmSummary): number {
  const left = new Date(a.createdAt).getTime();
  const right = new Date(b.createdAt).getTime();
  if (left !== right) return left - right;
  return a.id.localeCompare(b.id);
}

function SwarmItem({
  swarm,
  completion,
}: {
  swarm: SwarmSummary;
  completion: number;
}) {
  return (
    <Menu.RadioItem
      value={swarm.id}
      className="picker-item swarm-switcher-item"
      data-archived={swarm.archivedAt ? "" : undefined}
      title={`${swarm.name}, ${swarmWords(swarm.status)}`}
    >
      <CompletionRing fraction={completion} size={14} stroke={2.5} tone={swarmTone(swarm.status)} />
      <span className="picker-item-name">{swarm.name}</span>
      <span className="visually-hidden">{swarmWords(swarm.status)}</span>
      <span className="swarm-switcher-check" aria-hidden="true">✓</span>
    </Menu.RadioItem>
  );
}

/**
 * A project with no swarms yet.
 *
 * One action, because there is exactly one thing to do here, and the
 * sentence above it says what a swarm is rather than assuming the
 * word already means something.
 */
export function SwarmEmpty({ onNew }: { onNew: () => void }) {
  return (
    <div className="empty-state">
      <p className="muted">
        No swarms yet. A swarm takes one goal, splits it into a tree of tasks, and works them in
        parallel.
      </p>
      <button className="btn btn-primary" onClick={onNew}>
        Create swarm
      </button>
    </div>
  );
}
