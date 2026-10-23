import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
// 書体は npm の @fontsource から同梱する（SIL OFL。vite.config.ts が woff2 だけにする）。
// 本文は IBM Plex Sans JP、ログ・コマンド・数字は JetBrains Mono。どちらも 400 と 700 だけ
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root が無い");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
