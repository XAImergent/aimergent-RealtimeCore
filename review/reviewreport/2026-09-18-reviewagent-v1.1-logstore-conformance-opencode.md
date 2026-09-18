# realtime_core · 审核详报（第二轮）· v1.1-logstore-conformance（reviewagent · opencode）

> 本文**覆盖更新**第一轮 rejected 报告。第一轮问题在返修 candidate 上逐条复验。

## VERDICT: **approved（批准合并）**

| 项 | 值 |
|---|---|
| 被审仓 | `/srv/aimergent/0/realtime_core` |
| 分支 | `feat/v1.1-logstore-conformance` |
| exact target | base `076d5e13d8110d2339d6a9b64db863b1f9f97bb6`(origin/main) .. head `f47c5c920e7148833515c600d3bb9c649472f30a`，no-renames |
| 候选绑定 | `git ls-remote origin refs/heads/feat/v1.1-logstore-conformance` = `f47c5c92…f30a` == 本地 HEAD（铁律15③ 成立） |
| 返修提交 | `de755c5` backend@realtime_core（R1 并发 CAS / R2 错误归一化 / R3 行数 / R4 版本）；`f47c5c9` arbiter@realtime_core（契约六处更正） |
| 独立复跑 | `npm test` = **217 pass / 0 fail**（既有 201 零修改 + 本单 16）；`check-kernel-purity.mjs` = **71 PASS / 0 FAIL**；`bash ci/gates/run-gates.sh` = **🟢 exit 0**；不采信 worker 数字 |
| 探针 | 更新 `review/reviewcode/session/check-logstore-conformance-teeth-opencode.mjs` = **ALL PASS exit 0**；`review/reviewcode/backend/check-v1.1-logstore-compat-opencode.sh` = **17 PASS / 0 FAIL exit 0** |

结论：核心 P1「套件漏检并发 CAS」已由第 10 项 `append/cas-concurrent` 真实补上并能**按名**抓住 TOCTOU 适配器；错误归属、契约计数/版本、行为写反的第 4 条均已闭环。既有 201 测试零修改，机械门全绿。批准。

---

## 一、第一轮问题逐条复核（closed / open）

### 我的报告（opencode）

| 编号 | 第一轮结论 | 复核 | 证据（head=f47c5c9） |
|---|---|---|---|
| P1-1 | 套件无并发/交错 CAS 检查 | **closed** | 新增 `append/cas-concurrent`（`code/backend/src/session/logstore-conformance.js:137-172`）：3 路同 `expectedLastSeq=0` 先全部发出再 `allSettled`，断言恰 1 胜者、余 ConflictError、日志恰多一批、竞争后续写连续。牙探针 D1 **按名抓住**（`…teeth-opencode.mjs` D1）；单测 `logstore-conformance.test.mjs:197-211` 两个 TOCTOU 变体 + 连跑两次逐字相同 |
| P2-1 | `contract.md:99` session/ 段头 8 文件·11 符号 | **closed** | 现 `9 文件 · 13 符号`（`module_docs/contract.md:99`）；5 段头求和 = 4+1+2+9+1=**17 文件**、13+4+4+13+3=**37 符号** == 顶层 `:27`；compat C6 PASS |
| P2-2 | 版本/契约引用漂移 4 处 | **closed** | `package.json:4`→v1.1.0；`code/backend/package.json:5`→v1.1.0；`README.md:6-8`→v1.1.0/37 符号+达标方式；`contract.md:11` frontmatter id→`@v1.1.0`；compat C5/C8 全 PASS |
| P2-3 | 适配器泄漏原始异常、`err.check` 丢失 | **closed** | `unexpected()`（`:49-54`）在 `createStore()` 与每个 `spec.run` 外包一层重包为带 `check` 的 `LogStoreConformanceError`、原错误挂 `err.cause`（`:373-388`）；牙探针 A7 由 FAIL 转 PASS；单测 `:215-236` 钉死（含 cause） |
| P3-1 | 自报行数 332/334 漂移 | **残留（P3）** | 头部已回填 394（`worklog:8`、`report.json:8`），但 `codeagent/backend/docs/report.json:132` 的 `pitfalls_checked.evidence` 仍写「新文件 332 行」——见下 P3-a |
| P3-2 | 消费方义务 1 把数组当枚举措辞 | **closed** | `contract.md:235` 已把 `LOG_STORE_CONFORMANCE_CHECKS` 摘出单列，明确「数组、遍历、不得假设长度/下标固定」 |
| P3-3 | 第 9 项模糊检查判别力 | **保持** | 牙探针 A9 仍被 `fuzz/model-equivalence` 指名抓住 |

### 同审者报告（codex）

| 编号 | 复核 | 证据 |
|---|---|---|
| P1-1 套件无并发 CAS | **closed** | 同我的 P1-1；且契约符号行（`:160`）与检查清单（`:161`）显式写入「并发 CAS / 当前 10 项」 |
| P1-2 同 group 行为写反、与实现矛盾 | **closed** | `contract.md:238` 整条改写为「重复投递，不是竞争消费」：pull 不动游标→都收到；任一 ack 前移全组游标。与 `code/backend/src/session/delivery.js:78-88`（pull 只 read+记 pulledHigh，不 advance）逐条一致；codex 探针原行为反证（`:212-219`）已随契约更正而失去判据 |
| P1-3 「任一违约均指名」未兑现 | **closed** | 同我的 P2-3 |
| P2-1 两个 package description 仍 v1.0.0 | **closed** | 两处均 v1.1.0；compat C8 PASS |
| P2-2 自留痕行数 332 vs 334 不实 | **citable 处 closed，另有残留** | codex 点名的 `report.json:8`/`worklog:8` 已改 394；但 `report.json:132` 仍 332 → P3-a |

**P0**：无（两轮一致）。

---

## 二、第二轮独立复跑计数（unset 五个代理变量，不采信 worker）

1. `cd code/backend && npm test` → **`# tests 217 / # pass 217 / # fail 0`**。
   - 既有测试零修改：`git diff --name-status --no-renames 076d5e1..f47c5c9` 中 `*.test.mjs` 仅 **A** `code/backend/src/session/logstore-conformance.test.mjs`，无任何 M/D/R；base `git grep '^test('` = **201**；新文件 `grep -c '^test('` = **16**；201+16=217。
   - `git diff 9e31e1b..de755c5 -- '*.test.mjs'` 只 M 本单自产的新测试文件（新增并发/归一化用例），未触既有。
2. `node review/reviewcode/check-kernel-purity.mjs` → **71 PASS / 0 FAIL**（新文件零 import、零领域词、零 `Date.now(`/`Math.random(`、`db.transaction(`=0、≤500 行）。
3. `bash ci/gates/run-gates.sh` → **🟢 全部门禁通过**（归属 / report schema / 弱默认值 / 老仓路径 / 行数 / gitleaks / reviewcode）。
4. `LOG_STORE_CONFORMANCE_CHECKS` 长度 = **10**，顺序：`append/envelope-and-seq-from-one`、`append/cas-conflict`、`append/cas-concurrent`、`append/batch-atomic`、`read/window`、`cursor/advance-and-idempotent`、`cursor/no-rollback`、`cursor/not-past-log-end`、`stream/isolation`、`fuzz/model-equivalence`。
5. 并发检查连跑两次违约信息**逐字相同**：牙探针 D2 PASS（`racyCASStore` 两次 `[append/cas-concurrent]` message 完全一致）；单测 `logstore-conformance.test.mjs:206-211` 同断言。
6. 逐字比对：内存参考实现并发同 expected 恰 1 个 ConflictError（牙探针 D3 PASS）；全 async 包装 10/10 通过（B1 PASS）。

---

## 三、契约 × 代码一致性再核（10 项 / err.cause / 第 4 条 / 段头求和）

- **10 项**：`contract.md:160` 与 `:161` 均写 10 项，与 `LOG_STORE_CONFORMANCE_CHECKS.length=10`、变更记录 `:296` 一致；`contract.md` 中「9 项」已无残留（worklog 引用旧契约为历史快照，见 P3-b）。
- **err.cause**：契约 `:160` 承诺「泄漏原始异常同样重包成该形状、原错误挂 `err.cause`」；代码 `unexpected()`+双 try 包装兑现；单测 `:215-236`、`:238-244` 覆盖 spec 内抛错与 `createStore()` 抛错。
- **第 4 条 vs `delivery.js:78-88`**：`pull` 只 `logStore.getCursor` + `logStore.read`，仅更新 `pulledHigh`，**不调用 `advanceCursor`** → 同 group 多次 pull 都拿到同批未 ack 事件；`ack`（`:90-100`）才 `advanceCursor`。契约 `:238`「重复投递…谁 ack 谁替全组前移」「三条出路」与实现一致，无矛盾。
- **段头求和 17/37**：5 个 scope 段头 `（4·13）（1·4）（2·4）（9·13）（1·3）` 求和 = 17 文件 / 37 符号 == `:27` 顶层；compat C6 PASS。
- **I7**（`contract.md:254`）「同一快照 K 路并发 append 恰好一个胜者、其余全 ConflictError、日志恰好多一批」= 新检查逐字对应的断言。
- 版本四点（契约标题 `:1` / semver 当前 `:18` / 两 package.json）与 frontmatter id `:11` 均 v1.1.0。

---

## 四、探针更新（本轮产物）

- `review/reviewcode/session/check-logstore-conformance-teeth-opencode.mjs`
  - 段 A 标题改「10 项检查」；A1–A10、B1–B2、C1–C2 全 PASS。
  - **段 D 判定方向反转**：不再以「坏适配器自身并发丢写」判定套件缺口，改为
    (D1) 断言套件**按名**抓住非原子 CAS 适配器 → `[append/cas-concurrent]`；
    (D2) 同一坏适配器连跑两次违约信息**逐字相同**；
    (D3) 内存参考实现并发对照恰 1 个 ConflictError。
    「坏适配器确实坏」降级为 NOTE 前提自证，不再作为判据。原文件头 A/B/C 说明同步改写。
  - 结果：**ALL PASS，exit 0**（检查清单 10 项）。
- `review/reviewcode/backend/check-v1.1-logstore-compat-opencode.sh`
  - C7 断言由「`changed_files == base..resolved_head` 全等」修正为 schema 的 `embedded-self-v2`/`diff_mode=contains` **子集**语义（本 backend 报告不含 arbiter 的 `module_docs/contract.md` 提交；全等会在轮次间插入他人提交时误报，第一版探针即此误报）。保留「无幻影声明」牙齿，并 INFO 列出 diff 中他人 scope 文件。
  - 结果：**17 PASS / 0 FAIL，exit 0**（此前 C7 假阳性）。

> 同审 codex 的两份探针（`…probes-codex.mjs`、`…static-gates-codex.sh`）为**他人 scope，本审只读未改**；其陈旧断言/脚本缺陷见 P3-c，均不构成 candidate 缺陷，也不影响本轮 P1/P2 关闭判定（我已用自己的探针与单测独立复验）。

---

## 五、P3 / INFO（非阻断）

- **P3-a 残留自报数字**：`codeagent/backend/docs/report.json:132` 仍写「新文件 332 行」（实测 `wc -l` = **394**）；`:74` tech_debt proposal 仍写「9 项检查各配一个反证测试」（现 **10 项**）。worker 的 R1/R3「已同步」声明对这两处不成立。属证据文本不实，不改行为、不改契约，不阻断；建议合并前一并回填真值。
- **P3-b 历史叙事未加注**：`worklog:11`「11 用例」、`:42`「212 pass/新增 11」是第一轮自检原值，返修后正确值在 `:130-134`（217/16）与 `:8`（394 行）；同一文件内并存，易误读，建议补一行「（上为第一轮值，返修后见下）」。
- **P3-c codex 产物陈旧（他人文件，只读）**：
  - `…probes-codex.mjs:120`（断言 `rawError.name==='RangeError'`）、`:195`（断言 `unsafeResult.passed===9`）、`:212-219`（以「两次 pull 都见 seq=1」反证契约第 4 条）——三处钉的都是**已修复缺陷本身**，修复后必然反转；实测该探针现在 `:120` 处因 `LogStoreConformanceError` 而崩。属其首轮证据方向，需 codex/后续轮按修复后期望刷新。
  - `…static-gates-codex.sh:23` 用 `comm` 比对导出集合但未固定 `LC_ALL=C`，en_US.UTF-8 下 `sort` 与 `comm` 校序不一致报「not in sorted order」→ exit 1。实测 `LC_ALL=C` 后即通过；纯 locale 脚本缺陷，与候选无关。
- **INFO**：`module_docs/contract.md` 中其余 `v1.0.0` 出现处（`:3/:5/:19/:25/:244/:264/:284/:295`）均为「冻结基线 / 起用点 / 历史变更记录」语境，属正确历史引用，非版本漂移。

---

## 六、复核命令（可复现）

```bash
cd /srv/aimergent/0/realtime_core
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
node review/reviewcode/check-kernel-purity.mjs                                        # 71 PASS / 0 FAIL
(cd code/backend && npm test)                                                         # 217 pass / 0 fail
bash ci/gates/run-gates.sh                                                            # 🟢 exit 0
node review/reviewcode/session/check-logstore-conformance-teeth-opencode.mjs          # ALL PASS exit 0
bash review/reviewcode/backend/check-v1.1-logstore-compat-opencode.sh \
  076d5e13d8110d2339d6a9b64db863b1f9f97bb6 f47c5c920e7148833515c600d3bb9c649472f30a    # 17 PASS / 0 FAIL
git ls-remote origin refs/heads/feat/v1.1-logstore-conformance                        # == f47c5c92…f30a == HEAD
```

## 七、红线遵守

本轮只写 `review/reviewreport/` 与 `review/reviewcode/`（更新本人两份探针 + 本报告）；未改 `code/`、`module_docs/`、`ci/` 及 worker 文件；未 commit、未 push；未打印任何 secret。
