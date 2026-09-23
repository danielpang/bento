import * as Menu from "@radix-ui/react-dropdown-menu";

/**
 * The project switcher in the topbar.
 *
 * A native select rendered the one thing a board is always about as an
 * unlabelled system control, with no room to say which project is
 * current or what else there is. This says "Project" above the name,
 * marks the active row, and keeps creating one in the same menu:
 * switching and creating are the same question, asked from the same
 * place.
 *
 * The menu behaviour is Radix's. The hand rolled version closed on
 * Escape and on a click elsewhere, but declared role="menu" and
 * role="menuitemradio" while implementing none of what those roles
 * promise: no arrow keys, no typeahead, and focus never entered the
 * menu, so a keyboard user was told they had a menu and then handed
 * nothing to drive it with.
 */
export function ProjectPicker({
  projects,
  projectId,
  onSelect,
  onNewProject,
  onOpenProject,
}: {
  projects: { id: string; name: string }[];
  projectId: string | null;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  onOpenProject?: (id: string) => void;
}) {
  const current = projects.find((project) => project.id === projectId);

  return (
    <Menu.Root>
      <div className="picker">
        <Menu.Trigger className="picker-trigger">
          <span className="picker-labels">
            <span className="picker-kicker">Project</span>
            <span className="picker-current">{current?.name ?? "Choose a project"}</span>
          </span>
          <span className="picker-caret" aria-hidden="true" />
        </Menu.Trigger>

        {/* Anchored to the trigger by Radix rather than by the parent's
            position: relative, so the menu is positioned the same way
            whether or not the topbar clips its overflow. */}
        <Menu.Portal>
          <Menu.Content className="picker-menu" align="start" sideOffset={6} data-portal-layer="">
            <Menu.RadioGroup
              className="picker-group"
              value={projectId ?? ""}
              onValueChange={onSelect}
            >
              {projects.map((project) => (
                <Menu.RadioItem key={project.id} value={project.id} className="picker-item">
                  <span className="picker-tick" aria-hidden="true">
                    {project.id === projectId ? "✓" : ""}
                  </span>
                  <span className="picker-item-name">{project.name}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <Menu.Separator className="picker-sep" />
            {onOpenProject && projects.length > 0 && (
              <Menu.Sub>
                <Menu.SubTrigger className="picker-item picker-item-action">
                  <span className="picker-tick" aria-hidden="true">↗</span>
                  <span className="picker-item-name">Open project in new window</span>
                  <span aria-hidden="true">›</span>
                </Menu.SubTrigger>
                <Menu.Portal>
                  <Menu.SubContent className="picker-menu" sideOffset={6} data-portal-layer="" aria-label="Open project in new window">
                    <Menu.Group className="picker-group">
                      {projects.map(project => (
                        <Menu.Item key={project.id} className="picker-item" onSelect={() => onOpenProject(project.id)}>
                          <span className="picker-item-name">{project.name}</span>
                        </Menu.Item>
                      ))}
                    </Menu.Group>
                  </Menu.SubContent>
                </Menu.Portal>
              </Menu.Sub>
            )}
            <Menu.Item className="picker-item picker-item-action" onSelect={onNewProject}>
              <span className="picker-tick" aria-hidden="true">
                +
              </span>
              <span className="picker-item-name">New project</span>
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </div>
    </Menu.Root>
  );
}
