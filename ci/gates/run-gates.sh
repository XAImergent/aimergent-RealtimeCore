#!/usr/bin/env bash
# 项目级确定性门禁：任何模块 CI 都跑这一套（零 LLM，纯脚本）。
# 只扫描 Git 已跟踪文件，避免本地 node_modules、缓存与构建物造成假红。
#
# attribution_base 解析优先级（与 ci/gates/check-report-schema.sh 的 report_base
# 同一套约定，PROC-048/050：feature→dev 走 PR 后，push 事件在 feature 分支上
# GITHUB_BASE_REF 为空，此时必须落到集成分支 dev 而非 main，否则 dev 上的提交
# 被误判为 feature-only base）：
#   1. 显式环境变量 AIMERGENT_ATTRIBUTION_BASE
#   2. 可信 pull_request 事件（trusted_pr_event）验证过的 event base SHA
#   3. origin/$GITHUB_BASE_REF
#   4. origin/dev（若存在）
#   5. origin/main
#   6. main（无 origin 的本地/离线场景兜底）
set -uo pipefail

fail=0
say() { printf '%s\n' "$*"; }
bad() { printf '❌ %s\n' "$*"; fail=1; }
ok()  { printf '✅ %s\n' "$*"; }

# 发布晋升 dev→main：dev 上各任务的 report git.base 指向 dev 上的任务起点，在「必须是 main
# 祖先」判定下必然红；feature→dev 的 PR 已完成逐任务校验，故晋升事件跳过 canonical report 门。
release_promotion=0
if [ "${AIMERGENT_RELEASE_PROMOTION:-}" = 1 ] ||
   { [ "${GITHUB_HEAD_REF:-}" = dev ] && [ "${GITHUB_BASE_REF:-}" = main ]; }; then
  release_promotion=1
fi

tracked=()
if [ -d code ]; then
  mapfile -d '' tracked < <(git ls-files -z -- code)
else
  mapfile -d '' tracked < <(git ls-files -z)
fi

is_exempt() {
  local list=$1 path=$2
  [ -f "$list" ] && grep -qxF -- "$path" "$list"
}

say "── gate: commit agent 归属 ──"
attribution_marker=ci/gates/agent-attribution-activation
attribution_hook=ci/hooks/commit-msg
attribution_base=${AIMERGENT_ATTRIBUTION_BASE:-}
attribution_head=HEAD
trusted_pr_event=0
pr_event_base=''
pr_event_head=''
if [ "${GITHUB_ACTIONS:-}" = true ] &&
   [ "${GITHUB_EVENT_NAME:-}" = pull_request ] &&
   [[ "${GITHUB_REF:-}" =~ ^refs/pull/[1-9][0-9]*/merge$ ]] &&
   [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ] &&
   [ -n "${GITHUB_REPOSITORY:-}" ] &&
   [ -n "${GITHUB_SHA:-}" ] && [ -n "${GITHUB_HEAD_REF:-}" ] &&
   [ -n "${GITHUB_BASE_REF:-}" ]; then
  pr_event_repo=$(jq -er '.repository.full_name' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  pr_event_base=$(jq -er '.pull_request.base.sha' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  pr_event_head=$(jq -er '.pull_request.head.sha' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  pr_event_base_ref=$(jq -er '.pull_request.base.ref' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  pr_event_head_ref=$(jq -er '.pull_request.head.ref' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  if [ "$pr_event_repo" = "$GITHUB_REPOSITORY" ] &&
     [ "$pr_event_base_ref" = "$GITHUB_BASE_REF" ] &&
     [ "$pr_event_head_ref" = "$GITHUB_HEAD_REF" ] &&
     [[ "$pr_event_base" =~ ^[0-9a-f]{40}$ ]] &&
     [[ "$pr_event_head" =~ ^[0-9a-f]{40}$ ]] &&
     [[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] &&
     git cat-file -e "$pr_event_base^{commit}" 2>/dev/null &&
     git cat-file -e "$pr_event_head^{commit}" 2>/dev/null; then
    trusted_pr_event=1
  fi
fi

if [ -z "$attribution_base" ] && [ "$trusted_pr_event" -eq 1 ]; then
  attribution_base=$pr_event_base
elif [ -z "$attribution_base" ] && [ -n "${GITHUB_BASE_REF:-}" ] &&
   git rev-parse --verify --quiet "origin/$GITHUB_BASE_REF^{commit}" >/dev/null; then
  attribution_base="origin/$GITHUB_BASE_REF"
elif [ -z "$attribution_base" ] &&
     git rev-parse --verify --quiet 'origin/dev^{commit}' >/dev/null; then
  attribution_base=origin/dev
elif [ -z "$attribution_base" ] &&
     git rev-parse --verify --quiet 'origin/main^{commit}' >/dev/null; then
  attribution_base=origin/main
elif [ -z "$attribution_base" ] &&
     git rev-parse --verify --quiet 'main^{commit}' >/dev/null; then
  attribution_base=main
fi

if [ "$trusted_pr_event" -eq 1 ] &&
   [ "$(git rev-parse HEAD 2>/dev/null || true)" = "$GITHUB_SHA" ] &&
   [ "$(git rev-parse "$attribution_base^{commit}" 2>/dev/null || true)" = "$pr_event_base" ]; then
  synthetic_parents=()
  read -r -a synthetic_parents <<<"$(git show -s --format=%P HEAD 2>/dev/null || true)"
  if [ "${#synthetic_parents[@]}" -eq 2 ] &&
     [ "${synthetic_parents[0]}" = "$pr_event_base" ] &&
     [ "${synthetic_parents[1]}" = "$pr_event_head" ]; then
    attribution_head=$pr_event_head
    say "（可信 pull_request merge ref + event SHA + 双亲拓扑已确认；排除 GitHub synthetic merge commit，仅核真实 feature commits）"
  fi
fi

if [ -z "$attribution_base" ]; then
  if [ -f "$attribution_marker" ]; then
    bad "归属 marker 已存在，但无法解析 PR/main 基线"
  else
    say "（归属 marker 尚未安装，历史仓跳过）"
  fi
else
  attribution_merge_base=$(git merge-base "$attribution_head" "$attribution_base" 2>/dev/null || true)
  attribution_base_has_marker=0
  if git cat-file -e "$attribution_base:$attribution_marker" 2>/dev/null; then
    attribution_base_has_marker=1
  fi
  if [ -z "$attribution_merge_base" ]; then
    bad "无法计算归属校验 merge-base: $attribution_base"
  elif [ "$attribution_base_has_marker" -eq 1 ] &&
       ! git cat-file -e "$attribution_merge_base:$attribution_marker" 2>/dev/null; then
    bad "目标 main 已激活归属 marker；旧 feature 分支必须 rebase 后再验"
  elif git cat-file -e "$attribution_merge_base:$attribution_marker" 2>/dev/null; then
    if [ ! -f "$attribution_marker" ]; then
      bad "归属 marker 已在 main 激活，feature 分支不得删除"
    elif [ ! -x "$attribution_hook" ]; then
      bad "缺少可执行归属校验器: $attribution_hook"
    else
      attribution_hit=0
      while IFS= read -r commit; do
        [ -n "$commit" ] || continue
        if ! git show -s --format=%B "$commit" | "$attribution_hook" /dev/stdin; then
          subject=$(git show -s --format=%s "$commit")
          bad "commit 缺少合法唯一归属: $commit $subject"
          attribution_hit=1
        fi
      done < <(git rev-list --reverse "$attribution_merge_base..$attribution_head")
      [ "$attribution_hit" -eq 0 ] && ok "merge-base 后全部 feature commits 均有唯一合法归属"
    fi
  else
    if [ "$attribution_base_has_marker" -eq 0 ] && [ -f "$attribution_marker" ]; then
      say "（marker 由当前启用分支引入；本次不追溯历史，合入 main 后强制）"
    else
      say "（归属 marker 尚未安装，历史仓跳过）"
    fi
  fi
fi

say "── gate: canonical report schema ──"
if [ "$release_promotion" -eq 1 ]; then
  say "release promotion dev→main：逐任务报告校验已在 feature→dev 时完成，跳过"
elif [ ! -x ci/gates/check-report-schema.sh ]; then
  bad "缺少可执行 report schema gate: ci/gates/check-report-schema.sh"
elif ci/gates/check-report-schema.sh; then
  ok "当前任务 canonical reports 合规"
else
  bad "canonical report schema 未通过"
fi

say "── gate: 禁默认值 ──"
weak_hit=0
for f in "${tracked[@]}"; do
  case "$f" in *.py|*.js|*.mjs|*.cjs|*.ts|*.tsx|*.json) ;; *) continue ;; esac
  [ -f "$f" ] || continue
  if grep -qE '(admin888|change-this-to-a-random-string|dev-session-secret|4f7e8640790770fb74e0f178e20ac34d)' "$f"; then
    printf '  matched: %s\n' "$f"
    weak_hit=1
  fi
done
[ "$weak_hit" -eq 0 ] && ok "无弱默认值/泄露值" || bad "已跟踪业务文件出现弱默认值/泄露值"

say "── gate: 老仓路径 ──"
legacy_hit=0
legacy_exempt=ci/gates/legacy-path-exempt.txt
for f in "${tracked[@]}"; do
  [ -f "$f" ] || continue
  is_exempt "$legacy_exempt" "$f" && continue
  if grep -nF '/srv/ecs-services' "$f"; then
    printf '  at %s\n' "$f"
    legacy_hit=1
  fi
done
[ "$legacy_hit" -eq 0 ] && ok "无未豁免老仓路径" || bad "已跟踪文件残留 /srv/ecs-services 路径"

say "── gate: 单文件行数 ──"
size_hit=0
size_exempt=review/reviewcode/size_exempt.txt
for f in "${tracked[@]}"; do
  case "$f" in *.py|*.js|*.mjs|*.cjs|*.ts|*.tsx) ;; *) continue ;; esac
  [ -f "$f" ] || continue
  is_exempt "$size_exempt" "$f" && continue
  n=$(wc -l < "$f")
  if [ "$n" -gt 500 ]; then
    bad "超 500 行：$f ($n)"
    size_hit=1
  fi
done
[ "$size_hit" -eq 0 ] && ok "无超限文件（或已豁免）"

say "── gate: gitleaks 密钥扫描 ──"
if [ "${RUN_GITLEAKS_LOCAL:-0}" = 1 ] && command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --no-banner --config "$(dirname "$0")/.gitleaks.toml" || bad "gitleaks 命中"
else
  say "（GitHub Actions 由独立 action 扫新增变更；本地全历史扫描需 RUN_GITLEAKS_LOCAL=1）"
fi

say "── gate: 模块 reviewcode ──"
# 模块级 reviewcode 的跳过判定（两条件合在同一处，避免重复分支）：
#   • release promotion（dev→main）：逐任务审核探针已在 feature→dev 执行，晋升区间（整段
#     dev 变更）跑 run_all.sh 必然假红，跳过。
#   • infra rollout：某分支相对目标分支的 diff 非空、且**全部**落在 ci/ 或 .github/ 时，说明
#     这是 L0 治理层的 CI 模板分发提交（arbiter 归属、只动基础设施，不含模块产物），模块级
#     reviewcode 检查（arbiter scope 不含 ci/、也不要求 arbiter report 匹配）天然不适用，跳过。
# 其余门一律照跑。base 取法与 ci/gates/check-report-schema.sh 的 report_base 同一套优先级。
infra_diff_base=${AIMERGENT_REPORT_BASE:-}
if [ -z "$infra_diff_base" ] && [ -n "${GITHUB_BASE_REF:-}" ] &&
   git rev-parse --verify --quiet "origin/$GITHUB_BASE_REF^{commit}" >/dev/null; then
  infra_diff_base="origin/$GITHUB_BASE_REF"
elif [ -z "$infra_diff_base" ] &&
     git rev-parse --verify --quiet 'origin/dev^{commit}' >/dev/null; then
  infra_diff_base=origin/dev
elif [ -z "$infra_diff_base" ] &&
     git rev-parse --verify --quiet 'origin/main^{commit}' >/dev/null; then
  infra_diff_base=origin/main
elif [ -z "$infra_diff_base" ] &&
     git rev-parse --verify --quiet 'main^{commit}' >/dev/null; then
  infra_diff_base=main
fi
infra_rollout=0
if [ -n "$infra_diff_base" ]; then
  infra_merge_base=$(git merge-base HEAD "$infra_diff_base" 2>/dev/null || true)
  if [ -n "$infra_merge_base" ]; then
    infra_diff=$(git -c core.quotePath=false diff --name-only --no-renames \
      "$infra_merge_base..HEAD")
    if [ -n "$infra_diff" ] && ! grep -qvE '^(ci/|\.github/)' <<<"$infra_diff"; then
      infra_rollout=1
    fi
  fi
fi
if [ "$release_promotion" -eq 1 ]; then
  say "release promotion：逐任务审核探针已在 feature→dev 执行，跳过 run_all"
elif [ "$infra_rollout" -eq 1 ]; then
  say "infra rollout（仅 ci/ 与 .github/ 变更，L0 治理层所有）：跳过 review/reviewcode/run_all.sh"
elif [ -x review/reviewcode/run_all.sh ]; then
  ./review/reviewcode/run_all.sh || bad "reviewcode/run_all.sh 未全绿"
else
  say "（无 run_all.sh，跳过）"
fi

printf '\n'
[ "$fail" -eq 0 ] && { say "🟢 全部门禁通过"; exit 0; }
say "🔴 门禁失败"
exit 1
