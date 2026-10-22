/**
 * リンクをクリックして、React の onClick が preventDefault したかを返す。
 * jsdom の「遷移（ページの読み直し）」は document で止める（preventDefault の前の値を読んでから止める）。
 */
export function clickLink(el: Element, init: MouseEventInit = {}): boolean {
  let prevented = false;
  const spy = (e: Event) => {
    prevented = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener("click", spy);
  try {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  } finally {
    document.removeEventListener("click", spy);
  }
  return prevented;
}

/** 修飾キー付きと、左以外のボタン（新しいタブで開くなど、ブラウザに任せるクリック） */
export const BROWSER_CLICKS: { name: string; init: MouseEventInit }[] = [
  { name: "Ctrl", init: { ctrlKey: true } },
  { name: "Cmd", init: { metaKey: true } },
  { name: "Shift", init: { shiftKey: true } },
  { name: "Alt", init: { altKey: true } },
  { name: "中クリック", init: { button: 1 } },
];
