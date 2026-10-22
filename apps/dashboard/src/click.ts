/**
 * 画面の中で切り替えてよいクリックか。修飾キー（Ctrl・Cmd・Shift・Alt）付きと、左以外のボタン（中クリックなど）は
 * ブラウザに任せる（新しいタブ・ウィンドウで開く、ダウンロードなど）。普通の左クリックだけが true。
 */
export function isPlainLeftClick(e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
  );
}
