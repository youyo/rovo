import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
// 書体は npm の @fontsource から同梱する（SIL OFL。vite.config.ts が woff2 だけにする）。全体で M PLUS 1 Code の 400 と 700 だけ
import "@fontsource/m-plus-1-code/400.css";
import "@fontsource/m-plus-1-code/700.css";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root が無い");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
