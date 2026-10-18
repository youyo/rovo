/**
 * E2E 専用のルート（ENVIRONMENT=test のときだけ有効）。SandboxDO を HTTP から操作する。
 * 例外はメッセージを本文にして 500 で返す。
 */
export async function handleTestRoute(request: Request, env: Env): Promise<Response | undefined> {
  if (env.ENVIRONMENT !== "test" || request.method !== "POST") return undefined;
  const url = new URL(request.url);
  const m = /^\/test\/sandbox\/([a-z-]+)$/.exec(url.pathname);
  if (!m) return undefined;
  const body = (await request.json()) as {
    name: string;
    spec?: never;
    argv?: string[];
    options?: Record<string, unknown>;
    path?: string;
    content?: string;
  };
  const sandbox = env.SANDBOX_DO.getByName(body.name);
  try {
    switch (m[1]) {
      case "ensure-ready":
        await sandbox.ensureReady(body.spec as never);
        return Response.json({ ok: true });
      case "exec":
        return Response.json(await sandbox.exec(body.argv ?? [], body.options));
      case "read-file":
        return Response.json({ content: await sandbox.readFile(body.path ?? "") });
      case "write-file":
        await sandbox.writeFile(body.path ?? "", body.content ?? "");
        return Response.json({ ok: true });
      case "stop":
        return Response.json(await sandbox.stop());
      case "terminate":
        return Response.json(await sandbox.terminate());
      case "destroy":
        await sandbox.destroyForTest();
        return Response.json({ ok: true });
      case "fail-next-reap":
        await sandbox.failNextReapForTest();
        return Response.json({ ok: true });
      case "status":
        return Response.json(await sandbox.status());
      default:
        return undefined;
    }
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
