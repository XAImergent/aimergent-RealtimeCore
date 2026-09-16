#!/usr/bin/env bash
# 只检查当前任务相对 PR/main merge-base 新增或修改的 canonical reports。
#
# report_base 解析优先级（与 ci/gates/run-gates.sh 的 attribution_base 同一套约定，
# PROC-048/050：feature→dev 走 PR 后，push 事件在 feature 分支上 GITHUB_BASE_REF
# 为空，此时必须落到集成分支 dev 而非 main，否则 dev 上的提交被误判为
# feature-only base）：
#   1. 显式环境变量 AIMERGENT_REPORT_BASE
#   2. origin/$GITHUB_BASE_REF（pull_request 事件显式给出 PR 目标分支时）
#   3. origin/dev（若存在）
#   4. origin/main
#   5. main（无 origin 的本地/离线场景兜底）
set -uo pipefail

fail=0
bad() { printf '❌ report schema: %s\n' "$*" >&2; fail=1; }
ok() { printf '✅ report schema: %s\n' "$*"; }

report_base=${AIMERGENT_REPORT_BASE:-}
report_head=${AIMERGENT_REPORT_HEAD:-HEAD}
if ! git rev-parse --verify --quiet "$report_head^{commit}" >/dev/null; then
  bad "无法解析 report head: $report_head"
  exit 1
fi
if [ -z "$report_base" ] && [ -n "${GITHUB_BASE_REF:-}" ] &&
   git rev-parse --verify --quiet "origin/$GITHUB_BASE_REF^{commit}" >/dev/null; then
  report_base="origin/$GITHUB_BASE_REF"
elif [ -z "$report_base" ] &&
     git rev-parse --verify --quiet 'origin/dev^{commit}' >/dev/null; then
  report_base=origin/dev
elif [ -z "$report_base" ] &&
     git rev-parse --verify --quiet 'origin/main^{commit}' >/dev/null; then
  report_base=origin/main
elif [ -z "$report_base" ] &&
     git rev-parse --verify --quiet 'main^{commit}' >/dev/null; then
  report_base=main
fi

if [ -z "$report_base" ]; then
  bad "无法解析 PR/main 基线"
  exit 1
fi
merge_base=$(git merge-base "$report_head" "$report_base" 2>/dev/null || true)
if [ -z "$merge_base" ]; then
  bad "无法计算 merge-base: $report_base"
  exit 1
fi

validate_common() {
  local path=$1 expected_role=$2 blob report_commit report_base changed diff_names
  local review_base review_head actual_files claimed_files mismatch
  local claimed_count unique_count
  git cat-file -e "$report_head:$path" 2>/dev/null || {
    bad "canonical report 被删除或不可读: $path"
    return
  }
  report_commit=$(git log -1 --format=%H "$report_head" -- "$path")
  [ -n "$report_commit" ] || {
    bad "无法解析 canonical report 的 resolved_head: $path"
    return
  }
  blob=$(git show "$report_commit:$path" 2>/dev/null) || {
    bad "resolved_head 中 canonical report 不可读: $path@$report_commit"
    return
  }
  if ! jq -e --arg path "$path" --arg role "$expected_role" '
    .schema_version == 2 and
    (.module | type == "string" and length > 0) and
    .role == $role and
    (.task | type == "string" and length > 0) and
    (.tier == "simple" or .tier == "normal" or .tier == "hard") and
    # status 按角色分档。原先全角色只认这四个 verdict 词，而 backend/frontend
    # 这类 worker 自称其中任何一个都近似「自我批准」——他们没有诚实可写的值。
    # 实证：ai_cad 的 backend 报告三周内两次写成 self_checked（更诚实但非法），
    # 两次都要 cfo-arbiter 伸手改别人的文件才能过门（2026-08-05 2a134b8、
    # 2026-08-12 1a4434a）。规则不给诚实选项，就会持续制造这种越界修补。
    # 故 worker 角色额外允许 self_checked =「我自检通过，等独立审核」。
    # verdict 角色（reviewagent/arbiter/consulter）不给这个值——他们的职责就是下判断。
    # 兼容：worker 仍可用原四值，既有报告不受影响；新报告推荐 self_checked。
    (if $role == "backend" or $role == "frontend" then
       (.status == "self_checked" or .status == "approved" or
        .status == "rejected" or .status == "blocked" or .status == "escalate")
     else
       (.status == "approved" or .status == "rejected" or
        .status == "blocked" or .status == "escalate")
     end) and
    (.summary | type == "string" and length > 0) and
    .git.protocol == "embedded-self-v2" and
    (.git.branch | type == "string" and length > 0) and
    (.git.base | type == "string" and test("^[0-9a-f]{40}$")) and
    .git.head == "SELF" and .git.diff_mode == "contains" and
    (.git.changed_files | type == "array" and index($path) != null) and
    (.contract.touched | type == "boolean") and
    (.contract.which | type == "array") and
    (.contract.consumes | type == "array") and
    (.cross_module_impact | type == "array") and has("escalation") and
    (if has("process_issues") then
       (.process_issues | type == "array") and
       all(.process_issues[];
         (.issue_id | type == "string" and length > 0) and
         (.status == "open" or .status == "closed"))
     else true end)
  ' >/dev/null <<<"$blob"; then
    bad "缺少 embedded-self-v2 必填字段或 path/role 不匹配: $path"
    return
  fi

  report_base=$(jq -r .git.base <<<"$blob")
  if ! git rev-parse --verify --quiet "$report_base^{commit}" >/dev/null; then
    bad "git.base 不可解析: $path@$report_base"
    return
  fi
  if ! git merge-base --is-ancestor "$report_base" "$report_commit"; then
    bad "git.base 不是 resolved_head 祖先: $path@$report_commit"
    return
  fi
  if ! git merge-base --is-ancestor "$report_base" "$merge_base"; then
    bad "git.base 不是 PR 目标 merge-base 的祖先（疑似 feature-only base）: $path"
    return
  fi
  diff_names=$(git -c core.quotePath=false diff --name-only --no-renames "$report_base..$report_commit")
  while IFS= read -r changed; do
    [ -n "$changed" ] || continue
    if ! grep -Fqx -- "$changed" <<<"$diff_names"; then
      bad "git.changed_files 不在 base..resolved_head: $path 声称 $changed"
      return
    fi
  done < <(jq -r '.git.changed_files[]' <<<"$blob")

  if { [ "$expected_role" = reviewagent ] || [ "$expected_role" = consulter ]; } &&
     ! jq -e '
       (has("target") | not) and
       (.review_target | type == "object") and
       (.review_target.branch | type == "string" and length > 0) and
       (.review_target.base | type == "string" and test("^[0-9a-f]{40}$")) and
       (.review_target.head | type == "string" and test("^[0-9a-f]{40}$")) and
       .review_target.diff_mode == "exact" and
       (.review_target.changed_files | type == "array") and
       all(.review_target.changed_files[]; type == "string" and length > 0)
     ' >/dev/null <<<"$blob"; then
    bad "独立 reviewer 必须使用标准 review_target（exact），禁止 target 等别名: $path"
    return
  fi
  if [ "$expected_role" = reviewagent ] || [ "$expected_role" = consulter ]; then
    review_base=$(jq -r .review_target.base <<<"$blob")
    review_head=$(jq -r .review_target.head <<<"$blob")
    if ! git rev-parse --verify --quiet "$review_base^{commit}" >/dev/null ||
       ! git rev-parse --verify --quiet "$review_head^{commit}" >/dev/null; then
      bad "review_target base/head 不可解析: $path"
      return
    fi
    if ! git merge-base --is-ancestor "$review_base" "$review_head"; then
      bad "review_target base 不是 head 祖先: $path"
      return
    fi
    claimed_count=$(jq '.review_target.changed_files | length' <<<"$blob")
    unique_count=$(jq '.review_target.changed_files | unique | length' <<<"$blob")
    if [ "$claimed_count" -ne "$unique_count" ]; then
      bad "review_target.changed_files 含重复路径: $path"
      return
    fi
    actual_files=$(git -c core.quotePath=false diff --name-only --no-renames \
      "$review_base..$review_head")
    claimed_files=$(jq -r '.review_target.changed_files[]' <<<"$blob")
    # comm 要求两侧输入按同一比较规则排好序；sort/comm 若跟随非 C locale
    # （如 zh_CN.UTF-8）做本地化排序整理，既可能把不同文件名当重复项折叠，
    # 也会让 comm 用另一套比较规则扫描已排序输入，两者都会导致误判。
    # 强制 LC_ALL=C，让 sort 与 comm 使用同一套确定性字节序，不依赖运行环境 locale。
    mismatch=$(LC_ALL=C comm -3 \
      <(sed '/^$/d' <<<"$actual_files" | LC_ALL=C sort -u) \
      <(sed '/^$/d' <<<"$claimed_files" | LC_ALL=C sort -u))
    if [ -n "$mismatch" ]; then
      bad "review_target.changed_files 与 base..head no-renames diff 不完全一致: $path"
      return
    fi
  fi
  ok "$path"
}

review_artifact_changed=0
canonical_review_changed=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    codeagent/backend/docs/report.json) validate_common "$path" backend ;;
    codeagent/frontend/docs/report.json) validate_common "$path" frontend ;;
    codeagent/reviewagent/docs/report.json)
      canonical_review_changed=1
      validate_common "$path" reviewagent
      ;;
    codeagent/arbiter/docs/report.json) validate_common "$path" arbiter ;;
    CFO_agent/arbiter/docs/report.json) validate_common "$path" arbiter ;;
    CFO_agent/consulter/docs/findings/report.json) validate_common "$path" consulter ;;
    review/reviewreport/*) review_artifact_changed=1 ;;
  esac
done < <(git -c core.quotePath=false diff --name-only --diff-filter=ACMRD \
  "$merge_base..$report_head")

if [ "$review_artifact_changed" -eq 1 ] && [ "$canonical_review_changed" -ne 1 ]; then
  bad "review/reviewreport/* 有变更，但本任务未同步 canonical codeagent/reviewagent/docs/report.json"
fi

[ "$fail" -eq 0 ] || exit 1
ok "仅当前任务变更的 canonical reports 全部合规"
