# Wingman Codex Control

让 Grok Bot 管理同一台 Linux 电脑上、不同账号的 **现有 Codex 桌面会话**，并在任务结束后把结果回报给发起任务的 Bot。

这是基于 [juangurdian/wingman](https://github.com/juangurdian/wingman) 的扩展，保留上游 Git 历史与 MIT 许可证。原版说明见 [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md)。

## 功能

- 发现本机不同 Codex 配置环境，列出普通、归档、CLI 与子任务记录。
- 用 `账号::会话UUID` 选择目标，支持关键词搜索和账号筛选。
- 连接持有会话的现有桌面后端，向正在执行的任务追加指令、停止任务、继续原会话。
- 为带来源 Bot ID 的请求记录具体 turn，完成、失败或停止后自动回报给原 Bot。
- 持久保存通知队列，避免重复回报；发送结果不确定时保留 `uncertain` 状态，不自动重发。
- 核对当前账号的完整 Bot 名册后，自动清理已删除 Bot 的待发通知。隐藏、离线、名册不完整或切换账号不会被当作删除。
- 清理通知只取消回报订阅，不删除 Codex 会话，也不停止其任务。
- 提供持久 systemd 用户服务。安装仅启用 Wingman 服务，不添加 Codex/Grok Bot 桌面自启。

```text
Grok Bot 本地执行
      │
      ▼
wingman-codex CLI → 本机鉴权 MCP → 账号路由 → Codex 桌面会话拥有者
                                    │
                         具体 turn 完成 → 持久通知队列 → 原 Bot
```

## 环境

- Linux、systemd 用户会话、Node.js **24 或更新版本**、npm。
- 已安装并登录的 Codex 桌面。桌面插件、内部 IPC、SQLite 名册字段与当前已测试版本匹配。
- Grok Bot 具备访问这台电脑的本地执行通道；执行地点必须是用户电脑，而非云端沙箱。
- 回报使用本地 Grok Bot bridge。已安装对应 Noctalia bridge 的电脑可沿用；仓库也附带可单独运行的 companion。

桌面 IPC 和 Grok 的 React 客户端接口均非稳定公共 API，应用更新后可能需要适配。本扩展没有复刻官方手机客户端的全部设备配对、审批与插件功能。

## 安装

```bash
git clone https://github.com/pyrider3/wingman-codex-control.git
cd wingman-codex-control
npm ci --ignore-scripts
npm run build
node scripts/install.mjs --dry-run
node scripts/install.mjs
```

安装目录为 `~/.local/share/wingman-control/app`，状态目录为 `~/.local/state/wingman-control`。安装时生成本机随机密钥，仓库不包含任何密钥或会话数据。已有配置和通知队列会保留。

若 shell 找不到命令，请将 `~/.local/bin` 加入 PATH，或使用 `~/.local/bin/wingman-codex`。

```bash
systemctl --user status wingman.service
systemctl --user restart wingman.service
systemctl --user disable --now wingman.service
```

默认随用户管理器启动；若希望尚未登录桌面时服务也运行，可按需执行 `loginctl enable-linger "$USER"`。**手动打开 Codex 和 Grok Bot** 后，服务会自动发现相应实例。离线配置可列出和读取历史；任务控制需要对应 Codex 桌面运行。

### Grok Bot companion

已存在 `~/.local/state/noctalia-grok-bridge/bridge.sock` 时，无需另开 bridge。否则手动运行：

```bash
wingman-grok-bridge
```

它以调试管道启动 Grok Bot，提供只允许当前用户访问的本地 socket。Grok Bot 应通过该 bridge 启动；如果已通过其他方式打开，先自行退出该实例，再运行 companion。安装器不会自动启动或重启它。

可用 `GROK_BOT_BIN` 指定 Grok Bot 可执行文件。独立 companion 的代码与来源说明见 [integrations](integrations)。

## 使用

```bash
wingman-codex accounts
wingman-codex list --limit 20
wingman-codex list --account codex-account-2 --search '关键词'
wingman-codex list --archived true
wingman-codex select '账号::会话UUID'
wingman-codex selected
wingman-codex status
wingman-codex read --limit 20
wingman-codex send '请处理这个问题'
wingman-codex stop
wingman-codex resume '请继续'
```

命令也可直接带完整目标 ID：`wingman-codex send '账号::会话UUID' '消息'`。同时管理多个会话时建议每条命令都带 ID，避免共享的已选会话被另一条指令改变。裸 UUID 仅在全部账号中唯一时被接受。

`list` 不默认截断；`--limit` 会同时返回 total/matched/returned，不能把显示数量当作全机总数。`notLoaded` 表示未被桌面加载，不等于正在执行。任意自定义位置、尚未运行的配置不一定能被发现；启动对应桌面后可自动发现。

### 完成回报给原 Bot

发起请求时传来源 Bot ID 或唯一名称：

```bash
wingman-codex bots
wingman-codex send '账号::会话UUID' --bot 'Bot ID 或唯一名称' '请处理……'
wingman-codex resume '账号::会话UUID' --bot 'Bot ID 或唯一名称' '请继续……'
wingman-codex steer '账号::会话UUID' --bot 'Bot ID 或唯一名称' '补充要求……'
wingman-codex jobs
```

直接调用 MCP 时，`send_message` / `steer` 对应参数为 `origin_bot_id`。未标记来源的请求不自动通知，服务不会猜测收件 Bot。可以把以下约定告诉需要使用它的 Bot：

> 通过用户电脑的 wingman-codex 操作现有 Codex 会话。先列出并确认目标，发起请求时用 --bot 携带你自己的 Bot ID。收到完成回报后只向用户转述，未经新指令不要继续发起任务。发送结果不明时先查历史，不要自动重复发送。

已删除 Bot 的通知状态为 `recipient_deleted`，待发内容和摘要会清空；已送达记录保留。不把新建的同名 Bot 当作旧 Bot。旧记录缺少账号信息时，只在能确认原 Bot 存在的完整名册中补齐，不猜测删除。

**目前没有按 Bot 暂停通知的开关。** 口头说“不接收了”不会自动改变队列设置。

## 配置

可通过环境变量覆盖：

| 变量 | 用途 |
| --- | --- |
| `WINGMAN_STATE_DIR` | 本机状态目录 |
| `WINGMAN_CONFIG_PATH` | 密钥配置文件路径 |
| `CODEX_BIN` | 只读离线历史读取所用的 Codex 可执行文件 |
| `GROK_BOT_BIN` | companion 启动的 Grok Bot 可执行文件 |

本扩展 MCP 监听 `127.0.0.1:3847`，要求 Bearer 鉴权，不配置公网隧道。配置、数据库、日志、收据和会话清单都不应提交进 Git。

## 开发与验证

```bash
npm run build
npm test
npm run test:desktop
```

桌面扩展测试使用临时数据库和模拟名册，不删除真实 Bot，不触碰真实 Codex 任务。覆盖跨账号 UUID 歧义、具体 turn 匹配、通知去重与恢复、发送结果不确定、删除 Bot 清理、隐藏 Bot 和账号切换。

本机实测曾验证：跨账号读取，向现有活动任务追加指令，精确停止并继续原会话，任务完成后回报原 Bot。测试收据与任何私人会话内容均不包含在仓库中。

## 来源

- Wingman 原项目：<https://github.com/juangurdian/wingman>，MIT，见 [LICENSE](LICENSE)。
- Grok companion 与本机 Noctalia 集成代码的许可证见 [integrations/LICENSE](integrations/LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
