import React from "react";
import { createRoot } from "react-dom/client";
import NotesApp from "./CairnApp";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NotesApp />
  </React.StrictMode>
);