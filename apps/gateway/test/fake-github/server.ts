import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type FakeAppOptions, FakeGitHubApp, type FakeUser } from "../support/fake-github-app";

/**
 * E2E 用の偽 GitHub（GitHub App のユーザー認可 + 必要な REST API だけ）。
 * `startFakeGitHub()` で起動し、`stop()` で止める。テストからは `admin`（プロセス内）か
 * `POST {url}/__admin/<command>`（HTTP）で状態を操作する。
 */

export type TeamState = "active" | "pending" | "none";
export type FaultTarget = "api" | "token" | "cloudflare";

/** 偽の Cloudflare API（List provider keys。D10b）が受け付ける Bearer トークン（実在のトークンではない） */
export const FAKE_CLOUDFLARE_TOKEN = "e2e-cloudflare-token";

export type FakeProviderKey = { provider_slug: string; alias: string };

export interface FakeRepository {
  id: number;
  fullName: string;
  push: boolean;
  /** 指定すると、このログイン名のユーザーにだけ見える（/user/installations/:id/repositories と push 権限）。省略は全員に見える */
  visibleTo?: string[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, string> | null;
}

export interface FakeGitHubOptions {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  /** GitHub App 自身の API（JWT / Installation Token / Git Data / Pulls）を有効にする */
  app?: Pick<FakeAppOptions, "appId" | "publicKeyPem" | "storeFor">;
}

interface Config {
  /** null で期限なし（refresh token も発行しない） */
  accessTokenTtlSeconds: number | null;
  /** null で refresh token の期限なし */
  refreshTokenTtlSeconds: number | null;
}

interface AccessRecord {
  login: string;
  expiresAt: number | null;
  expired: boolean;
}
interface RefreshRecord {
  login: string;
  access: string;
  expiresAt: number | null;
  revoked: boolean;
}
interface Fault {
  status: number;
  remaining: number;
}

const DEFAULT_CONFIG: Config = {
  accessTokenTtlSeconds: 28800,
  refreshTokenTtlSeconds: 15811200,
};

function rand(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("hex")}`;
}

class State {
  config: Config = { ...DEFAULT_CONFIG };
  users = new Map<string, { id: number; login: string }>();
  currentUser: string | null = null;
  teams = new Map<string, TeamState>();
  installations = new Map<number, FakeRepository[]>();
  codes = new Map<string, string>();
  access = new Map<string, AccessRecord>();
  refresh = new Map<string, RefreshRecord>();
  faults: Record<FaultTarget, Fault | null> = { api: null, token: null, cloudflare: null };
  /** AI Gateway に BYOK 登録されたプロバイダーキー（List provider keys の応答）。既定は Anthropic と OpenAI の default */
  providerKeys: FakeProviderKey[] = [
    { provider_slug: "anthropic", alias: "default" },
    { provider_slug: "openai", alias: "default" },
  ];
  log: RecordedRequest[] = [];
}

export function createAdmin(
  getState: () => State,
  reset: () => void,
  getApp: () => FakeGitHubApp | undefined = () => undefined,
) {
  return {
    reset,
    addUser(user: { id: number; login: string }) {
      const s = getState();
      s.users.set(user.login, user);
      s.currentUser = user.login;
    },
    setCurrentUser(login: string) {
      getState().currentUser = login;
    },
    setTeamMembership(org: string, team: string, login: string, state: TeamState) {
      const key = `${org}/${team}/${login}`;
      if (state === "none") getState().teams.delete(key);
      else getState().teams.set(key, state);
    },
    setInstallation(inst: { id: number; repositories: FakeRepository[] }) {
      getState().installations.set(inst.id, inst.repositories);
      // App の API（Installation Token / Git Data）でも同じリポジトリが見えるようにする
      for (const r of inst.repositories) {
        getApp()?.seedRepo({ id: r.id, fullName: r.fullName, installationId: inst.id });
      }
    },
    removeInstallation(id: number) {
      getState().installations.delete(id);
    },
    /** 発行済みの access token をすべて期限切れ（401）にする */
    expireAccessTokens() {
      for (const rec of getState().access.values()) rec.expired = true;
    },
    /** 発行済みの refresh token をすべて失効（bad_refresh_token）にする */
    revokeRefreshTokens() {
      for (const rec of getState().refresh.values()) rec.revoked = true;
    },
    /** status=null で解除。count 省略で解除するまで続く */
    setFault(target: FaultTarget, status: number | null, count?: number) {
      getState().faults[target] =
        status === null ? null : { status, remaining: count ?? Number.POSITIVE_INFINITY };
    },
    setProviderKeys(keys: FakeProviderKey[]) {
      getState().providerKeys = keys;
    },
    setConfig(config: Partial<Config>) {
      Object.assign(getState().config, config);
    },
    requests(): RecordedRequest[] {
      return [...getState().log];
    },
  };
}
export type FakeGitHubAdmin = ReturnType<typeof createAdmin>;

export interface FakeGitHub {
  url: string;
  port: number;
  clientId: string;
  clientSecret: string;
  admin: FakeGitHubAdmin;
  /** options.app を渡したときだけ有効。偽 GitHub の App API の状態を直接操作・確認できる */
  app: FakeGitHubApp | undefined;
  stop(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Record<string, string> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return null;
  const ct = req.headers["content-type"] ?? "";
  try {
    if (ct.includes("json")) return JSON.parse(text) as Record<string, string>;
    return Object.fromEntries(new URLSearchParams(text));
  } catch {
    return null;
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeGitHub(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const clientId = options.clientId ?? "fake-client-id";
  const clientSecret = options.clientSecret ?? "fake-client-secret";
  let state = new State();
  const app = options.app ? new FakeGitHubApp(options.app) : undefined;
  const admin = createAdmin(
    () => state,
    () => {
      state = new State();
      app?.reset();
    },
    () => app,
  );

  const takeFault = (target: FaultTarget): Fault | null => {
    const f = state.faults[target];
    if (!f) return null;
    f.remaining -= 1;
    if (f.remaining <= 0) state.faults[target] = null;
    return f;
  };

  const faultResponse = (res: ServerResponse, f: Fault) => {
    const headers: Record<string, string> = f.status === 429 ? { "retry-after": "1" } : {};
    sendJson(res, f.status, { message: "injected fault" }, headers);
  };

  function handleAdmin(command: string, body: Record<string, unknown>, res: ServerResponse) {
    switch (command) {
      case "reset":
        admin.reset();
        break;
      case "users":
        admin.addUser({ id: Number(body.id), login: String(body.login) });
        break;
      case "current-user":
        admin.setCurrentUser(String(body.login));
        break;
      case "teams":
        admin.setTeamMembership(
          String(body.org),
          String(body.team),
          String(body.login),
          body.state as TeamState,
        );
        break;
      case "installations":
        admin.setInstallation({
          id: Number(body.id),
          repositories: (body.repositories ?? []) as FakeRepository[],
        });
        break;
      case "expire-access-tokens":
        admin.expireAccessTokens();
        break;
      case "revoke-refresh-tokens":
        admin.revokeRefreshTokens();
        break;
      case "fault":
        admin.setFault(
          body.target as FaultTarget,
          (body.status ?? null) as number | null,
          body.count === undefined ? undefined : Number(body.count),
        );
        break;
      case "provider-keys":
        admin.setProviderKeys((body.keys ?? []) as FakeProviderKey[]);
        break;
      case "config":
        admin.setConfig(body as Partial<Config>);
        break;
      case "requests":
        sendJson(res, 200, { requests: admin.requests() });
        return;
      case "app": {
        // App API の管理: {method, args} で FakeGitHubApp のメソッドを呼ぶ（HTTP 越しの E2E 用）
        const target = app as unknown as Record<string, (...a: unknown[]) => unknown> | undefined;
        const fn = target?.[String(body.method)];
        if (!target || typeof fn !== "function" || String(body.method).startsWith("handle")) {
          sendJson(res, 400, { message: "unknown app admin method" });
          return;
        }
        Promise.resolve(fn.apply(target, (body.args ?? []) as unknown[])).then(
          (result) => sendJson(res, 200, { ok: true, result: result ?? null }),
          (e) => sendJson(res, 500, { message: String(e) }),
        );
        return;
      }
      default:
        sendJson(res, 404, { message: `unknown admin command: ${command}` });
        return;
    }
    sendJson(res, 200, { ok: true });
  }

  function authorize(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    if (q.get("client_id") !== clientId) {
      sendJson(res, 400, { message: "unknown client_id" });
      return;
    }
    const redirectUri = q.get("redirect_uri");
    if (!redirectUri) {
      sendJson(res, 400, { message: "redirect_uri required" });
      return;
    }
    const login = q.get("login") ?? state.currentUser;
    if (!login || !state.users.has(login)) {
      sendJson(res, 400, { message: "no such fake user" });
      return;
    }
    const code = rand("code");
    state.codes.set(code, login);
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    const st = q.get("state");
    if (st !== null) back.searchParams.set("state", st);
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  function issue(login: string, wantJson: boolean, res: ServerResponse) {
    const { accessTokenTtlSeconds: at, refreshTokenTtlSeconds: rt } = state.config;
    const access = rand("ghu");
    const now = Date.now();
    state.access.set(access, {
      login,
      expiresAt: at === null ? null : now + at * 1000,
      expired: false,
    });
    const out: Record<string, string | number> = {
      access_token: access,
      token_type: "bearer",
      scope: "",
    };
    if (at !== null) {
      const refresh = rand("ghr");
      state.refresh.set(refresh, {
        login,
        access,
        expiresAt: rt === null ? null : now + rt * 1000,
        revoked: false,
      });
      out.expires_in = at;
      out.refresh_token = refresh;
      if (rt !== null) out.refresh_token_expires_in = rt;
    }
    respondOAuth(res, wantJson, out);
  }

  function respondOAuth(
    res: ServerResponse,
    wantJson: boolean,
    body: Record<string, string | number>,
  ) {
    if (wantJson) return sendJson(res, 200, body);
    const form = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
    res.writeHead(200, { "content-type": "application/x-www-form-urlencoded" });
    res.end(form.toString());
  }

  function tokenEndpoint(
    body: Record<string, string> | null,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const wantJson = (req.headers.accept ?? "").includes("json");
    const b = body ?? {};
    const err = (error: string) => respondOAuth(res, wantJson, { error, error_description: error });
    if (b.client_id !== clientId || b.client_secret !== clientSecret) {
      return err("incorrect_client_credentials");
    }
    if (b.grant_type === "refresh_token") {
      const rec = b.refresh_token ? state.refresh.get(b.refresh_token) : undefined;
      if (!rec || rec.revoked || (rec.expiresAt !== null && rec.expiresAt <= Date.now())) {
        return err("bad_refresh_token");
      }
      // トークンを入れ替え、旧 access / 旧 refresh を無効にする
      state.refresh.delete(b.refresh_token as string);
      state.access.delete(rec.access);
      return issue(rec.login, wantJson, res);
    }
    const login = b.code ? state.codes.get(b.code) : undefined;
    if (!login) return err("bad_verification_code");
    state.codes.delete(b.code as string);
    return issue(login, wantJson, res);
  }

  function bearer(req: IncomingMessage): AccessRecord | null {
    const h = req.headers.authorization ?? "";
    const m = /^(?:Bearer|token)\s+(.+)$/i.exec(h);
    if (!m?.[1]) return null;
    const rec = state.access.get(m[1]);
    if (!rec || rec.expired) return null;
    if (rec.expiresAt !== null && rec.expiresAt <= Date.now()) return null;
    return rec;
  }

  /**
   * 利用者のトークン（OAuth で発行した ghu_）での呼び出しなら、その人を返す。Installation Token や無効なトークンは undefined。
   * App の API は、これを渡されたときだけ利用者のトークンとして扱う（Installation のリポジトリに push 権限があるものだけ見える）。
   */
  function userFor(req: IncomingMessage): FakeUser | undefined {
    const who = bearer(req);
    if (!who) return undefined;
    return {
      login: who.login,
      canPush: (fullName) =>
        [...state.installations.values()].some((repos) =>
          repos.some(
            (r) =>
              r.push &&
              r.fullName.toLowerCase() === fullName.toLowerCase() &&
              (r.visibleTo === undefined || r.visibleTo.includes(who.login)),
          ),
        ),
    };
  }

  function paginate<T>(items: T[], url: URL, req: IncomingMessage) {
    const perPage = Math.min(
      Math.max(Number(url.searchParams.get("per_page") ?? 30) || 30, 1),
      100,
    );
    const page = Math.max(Number(url.searchParams.get("page") ?? 1) || 1, 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < items.length) {
      const next = new URL(url.pathname, `http://${req.headers.host}`);
      next.searchParams.set("per_page", String(perPage));
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next.toString()}>; rel="next"`;
    }
    return { slice, headers };
  }

  /** 偽の Cloudflare API: GET /client/v4/accounts/:a/ai-gateway/gateways/:g/provider_configs（page / per_page） */
  function providerConfigs(url: URL, req: IncomingMessage, res: ServerResponse) {
    const fault = takeFault("cloudflare");
    if (fault) return faultResponse(res, fault);
    if (req.headers.authorization !== `Bearer ${FAKE_CLOUDFLARE_TOKEN}`) {
      return sendJson(res, 401, { success: false, errors: [{ code: 10000 }], result: null });
    }
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const perPage = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("per_page") ?? 20) || 20),
    );
    const result = state.providerKeys.slice((page - 1) * perPage, page * perPage).map((k) => ({
      id: `cfg_${k.provider_slug}_${k.alias}`,
      alias: k.alias,
      default_config: k.alias === "default",
      gateway_id: "gw",
      modified_at: "2026-10-20T00:00:00Z",
      provider_slug: k.provider_slug,
      secret_id: "secret",
      secret_preview: "sk-…FAKE",
    }));
    return sendJson(res, 200, { success: true, result });
  }

  function api(url: URL, req: IncomingMessage, res: ServerResponse) {
    const fault = takeFault("api");
    if (fault) return faultResponse(res, fault);
    const who = bearer(req);
    if (!who) return sendJson(res, 401, { message: "Bad credentials" });
    const user = state.users.get(who.login);
    if (!user) return sendJson(res, 401, { message: "Bad credentials" });
    const path = url.pathname;

    if (path === "/user") return sendJson(res, 200, { id: user.id, login: user.login });

    let m = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/memberships\/([^/]+)$/.exec(path);
    if (m) {
      const [org, team, login] = [m[1], m[2], m[3]].map((x) => decodeURIComponent(x as string));
      const st = state.teams.get(`${org}/${team}/${login}`);
      if (!st) return sendJson(res, 404, { message: "Not Found" });
      return sendJson(res, 200, { state: st, role: "member" });
    }

    if (path === "/user/installations") {
      const all = [...state.installations.keys()].map((id) => ({ id, app_id: 1 }));
      const { slice, headers } = paginate(all, url, req);
      return sendJson(res, 200, { total_count: all.length, installations: slice }, headers);
    }

    m = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
    if (m) {
      const all = state.installations.get(Number(m[1]));
      if (!all) return sendJson(res, 404, { message: "Not Found" });
      // visibleTo を持つリポジトリは、そのユーザーにだけ見える
      const repos = all.filter(
        (r) => r.visibleTo === undefined || r.visibleTo.includes(user.login),
      );
      const { slice, headers } = paginate(repos, url, req);
      return sendJson(
        res,
        200,
        {
          total_count: repos.length,
          repository_selection: "selected",
          repositories: slice.map((r) => {
            const [owner, name] = r.fullName.split("/");
            return {
              id: r.id,
              name,
              full_name: r.fullName,
              owner: { login: owner },
              permissions: { admin: false, push: r.push, pull: true },
            };
          }),
        },
        headers,
      );
    }

    return sendJson(res, 404, { message: "Not Found" });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (app && /^\/(app\/|repos\/|installation\/|graphql$)/.test(url.pathname)) {
      // GitHub App の API は FakeGitHubApp（Request -> Response）に任せる
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      try {
        const r = await app.handle(
          new Request(url, {
            method,
            headers,
            ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
          }),
          userFor(req),
        );
        const out = r ?? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(Buffer.from(await out.arrayBuffer()));
      } catch (e) {
        sendJson(res, 500, { message: String(e) });
      }
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : null;
    const isAdmin = url.pathname.startsWith("/__admin/");
    if (!isAdmin) {
      state.log.push({
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
      });
    }
    try {
      if (isAdmin) return handleAdmin(url.pathname.slice("/__admin/".length), body ?? {}, res);
      if (req.method === "GET" && url.pathname === "/login/oauth/authorize") {
        return authorize(url, res);
      }
      if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
        const fault = takeFault("token");
        if (fault) return faultResponse(res, fault);
        return tokenEndpoint(body, req, res);
      }
      if (
        req.method === "GET" &&
        /^\/client\/v4\/accounts\/[^/]+\/ai-gateway\/gateways\/[^/]+\/provider_configs$/.test(
          url.pathname,
        )
      ) {
        return providerConfigs(url, req, res);
      }
      if (req.method === "GET") return api(url, req, res);
      return sendJson(res, 404, { message: "Not Found" });
    } catch (e) {
      sendJson(res, 500, { message: String(e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    clientId,
    clientSecret,
    admin,
    app,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
