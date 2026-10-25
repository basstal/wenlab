# wenlab

Chinese technical writing guidelines and a read-only Markdown documentation audit toolkit for AI agents and authors. Includes an Agent Skill for documentation quality review, Markdown linting, Chinese typography, spelling, terminology and link checks.

中文文档既要格式规范，也要内容准确、表达清楚。wenlab 把写作规范和检查工具放在一起，帮助作者和 Agent 检查这三类问题。

脚本检查文件名、排版、结构、拼写、术语和链接；内容与表达由人或 Agent 按 [写作规范](docs/通用写作规范.md) 审阅。检查只读，不修改原文。
Gate 入口、编排、审阅包和测试均由 Node.js `.mjs` 脚本实现。

## Agent 入口

需要审计 Markdown 文档质量、审阅中文技术文档，或检查目录和 Git 项目中的文档时，可使用本仓库的 [wenlab-docs-audit 技能](.agents/skills/wenlab-docs-audit/SKILL.md)。技能说明包含适用场景、上下文获取、格式检查和内容与表达审校流程；加载方式由 Agent 宿主配置。

For AI agents: start with the [wenlab-docs-audit Agent Skill](.agents/skills/wenlab-docs-audit/SKILL.md) when asked to audit or review Markdown documentation, Chinese technical writing, or documentation quality in a file, directory or Git project. Run the CLI for formatting checks, then follow the writing guidelines for semantic and editorial review.

- 执行入口：[技能说明](.agents/skills/wenlab-docs-audit/SKILL.md)；用户需指定待审计的文件、目录或项目。
- 写作依据：[通用写作规范](docs/通用写作规范.md)、[当前状态文档写作规范](docs/当前状态文档写作规范.md) 和 [中文技术写作语义审校清单](docs/中文技术写作语义审校清单.md)。
- 命令与配置：[Markdown 审计入口](docs/Markdown-审计入口.md) 和 [依赖安装说明](docs/依赖安装说明.md)。
- 发布包：[GitHub Releases](https://github.com/basstal/wenlab/releases) 提供项目源码与 Windows 原生工具包，发布说明包含解压和运行步骤。

## 工具链

需要 Node.js 22.18.0+、Git，以及以下固定版本的工具：

| 工具        | 版本   | 用途               |
| ----------- | ------ | ------------------ |
| AutoCorrect | 2.16.3 | 中英文排版         |
| rumdl       | 0.3.0  | Markdown 结构      |
| CSpell      | 10.3.6 | 英文拼写           |
| Prettier    | 3.9.9  | 格式检查与修复预览 |
| Vale        | 3.24.0 | 写作规则与术语     |
| lychee      | 0.24.2 | 链接与锚点         |

可选用 Beyond Compare 查看原文与格式修复预览的差异。

## 常规用法

依赖准备与检测见 [依赖安装说明](docs/依赖安装说明.md)。完成后在 wenlab 根目录运行：

```text
# 检查本项目 docs 目录
node ./tools/docs-audit/LocalGate.mjs
# 检查另一个项目
node ./tools/docs-audit/LocalGate.mjs -Path ../your-project
# 发布前额外检查外部网址
node ./tools/docs-audit/RemoteGate.mjs -Path ../your-project
```

退出码 0 表示通过，1 表示文档有问题，2 表示工具、配置或执行故障。报告保存在本仓库 `.tmp/docs-audit/`，先看当次报告中的 `diagnosis.md`。

需要检查内容和表达时，让已加载 `wenlab-docs-audit` 技能的 Agent 执行“用 wenlab 对指定项目做文档质量检测”。

## 可调配置

在被检查项目的 `.wenlab/` 下配置：

- `dictionary.txt`：添加项目专有名词，供拼写检查使用。
- `docs-audit.json`：用 `exclude` 排除目录名、相对路径或通配符模式，用 `rumdl.disable`、`vale.disable` 关闭指定规则，用 `lychee.exclude` 排除链接，用 `fileNames.enabled` 开关文件名检查。`exclude` 支持 `*` 和 `**`，只在配置列出条目时生效，不内置默认排除项。

命令参数可调整范围（`-Path`）、报告位置（`-ReportDirectory`）、超时（`-TimeoutSeconds`），或附加词典（`-Dictionary`）。加 `-Profiler` 可查看耗时。

共享规则放在本仓库 [.wenlab/](.wenlab/)。配置格式、规则说明和完整参数见 [Markdown 审计入口](docs/Markdown-审计入口.md)。

## 许可证

本项目原创代码和文档采用 [MIT 协议](LICENSE)。第三方工具与材料保留各自的许可证，见 [第三方许可说明](THIRD-PARTY-NOTICES)。
