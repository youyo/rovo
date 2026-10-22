// globalSetup が作ったデータ（接続先・ユーザー・タスク）を、環境変数（JSON）経由でテストのワーカーに渡す。

export interface E2eUser {
  id: number;
  login: string;
}

export interface E2eState {
  baseUrl: string;
  githubUrl: string;
  users: { alice: E2eUser; bob: E2eUser };
  /** タスク ID。キーは役割（seed.ts の SEEDED） */
  tasks: Record<string, string>;
  /** テストごとに本文に仕込む目印（権限の無いタスクの題名の断片など） */
  marks: { secretTitle: string; xssTitle: string };
}

export const STATE_ENV = "ROVO_DASHBOARD_E2E_STATE";

export function readState(): E2eState {
  const raw = process.env[STATE_ENV];
  if (!raw) throw new Error(`${STATE_ENV} が無い（globalSetup が走っていない）`);
  return JSON.parse(raw) as E2eState;
}

/** 手順が長いタスク（key: long）に、globalSetup が最初に積むコマンドの数 */
export const LONG_STEPS = 60;
