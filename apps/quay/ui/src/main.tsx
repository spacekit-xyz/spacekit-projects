import React from "react";
import { createRoot } from "react-dom/client";
import QuayApp from "./QuayApp";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QuayApp />
  </React.StrictMode>
);