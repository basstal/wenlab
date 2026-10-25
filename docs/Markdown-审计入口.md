---
"读者": "运行 Markdown 审计 Gate 或维护审计脚本的文档作者、开发者与 Agent"
"用途": "说明如何选择和运行 LocalGate 与 RemoteGate、解读检查结果，并借助审阅包审阅格式修复"
"内容核心范围":
  - "Gate 分级与执行时机：LocalGate 与 RemoteGate 的检查内容、只读约束和网络访问范围。"
  - "检查范围：默认范围、-Path 的文件清单规则与项目根目录的确定。"
  - "项目级配置：.wenlab/ 下的项目词典与规则覆盖，以及 -Dictionary 附加词典。"
  - "运行参数与报告：-ReportDirectory、-TimeoutSeconds、-Profiler，报告目录结构与诊断报告各节。"
  - "结果判定：退出码、FAIL/REVIEW/ERROR 的归类规则及人工复核要求。"
  - "审阅包与 GUI 比对：修复预览、Beyond Compare 专用会话和过期预览保护。"
  - "各工具的配置位置、配置取舍与审计脚本的测试命令。"
"不涉及的范围":
  - "工具与依赖的安装、来源核验和固定版本记录。"
  - "文档语义审校、中文语病和跨文档一致性检查。"
  - "Obsidian、MDX 等扩展 Markdown 语法的验证。"
---

# Markdown 审计入口

本地格式质量阀门 LocalGate 与远程格式质量阀门 RemoteGate 两个 Node.js Gate 入口只读地检查 Markdown 文档的排版、结构、拼写、格式、术语和链接。运行前需要 Node.js 22.18.0 或更新版本、Git，以及已安装的固定版本工具。
依赖安装与检测见[依赖安装说明](依赖安装说明.md)。
Gate 通过不代表中文语病、跨文档语义冲突与内容重复已经审校，也不代表验证了 Obsidian、MDX 等扩展语法。

## Gate 分级

| 入口                           | 执行时机                 | 检查内容                                                                                                                       |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| LocalGate（本地格式质量阀门）  | 文档修改后，提交、合并前 | 文件名检查、AutoCorrect 2.16.3、rumdl 0.3.0、CSpell 10.3.6、Prettier 3.9.9、Vale 3.24.0，以及 lychee 0.24.2 离线文件与锚点检查 |
| RemoteGate（远程格式质量阀门） | 发布前、定期 CI          | LocalGate 的全部检查 + lychee 在线 HTTP/HTTPS 与锚点检查                                                                       |

- 所有入口只读，不执行安装、自动修复、npx、Vale 包同步或外部规则下载。检查前后比较源文件 SHA256，出现变化时报告 ERROR。
- LocalGate 不访问外部网址。RemoteGate 会访问文档引用的网址，相同 URL 在不同文件中可能重复请求。

## 运行

```text
node ./tools/docs-audit/LocalGate.mjs
node ./tools/docs-audit/RemoteGate.mjs
# 指定检查范围和超时
node ./tools/docs-audit/LocalGate.mjs -Path docs/Markdown-审计入口.md -TimeoutSeconds 120
# 检查其他目录或仓库中的文档：进入该目录后用相对路径，或直接给出绝对路径
node PathToWenlab/tools/docs-audit/LocalGate.mjs -Path .
# 记录各项检测及内部调用的耗时（RemoteGate 同样支持）
node ./tools/docs-audit/LocalGate.mjs -Path docs -Profiler
```

可从任意工作目录调用脚本的绝对路径。文件名通过参数数组传递，支持中文和空格。

### 检查范围与项目根目录

- 默认范围是本仓库 `docs` 目录下递归找到的所有 `.md`、`.markdown` 文件。
- `-Path` 可以是任意目录、子目录或单个 Markdown 文件，不要求位于 Git 工作区中。相对路径按调用时的当前工作目录解析，如在项目目录中执行时用 `-Path .`；也可以给出绝对路径。不指定 `-Path` 时，无论从哪个目录调用，都检查本仓库的 `docs`。
- 文件清单按 `-Path` 选择规则，`diagnosis.md` 的“配置与警告”一节写明本次使用的规则：
  - `-Path` 正好是 Git 仓库根目录时，按 Git 规则收集已跟踪及未被 `.gitignore` 忽略的 Markdown，再应用项目排除规则。已删除但仍在 Git 索引中的文档返回 ERROR。
  - 其他目录（如 Git 仓库下的 `docs`，或不在 Git 中的目录）递归收集其中所有 Markdown，包括被 `.gitignore` 忽略的文件；跳过名为 `.git` 和 `node_modules` 的目录、项目排除规则匹配项、当次报告输出目录，以及符号链接或目录联接指向的目录。
  - `-Path` 是单个文件时只检查该文件。
  - 两种目录规则都应用 `.wenlab/docs-audit.json` 的 `exclude` 列表；没有配置排除项时，不额外跳过任何项目路径。`-Path` 直接指向被排除的目录或其中的文件时，该显式范围不被同一条规则拦截；其下其他排除规则仍生效。
  - 非归档文档中指向 archive 目录的链接会被列出，见“报告与审阅包”；归档文档之间的链接不列出。
- 项目根目录：`-Path` 位于 Git 工作区中时取该工作区根目录，否则取 `-Path` 所在的目录本身。检查工具以项目根目录为工作目录运行，lychee 也以它为根目录解析以 `/` 开头的链接。
- 不存在的路径和不含 Markdown 的范围返回 ERROR。
- CSpell 通过 `--file-list`、lychee 通过 `--files-from` 读取本次 `input-files.txt`，清单为 UTF-8 无 BOM，每行一个绝对路径。Prettier 检查通过本地 `Check-Markdown.mjs` 读取 JSON 清单并调用已安装的 Prettier API。三者都只在命令行上传递清单路径，每种工具一次调用处理整份清单，也不自行扩大审计范围。

### 项目级配置

- 项目级配置统一放在项目根目录下的 `.wenlab/` 目录：`dictionary.txt` 为项目词典，`docs-audit.json` 为规则覆盖与排除列表；其他位置的同名文件不会被读取。wenlab 仓库自身同样遵守这一规则。
- CSpell 词典按三层叠加：wenlab 词典 [.wenlab/dictionary.txt](../.wenlab/dictionary.txt) 始终加载，作为兜底；审计 wenlab 自身时，它同时就是项目词典，只加载一次；被审计项目的 `.wenlab/dictionary.txt` 默认加载，不存在时在终端、`summary.json` 和 `diagnosis.md` 中给出警告，检查照常进行，警告不影响退出码；`-Dictionary` 再附加一个词典文件，不替换前两层，相对路径按项目根目录解析，文件不存在时返回 ERROR。
- 被审计项目可用 `.wenlab/docs-audit.json` 按项目调整规则；文件不存在时使用默认规则，不发警告。格式为 JSON，只接受以下五项：
  - `exclude`：相对项目根目录的目录名、文件路径或通配符数组。不含 `/` 的条目匹配任意路径段；含 `/` 的条目匹配完整相对路径或目录子树；匹配不区分大小写，`*` 不跨目录，`**` 可跨目录。
  - `rumdl.disable`：在 wenlab 的 rumdl 配置之上额外关闭的规则，如 `["MD025", "MD036"]`，通过 `--extend-disable` 传入。
  - `lychee.exclude`：用正则表达式数组排除不检查的链接，同时用于本地和在线检查。
  - `vale.disable`：关闭 wenlab 的 Vale 规则，如 `["Wenlab.ThousandsSeparator", "Wenlab.LoneHeading"]`。Gate 为当次运行生成一份关闭这些规则的 Vale 配置，保存在报告目录的 `vale.ini` 中。
  - `fileNames.enabled`：设为 `false` 时关闭文件名检查，默认启用，见“文件名检查”。

文件不是合法 JSON、出现其他字段、`exclude` 不是数组或含绝对路径、父目录跳转及无效条目、rumdl 规则名不是 `MD` 加三位数字、Vale 规则名不是 `.wenlab/styles/Wenlab/` 中已有的规则、链接排除项不是非空字符串、正则无法解析，或 `fileNames.enabled` 不是布尔值时，返回 ERROR。

排除列表示例：

```json
{
  "exclude": [
    "drafts-*",
    "**/*.tmp.md",
    "docs/generated/**"
  ]
}
```

### 文件名检查

文件名检查默认启用，被审计项目可在 `.wenlab/docs-audit.json` 中设置 `"fileNames": { "enabled": false }` 关闭。Gate 在其他检查之前逐个检查文件清单中的文件名，结果作为 `filenames` 一项列入报告，不调用外部工具：

- 文件名只能由英文字母（大小写均可）、数字、中文和连词线组成，多个单词之间用连词线分隔，如 `advanced-usage.md`、`Markdown-审计入口.md`、`AGENTS-md-编写规范.md`。
- 不含空格、点和下划线，不含中文以外的非 ASCII 字符（如全角标点），也不含其他 ASCII 符号；连词线不出现在开头、结尾或连续出现。文件名主体中的点应替换为连词线。
- 扩展名为小写的 `.md` 或 `.markdown`。
- 只检查文件名，不检查所在目录的名称。

### 运行参数

- `-ReportDirectory` 指定报告输出目录，相对路径按 wenlab 仓库根目录解析，也支持绝对路径；不指定时写入 wenlab 仓库的 `.tmp/docs-audit/`。报告目录会从源文档扫描中排除；若显式指向被检查仓库内部，报告仍会写在该位置，但不会作为输入文档。
- `-TimeoutSeconds` 默认 180 秒。逐文件调用使用此超时；清单检查及预览进程的超时为此值乘以该批文件数。检查进程的总超时受 Node.js 定时器上限约束。批处理不能单独中断某个文件，超时会将整批判为执行故障。
- `-Profiler` 启用可选的耗时统计。终端显示各工具总耗时，以及项目根目录定位与文件扫描、版本探测、逐文件或批量检测与预览调用的次数、合计、平均和最大耗时。失败、超时及启动异常也计时，不改变 Gate 的判定规则；默认关闭。
- `-Dictionary` 附加一个项目词典，见“项目级配置”。

## 结果判定

| 退出码 | 含义                                                 |
| ------ | ---------------------------------------------------- |
| 0      | 所有必需检查通过                                     |
| 1      | 至少一个 FAIL 或 REVIEW，均阻断 Gate                 |
| 2      | 缺工具、版本不符、配置/执行/报告故障，优先于退出码 1 |

lychee 的结果按以下规则归类，解析同时覆盖其输出中的 `error_map` 与 `timeout_map`：

- HTTP 404、410 及本地文件或锚点失效归为 FAIL。
- 401、403、429、5xx、超时和其他不确定的网络错误归为 REVIEW。REVIEW 不能视为 PASS，需依据原始 URL 与状态人工复核。
- 无法启动、非预期退出码、输出不符合约定时归为 ERROR。

Vale 逐篇检查，单篇文档出现执行故障（如 frontmatter 的 YAML 无法解析、超时或非预期退出码）时，会记录该文档和错误原因并继续检查其余文档。全部检查完后，只要有任何一篇未能完成检查，Vale 就归为 ERROR；否则有告警时归为 FAIL。告警位置和未完成检查的文档都列在 `diagnosis.md` 的 Vale 小节中。

所有工具都在报告中记录实际版本。

## 报告与审阅包

每次运行生成独立的报告目录 `.tmp/docs-audit/<Gate>/<UTC时间>-<运行ID>/`，不同运行互不覆盖，无论是否通过都会保存。目录中包含 `summary.json`、逐工具日志、lychee 原始 JSON，以及为当次范围生成的审阅包：

| 文件/目录             | 用途                                                         |
| --------------------- | ------------------------------------------------------------ |
| `diagnosis.md`        | 本次诊断：各项检查的问题定位与修复建议、配置与警告、重跑命令 |
| `repair-preview/`     | 按本次目录结构保存的 Prettier 格式修复副本，原文不改写       |
| `comparison.json`     | 原始目录、当次预览、文件哈希和独立的比较会话名               |
| `Open-Comparison.mjs` | 直接打开本次 Beyond Compare GUI 规则比对的脚本               |

`diagnosis.md` 中的“定位与修复建议”按实际执行的每项检查分别列出结果。文件名检查列出不合规的文件及原因；AutoCorrect 提供文件、行列及原文和建议片段；CSpell 提供未知词及行列；rumdl、Vale 提供规则诊断，Vale 另列执行失败文件；Prettier 列出格式问题文件；lychee 列出来源、目标链接、状态及修复或人工复核建议。通过项明确标注通过，执行失败或无可解析定位时保留日志入口，不将其当作通过。

“对归档文档的链接引用”一节列出本次文档中指向 archive 目录（不区分大小写）的链接，给出文件、行列和链接目标，同时写入 `summary.json` 的 `ArchiveLinks`。识别范围是内联链接、图片和引用式链接定义，代码块与行内代码中的链接不计；以 `/` 开头的目标按项目根目录解析，网址和同页锚点不计。这一节只供核对，不影响检查结果和退出码。没有这类链接时，这一节写明“本次文档中没有指向归档文档的链接”；检查在扫描链接之前就已中止时，不生成这一节。

“打开 GUI 全量规则比对”之前的“配置与警告”一节集中列出：全部警告、项目根目录与 `.wenlab/` 位置、文件清单规则、实际使用的各层词典、项目审计配置中的覆盖项、Prettier 的 EditorConfig 与配置指纹，以及各工具基础配置所在目录。没有生成审阅包时，该节位于“重新运行”之前。

`summary.json` 中的 `ExitCodes` 按调用记录，`Batches` 保存各次调用对应的文件、退出码及超时信息；批次退出码不能当作每个文件的结果。Prettier 的逐文件 PASS、FAIL、ERROR 及耗时见 `prettier-check.json`，错误文件不会阻断同次进程中其他文件的检查。具体问题文件也保留在工具日志和诊断报告中。

全部 PASS 且未启用 `-Profiler`、没有警告时，终端只显示各项检查结果和汇总；如有指向归档文档的链接，另外打印其数量及 `diagnosis.md` 的完整路径。启用 `-Profiler` 时还会打印耗时统计，存在警告时打印警告。存在 FAIL、REVIEW 或 ERROR 时，汇总后打印“诊断与修复建议”及 `diagnosis.md` 的完整路径；审阅包可用时，再打印“打开 GUI 全量规则比对”及完整的启动命令。终端不打印报告目录，也不会自动打开 GUI。

启用 `-Profiler` 后，终端额外输出耗时统计。`diagnosis.md` 汇总各工具与内部调用的耗时，`summary.json` 和额外生成的 `profile.json` 保存汇总及逐次调用明细，包括文件、耗时、退出码、超时和异常。统计使用墙钟时间，工具总耗时包含版本探测、逐文件检查与编排开销；审阅包生成耗时包含预览调用，不能重复相加。总耗时截至审阅包生成完毕，不包含最终报告序列化和落盘。Prettier 的检查与预览各有两层计时，彼此重叠，不能相加：`check` 为整个检查进程耗时，`check-api` 为其内部逐文件 API 与读文件耗时；`preview-batch` 为整个预览进程耗时，`preview` 为其内部逐文件 API 与读写耗时。报告末尾的重跑命令保留 `-Profiler`、非默认超时参数和 `-Dictionary`。

Prettier 检查 API 遵循固定配置、本地插件、忽略规则及 `.editorconfig`，不写入原文。预览通过本地脚本 `Format-Previews.mjs` 在一个 Node 进程内调用已安装的 Prettier API，只写入本次报告下的预览与诊断副本；逐文件状态、错误和耗时保存在 `prettier-preview.json`。格式化失败的文件保留原始副本，并继续处理后续文件。

### 预览稳定性与配置保护

检查与预览共用 `PrettierConfiguration.mjs` 解析配置，均启用 EditorConfig。逐文件记录 Prettier 版本、有效选项及 SHA256 配置指纹；指纹包括固定配置、忽略文件、实际查找范围内的 `.editorconfig` 文件和本地插件内容，保存在检查与预览 JSON 以及 `comparison.json` 中。检查与预览指纹不一致时，标记 `CONFIGURATION_MISMATCH`，保留原文副本，不提供修复候选。

预览先计算 `y = F(原文)`。结果与原文不同时，再计算 `z = F(y)`，精确比较完整文本。y 与 z 不同时标记 `UNSTABLE_FORMAT`，`repair-preview/` 中保留原文字节，y、z 分别保存到 `format-stability/` 下，仅作诊断证据。未变化的文件不重复格式化。

`diagnosis.md` 在检查表格之后单独列出“格式不稳定文件清单（y 与 z 不同）”，包含文件及 y、z 链接；其他被隔离的预览另行列出。不稳定、配置不一致或格式化异常都会使 Gate 返回 ERROR（退出码 2），其余文件继续检查和生成预览。GUI 中被隔离文件没有差异不代表通过，不能继续套用 y、z 诊断副本。

### 审阅格式修复

1. 运行 Gate。存在问题时，终端会打印 `diagnosis.md` 路径和 GUI 启动命令。
2. 打开 Beyond Compare，比对原文与 `repair-preview/`：

   ```text
   # 进入终端显示的当次报告目录后执行：
   node ./Open-Comparison.mjs
   # 也可从仓库根目录显式指定某次报告：
   node ./tools/docs-audit/Open-Comparison.mjs -RunDirectory .tmp/docs-audit/RemoteGate/<运行目录>
   ```

3. 审阅差异，把确认的修改应用到原文。
4. 重新运行同一个 Gate，以全部检查 PASS、退出码 0 为准。

预览只用 Prettier 处理格式，不处理拼写、术语、链接、语义或全部结构问题；格式化失败的文件保留原样并在报告中标记。不能把预览当作已修复的原文。

### Beyond Compare 比对

- 程序位置保存在 [beyond-compare.json](../.wenlab/beyond-compare.json)，可用启动脚本的 `-BeyondComparePath` 参数或 `BEYOND_COMPARE_EXE` 环境变量覆盖。
- 启动脚本在当次报告目录生成只含专用目录会话的 `.bcpkg` 设置包，自动导入后打开 GUI，无需手工创建会话。目录范围会话包含 `*.md` 文件，使用“仅比较文件”视图隐藏不含 `*.md` 的文件夹，启用规则内容比较、关闭快速相同跳过、加载时展开全部子目录。
- 每次运行使用独立会话，避免串用其他目录的配置；不修改全局默认规则，不输出 Beyond Compare 日志或 HTML。
- 启动前核对源文件、预览以及已记录的配置和插件 SHA256。内容已修改时拒绝打开旧预览，需重新运行 Gate。存在被隔离的预览时，启动脚本会提示先查看报告清单。
- 目录比对的会话过滤器为 `*.md`，因此目录范围中的 `.markdown` 文件仍会审计并生成预览，但不出现在比对窗口中。单文件范围使用该文件的完整名称作为过滤器，所以直接审计 `.markdown` 文件时它会出现在窗口中。未进入本次文件清单的 Markdown（被排除或跳过的目录，或在仓库根目录范围下被 Git 忽略的文件）可能在 GUI 中显示为单边项目，实际审计覆盖范围以 `comparison.json` 为准。
- 会话格式已在 Beyond Compare 4.3.4 验证，其他主版本需要另行验证。

## 工具查找与配置

原生工具优先从 `tools/docs-audit/bin/<工具名>.exe` 查找，然后查 PATH；npm CLI 直接调用项目 `node_modules` 中固定版本的入口。Gate 在运行每个工具前核对其版本，版本不符时返回 ERROR。

各检查工具的基础配置都放在 wenlab 仓库的 `.wenlab/` 目录：`.autocorrectrc`、`rumdl.toml`、`cspell.json`、`dictionary.txt`、`.prettierrc.json`、`.prettierignore`、`.vale.ini` 与 `styles/Wenlab/`、`lychee.toml`，以及审阅包使用的 Beyond Compare 程序位置 `beyond-compare.json`。审计脚本、Prettier 斜体插件和 npm 依赖清单不是配置，仍在 `tools/docs-audit/`。

### AutoCorrect

AutoCorrect 检查中英文混排的空格与标点：中文与英文、数字之间加空格，中文语句使用全角标点，英文语句使用半角标点，全角标点前后不留空格，全角字母和数字改为半角。

- 配置 `.autocorrectrc` 在默认规则之上关闭内置拼写检查，英文拼写交给 CSpell；同时不检查代码块。
- 关闭在连字符两侧加空格的 `space-dash` 规则，复合词与图表编号保持“氧化-还原”“图 1-1”的写法。
- Gate 逐篇调用 `--lint --strict --format json`，从 JSON 中收集文件、行列、原文和建议片段。
- 2.16.3 的 JSON 模式即使发现问题也可能返回 0，因此 Gate 按诊断条目判定结果；日志与 `ExitCodes` 仍保留工具的实际退出码。
- 已知限制：AutoCorrect 遵循项目根目录下的 `.gitignore`，会跳过位于被忽略路径中的文件，并且不报错。递归收集的范围包含这类文件时，AutoCorrect 的 PASS 不代表它们已经检查。

### rumdl

rumdl 检查 Markdown 结构，配置为 `rumdl.toml`。

- 只运行 `check`，不执行 `fmt` 或 `fix`。Gate 逐篇调用，禁用代码块外部工具和磁盘缓存，将配置警告视为执行错误，以 JSON 输出诊断。
- 显式启用标题、列表、空行、围栏代码块、引用、链接与图片、强调和表格等结构规则，不启用长行（MD013）与内联 HTML（MD033）限制。
- 统一的写法：无序列表用 `-`；有序列表递增编号；分隔线用 `---`；代码块使用反引号围栏；斜体与粗体用 `*`；表格各列对齐；页内锚点按 GitHub 规则生成。
- MD026 检查标题末尾的点号：半角的 `.,;:`，以及全角的句号、逗号、分号、冒号和顿号。问号和叹号不报告。
- 不启用检查相对链接目标的 MD057；本地文件链接与锚点是否存在由 lychee 离线检查。
- 不启用检查重复标题的 MD024。标题重名改由 Vale 的 `HeadingDuplicates.yml` 检查，它在 MD024 只查同级重名的基础上，还检查与直接上级同名的标题。
- 被审计项目可用 `rumdl.disable` 额外关闭规则，见“项目级配置”。

### CSpell

CSpell 检查英文拼写，配置为 `cspell.json`。

- 语言为美式与英式英语，忽略网址，不读取 `.gitignore`。
- Gate 一次调用通过 `--file-list` 检查整份清单，从输出中提取未知词及行列。
- 随包词典、wenlab 词典、项目词典和 `-Dictionary` 附加的词典按“项目级配置”所述叠加。用到项目词典或附加词典时，Gate 在报告目录生成导入基础配置的 `cspell-config.json`。
- wenlab 词典只收录审计工具相关的专有名词；某个项目特有的专业词应写进该项目的 `.wenlab/dictionary.txt`。两类词典都只逐项收录经判断的专有名词，不批量接受未知词。

### Prettier

Prettier 检查 Markdown 格式，并为审阅包生成格式修复预览。配置为 `.prettierrc.json` 与 `.prettierignore`。

- 检查和预览都不经过 Prettier CLI：检查由 `Check-Markdown.mjs`、预览由 `Format-Previews.mjs` 各自在一个 Node 进程内调用已安装的 Prettier API。两者通过 `PrettierConfiguration.mjs` 共用配置并启用 EditorConfig，详见“报告与审阅包”。
- 保留段落软换行；不格式化代码块内容，与 AutoCorrect、rumdl 跳过代码块的做法一致，文档中故意写的反例不会被改写。
- 保留文件原有的 CRLF 或 LF 换行符（`endOfLine` 为 `auto`）。同一文件混用两种换行符时，Prettier 会按第一行统一并判为格式问题，这一行为无法通过配置关闭。
- Prettier 本身固定用 `_` 输出斜体，没有对应配置项；项目通过本地插件 [prettier-plugin-asterisk-emphasis.mjs](../tools/docs-audit/prettier-plugin-asterisk-emphasis.mjs) 改为输出 `*`，与 rumdl MD049 的要求一致。斜体的首尾紧挨着另一个斜体或粗体时，插件保留 `_`，以免标记合并成 `**` 而改变含义；这种嵌套写法会被 rumdl 报出，应改写为不嵌套的形式。
- `.prettierignore` 不额外排除文件，审计范围只由 Gate 的文件清单决定。

### Vale

Vale 检查中文标点与数值写法、句子长度与段末标点、标题结构、术语。规则全部位于 `.wenlab/styles/Wenlab/`，不依赖在线规则包，只报告问题，不改写原文。

- `.vale.ini` 对 `.md` 和 `.markdown` 文件启用全部 Wenlab 规则。所有规则都是 error 级别，命中即判为 FAIL。
- Gate 逐篇调用，单篇文档的执行故障不中断其余文档的检查，见“结果判定”。
- 被审计项目可用 `vale.disable` 关闭个别规则，见“项目级配置”。

中文标点与数值规则只检查正文和 frontmatter 中的值，不检查行内代码、代码块、链接地址和 YAML 语法本身。标识符、命令和示例反例应写成行内代码或代码块。

| 规则                      | 报告的写法                                                   | 应改为                                                                                           |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `Quotes.yml`              | 紧邻汉字的半角引号 `"` 或 `'`                                | 全角引号“”，嵌套时内层用‘’                                                                       |
| `NestedQuotes.yml`        | 双引号内又出现双引号                                         | 内层改用单引号‘’                                                                                 |
| `Parentheses.yml`         | 紧邻汉字的半角括号                                           | 全角括号（）                                                                                     |
| `Ellipsis.yml`            | 紧邻中文的 `...`、`。。。`，单个、三个及以上的 `…`，以及 `⋯` | 两个 `…` 组成的“……”；整句英文中的 `...` 不报告                                                   |
| `EllipsisEtc.yml`         | 省略号后接“等”                                               | 只保留其中一个                                                                                   |
| `Exclamation.yml`         | 连用的感叹号                                                 | 只用一个                                                                                         |
| `Dash.yml`                | 汉字之间的 `--`、单个 `—`，以及三个及以上的 `—`              | 用于解释说明时改为破折号“——”；两个名词组成的复合词改用连字符“-”，如“氧化-还原”                   |
| `RangeConnector.yml`      | 带单位的数值范围用 `-`、`—`、`~` 连接                        | 波浪连接号“～”或“至”；ISO 日期、版本号、`x86-64` 这类标识符和“图 1-1”这类图表编号不报告          |
| `RangeUnits.yml`          | 用“～”连接的范围只有后一个数字带单位，如 `67～89%`           | 两个数字都写单位，如“67%～89%”；个、次、章等量词不算单位                                         |
| `UnitSpacing.yml`         | 数字紧接英文单位，如 `16GB`、`100ms`                         | 中间加空格；单位按白名单匹配，`x64`、`H264`、`1080p` 不报告                                      |
| `ThousandsSeparator.yml`  | 不带千分位、超过 4 位的整数                                  | 加千分位逗号，如“1,258,000”；小数部分、版本号和带字母的编号不报告                                |
| `ReductionMultiple.yml`   | “降低、减少、下降”等词后接“N 倍”                             | 改用百分比                                                                                       |
| `PeriodInParentheses.yml` | 句末括号注释内的句号，如 `（见第 26 页。）`                  | 句号放在括号外；括号前已用句号结束的整句注释不报告                                               |
| `FigureNumber.yml`        | 图表编号用 `—`、`–`、`～` 或 `~` 连接，如 `图 1—1`           | 连字符“-”，如“图 1-1”                                                                            |
| `Currency.yml`            | 用中文数字书写的金额，如 `一千元`、`五美元`                  | 阿拉伯数字，如“1,000 元”；“几百元”“上千元”等约数、“100 亿元”和“一元复始”“三元组”等固定说法不报告 |

句子规则检查正文：

- `ParagraphPeriod.yml`：以汉字结尾、缺少句末标点的段落。只检查独立的正文段落，不检查标题、列表项、引用块、表格单元格和 frontmatter 的值。
- `LongSentence.yml`：两个标点之间超过 40 个字，或以句号、问号、叹号、分号结束的一句超过 100 个字。只统计汉字，夹在中间的英文和数字不计入。
- `CommaSplice.yml`：同一句中连用 5 个或更多逗号，中间没有句号、分号、冒号、问号或叹号。并列的分句应按语义改用分号或句号断开。

标题结构由三条脚本规则检查。它们读取原始文本，跳过 frontmatter 和围栏代码块，只识别以 `#` 开头的 ATX 标题，不识别下划线式标题：

- `HeadingDuplicates.yml`：同一上级下的标题重名，或与直接上级标题同名。不同上级下的同名标题不报告。
- `LoneHeading.yml`：某个标题是其上级标题下唯一的下级标题。应省略这一层，或补充同级标题。
- `HeadingDepth.yml`：四级及更深的标题。三级标题下的并列内容改用列表。

术语规则 `Terms.yml` 检查五个英文品牌名的错误写法：`Github`、`NodeJS`、`Powershell`、`Typescript`、`Javascript`，分别应写为 GitHub、Node.js、PowerShell、TypeScript、JavaScript。中文用词是否恰当取决于语境，如“登陆”“帐户”，不做无条件替换，留给语义审校。

### lychee

lychee 检查链接，配置为 `lychee.toml`。

- 两个 Gate 都运行离线检查 `lychee-local`，加 `--offline`，只检查本地文件与锚点；RemoteGate 另外运行在线检查 `lychee-online`，访问 HTTP 和 HTTPS 网址。
- Gate 每种检查一次调用，通过 `--files-from` 检查整份清单，启用锚点检查，以项目根目录解析以 `/` 开头的链接，以 JSON 输出结果。
- 不检查代码块和行内代码中的链接。在线检查时，每个请求超时 20 秒，失败后重试 1 次，最多 4 个并发请求，不使用缓存。
- 被审计项目可用 `lychee.exclude` 排除链接，见“项目级配置”；FAIL 与 REVIEW 的归类见“结果判定”。

## 测试

```text
# 模拟 CLI 响应，覆盖编排与故障聚合。
node ./tools/docs-audit/tests/Test-DocsAudit.mjs
# 使用已安装的六个真实工具与本机回环 HTTP 服务，不安装任何依赖。
node ./tools/docs-audit/tests/Test-RealTools.mjs
# 验证任意目录/单文件审阅包、重复运行及过期预览拒绝。
node ./tools/docs-audit/tests/Test-ReviewArtifacts.mjs
# 验证 wenlab 兜底词典、项目词典缺失时的警告、-Dictionary 附加及缺失时报错。
node ./tools/docs-audit/tests/Test-ProjectDictionary.mjs
# 验证项目级 .wenlab/docs-audit.json 的规则覆盖、目录和文件排除、文件名检查及无效配置报错。
node ./tools/docs-audit/tests/Test-ProjectConfig.mjs
```
