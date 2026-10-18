/**
 * OAuthProvider が暗号化して保存し、API リクエストごとに ctx.props として渡す認証情報。
 * 識別子だけを持つ。GitHub のトークンは UserDO に暗号化して置き、ここには入れない。
 */
export interface AuthProps extends Record<string, unknown> {
  githubUserId: number;
  login: string;
}

export function isAuthProps(value: unknown): value is AuthProps {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.githubUserId === "number" && typeof v.login === "string";
}
