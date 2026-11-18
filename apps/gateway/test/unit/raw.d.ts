// vite の `?raw` import（テストの入力ファイルを文字列として読む）。
declare module "*?raw" {
  const content: string;
  export default content;
}
