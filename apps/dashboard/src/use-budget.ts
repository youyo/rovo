import type { BudgetMeDto } from "@rovo/dashboard-contract";
import { useEffect, useRef, useState } from "react";
import { fetchBudget } from "./api";

/**
 * 自分の予算を 1 回だけ取る（一覧が届くまでのステータスバー用）。失敗しても何もしない（null のまま）。
 * 一覧が届いたあとは一覧の予算を使うので、取り直さない。
 */
export function useBudget(deps: { fetchImpl?: typeof fetch } = {}): BudgetMeDto | null {
  const [budget, setBudget] = useState<BudgetMeDto | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  useEffect(() => {
    let alive = true;
    void fetchBudget(depsRef.current.fetchImpl).then((r) => {
      if (alive && r.kind === "ok") setBudget(r.data);
    });
    return () => {
      alive = false;
    };
  }, []);
  return budget;
}
