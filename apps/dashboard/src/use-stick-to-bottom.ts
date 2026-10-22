import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { isNearBottom } from "./scroll";

/**
 * 画面（スクロールする枠）の末尾への追従。
 * 末尾にいる間は、`changeKey` が変わる（新しい行・出力が来た）たびに末尾へ動かす。
 * 利用者が上へスクロールしたら追従を止め（読んでいる位置を動かさない）、末尾まで戻したら再開する。
 */
export function useStickToBottom(changeKey: string) {
  const ref = useRef<HTMLElement | null>(null);
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const near = isNearBottom(el);
    followRef.current = near;
    setFollowing(near);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: changeKey が変わったときに末尾へ動かす
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [changeKey]);

  const jumpToEnd = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    followRef.current = true;
    setFollowing(true);
  }, []);

  return { ref, following, onScroll, jumpToEnd };
}
