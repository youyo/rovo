// docs/assets/brand/social-preview.svg を 1280x640 の PNG に書き出す（mise run docs:social-preview）。
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const svg = fileURLToPath(
  new URL("../../../docs/assets/brand/social-preview.svg", import.meta.url),
);
const png = fileURLToPath(
  new URL("../../../docs/assets/brand/social-preview.png", import.meta.url),
);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${svg}`);
  await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 1280, height: 640 } });
} finally {
  await browser.close();
}
