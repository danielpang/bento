import { ipcRenderer } from "electron";
import type { DesktopUpdateNotice } from "./contracts.js";

/** Lives in the isolated preload, in trusted main frames only. */
export function installUpdateToast(kind: "launcher" | "console") {
  window.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = `
      #bento-update-toast { position: fixed; left: 16px; bottom: 16px; z-index: 60;
        max-width: min(420px, calc(100vw - 32px)); box-sizing: border-box;
        display: flex; align-items: center; gap: 10px; padding: 12px;
        border: 1px solid var(--line-bright, var(--line)); border-left: 3px solid var(--brand, var(--accent));
        border-radius: var(--radius, 8px); background: var(--panel-raised, var(--panel));
        color: var(--text, inherit); box-shadow: 0 6px 20px #0003; font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
        -webkit-app-region: no-drag; }
      #bento-update-toast[hidden] { display: none; }
      #bento-update-toast .update-message { flex: 1; min-width: 0; }
      #bento-update-toast button { flex: none; font: inherit; cursor: pointer; }
      #bento-update-toast .update-action { border: 1px solid var(--line-bright, var(--line)); border-radius: 5px;
        color: inherit; background: var(--panel); padding: 5px 9px; }
      #bento-update-toast .update-dismiss { border: 0; padding: 2px; background: none; color: inherit; font-size: 18px; line-height: 1; }
      #bento-update-toast button:focus-visible { outline: 2px solid var(--brand, var(--accent)); outline-offset: 3px; }
      #bento-update-toast button:disabled { cursor: wait; opacity: .6; }
      :root[data-desktop] .toasts { bottom: calc(16px + var(--desktop-update-toast-space, 0px)); }
    `;
    document.head.append(style);
    const toast = document.createElement("div");
    toast.id = "bento-update-toast";
    toast.hidden = true;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    const message = document.createElement("span");
    message.className = "update-message";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "update-action";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "update-dismiss";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "Dismiss update notification");
    toast.append(message, action, dismiss);
    document.body.append(toast);
    let current: DesktopUpdateNotice | null = null;
    let working = false;
    const reserveSpace = () => document.documentElement.style.setProperty("--desktop-update-toast-space", `${toast.hidden ? 0 : toast.getBoundingClientRect().height + 8}px`);
    new ResizeObserver(reserveSpace).observe(toast);
    const render = (notice: DesktopUpdateNotice | null) => {
      current = notice;
      toast.hidden = notice === null;
      if (notice) {
        message.textContent = `Bento ${notice.version} ${notice.action === "download" ? "is available." : "is ready to install."}`;
        action.textContent = notice.action === "download" ? "Download update" : "Restart and update";
        action.disabled = working || notice.busy;
      }
      reserveSpace();
    };
    action.addEventListener("click", () => {
      if (working || !current || current.busy) return;
      working = true;
      render(current);
      void ipcRenderer.invoke(`${kind}:update`).catch(() => {
        message.textContent = "Could not start the update. Please try again.";
      }).finally(() => { working = false; action.disabled = current?.busy ?? false; });
    });
    dismiss.addEventListener("click", () => { void ipcRenderer.invoke(`${kind}:dismiss-update`).catch(() => {}); });
    let received = false;
    ipcRenderer.on("desktop:update", (_event, notice: DesktopUpdateNotice | null) => { received = true; render(notice); });
    void ipcRenderer.invoke(`${kind}:update-status`).then(notice => { if (!received) render(notice); }).catch(() => {});
  }, { once: true });
}
