// wrangler types の生成物（worker-configuration.d.ts）に含まれないものを補う。
// Cloudflare.Env に足すと、Worker の Env と cloudflare:test の env の両方に反映される。
declare namespace Cloudflare {
  interface Env {
    // ---- Worker Secret（wrangler secret put。ローカルは .dev.vars、E2E は --var）----
    /** Installation Token を SandboxDO に暗号化保存する鍵。base64 の 32 バイト（Gateway の TOKEN_ENC_KEY と同じ形） */
    TOKEN_ENC_KEY: string;
  }
}
interface Env {
  TOKEN_ENC_KEY: string;
}
