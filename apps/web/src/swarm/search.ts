import type { SwarmTask } from "./types.js";

type SearchNode = Pick<SwarmTask, "id" | "title" | "parentId">;

/** Search the whole plan, not just the nodes its current folds draw. */
export function searchSwarmNodes(nodes: SearchNode[], query: string): {
  matchIds: ReadonlySet<string>;
  revealIds: ReadonlySet<string>;
} {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matchIds = new Set<string>();
  const revealIds = new Set<string>();
  if (terms.length === 0) return { matchIds, revealIds };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const text = `${node.title} ${node.id}`.toLocaleLowerCase();
    if (!terms.every((term) => text.includes(term))) continue;
    matchIds.add(node.id);
    let parentId = node.parentId;
    const seen = new Set([node.id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      revealIds.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  return { matchIds, revealIds };
}
