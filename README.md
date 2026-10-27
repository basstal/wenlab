# wenlab

中文文档既要格式规范，也要内容准确、表达清楚。wenlab 把写作规范和检查工具放在一起，帮助作者和 Agent 审阅格式质量、内容质量和编辑质量。

格式质量由 Gate（格式质量阀门）脚本检查，覆盖文件名、排版、结构、拼写、格式、术语和链接；内容质量与编辑质量由人或 Agent 先按 [Agent 写作备忘](docs/agent写作备忘.md) 确定文章类型，再选用对应规范和审阅重点。检查只读，不修改原文。
Gate 入口、编排、审阅包和测试均由 Node.js `.mjs` 脚本实现。

## Agent 入口

本 Skill 需要完整的 wenlab 仓库及相应运行环境。仅通过 Skill 目录或安装器获取 `.agents/skills/wenlab-docs-audit/`，不能获得完整审计能力；写作规范、项目配置和 Gate 脚本位于仓库其他目录中。
使用前请准备完整仓库或 [GitHub Releases](https://github.com/basstal/wenlab/releases) 中的项目源码，并按 [依赖安装说明](docs/依赖安装说明.md) 核对运行环境。只审阅内容质量或编辑质量时不运行 Gate，但仍需完整仓库、Node.js 和上下文脚本。

需要审阅 Markdown 文档质量时，可使用本仓库的 [wenlab-docs-audit Skill](.agents/skills/wenlab-docs-audit/SKILL.md)。Skill 说明包含适用场景、上下文获取、格式质量检查，以及按文章类型选择规范的内容质量与编辑质量审校流程。使用时需指定待审阅的文件、目录或项目，加载方式由 Agent 宿主配置。

- 写作依据：先按 [Agent 写作备忘](docs/agent写作备忘.md) 的分类表为每篇文档确定文章类型，再采用表中对应的规范和审阅重点。编程、计算机和游戏技术类选用 [当前状态文档写作规范](docs/当前状态文档写作规范.md) 和 [中文技术写作语义审校清单](docs/中文技术写作语义审校清单.md)，并按当前状态文档规范的要求一并阅读 [通用写作规范](docs/通用写作规范.md)；表中标为“暂定”或未列出的类型使用通用写作规范。
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

退出码 0 表示通过，1 表示文档有问题，2 表示缺工具、版本不符，或配置、执行、报告故障。退出码 3 只由 RemoteGate 返回，表示没有确定的问题，但有外部链接返回 401、403、429、5xx 或超时等结果，需要人工复核。报告默认保存在本仓库 `.tmp/docs-audit/`，先看当次报告中的 `diagnosis.md`。

需要审阅内容质量和编辑质量时，让已加载 `wenlab-docs-audit` Skill 的 Agent 执行“用 wenlab 对指定项目做文档质量审阅”。

## 可调配置

在被检查项目的 `.wenlab/` 下配置：

- `dictionary.txt`：添加项目专有名词，供拼写检查使用。
- `docs-audit.json`：按项目调整检查规则和范围。
  - `exclude`：排除目录名、相对路径或通配符模式，支持 `*` 和 `**`。只在配置列出条目时生效，不内置默认排除项。
  - `rumdl.disable`、`vale.disable`：关闭指定规则。
  - `lychee.exclude`：排除不检查的链接。
  - `fileNames.enabled`：开关文件名检查。
  - `archiveLinks.enabled`、`archiveLinks.directoryNames`：开关归档链接检查，并指定归档目录名。未配置 `directoryNames` 时不识别任何归档目录，也不扫描归档链接。

命令参数可调整范围（`-Path`）、报告位置（`-ReportDirectory`）、超时（`-TimeoutSeconds`），或附加词典（`-Dictionary`）。加 `-Profiler` 可查看耗时。

各检查工具的基础配置放在本仓库 [.wenlab/](.wenlab/)。配置格式、规则说明和完整参数见 [Markdown 审计入口](docs/Markdown-审计入口.md)。

## 许可证

本项目原创代码和文档采用 [MIT 协议](LICENSE)。第三方工具与材料保留各自的许可证，见 [第三方许可说明](THIRD-PARTY-NOTICES)。
