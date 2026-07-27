import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ToastHost } from "./components/Toasts.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    {/* One host for the whole app: every panel reports failures the
        same way, and none of them rearranges the page to do it. */}
    <ToastHost>
      <App />
    </ToastHost>
  </StrictMode>,
);
