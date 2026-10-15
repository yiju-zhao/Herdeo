# Herdeo

**Herdeo = Herdr + Paseo。电脑上保留原生终端，手机上随时接手。**

Herdeo 把 Herdr 中启动的 Codex、Claude Code 和 Pi 会话接入 Paseo。终端和手机操作同一个原生进程与会话，使用 Paseo 的消息、工具卡片和授权组件展示交互。

当前版本：**0.2.1**。

## 工作方式

```text
Herdr 原生 CLI ←→ Herdeo ←→ 本机 Paseo daemon ←→ Paseo 手机/桌面客户端
```

每台运行 agent 的机器部署一份 Herdeo，并在 Paseo 中单独添加 Host。

| Agent | Herdr 界面 | Paseo Provider | 接入方式 |
| --- | --- | --- | --- |
| Codex | 原生 Codex TUI | Codex | 连接终端拥有的 app-server 和原生 thread |
| Claude Code | 原生 Claude TUI | Claude Code · 原生终端 | MCP Channels 与观察型 hooks |
| Pi | 原生 Pi TUI | Pi · 原生终端 | Pi 公共扩展 API |

接入已有桥接会话不会启动第二个模型执行进程。Paseo 新建原生会话时，Herdeo 会创建相应的 Herdr workspace，再连接该终端中的原生 CLI。

## 已实现

- Herdr 启动的桥接会话自动出现在 Paseo。
- 终端与 Paseo 双向发送消息，同步回复和工具结果。
- 原生 CLI 的界面、快捷键和本地交互保留。
- 转发支持的授权请求；Pi 的选择、确认和输入弹窗可从任一界面回答。
- CLI 退出后保留 Claude/Pi 的已保存历史；恢复原生会话时核对 provider、项目和原生 session ID。
- Claude/Pi 消息在持有原生 CLI 的宿主进程中按 `clientMessageId` 去重。
- 合并流式快照写入，正常退出时保存最终状态。
- 只读连接诊断，以及带文件校验清单的发布包。

## 环境

需要在目标机器上预先安装并登录需要使用的工具：

- Node.js 22 或更高版本、Git。
- Herdr、Paseo CLI、Codex、Claude Code、Pi。当前安装器会检查这五个命令。
- 手机远程访问时，两端加入可互通的 Tailscale 网络。

已验证的环境包括 macOS arm64 和 Linux arm64；工具版本包括 Herdr 0.9.3、Paseo 0.10.3 / 0.11.1、Codex 0.162.1、Claude Code 2.1.300、Pi 0.87.1。Claude Channels 属于实验性接口，升级 CLI 后需要重新检查兼容性。

## 安装

在**运行 agent 的目标机器**上执行。安装目录固定为 `~/.hb/app`：

```bash
git clone https://github.com/yiju-zhao/Herdeo.git "$HOME/.hb/app"
cd "$HOME/.hb/app"
npm ci
npm run build
node dist/scripts/release.js

# 将地址替换为目标机器自己的 Tailscale IPv4。
node dist/scripts/install.js --address 100.x.y.z
```

如果 Pi 已安装但尚未登录或选择模型，可以显式允许稍后配置：

```bash
node dist/scripts/install.js --address 100.x.y.z --allow-unconfigured-pi
```

随后在原生 Pi 中运行 `/login` 并选择模型。工具账户保留在目标机器，Herdeo 不自动复制另一台机器或另一种 CLI 的账户。

安装器会：

- 创建独立的 Herdr `paseo` session，以及绑定指定地址、使用 **6795** 端口的 Paseo daemon。
- 在 `~/.hb/` 保存私有配置、随机连接密码、日志和运行状态。
- 为 Herdr 新 shell 添加 `claude`、`codex`、`pi` 包装命令，并备份修改前的 shell 配置。
- 安装专属 launchd / systemd 用户服务，不重启已有的默认 Herdr 或其他 Paseo 实例。

已有部署不能再次运行安装器覆盖。Linux 长期无人登录的服务器还需确保用户服务能在注销后继续运行；安装器不替用户开启系统 lingering。

## 连接 Paseo

在目标机器私下运行：

```bash
~/.hb/bin/herdeo connection
```

在 Paseo 添加 Direct Host，填写该命令显示的 Host、端口和密码。当前安装方式通过 Tailscale 使用端口 6795，SSL 关闭。每台机器分别添加一个 Host，使用各自的密码。

`connection` 会显示私密密码；不要把它的输出提交到仓库或分享为公开日志。

## 日常使用

从普通 SSH shell 打开专属 Herdr 界面：

```bash
~/.hb/bin/herdeo attach
```

在 Herdr 的项目目录直接运行：

```bash
claude
codex
pi

# 在 Herdr 恢复原生 Claude 会话
claude --resume
```

已打开且没有加载新 PATH 的 shell 可以使用 `~/.hb/bin/claude`、`~/.hb/bin/codex` 或 `~/.hb/bin/pi`。

也可以创建一个新的 Herdr workspace：

```bash
~/.hb/bin/herdeo start claude --cwd /path/to/project
~/.hb/bin/herdeo start codex --cwd /path/to/project
~/.hb/bin/herdeo start pi --cwd /path/to/project
```

这些命令返回新 pane 的信息，不会切走当前 Herdr workspace。已有 `hb` 是兼容别名。在 Herdr 内只运行 `herdeo` 会显示使用提示，避免意外嵌套另一个 Herdr 界面。

在 Paseo 新建 Claude 或 Pi 时，选择表格中的 **原生终端** provider。Builtin Claude/Pi provider 为之前的 SDK 前端保留；选择它们仍会使用旧版文本界面。Codex 使用 builtin Codex provider。

Claude 每个新进程的开发 Channels 确认、目录信任和登录，都需要先在原生终端完成。Pi 也保留自己的启动与登录界面。Herdeo 不自动回答这些启动确认。

## 诊断

```bash
~/.hb/bin/herdeo doctor
~/.hb/bin/herdeo status --json
~/.hb/bin/herdeo doctor --all
~/.hb/bin/herdeo version
```

`doctor` 只读取状态，分别检查：

- Paseo 是否可连接并通过认证。
- Herdr 服务是否可达，原生进程是否仍位于原 pane。
- 通道是否就绪、等待初始化或已失效。
- Paseo 卡片是否可见、已归档或尚未注册。
- 当前任务是否空闲、执行中或等待授权。
- 发布文件是否通过完整性校验。

服务不可达会显示状态未知，不会直接推断 CLI 已退出。检查发生在服务器端；手机的 Tailscale 连接及保存的 Host 信息仍需正确。

## 归档和恢复

以下恢复逻辑用于 Claude/Pi 的原生终端 provider：

- Paseo 归档卡片只关闭该视图，原生 Herdr CLI 可以继续运行。
- 在 Paseo History 中 Unarchive 可恢复记录；已退出的 CLI 不会由 Paseo 自动启动。
- 在 Herdr 显式恢复同一原生会话后，Herdeo 根据项目与原生 session ID 重新连接。
- 仅归档 workspace 时，使用官方恢复 API 恢复原 workspace，并复用原卡片。
- 如果 project 本身已删除，原 workspace 无法恢复；Herdeo 为同一原生会话建立新卡片，保留原生上下文与桥接历史。旧记录保留归档状态。
- 其他恢复失败会显示错误，不会悄悄创建另一个执行进程。

删除 Paseo 记录与删除原生 CLI 历史是不同操作。Herdeo 不自动清除原生 CLI 的历史文件。

## 当前边界

- Paseo 支持向空闲的原生会话发送纯文本；图片、原生 slash commands、Claude 模型切换和其他高级控制请在 Herdr 中使用。
- Claude 远程授权要求真实 hook 提供完整且无歧义的工具参数，否则需在原生终端批准。
- 已在运行、且未通过 Herdeo 启动的普通 CLI 不能被事后无缝接管。
- 在原生进程内切换到另一段会话会使旧绑定失效；为新的会话重新启动桥接 CLI。
- Claude/Pi 去重覆盖同一宿主进程中的重试及 Paseo 重连；不承诺跨宿主崩溃或新 CLI 进程的 exactly-once 执行。
- 已运行的旧版 CLI 会保留旧版宿主逻辑，下次启动或 resume 后使用新版逻辑。
- Herdr 或整机重启会结束相应的 live executor，需要在原生终端恢复。

## 开发和验证

```bash
npm ci
npm run typecheck
npm test
npm run build
```

自动化测试需要 Python 3，用于真实 PTY 启动验证。当前有 **56 项回归测试**，覆盖原生界面、PID/session 绑定、Codex thread 路由、授权、流式历史、归档恢复、消息去重和只读诊断。

真实环境验证还覆盖 Codex、Claude 与 Pi 的双向交互。真实账户验证与隔离回归测试分开进行；不会由 `npm test` 向模型服务发请求。

v0.2.1 已补充真实 Codex 验证：Herdr 启动后自动注册、双向消息、流式输出、原生工具卡片，以及 Paseo 创建原生 Herdr 会话；两种启动方向都核对了原始 PID 和 thread ID。

`scripts/` 中保留了早期独立开发实例和手动验证脚本，部分依赖本地 `.dev/` 配置。不要把它们当作日常部署安装入口。

## 发布与升级

```bash
npm run release
```

命令运行类型检查、回归测试和构建，生成：

```text
.dev/releases/herdeo-<version>-<build>.tar.gz
.dev/releases/herdeo-<version>-<build>.tar.gz.sha256
release.json
```

发布清单记录运行代码、插件、依赖清单和文档的文件哈希。源码仓库不跟踪构建产物、私有配置或运行状态。

升级已有部署时，先备份 `~/.hb/app` 的代码，校验发布包，再应用到该目录。保留私有配置、密码、历史、运行状态及匹配的生产依赖。在现有部署环境中运行 `node dist/scripts/upgrade.js`，检查当前无执行中的任务或待处理授权后，仅重载 `herdr-bridge` 插件。CLI 不需要被强行退出。

插件 ID `herdr-bridge`、私有目录 `~/.hb` 和端口 6795 保留兼容。代码回滚恢复代码备份，不回滚用户数据，也不自动重启原生 CLI。
