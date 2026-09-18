#!/usr/bin/env bash
# review/reviewcode/backend/check-v1.1-logstore-compat-opencode.sh
# 独立审核探针（reviewagent@realtime_core · v1.1.0 · 2026-09-18）
# 机械核验任务单 §1/§5/§6：兼容门、版本四处一致、契约计数、report.json 证据。
# 只读 code/ 与 git 历史；不改任何被测文件。退出码 0=全过，1=有 FAIL。
set -uo pipefail

BASE=${1:-076d5e13d8110d2339d6a9b64db863b1f9f97bb6}
HEAD=${2:-9e31e1bcc46694d66a8017bb1a1708b40c66eabb}
REPORT=codeagent/backend/docs/report.json
pass=0; fail=0
ok()   { printf '  PASS %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$*"; fail=$((fail+1)); }
note() { printf '  INFO %s\n' "$*"; }

cd "$(git rev-parse --show-toplevel)" || exit 2

echo "=== C1 兼容门：既有测试文件零修改（只允许新增测试文件）==="
mapfile -t modtests < <(git diff --name-status --no-renames "$BASE..$HEAD" | awk '$1 ~ /^[MDR]/ && $2 ~ /\.test\.m?js$/ {print $1" "$2}')
if [ "${#modtests[@]}" -eq 0 ]; then ok "既有 *.test.mjs 无 M/D/R（无任何既有测试文件被改）"; else bad "既有测试文件被改：${modtests[*]}"; fi
mapfile -t newsrc < <(git diff --name-status --no-renames "$BASE..$HEAD" | awk '$1=="A" && $2 ~ /^code\/backend\/src\/.*\.js$/ {print $2}')
note "新增 src 文件：${newsrc[*]:-（无）}"

echo "=== C2 兼容门：既有生产 .js 零修改（签名不变的结构性前提）==="
mapfile -t modsrc < <(git diff --name-status --no-renames "$BASE..$HEAD" | awk '$1 ~ /^[MDR]/ && $2 ~ /^code\/backend\/src\/.*\.js$/ {print $1" "$2}')
if [ "${#modsrc[@]}" -eq 0 ]; then ok "既有 src/*.js 无 M/D/R"; else bad "既有 src 被改：${modsrc[*]}"; fi

echo "=== C3 既有 35 导出签名逐字比对（base 中存在的每个 src 文件）==="
sigfail=0; sigcount=0
while IFS= read -r f; do
  if ! git cat-file -e "$BASE:$f" 2>/dev/null; then continue; fi
  a=$(git show "$BASE:$f" | grep -E '^export' | sed 's/[[:space:]]\+/ /g; s/ $//')
  b=$(grep -E '^export' "$f" | sed 's/[[:space:]]\+/ /g; s/ $//')
  sigcount=$((sigcount+1))
  if [ "$a" != "$b" ]; then bad "导出签名漂移：$f"; sigfail=1; fi
done < <(find code/backend/src -name '*.js' ! -name '*.test.mjs' | sort)
[ "$sigfail" -eq 0 ] && ok "base 中既有 $sigcount 个生产文件的 export 行逐字未变"

echo "=== C4 导出符号总数 = 37（35 既有 + 2 新增）==="
total=$(grep -rh '^export' code/backend/src --include='*.js' | grep -v '\.test\.mjs' | wc -l)
[ "$total" -eq 37 ] && ok "导出总数 $total = 37" || bad "导出总数 $total ≠ 37"

echo "=== C5 版本 1.1.0 四处一致（契约标题 / semver 当前 / 两个 package.json）==="
grep -q '^# realtime_core · 对外接口契约（v1\.1\.0' module_docs/contract.md && ok "contract.md 标题 v1.1.0" || bad "contract.md 标题非 v1.1.0"
grep -q '当前：v1\.1\.0' module_docs/contract.md && ok "contract.md semver『当前：v1.1.0』" || bad "contract.md semver 当前版本非 v1.1.0"
[ "$(jq -r .version package.json)" = "1.1.0" ] && ok "根 package.json version=1.1.0" || bad "根 package.json version≠1.1.0"
[ "$(jq -r .version code/backend/package.json)" = "1.1.0" ] && ok "code/backend/package.json version=1.1.0" || bad "code/backend/package.json version≠1.1.0"

echo "=== C6 契约符号表计数与代码一致（顶层 5 scope · 17 文件 · 37 符号）==="
grep -q '## 公共 API 面（5 scope · 17 文件 · 37 导出符号）' module_docs/contract.md && ok "顶层计数 = 17 文件 · 37 符号" || bad "顶层计数与代码不符"
# 逐 scope 头计数求和必须等于顶层
sumf=0; sums=0
while read -r ff ss; do sumf=$((sumf+ff)); sums=$((sums+ss)); done < <(
  grep -oE '（[0-9]+ 文件 · [0-9]+ 符号）' module_docs/contract.md | sed -E 's/（([0-9]+) 文件 · ([0-9]+) 符号）/\1 \2/')
if [ "$sumf" -eq 17 ] && [ "$sums" -eq 37 ]; then ok "各 scope 头计数求和 = 17 文件 · 37 符号"; else bad "各 scope 头计数求和 = $sumf 文件 · $sums 符号 ≠ 17/37（契约内部自相矛盾）"; fi

echo "=== C7 report.json 证据（changed_files ⊆ base..resolved_head / base / status）==="
# report schema：git.head=SELF + diff_mode=contains ⇒ changed_files 是 base..resolved_head
# 的子集（本 backend 报告不含 arbiter 对 module_docs/contract.md 的提交），
# 不要求与整段 diff 相等。相等断言在轮次间插入他人提交时会误报（第一版探针即此）。
rbase=$(jq -r .git.base "$REPORT")
rcommit=$(git log -1 --format=%H "$HEAD" -- "$REPORT")
[ "$rbase" = "$BASE" ] && ok "git.base=$rbase 正确（PR 目标起点）" || bad "git.base=$rbase ≠ $BASE"
[ "$(jq -r .status "$REPORT")" = "self_checked" ] && ok "status=self_checked" || bad "status≠self_checked"
diffset=$(git -c core.quotePath=false diff --name-only --no-renames "$rbase..$rcommit" | LC_ALL=C sort -u)
claimed=$(jq -r '.git.changed_files[]' "$REPORT" | LC_ALL=C sort -u)
phantom=$(LC_ALL=C comm -23 <(printf '%s\n' "$claimed") <(printf '%s\n' "$diffset"))
if [ -z "$phantom" ]; then
  ok "changed_files 全部落在 base..resolved_head（contains 语义，$(printf '%s\n' "$claimed" | grep -c .) 项，无幻影声明）"
else
  bad "changed_files 含不在 base..resolved_head 的路径：$(printf '%s' "$phantom" | tr '\n' ' ')"
fi
extra=$(LC_ALL=C comm -13 <(printf '%s\n' "$claimed") <(printf '%s\n' "$diffset"))
if [ -n "$extra" ]; then note "diff 中未由本报告声称（他人 scope，contains 允许）：$(printf '%s' "$extra" | tr '\n' ' ')"; fi

echo "=== C8 铁律11 关联文档一致性（版本/计数漂移）==="
for f in package.json code/backend/package.json; do
  if jq -r .description "$f" | grep -q 'v1\.0\.0'; then bad "$f description 仍引用 contract v1.0.0（本单已升 v1.1.0）"; else ok "$f description 无陈旧 v1.0.0"; fi
done
if grep -q 'v1\.0\.0 正式契约：35 导出符号' README.md; then bad "README.md 仍写 v1.0.0 / 35 符号（现 v1.1.0 / 37）"; else ok "README.md 无陈旧契约版本"; fi
if grep -q 'id: realtime-core-kernel@v1\.0\.0' module_docs/contract.md; then bad "contract.md frontmatter id 仍为 @v1.0.0（标题/semver 已 v1.1.0）"; else ok "contract.md frontmatter id 已同步"; fi

echo
echo "=== compat probe: $pass PASS / $fail FAIL ==="
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
