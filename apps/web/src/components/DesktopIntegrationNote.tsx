import { desktop } from "../desktop.js";

export function DesktopIntegrationNote() {
  return desktop ? <p className="muted">Authorization opens Settings in your browser. Connect there, then return to Bento. For a shared server, choose the same team in the browser.</p> : null;
}
