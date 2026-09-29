/** Hide the old default template caption already saved on existing installs. */
export function visibleTemplateDescription(description: string): string {
  return description === "The planner and worker a swarm uses when nobody has chosen others."
    ? ""
    : description;
}
