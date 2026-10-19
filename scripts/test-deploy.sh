#!/usr/bin/env bash
# deploy.sh の自己確認。pnpm を偽物に差し替え、実際の wrangler は呼ばない（Cloudflare には触れない）。
#  (a) ROVO_DEPLOY_DIR が未設定・空・存在しない・設定ファイルが無いときは、0 以外で終わり、wrangler を呼ばない
#  (b) 呼ぶときは必ず下流の設定を -c で渡す（upstream の apps/*/wrangler.jsonc は渡さない）
#  (c) all は web → agent → gateway の順。設定が 1 つでも欠けていたら、1 つも実行しない。途中で失敗したら止まる
#  (d) secrets は 4 つの secret put を対話のまま実行し、値を引数に載せない
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$here/deploy.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0

expect() { # expect <名前> <期待> <実際>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "NG   $1 (期待 [$2] / 実際 [$3])"; fail=1; fi
}

# 偽の pnpm: 呼ばれた cwd と引数を記録する。FAKE_FAIL_ON を含む呼び出しは失敗させる
mkdir -p "$work/bin"
cat > "$work/bin/pnpm" <<'F'
#!/usr/bin/env bash
echo "$(basename "$PWD") $*" >> "$FAKE_LOG"
case "$*" in *"${FAKE_FAIL_ON:-__none__}"*) exit 7 ;; esac
exit 0
F
chmod +x "$work/bin/pnpm"

export FAKE_LOG="$work/calls.log"
# 安全確認: PATH の差し替えが効いていて、pnpm が偽物に解決されることを、何かを実行する前に確かめる
resolved="$(PATH="$work/bin:$PATH" command -v pnpm)"
if [ "$resolved" != "$work/bin/pnpm" ]; then
  echo "中止: pnpm が偽物に解決されない（$resolved）。実際の wrangler を呼ぶ恐れがあるので、何も実行しない" >&2
  exit 2
fi
run() { # run <ROVO_DEPLOY_DIR を設定するか: set|unset> <値> <引数...>
  : > "$FAKE_LOG"
  local mode="$1" val="$2"; shift 2
  if [ "$mode" = set ]; then
    ( cd "$work" && ROVO_DEPLOY_DIR="$val" PATH="$work/bin:$PATH" bash "$deploy" "$@" ) >"$work/out.log" 2>&1 </dev/null
  else
    ( cd "$work" && env -u ROVO_DEPLOY_DIR PATH="$work/bin:$PATH" bash "$deploy" "$@" ) >"$work/out.log" 2>&1 </dev/null
  fi
}
calls() { cat "$FAKE_LOG"; }
ncalls() { wc -l < "$FAKE_LOG" | tr -d ' '; }

mkdir -p "$work/full" "$work/partial" "$work/empty"
for n in gateway agent web; do echo '{}' > "$work/full/$n.wrangler.jsonc"; done
echo '{}' > "$work/partial/web.wrangler.jsonc"
echo '{}' > "$work/partial/gateway.wrangler.jsonc"

# (a) 失敗するべき場合: 0 以外で終わり、wrangler を 1 回も呼ばない
for t in web agent gateway all secrets; do
  run unset "" "$t"; rc=$?
  expect "(a1) $t: ROVO_DEPLOY_DIR 未設定は失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
  expect "(a1) $t: 未設定では wrangler を呼ばない" 0 "$(ncalls)"
  run set "" "$t"; rc=$?
  expect "(a2) $t: ROVO_DEPLOY_DIR が空は失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
  expect "(a2) $t: 空では wrangler を呼ばない" 0 "$(ncalls)"
  run set "$work/nonexistent" "$t"; rc=$?
  expect "(a3) $t: 存在しないディレクトリは失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
  expect "(a3) $t: 存在しないディレクトリでは wrangler を呼ばない" 0 "$(ncalls)"
  run set "$work/empty" "$t"; rc=$?
  expect "(a4) $t: 設定ファイルが無いと失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
  expect "(a4) $t: 設定ファイルが無いと wrangler を呼ばない" 0 "$(ncalls)"
done
run set "$work/full" bogus; rc=$?
expect "(a5) 未知の対象は失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
run set "$work/full"; rc=$?
expect "(a6) 対象なしは失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(a5,a6) 未知の対象・対象なしでは wrangler を呼ばない" 0 "$(ncalls)"

# (b) 単体のデプロイ: 下流の設定を -c で渡す。cwd は apps/<name>
run set "$work/full" web; rc=$?
expect "(b1) web: 成功する" 0 "$rc"
expect "(b2) web: apps/web で wrangler deploy -c <下流の設定>" "web exec wrangler deploy -c $work/full/web.wrangler.jsonc" "$(calls)"
run set "$work/full" agent; expect "(b3) agent" "agent exec wrangler deploy -c $work/full/agent.wrangler.jsonc" "$(calls)"
run set "$work/full" gateway; expect "(b4) gateway" "gateway exec wrangler deploy -c $work/full/gateway.wrangler.jsonc" "$(calls)"
# 相対パスは実行したディレクトリからの相対として絶対パスにして渡す
run set "full" web
expect "(b5) 相対パスは絶対パスにして渡す" "web exec wrangler deploy -c $work/full/web.wrangler.jsonc" "$(calls)"
# upstream の wrangler.jsonc を渡していない
if grep -q "apps/.*/wrangler.jsonc" "$FAKE_LOG"; then expect "(b6) upstream の設定を渡さない" ok ng; else expect "(b6) upstream の設定を渡さない" ok ok; fi

# (c) all
run set "$work/full" all; rc=$?
expect "(c1) all: 成功する" 0 "$rc"
expect "(c2) all: web → agent → gateway の順" "web exec wrangler deploy -c $work/full/web.wrangler.jsonc
agent exec wrangler deploy -c $work/full/agent.wrangler.jsonc
gateway exec wrangler deploy -c $work/full/gateway.wrangler.jsonc" "$(calls)"
run set "$work/partial" all; rc=$?
expect "(c3) all: 設定が 1 つ欠けたら失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(c4) all: 設定が 1 つ欠けたら 1 つも実行しない（半端なデプロイをしない）" 0 "$(ncalls)"
grep -q "agent.wrangler.jsonc" "$work/out.log"; expect "(c5) 欠けた設定の名前を表示する" 0 $?
FAKE_FAIL_ON="agent.wrangler" run set "$work/full" all; rc=$?
expect "(c6) all: 途中で失敗したら 0 以外で終わる" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(c7) all: 途中で失敗したら後続を実行しない" "web exec wrangler deploy -c $work/full/web.wrangler.jsonc
agent exec wrangler deploy -c $work/full/agent.wrangler.jsonc" "$(calls)"

# (d) secrets
run set "$work/full" secrets; rc=$?
expect "(d1) secrets: 成功する" 0 "$rc"
expect "(d2) secrets: gateway の 3 つと agent の 1 つを secret put する" "gateway exec wrangler secret put GITHUB_APP_CLIENT_SECRET -c $work/full/gateway.wrangler.jsonc
gateway exec wrangler secret put GITHUB_APP_PRIVATE_KEY -c $work/full/gateway.wrangler.jsonc
gateway exec wrangler secret put TOKEN_ENC_KEY -c $work/full/gateway.wrangler.jsonc
agent exec wrangler secret put TOKEN_ENC_KEY -c $work/full/agent.wrangler.jsonc" "$(calls)"
run set "$work/partial" secrets; rc=$?
expect "(d3) secrets: agent の設定が無いと失敗し、1 つも実行しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"

# (e) プレースホルダ（<...>）が残った設定は、何も実行せずに失敗する
mkdir -p "$work/ph-web" "$work/ph-agent" "$work/ph-gw" "$work/ph-comment" "$work/ph-url"
for d in ph-web ph-agent ph-gw ph-comment ph-url; do
  for n in gateway agent web; do printf '{\n  "name": "x"\n}\n' > "$work/$d/$n.wrangler.jsonc"; done
done
printf '{\n  "vars": {\n    "AI_GATEWAY_ID": "<AI_GATEWAY_ID>"\n  }\n}\n' > "$work/ph-web/web.wrangler.jsonc"
printf '{\n  "vars": {\n    "A": "<YOUR_ID>"\n  }\n}\n' > "$work/ph-agent/agent.wrangler.jsonc"
printf '{\n  "vars": {\n    "A": "<YOUR_ID>"\n  }\n}\n' > "$work/ph-gw/gateway.wrangler.jsonc"
printf '{\n  // <YOUR_ID> を置き換える（コメントは対象外）\n  "name": "x"\n}\n' > "$work/ph-comment/web.wrangler.jsonc"
printf '{\n  "vars": {\n    "U": "https://<YOUR_GATEWAY_HOST>"\n  }\n}\n' > "$work/ph-url/web.wrangler.jsonc"

run set "$work/ph-web" web; rc=$?
expect "(e1) web: プレースホルダが残っていたら失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(e1) web: プレースホルダが残っていたら wrangler を呼ばない" 0 "$(ncalls)"
grep -q "web.wrangler.jsonc:3" "$work/out.log"; expect "(e2) ファイルと行番号を表示する" 0 $?
grep -q "<AI_GATEWAY_ID>" "$work/out.log"; expect "(e3) 残っているプレースホルダを表示する" 0 $?
run set "$work/ph-agent" all; rc=$?
expect "(e4) all: 1 つでも残っていたら失敗し、1 つも実行しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
grep -q "agent.wrangler.jsonc:3" "$work/out.log"; expect "(e5) all: 残っているファイルと行を表示する" 0 $?
run set "$work/ph-gw" secrets; rc=$?
expect "(e6) secrets: 残っていたら失敗し、1 つも実行しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
run set "$work/ph-url" web; rc=$?
expect "(e7) 文字列の途中の <...>（URL）も検出する" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
run set "$work/ph-comment" web; rc=$?
expect "(e8) コメント行の <...> は対象外" "0 1" "$rc $(ncalls)"

# deploy.example/ をそのまま使うと失敗する。<...> を全部置き換えたコピーなら通る
example="$here/../deploy.example"
for t in web agent gateway all secrets; do
  run set "$example" "$t"; rc=$?
  expect "(e9) deploy.example/ のまま $t は失敗し、wrangler を呼ばない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
done
mkdir -p "$work/filled"
for n in gateway agent web; do
  sed -E 's/<[A-Za-z_][A-Za-z0-9_]*>/filled/g' "$example/$n.wrangler.jsonc" > "$work/filled/$n.wrangler.jsonc"
done
run set "$work/filled" all; rc=$?
expect "(e10) 全部置き換えた deploy.example/ のコピーは all が通る" "0 3" "$rc $(ncalls)"
run set "$work/filled" secrets; rc=$?
expect "(e11) 全部置き換えたコピーは secrets も通る" "0 4" "$rc $(ncalls)"

# upstream の apps/*/wrangler.jsonc へのシンボリックリンクは、本番の値が無いので拒否する
mkdir -p "$work/link"
for n in gateway agent; do cp "$work/filled/$n.wrangler.jsonc" "$work/link/$n.wrangler.jsonc"; done
ln -s "$here/../apps/web/wrangler.jsonc" "$work/link/web.wrangler.jsonc"
run set "$work/link" web; rc=$?
expect "(f1) upstream の apps/web/wrangler.jsonc へのリンクは失敗し、wrangler を呼ばない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
run set "$work/link" all; rc=$?
expect "(f2) all: 1 つでも upstream へのリンクなら、1 つも実行しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"

exit "$fail"
