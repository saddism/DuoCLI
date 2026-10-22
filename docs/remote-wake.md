# macOS 远程访问时启动 DuoCLI

公网请求经过 Cloudflare Tunnel → `127.0.0.1:9801` 的后台入口 → DuoCLI 的 `9800` 服务。
后台入口没有请求时不会启动 App；请求到达时发现 `9800` 未监听，使用 macOS `open -g` 启动指定的 DuoCLI.app，等待就绪，再转发请求。多个同时到达的请求共用一次启动。

本机持续开发时，先安装[固定源码启动入口](./local-source-launcher.md)，让桌面和远程唤醒都打开 `~/Applications/DuoCLI.app`。这个 App 每次冷启动自动构建当前本地源码，不需要反复更新打包 App；安装器会把该入口的构建等待时间设为 90 秒。

入口只监听本机回环地址。HTTP、流式响应和 WebSocket 原样转发，访问令牌仍由 DuoCLI 验证。启动最多等待 25 秒；失败返回 HTTP 503，可稍后重试。电脑需要开机、联网并处于已登录的用户会话；此方案不负责唤醒睡眠或关机的电脑。

## 安装

先准备可运行的 DuoCLI.app 和独立于 App 的 Cloudflare Tunnel LaunchAgent。下面命令默认只预览安装范围，路径和域名需替换成当前机器的实际值：

```sh
node scripts/install-remote-wake.mjs \
  --app /absolute/path/DuoCLI.app \
  --hostname your-domain.example.com \
  --config /absolute/path/private-tunnel-config.yml \
  --node /opt/homebrew/bin/node
```

追加 `--apply` 执行。若项目私有配置和用户目录配置都可能被使用，分别传入两个 `--config`。安装器只修改指定域名的 `http://127.0.0.1:9800` 路由，改为 `9801`，并保留私有配置备份。

入口脚本复制到 `~/.local/lib/duocli/`，避开 LaunchAgent 读取 Documents 目录时的隐私权限限制。LaunchAgent 为 `~/Library/LaunchAgents/com.duocli.remote-wake.plist`，登录时启动并在异常退出后重启，日志为 `~/.config/duocli-tunnel/remote-wake.log`。更新入口脚本后重新执行安装器即可。

安装器会禁用旧的 `com.kaifeng.duocli-app` 常驻守护，避免它在按需启动时同时打开开发版 App。如果旧守护仍加载，安装器会先停止执行，以免终止它管理的终端会话；需先处理该守护，再安装。

修改路由后，需要重启使用这些配置的隧道进程；保持 DuoCLI 和现有终端会话运行。只重启已确认属于该配置的进程，不使用宽泛的 `pkill`。如果同时存在系统隧道和 App 启动的隧道，两者都需要读取新路由。

## 验证

```sh
node --test tests/remote-wake-gateway.test.mjs
DUOCLI_WAKE_TEST_APP=/absolute/path/DuoCLI.app node tests/e2e/remote-wake-macos.e2e.mjs
```

第二个测试在独立端口、独立用户数据目录和独立手机配置目录启动真实 App，验证首次请求启动成功、页面可访问、没有恢复现有终端、接口仍要求令牌，然后只停止该独立实例。不会退出当前正在使用的 DuoCLI。

部署后分别检查本地入口和公网首页；`launchctl print gui/$(id -u)/com.duocli.remote-wake` 查看后台状态。真实主客户端退出后的公网唤起，可在终端工作保存完毕后手动退出 App 再访问域名验证。

## 回退

安装器输出的 `~/.config/duocli-tunnel/remote-wake-backup-*/manifest.json` 记录每个原文件与备份的对应关系。卸载后台入口可执行 `launchctl bootout gui/$(id -u)/com.duocli.remote-wake`，然后 `launchctl disable gui/$(id -u)/com.duocli.remote-wake` 防止登录重启。按 manifest 恢复对应隧道配置，重启已确认属于这些配置的隧道。

旧 App 守护原先处于启用状态时，可用 `launchctl enable gui/$(id -u)/com.kaifeng.duocli-app` 恢复启用。安装器不删除原守护、凭证、App 或终端数据。
