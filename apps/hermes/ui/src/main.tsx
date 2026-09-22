import React from "react";
import { createRoot } from "react-dom/client";
import { Web3Providers } from "./providers/Web3Providers";
import HermesApp from "./HermesApp";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Web3Providers>
      <HermesApp />
    </Web3Providers>
  </React.StrictMode>,
);
