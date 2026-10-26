# AGENTS.md

本仓库保存中文写作规范，以及审阅 Markdown 文档质量的只读审计工具。多数任务是撰写、修订或审阅文档；其余是维护 `tools/docs-audit/` 中的审计脚本。

## 仓库地图

- `docs/` — 写作规范与审计工具说明，也是 Gate 的默认检查范围
  - [`docs/通用写作规范.md`](docs/通用写作规范.md) — 修改或审阅任何文档前先读
  - [`docs/当前状态文档写作规范.md`](docs/当前状态文档写作规范.md) — 编程、计算机、游戏技术类文档在通用写作规范之上另外遵循
  - [`docs/agent写作备忘.md`](docs/agent写作备忘.md) — 按文章类型确定审阅重点和适用规范，以其中的分类表为准
  - [`docs/AGENTS-md-编写规范.md`](docs/AGENTS-md-编写规范.md) — 修改本文件的依据
  - [`docs/中文技术写作语义审校清单.md`](docs/中文技术写作语义审校清单.md) — Gate 无法机械检查、需在语义审校中逐条核对的写作规则
  - [`docs/Markdown-审计入口.md`](docs/Markdown-审计入口.md) — Gate 的参数、检查内容、退出码与报告结构
  - [`docs/依赖安装说明.md`](docs/依赖安装说明.md) — 安装 npm 依赖、核对本机预置工具的版本
  - `docs/archive/` — 已归档的历史文档，不代表当前规范，由 `.wenlab/docs-audit.json` 排除在 Gate 之外
- `.wenlab/` — 各检查工具与审阅包的基础配置，审阅任何项目时都从这里读取；同时也是 wenlab 仓库自身的项目级审计配置。其他项目的配置放在各自根目录的 `.wenlab/` 下
  - `.wenlab/dictionary.txt` — CSpell 词典，审阅任何项目时都作为兜底词典加载
  - `.wenlab/docs-audit.json` — 项目级规则覆盖与目录、文件排除列表
- `.agents/skills/` — 存放供 Agent 宿主加载的 Agent Skills，本仓库不提供安装步骤
  - `.agents/skills/wenlab-docs-audit/SKILL.md` — 对文件、目录或 Git 项目做格式、内容、编辑质量审阅
- `tools/docs-audit/` — Markdown 审计工具：Gate 入口、编排脚本与测试
  - `tools/docs-audit/LocalGate.mjs`、`RemoteGate.mjs` — 本地格式质量阀门与远程格式质量阀门的入口
  - `tools/docs-audit/DocsAudit.mjs` — 编排逻辑：查找工具、核对固定版本、运行检查、汇总结果
  - `tools/docs-audit/ReviewArtifacts.mjs` — 生成诊断报告与审阅包
  - `tools/docs-audit/Open-Comparison.mjs` — 打开 Beyond Compare 比对审阅包
  - `tools/docs-audit/Check-Dependencies.mjs` — 检测 Node.js、Git、npm 依赖和本机原生工具
- `.tmp/` — 临时文件、一次性脚本，以及 Gate 与测试的报告输出（`.tmp/docs-audit/`）

## 验证

修改文档后：

```text
# 修改 docs/ 下的文档后、提交前
node ./tools/docs-audit/LocalGate.mjs
# 默认范围只有 docs/；检查其他目录或单个文件时用 -Path
node ./tools/docs-audit/LocalGate.mjs -Path AGENTS.md
node ./tools/docs-audit/LocalGate.mjs -Path .
```

退出码 0 才算通过；1 表示文档质量问题，2 表示缺工具、版本不符，或配置、执行、报告故障（含格式修复预览不稳定），3 表示只有需要人工复核的外部链接结果（仅 RemoteGate）。Gate 通过不代表语义审校完成，仍需按写作规范通读；内容质量与编辑质量的审校可使用 `.agents/skills/wenlab-docs-audit/` Skill。`RemoteGate.mjs` 会访问文档中的外部网址，只在发布前、定期 CI 或用户要求时运行。

修改审计脚本后：

```text
# 模拟 CLI 响应，覆盖编排与故障分支
node ./tools/docs-audit/tests/Test-DocsAudit.mjs
# 真实工具与本机回环 HTTP 服务
node ./tools/docs-audit/tests/Test-RealTools.mjs
# 任意范围的审阅包、重复运行与过期预览拒绝
node ./tools/docs-audit/tests/Test-ReviewArtifacts.mjs
# wenlab 兜底词典、项目词典缺失警告、-Dictionary 附加与缺失报错
node ./tools/docs-audit/tests/Test-ProjectDictionary.mjs
# 项目级 .wenlab/docs-audit.json 的规则覆盖、目录和文件排除、链接排除、文件名检查、归档链接检查与无效配置报错，以及 Skill 上下文脚本 Get-AuditContext.mjs 的文档清单
node ./tools/docs-audit/tests/Test-ProjectConfig.mjs
```

按修改范围选择回归测试：

- 修改 `DocsAudit.mjs` 或 Gate 入口：运行全部五个测试。
- 修改 `.wenlab/docs-audit.json` 或 `.agents/skills/wenlab-docs-audit/scripts/Get-AuditContext.mjs`：至少运行 `Test-ProjectConfig.mjs`。
- 修改 `.wenlab/dictionary.txt`：至少运行 `Test-ProjectDictionary.mjs`。
- 修改 `tools/docs-audit/package.json`、`package-lock.json` 或 `Check-Dependencies.mjs`：先运行 `Check-Dependencies.mjs`，再运行 `Test-RealTools.mjs`。
- 只修改 `ReviewArtifacts.mjs` 或 `Open-Comparison.mjs`：至少运行 `Test-ReviewArtifacts.mjs`。
- 修改 `tools/docs-audit/` 下的其他 `.mjs` 脚本或 `.wenlab/` 下的其他工具配置：至少运行 `Test-RealTools.mjs` 和 `Test-ReviewArtifacts.mjs`。

修复审计脚本的缺陷时，先在 `tests/` 中找到或补充能复现问题的场景并确认它失败；修复后重新运行同一测试，再运行上述回归测试。

## 规则

- 一次性脚本与临时文件输出到 `.tmp/` 下，不要写到 `tools/docs-audit/` 或其他目录。

## 修改范围

- 修改审计脚本时，只改与当前任务直接相关的代码，不顺带重构、改名或引入新依赖；修订文档时，按 [`docs/通用写作规范.md`](docs/通用写作规范.md) 根据语义影响范围决定修改粒度，允许重写段落或章节，不为缩小 Diff 保留不合理的结构。
