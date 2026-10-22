# 本机固定启动入口

本机开发 DuoCLI 时，使用 `~/Applications/DuoCLI.app` 或桌面的 `DuoCLI.app`。这两个图标和 `DuoCLI一键启动.command` 都调用项目的 `scripts/start-latest.sh`。远程唤醒也打开这个固定 App。

每次在 App 已退出的情况下打开，入口使用 Node.js 20 编译当前本地工作区、复制页面资源，构建成功后启动 Electron。因此本地修改无需重新打包或更换图标。App 已运行时重复打开只激活窗口；修改代码后需要通过 Cmd+Q 正常退出，再打开。仅关闭窗口不会退出后台服务。

固定 App 会通过已有的终端启动流程运行构建，终端可留在后台；构建完成后显示 DuoCLI 窗口。若另一个旧入口已经占用远程端口，启动会停止并提示先正常退出旧客户端，以保护其中的终端会话。

入口不会拉取远程代码、stash、切换分支或强行终止终端。这里的“最新版”指当前本地代码，不代表 GitHub 的最新提交。编译失败会停止启动，不会回退到旧构建。修正代码后再次打开即可重试，日志在 `/tmp/duocli-start.log`。

项目需保留在安装时的路径，依赖需已安装。移动项目或换电脑时，重新安装一次入口：

```sh
node scripts/install-source-launcher.mjs          # 预览
node scripts/install-source-launcher.mjs --apply  # 安装
```

安装器更新用户 Applications 和桌面入口，存在远程唤醒任务时更新其 App 路径，将构建等待时间设为 90 秒，并只重启该唤醒任务。不会改隧道配置、退出 DuoCLI 或删除旧打包 App。原入口和配置保存在 `~/.config/duocli-tunnel/source-launcher-backup-*/`，对应关系见 `manifest.json`。

不要使用 `release/mac-arm64/DuoCLI.app` 作为本机开发入口；那是构建时的代码快照，适合分发。安装器会取消它的旧系统登记并登记固定入口。

验证：

```sh
node --test tests/source-launcher.test.mjs tests/remote-wake-gateway.test.mjs
```
