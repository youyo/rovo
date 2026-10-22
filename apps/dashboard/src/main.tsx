import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
// 書体は npm の @fontsource から同梱する（SIL OFL。vite.config.ts が woff2 だけにする）。使う太さだけ
import "@fontsource/familjen-grotesk/400.css";
import "@fontsource/familjen-grotesk/500.css";
import "@fontsource/familjen-grotesk/600.css";
import "@fontsource/familjen-grotesk/700.css";
import "@fontsource/zen-kaku-gothic-new/400.css";
import "@fontsource/zen-kaku-gothic-new/500.css";
import "@fontsource/zen-kaku-gothic-new/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root が無い");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
