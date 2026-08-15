# 计划 A：仓库上线与双平台 CI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MeshMind 推上 GitHub 公开仓库，让双平台 CI 跑绿，并当场修掉 Windows 首次验证暴露的所有问题。

**Architecture:** 仓库已有 `.github/workflows/ci.yml`（macOS + Windows 矩阵，跑 pnpm test / pnpm build / cargo test / clippy / fmt，非 PR 时打包）。本计划不重写它，而是：先做敏感信息扫描 → 建仓库推送 → 观察首次运行 → 按分诊表修问题 → 收紧配置。

**Tech Stack:** gh CLI（已登录 `LingyiChen-AI`）/ GitHub Actions / Rust stable / pnpm 10

**前置状态：** `main` 分支，工作区干净，Rust 177 测试 + 前端 135 测试全绿，clippy `-D warnings` 零告警，无 git remote。

---

### Task 1: 敏感信息扫描

推公开仓库之前必须做。历史已被 `filter-branch` 重写过一次（清理构建产物），但从未扫过密钥。

**Files:**
- 只读检查，无修改

- [ ] **Step 1: 扫描全部历史中的可疑字符串**

```bash
cd /Users/chenhao/codes/myself/MeshMind
git log -p --all | grep -inE 'api[_-]?key|secret|passwd|password|bearer |authorization:|BEGIN [A-Z ]*PRIVATE KEY|ghp_|github_pat_|sk-[a-zA-Z0-9]{20}' | head -40
```

Expected: 无输出，或仅命中文档里对「密钥」「password」这类词的中文描述。**逐条看清楚**，命中即停下人工判断，不要凭 grep 行数下结论。

- [ ] **Step 2: 检查是否有不该提交的文件类型**

```bash
git ls-files | grep -iE '\.(env|pem|key|p12|pfx|keystore|jks)$|(^|/)\.env' || echo "无敏感文件类型"
git ls-files | wc -l
```

Expected: 输出「无敏感文件类型」，文件数约 120。

- [ ] **Step 3: 确认忽略规则覆盖将来会出现的密钥**

`.gitignore` 追加（更新器私钥虽然计划放在仓库外，但多一层保险不亏）：

```
*.key
*.pem
.env
.env.*
```

- [ ] **Step 4: 提交**

```bash
git add .gitignore
git commit -m "chore: 忽略规则补上密钥与环境文件"
```

---

### Task 2: 统一行尾，避免 Windows 检出后炸测试

Windows 上 git 默认 `core.autocrlf=true`，检出时把 LF 换成 CRLF。`include_str!` 进来的 SQL、以及测试里的多行字符串字面量都会随之变化，可能产生只在 Windows 上失败的测试。

**Files:**
- Create: `.gitattributes`

- [ ] **Step 1: 写 .gitattributes**

```gitattributes
# 仓库内一律 LF。Windows 检出时不做 CRLF 转换，
# 避免 include_str! 的 SQL 与测试里的多行字面量在两平台上不一致。
* text=auto eol=lf

# 二进制文件不做任何转换
*.png binary
*.ico binary
*.icns binary
*.dmg binary
*.msi binary
```

- [ ] **Step 2: 确认现有文件已是 LF**

```bash
cd /Users/chenhao/codes/myself/MeshMind
file $(git ls-files '*.rs' '*.ts' '*.tsx' '*.sql' '*.json' '*.md' | head -40) | grep -i crlf || echo "全部 LF"
```

Expected: 输出「全部 LF」。若有 CRLF 文件，跑 `git add --renormalize .` 后再提交。

- [ ] **Step 3: 提交**

```bash
git add .gitattributes
git commit -m "chore: 统一行尾为 LF"
```

---

### Task 3: 建公开仓库并推送

用户已明确授权建**公开**仓库。

**Files:**
- 无文件改动

- [ ] **Step 1: 确认 gh 身份**

```bash
gh auth status 2>&1 | head -4
```

Expected: `Logged in to github.com account LingyiChen-AI`。

- [ ] **Step 2: 建仓库并推送**

```bash
cd /Users/chenhao/codes/myself/MeshMind
gh repo create LingyiChen-AI/MeshMind \
  --public \
  --source=. \
  --remote=origin \
  --description "本地优先的跨平台智能笔记客户端：随手捕捉、块式写作、中文与拼音极速检索" \
  --push
```

Expected: 输出仓库 URL，且 `git remote -v` 显示 origin。

- [ ] **Step 3: 确认推送完整**

```bash
git remote -v
git log origin/main --oneline | head -3
gh repo view LingyiChen-AI/MeshMind --json name,visibility,defaultBranchRef
```

Expected: `visibility` 为 `PUBLIC`，默认分支 `main`。

---

### Task 4: 观察首次 CI 并分诊

这是本计划的核心。Windows 侧至今零验证，首次运行大概率有红。

**Files:**
- 视失败情况而定

- [ ] **Step 1: 等待并查看首次运行结果**

```bash
cd /Users/chenhao/codes/myself/MeshMind
gh run list --limit 3
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
```

Windows 上首次构建要拉整套 Rust 依赖并编译 bundled SQLite，预计 15-25 分钟。

- [ ] **Step 2: 失败时拉取日志定位**

```bash
RUN=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view $RUN --log-failed | tail -80
```

- [ ] **Step 3: 按分诊表处理**

下面是按可能性排序的预判。**不要预先修这些**——只在 CI 真的报了才动，凭猜测改配置只会引入新问题。

| 症状 | 根因 | 处理 |
|---|---|---|
| `cc` / `cl.exe` 找不到，`libsqlite3-sys` 构建失败 | MSVC 工具链缺失 | `windows-latest` 自带 MSVC。若真缺，在 workflow 的 Windows 分支加 `ilammy/msvc-dev-cmd@v1` |
| `pnpm install --frozen-lockfile` 报 lockfile 不匹配 | `package.json` 与 `pnpm-lock.yaml` 漂移 | 本地跑 `pnpm install` 后提交更新的 lockfile |
| `cargo test` 在 Windows 上有测试失败而 macOS 通过 | 行尾、路径分隔符、或文件系统大小写 | 看具体测试。Task 2 已处理行尾；路径问题查是否有硬编码的 `/` |
| `tauri build` 报找不到 WiX | Tauri 首次会自动下载 WiX | 通常重跑即可；持续失败则在 workflow 里显式缓存 `~/AppData/Local/tauri` |
| 路径过长错误（`ENAMETOOLONG` / `path too long`） | Windows 260 字符限制 + 深层 node_modules | workflow 里加 `git config --system core.longpaths true` |
| `cargo fmt --check` 只在 Windows 上失败 | 行尾 | Task 2 已处理；仍失败则确认 `.gitattributes` 生效（`git add --renormalize .`） |
| 打包步骤超时 | Windows runner 编译慢 | 确认 `Swatinem/rust-cache` 生效；必要时给该 job 加 `timeout-minutes: 45` |

- [ ] **Step 4: 每修一个问题就推一次并复验**

```bash
git add -A
git commit -m "fix(ci): <具体修了什么>"
git push
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
```

一次只改一件事。同时改三处再推，绿了也不知道是哪处起的作用，红了更难定位。

- [ ] **Step 5: 确认两个平台全绿**

```bash
gh run list --limit 1 --json conclusion,headBranch --jq '.[0]'
```

Expected: `conclusion` 为 `success`。

**这一步没绿之前不要进入 Task 5，也不要开始计划 B。**

---

### Task 5: 收紧 CI 配置

首次绿之后再做，避免和 Windows 问题混在一起。

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 读当前配置**

```bash
cat .github/workflows/ci.yml
```

- [ ] **Step 2: 确认三件事已就位，缺则补**

1. **`cargo` 命令带 `--locked`**：`cargo test --workspace --locked`、`cargo clippy --workspace --all-targets --locked -- -D warnings`。作用是让 `Cargo.lock` 与 manifest 不一致时立刻失败，而不是 CI 悄悄改 lockfile 后通过——本项目已经踩过一次「lockfile 未提交」。
2. **`concurrency` 取消同分支旧运行**：
   ```yaml
   concurrency:
     group: ${{ github.workflow }}-${{ github.ref }}
     cancel-in-progress: true
   ```
3. **打包产物上传**：`actions/upload-artifact@v4`，保留 7 天，`if-no-files-found: warn`。

- [ ] **Step 3: 推送并确认仍绿**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: 加 --locked 并确认并发取消与产物上传"
git push
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: 两平台均 `success`。

---

### Task 6: 记录 Windows 首次验证结果

**Files:**
- Modify: `docs/manual-verification.md`

- [ ] **Step 1: 把 CI 已覆盖的项标出来**

`docs/manual-verification.md` 里有一批项目现在已由 CI 自动覆盖（构建、测试、打包能否产出）。在文件开头加一段说明：哪些项已由 CI 覆盖、不必人工重复；哪些仍然只能人工（窗口、热键、托盘、剪贴板、真机安装）。

- [ ] **Step 2: 记录 Windows 首次验证中发现并修复的问题**

在文件末尾加一节「Windows 首次验证纪要」，逐条写：症状、根因、修法。这段是给三个月后的自己看的——同类问题会在加新依赖时重现。

若 Task 4 中一个问题都没出现，如实写「首次 CI 双平台一次通过，无需修复」，不要为了充实内容编造。

- [ ] **Step 3: 提交**

```bash
git add docs/manual-verification.md
git commit -m "docs: 记录 Windows 首次验证结果"
git push
```

---

## 完成标准

- GitHub 上存在公开仓库 `LingyiChen-AI/MeshMind`，代码已推送
- CI 在 macOS 与 Windows 上均 `success`
- Windows 上首次完成 `cargo test` / `clippy` / `fmt` / `pnpm test` / `pnpm build` / 打包
- 敏感信息扫描已执行且无命中
- `.gitattributes` 已就位，两平台行尾一致
- Windows 首次验证的发现已记录在案
