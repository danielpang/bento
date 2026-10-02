import * as Menu from "@radix-ui/react-dropdown-menu";
import { CompletionRing } from "./CompletionRing.js";
import { TabScroll } from "./TabScroll.js";
import { swarmTone, swarmWords } from "../swarm/status.js";
import type { SwarmSummary } from "../swarm/types.js";

/**
 * A project's swarms, as a strip of tabs.
 *
 * Ordered by creation with the newest last, which is where the eye
 * goes and where `New swarm` sits, so starting one and then finding
 * it are the same place. Each tab carries the three things worth
 * knowing without opening it: what it is called, how far along it is,
 * and whether it is moving.
 *
 * The ring here is the root ring of the tree inside, computed by the
 * same module the page uses. That is what makes a leaf finishing
 * visible from the strip.
 */
export function SwarmStrip({
  swarms,
  selectedId,
  completionFor,
  onSelect,
  onNew,
  onRestore,
}: {
  swarms: SwarmSummary[];
  selectedId: string | null;
  /**
   * The open swarm's completion, as the page computed it. The list
   * endpoint sends its own for every other tab; this keeps the tab
   * and the header of the swarm you are actually looking at from
   * disagreeing by a poll.
   */
  completionFor?: (swarm: SwarmSummary) => number;
  onSelect: (swarmId: string) => void;
  onNew: () => void;
  onRestore: (swarmId: string) => void;
}) {
  const ordered = [...swarms].sort(byCreation);
  const live = ordered.filter((swarm) => swarm.archivedAt === null);
  const archived = ordered.filter((swarm) => swarm.archivedAt !== null);

  return (
    /*
     * Navigation, not a tab panel: the strip holds an overflow menu
     * and a New swarm button alongside the swarms, and a tablist
     * promising `role="tab"` for those would be describing controls
     * that are not tabs. Marked the way the topbar marks the page you
     * are on.
     */
    <nav className="swarm-strip" aria-label="Swarms">
      <TabScroll active={selectedId ?? undefined}>
        <div className="tab-row">
          {live.map((swarm) => (
            <SwarmTab
              key={swarm.id}
              swarm={swarm}
              selected={swarm.id === selectedId}
              completion={completionFor?.(swarm) ?? swarm.completion}
              onSelect={onSelect}
            />
          ))}
          {/* An archived swarm opened by a link keeps its place in the
              strip while it is open, rather than the strip claiming
              nothing is selected. */}
          {archived
            .filter((swarm) => swarm.id === selectedId)
            .map((swarm) => (
              <SwarmTab
                key={swarm.id}
                swarm={swarm}
                selected
                archived
                completion={completionFor?.(swarm) ?? swarm.completion}
                onSelect={onSelect}
              />
            ))}
          {archived.length > 0 && (
            <ArchivedMenu
              archived={archived}
              onSelect={onSelect}
              onRestore={onRestore}
            />
          )}
          <button type="button" className="tab swarm-tab-new" onClick={onNew}>
            New swarm
          </button>
        </div>
      </TabScroll>
    </nav>
  );
}

function byCreation(a: SwarmSummary, b: SwarmSummary): number {
  const left = new Date(a.createdAt).getTime();
  const right = new Date(b.createdAt).getTime();
  if (left !== right) return left - right;
  return a.id.localeCompare(b.id);
}

function SwarmTab({
  swarm,
  selected,
  archived,
  completion,
  onSelect,
}: {
  swarm: SwarmSummary;
  selected: boolean;
  archived?: boolean;
  completion: number;
  onSelect: (swarmId: string) => void;
}) {
  return (
    <button
      type="button"
      className={selected ? "tab tab-on swarm-tab" : "tab swarm-tab"}
      data-tab={swarm.id}
      aria-current={selected ? "page" : undefined}
      data-archived={archived ? "" : undefined}
      onClick={() => onSelect(swarm.id)}
      title={`${swarm.name}, ${swarmWords(swarm.status)}`}
    >
      <CompletionRing fraction={completion} size={14} stroke={2.5} tone={selected ? "brand" : "muted"} />
      <span className="swarm-tab-name">{swarm.name}</span>
      <span className="dot" data-state={swarmTone(swarm.status)} aria-hidden="true" />
      <span className="visually-hidden">{swarmWords(swarm.status)}</span>
    </button>
  );
}

/**
 * Archived swarms, folded away at the end.
 *
 * They are not deleted and they are not gone: a finished swarm is
 * something people come back to for its report and its pull request.
 * A menu keeps the strip about the work in front of you while leaving
 * every one of them one click away, with restoring in the same place.
 */
function ArchivedMenu({
  archived,
  onSelect,
  onRestore,
}: {
  archived: SwarmSummary[];
  onSelect: (swarmId: string) => void;
  onRestore: (swarmId: string) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="tab swarm-tab-archived">
        Archived
        <span className="swarm-tab-count">{archived.length}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="picker-menu" align="end" sideOffset={6} data-portal-layer="">
          {archived.map((swarm) => (
            <Menu.Item
              key={swarm.id}
              className="picker-item swarm-archived-item"
              onSelect={() => onSelect(swarm.id)}
            >
              <CompletionRing fraction={swarm.completion} size={13} stroke={2.5} tone="muted" />
              <span className="picker-item-name">{swarm.name}</span>
              <button
                type="button"
                className="btn btn-ghost swarm-restore"
                onClick={(e) => {
                  // The row opens the swarm; the button puts it back on
                  // the strip. Two actions in a row, so the smaller one
                  // has to say the click stops here.
                  e.preventDefault();
                  e.stopPropagation();
                  onRestore(swarm.id);
                }}
              >
                Restore
              </button>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
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
        New swarm
      </button>
    </div>
  );
}
