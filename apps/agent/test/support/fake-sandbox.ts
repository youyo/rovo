import type { ExecOptions, ExecResult, SandboxPort } from "../../src/sandbox-port";

export type ExecHandler = (
  argv: string[],
  options: ExecOptions,
) => Partial<ExecResult> | Promise<Partial<ExecResult>>;

/** Unit 用の SandboxPort。ファイルはメモリ上、exec は台本（ハンドラ）で応答し、呼び出しを記録する。 */
export class FakeSandbox implements SandboxPort {
  readonly files = new Map<string, string>();
  readonly calls: { argv: string[]; options: ExecOptions }[] = [];

  constructor(private readonly handler: ExecHandler = () => ({})) {}

  async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ argv, options });
    const r = await this.handler(argv, options);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      ...r,
    };
  }

  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}
