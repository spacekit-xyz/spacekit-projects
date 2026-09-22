/**
 * Example entry for the webapp you package as CRM.pkg.
 *
 *   npm run build   →  dist/
 *   spacekit pkg dist --name CRM   →  CRM.pkg  →  publish to marketplace
 *
 * Swap MemoryAdapter for the real bindings exposed by the SpaceKit
 * runtime (e.g. `window.spacekit` in the desktop app / webview host).
 */
import { createRoot } from "react-dom/client";
import { CRM } from "./index";
import { isEmbedHost, resolveAdapter } from "./embedAdapter";

const adapter = resolveAdapter();
const embedded = isEmbedHost();

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <div
      style={{
        height: "100%",
        minHeight: embedded ? undefined : "100vh",
        padding: embedded ? 0 : 16,
        boxSizing: "border-box",
        background: "#05080F",
      }}
    >
      <CRM adapter={adapter} actor="you" embedded={embedded} />
    </div>,
  );
}
