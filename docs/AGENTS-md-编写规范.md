---
"读者": "为代码仓库编写和维护 AGENTS.md 的开发者与 Agent"
"用途": "参考大型开源项目的实践，决定 AGENTS.md 应包含哪些内容，以及如何把要求写成 Agent 可执行的规则"
"内容核心范围":
  - "仓库导航：以职责和关键入口组织地图，不复制目录树。"
  - "可执行规则：构建、测试与验证命令，禁止行为及替代方案，Bug 修复验证闭环，安全与最小修改约束。"
  - "内容归属：根 AGENTS.md、模块 AGENTS.md、Skill 与架构文档的分工。"
  - "区分什么样的规范和禁止事项应该写进 AGENTS.md。"
"不涉及的范围":
  - "各 Agent 工具加载 AGENTS.md 的机制与优先级规则。"
  - "具体项目 AGENTS.md 的完整模板或代写。"
  - "Skill 和架构文档本身的写法。"
---

# AGENTS.md 编写规范

AGENTS.md 是放在仓库中、供编码 Agent 在执行任务前读取的说明文件。本文归纳 Next.js、Kubernetes、Rust、VS Code 等大型开源项目的做法，给出 AGENTS.md 应该写什么、怎样写才能让 Agent 直接执行，以及哪些内容应放到别处。

各节的“推荐”示例是示意写法，目录和命令需替换为自己项目的实际内容。“佐证”是对上述项目 AGENTS.md 做法的归纳转述，不是原文引用；这些文件会随项目更新，引用前应以对应仓库的当前版本为准，具体入口见文末[资料来源](#资料来源)。

## 1. 根 AGENTS.md 首先承担仓库导航职责

推荐：

```md
## Repository Map

- `Runtime/` — 游戏 Runtime 代码
  - `Runtime/Bootstrap/GameEntry.cs` — 启动入口
- `Editor/` — 编辑器及内容生产工具
  - `Editor/EditorMenu.cs` — 菜单与工具注册
- `Server/` — Dedicated Server
  - `Server/Program.cs` — 进程入口
- `Tests/` — 自动化测试
  - `Tests/Game.Tests.csproj` — 测试项目
- `docs/` — 架构和设计文档
```

地图的目的不是向 Agent 展示目录树，而是说明各目录的职责，让 Agent 接到任务后知道第一步去哪里。

编写地图前，先弄清项目的主要目标和功能，以及已形成的目录约定；地图只描述当前实际存在的目录和职责。

地图中，每一项写清目录和职责；目录下有关键入口文件的，再把关键入口列为子项。
职责描述应准确并适度抽象，不要写成目录下各文件功能的罗列，也不要机械列举所有目录和文件。

判断一个路径是否应该写进地图，可以问：Agent 第一次接触项目、不知道这个路径时，会不会明显增加完成任务的搜索成本，或者容易改错地方？如果不会，就不写进地图。

Next.js 的做法可作佐证。它的根 AGENTS.md 开头先列出 `packages/`、`turbopack/`、`crates/`、`test/`、`examples/`、`docs/`、`scripts/` 等顶层目录，并进一步说明：

- `packages/next/src/` 是核心源码；
- Dev Server、Production Server 和 Build 分别从哪个文件进入；
- 各个 package 分别承担什么职责。

## 2. 写出可直接执行的构建、测试与验证命令

推荐：

```md
## Validation

- Focused test: `dotnet test Tests/Game.Tests.csproj`
- Full validation: `dotnet test` and `dotnet format --verify-no-changes`
```

命令应按使用场景分层，不要只给一条构建并测试全部内容的命令：

```md
## Build

<最常用 build>

## Focused Tests

<修改单模块时运行>

## Full Validation

<准备提交时运行>
```

这种做法可以从两个项目得到佐证：

- Kubernetes 直接给出 `make test WHAT=./pkg/kubelet`、`make test-integration WHAT=./test/integration/scheduler`、`make verify` 和 `make update` 等带参数的命令，Agent 可以直接执行；
- Next.js 按开发模式与生产模式、Turbopack 与 webpack 区分测试命令，如 `pnpm test-dev-turbo`、`pnpm test-dev-webpack`、`pnpm test-start-turbo`、`pnpm test-start-webpack` 和 `pnpm test-unit`，并说明不同修改范围应使用的 build 命令。

## 3. 规则写成可判定的禁止行为与替代方案

规则应写成能够直接判定的形式；
禁止某种做法时，同时给出正确的替代方案。
一条好的规则应尽可能回答四个问题：什么时候触发？什么不能做？应该做什么？怎么验证？

推荐：

```md
Do not manually edit files under `Generated/`. Regenerate them with `dotnet run --project Tools/CodeGen`.

Runtime assemblies must not reference `Editor` assemblies.

Run `dotnet test Tests/Game.Tests.csproj` after modifying gameplay logic.

Do not add a NuGet package if the same capability already exists under `Shared/`.
```

这种写法可以从两个项目得到佐证：

- Kubernetes 规定不得手工修改 `zz_generated.*` 和 `generated.pb.go` 等生成文件，应运行 `make update` 重新生成；不应直接执行 `go mod tidy`，应使用项目提供的依赖更新脚本；
- Rust 规定统一使用 `./x` 作为工具入口，不直接调用 Cargo；格式化同样使用 `./x fmt`，而不是直接执行底层工具。

## 4. Bug 修复要写明验证闭环

建议采用“先确认失败，再修复，最后确认通过”的闭环。确认失败可以证明测试确实覆盖了问题，确认通过才能说明修复生效；只由 Agent 在改完代码后自行判断，两点都无法证明。

推荐：

```md
## Bug Fix Workflow

For bug fixes:

1. Reproduce the problem.
2. Add or locate a failing test when practical.
3. Confirm the failure.
4. Implement the smallest coherent fix.
5. Confirm the same test passes.
6. Run relevant regression tests.
```

Rust 的做法可作佐证。它的 AGENTS.md 要求修 Bug 前先找到或新增能够失败的测试，实际运行并观察它失败，之后才允许修改实现；修改后重新运行同一个测试，确认它通过。

## 5. 详细架构文档不重复写进 AGENTS.md，只建立导航

AGENTS.md 适合充当把 Agent 引向专门文档的路由（Router），而不是包罗所有知识的百科（Wiki）。

推荐：

```md
## Documentation

- Architecture → `ARCHITECTURE.md`
- Networking → `docs/networking.md`
- Save system → `docs/save-system.md`
- Asset pipeline → `docs/asset-pipeline.md`
```

这种做法可以从两个项目得到佐证：

- VS Code 的根 AGENTS.md 在这几个项目中最短，只有几行，说明自身是面向编码 Agent 的指引，并把项目介绍、架构、编码规范和验证步骤等详细内容指向 Copilot Instructions；
- Rust 按主题把读者引向不同文档：标准库对应 std-dev-guide，编译器对应 rustc-dev-guide，构建与运行、测试、编译器架构和贡献流程也各有对应文档。

## 6. 高频规则留在 AGENTS.md，低频复杂流程放进 Skill 或文档

分界原则是：AGENTS.md 只放高频、全局、每次任务都必须知道的规则；
Skill 和文档放低频、复杂、按需读取的流程。

推荐：

```md
## Common Rules

<高频规则>

## Specialized Workflows

- CI repair → `.agents/skills/ci-repair/`
- Release → `.agents/skills/release/`
- Networking migration → `docs/networking-migration.md`
```

Next.js 的做法可作佐证。它的根 AGENTS.md 规定：有条件触发或步骤较深的工作流使用 Skills，基础的迭代、构建与测试策略留在 AGENTS.md。它据此把 PR 分诊、创建 PR、发布测试、feature flag、运行时调试、React 同步和 backport 等流程拆进 `.agents/skills/`。

## 7. 安全规则必须具体

项目涉及 GitHub token、OpenAI 或 DeepSeek 等服务的 API key、Steam key、SSH 密钥、签名密钥或 CI secrets 时，应写明具体的密钥处理规则。

推荐：

```md
## Secrets

- Never print token values.
- Never commit `.env.local`.
- Do not replace missing credentials with invented placeholders.
- Redact credentials from shared logs.
```

Next.js 的做法可作佐证。它规定：

- 环境变量默认按敏感信息处理；
- 不得在聊天、commit、日志中打印 token、API key 或 cookie；
- 不得提交本地 secret 文件；
- 本地缺少 secret 时不能凭空构造；
- 分享日志时必须脱敏。

## 8. 定义最小修改原则

最小修改原则对 Agent 尤其重要。Agent 修一个问题时，容易附带重构、抽象、改命名或升级依赖，最后把两行的 Bug 修复扩大成几十个文件的改动。

推荐：

```md
## Change Policy

- Prefer the smallest coherent change.
- Do not perform unrelated refactors.
- Reuse existing infrastructure before adding new abstractions.
- Do not introduce a dependency when an existing project facility is sufficient.
```

Kubernetes 的做法可作佐证。它要求修改保持聚焦、便于评审，并同时补充对应的测试。

## 9. 按内容归属决定写在哪里

遇到一条项目知识时，按以下顺序判断，命中第一条即停止：

1. Agent 几乎每次任务都需要知道：写进根 AGENTS.md。
2. 只在某个模块工作时需要：写进该模块目录下的 AGENTS.md，只描述该子树独有的约束。
3. 属于一套复杂的操作流程：写成 Skill。
4. 属于长期的架构知识：写进 `docs/` 或 `ARCHITECTURE.md`。

第 3、4 条的佐证见[5. 详细架构文档不重复写进 AGENTS.md，只建立导航](#5-详细架构文档不重复写进-agentsmd只建立导航)和[6. 高频规则留在 AGENTS.md，低频复杂流程放进 Skill 或文档](#6-高频规则留在-agentsmd低频复杂流程放进-skill-或文档)。第 2 条可以从 Next.js 得到佐证：它用很短的局部 AGENTS.md 表达某个子树独有的约束。

## 资料来源

以下链接是本文归纳第三方项目做法时使用的公开 GitHub 入口，核对日期为 2026-10-25。各文件会继续更新，引用具体规则前应重新打开对应链接核对：

- Next.js
  - [根 AGENTS.md](https://github.com/vercel/next.js/blob/canary/AGENTS.md)
  - [packages/next/AGENTS.md](https://github.com/vercel/next.js/blob/canary/packages/next/AGENTS.md)
- Kubernetes
  - [AGENTS.md](https://github.com/kubernetes/kubernetes/blob/master/AGENTS.md)
- Rust
  - [AGENTS.md](https://github.com/rust-lang/rust/blob/master/AGENTS.md)
- VS Code
  - [AGENTS.md](https://github.com/microsoft/vscode/blob/main/AGENTS.md)
  - [Copilot Instructions](https://github.com/microsoft/vscode/blob/main/.github/copilot-instructions.md)
