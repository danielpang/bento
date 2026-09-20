import { ipcRenderer } from "electron";

/** Only trusted main frames install desktop chrome. Artifact frames never do. */
export function installWindowChrome(kind: "console" | "launcher") {
  if (!process.isMainFrame || process.platform !== "darwin") return;
  const fullscreen = (value: boolean) => {
    document.documentElement.toggleAttribute("data-desktop-fullscreen", value);
  };
  ipcRenderer.on("desktop:fullscreen", (_event, value: boolean) => fullscreen(value));
  window.addEventListener("DOMContentLoaded", () => {
    const root = document.documentElement;
    root.dataset.desktop = "mac";
    if (kind === "launcher") {
      ipcRenderer.on("desktop:appearance", (_event, theme: string) => { root.dataset.theme = theme; });
      void ipcRenderer.invoke("launcher:appearance").then(state => {
        root.dataset.theme = state.theme;
        fullscreen(state.fullscreen);
      });
      return;
    }
    const dragRegion = document.createElement("div");
    dragRegion.className = "desktop-titlebar";
    dragRegion.setAttribute("aria-hidden", "true");
    document.body.prepend(dragRegion);
    const update = () => {
      const theme = root.dataset.theme;
      if (theme === "light" || theme === "dark" || theme === "navy") {
        // Native window backing follows the renderer without overriding the
        // system's prefers-color-scheme, which the System theme depends on.
        void ipcRenderer.invoke("console:appearance", theme).then(state => fullscreen(state.fullscreen));
      }
    };
    new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    update();
  }, { once: true });
}
