#!/usr/bin/env bash
set -euo pipefail

base=076d5e13d8110d2339d6a9b64db863b1f9f97bb6
head=f47c5c920e7148833515c600d3bb9c649472f30a
worker_head=de755c57eb057fa0c5e16988a326fd68dde641d5

mapfile -t changed_tests < <(git diff --name-status --no-renames "$base..$head" -- code/backend | awk '$2 ~ /\.test\.(mjs|js|cjs)$/ {print $1 " " $2}')
test "${#changed_tests[@]}" -eq 1
test "${changed_tests[0]}" = 'A code/backend/src/session/logstore-conformance.test.mjs'

base_cases=$(git grep -hE '^test\(' "$base" -- 'code/backend/**/*.test.mjs' | wc -l)
test "$base_cases" -eq 201

mapfile -t changed_existing_src < <(git diff --name-status --no-renames "$base..$head" -- 'code/backend/src/**/*.js' | awk '$1 != "A" {print}')
test "${#changed_existing_src[@]}" -eq 0

base_exports=$(git grep -hE '^export (const|function|class|async function)' "$base" -- 'code/backend/src/**/*.js' \
  | sed -E 's/.*export (const|function|class|async function) ([A-Za-z0-9_]+).*/\2/' | sort)
head_exports=$(git grep -hE '^export (const|function|class|async function)' "$head" -- 'code/backend/src/**/*.js' \
  | sed -E 's/.*export (const|function|class|async function) ([A-Za-z0-9_]+).*/\2/' | sort)
test "$(printf '%s\n' "$base_exports" | wc -l)" -eq 35
comm -23 <(printf '%s\n' "$base_exports") <(printf '%s\n' "$head_exports") | test ! -s /dev/stdin
test "$(printf '%s\n' "$head_exports" | wc -l)" -eq 37

test "$(jq -r .version package.json)" = 1.1.0
test "$(jq -r .version code/backend/package.json)" = 1.1.0
grep -q '^# realtime_core · 对外接口契约（v1\.1\.0 · 正式）$' module_docs/contract.md
grep -q '^\- \*\*当前：v1\.1\.0（正式，冻结启用）\*\*' module_docs/contract.md

test "$(jq -r .status codeagent/backend/docs/report.json)" = self_checked
test "$(jq -r .git.base codeagent/backend/docs/report.json)" = "$base"
diff -u \
  <(jq -r '.git.changed_files[]' codeagent/backend/docs/report.json | sort) \
  <(git diff --name-only --no-renames "$base..$worker_head" | sort | grep -v '^module_docs/contract\.md$')

printf 'PASS static gates: 201 old cases, only one added test file, 35 old exports retained, versions/report contains set exact\n'
