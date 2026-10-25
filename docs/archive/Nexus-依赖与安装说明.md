---
"读者": "在新机器部署或更新审计工具依赖的开发者与 Agent"
"用途": "说明审计工具所需的运行时与 CLI 固定版本，以及只从 Nexus 获取、安装和核验它们的方法"
"内容核心范围":
  - "运行要求：PowerShell、Git、Node.js 及六个 CLI 的固定版本与查找顺序。"
  - "npm 依赖安装：lockfile 生成、来源与完整性核验、npm ci 复现及禁止生命周期脚本。"
  - "原生工具获取：raw-hosted 制品的下载前缀、SHA256 与批准记录。"
  - "来源约束与故障处理：禁止的安装方式，以及缺制品或仓库故障时的停止规则。"
  - "首次部署的历史记录，单独标注日期。"
"不涉及的范围":
  - "Gate 的运行方式、检查规则和结果判定。"
  - "依赖漏洞审计或源码安全审计。"
  - "Nexus 仓库本身的配置与制品上传流程。"
---

# Nexus 依赖与安装说明

审计工具依赖的运行时和 CLI 都使用固定版本，只能从 Nexus 获取。LocalGate 与 RemoteGate 两个 Gate 入口不会自动安装、升级或下载任何依赖；缺工具或版本不符时返回退出码 2，此时按本文准备依赖。

## 运行要求

- PowerShell 7.2 或更新版本，以及 Git。
- Node.js 22.18.0 或更新版本，这是 CSpell 的要求，已写在 `package.json` 的 `engines` 中。
- 以下六个 CLI，版本必须完全一致：

| 工具        | 固定版本 | 获取方式                                             |
| ----------- | -------- | ---------------------------------------------------- |
| AutoCorrect | 2.16.3   | 使用用户 bin 目录中已有的安装，本仓库未记录其来源    |
| rumdl       | 0.3.0    | 从 Nexus raw-hosted 下载，见“获取原生工具”           |
| CSpell      | 10.3.6   | 从 Nexus npm-group 安装，由 `package-lock.json` 固定 |
| Prettier    | 3.9.9    | 从 Nexus npm-group 安装，由 `package-lock.json` 固定 |
| Vale        | 3.24.0   | 使用用户 bin 目录中已有的安装，本仓库未记录其来源    |
| lychee      | 0.24.2   | 使用用户 bin 目录中已有的安装，本仓库未记录其来源    |

原生工具优先从项目 `.tools/docs-audit/` 查找，然后查 PATH。两个 Gate 入口只核对版本，不在每次执行时校验二进制哈希。

## 安装 npm 依赖

在 `tools/docs-audit` 下执行。Nexus 的 TLS 信任链（Caddy）需位于 Windows 系统根证书库，npm 通过 `NODE_USE_SYSTEM_CA=1` 使用系统证书。只在当前进程设置该变量，不修改用户或机器的全局配置，不导入证书，不关闭证书校验。

复现已有的 lockfile：

```powershell
$env:NODE_USE_SYSTEM_CA = '1'
npm ci --registry=https://nexus.home.arpa/repository/npm-group/ --ignore-scripts
```

只有主动更新依赖时才重新解析 lockfile，步骤如下：

1. 修改 `package.json` 中的固定版本。
2. 只生成 lockfile，不安装：

   ```powershell
   $env:NODE_USE_SYSTEM_CA = '1'
   npm install --package-lock-only --registry=https://nexus.home.arpa/repository/npm-group/ --ignore-scripts
   ```

3. 检查 `package-lock.json`：全部 `resolved` 都位于 `https://nexus.home.arpa/repository/npm-group/` 下，全部条目都有 `integrity`，没有声明安装生命周期脚本的条目。
4. 用上面的 `npm ci` 命令安装。
5. 同步更新 `DocsAudit.psm1`、`ReviewArtifacts.ps1`、`tests/Test-RealTools.ps1`、`tests/Test-DocsAudit.ps1` 和本文中的固定版本号。`tests/Test-DocsAudit.ps1` 中模拟的版本字符串必须与 `DocsAudit.psm1` 核对的版本一致。

`package-lock.json` 随项目提交，是依赖坐标、版本、`resolved` 和 `integrity` 的唯一依据。

## 获取原生工具

只使用 Nexus raw-hosted 中已审计的制品，并核对版本、架构和 SHA256。不得通过 cargo、winget、外部发行页或下载脚本替代。

rumdl 0.3.0 的下载前缀：

```text
https://nexus.home.arpa/repository/raw-hosted/rumdl/0.3.0/
```

- 归档文件：`rumdl-v0.3.0-x86_64-pc-windows-msvc.zip`。
- ZIP SHA256：`72ed0bd3912560758cfc66cb439a2804755a858573e605cd3d1e65e8aa79d2a1`。
- EXE SHA256：`3545ff97e4471cc8c8a86b34c14fd751aed7ffdabd765238819ee4c338829df9`。
- Nexus 审计记录批准 ID：`20261021T110217-rumdl-0.3.0`。
- 安装前核对仓库 SHA256、官方校验文件和审计记录中的 EXE SHA256，并确认归档内只有 `rumdl.exe`；解压到项目 `.tools/docs-audit/`。
- 该制品没有 Authenticode 签名。仓库审计记录中有针对这一精确版本和哈希的批准例外，不适用于其他版本。

## 来源约束与故障处理

- npm 命令必须同时带 `--registry=https://nexus.home.arpa/repository/npm-group/` 和 `--ignore-scripts`，任何方式都不得放行安装期生命周期脚本。
- 遇到缺包、`resolved` 指向 npm-group 以外、TLS 错误或仓库故障时，立即停止并报告包名、版本、仓库和错误原因，不使用其他来源。
- 来源与安装策略的核验不等于依赖漏洞或源码审计。

## 首次部署记录（2026-10-21 至 2026-10-22）

以下为首次部署时的历史情况，不代表其他机器的当前状态：

- Markdown 结构检查由 markdownlint-cli2 替换为 rumdl 0.3.0，不再保留前者的 npm 依赖或配置。
- 2026-10-21，在另外两个指定的 npm 版本补齐后，按上述两阶段流程安装：锁定 109 个依赖条目，全部 `resolved` 位于 npm-group 且均有 `integrity`，未发现声明安装生命周期脚本的条目。
- 当时的用户级、机器级环境已设置 `NODE_USE_SYSTEM_CA=1`，但执行安装的进程没有继承该变量，因此当时通过 `node --use-system-ca` 启动 npm 子进程完成安装。
- AutoCorrect、Vale、lychee 使用用户已有的安装，部署时没有重新下载，也没有核实其历史来源。
- 2026-10-22，六个 CLI 均已可用，所用 Node.js 为 22.19.0。
