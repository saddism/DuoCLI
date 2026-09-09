-- DuoCLI 一键启动器：拉取最新源码，停掉旧打包版，再启动当前仓库。
-- 桌面 .app 由此脚本编译；勿再指向 release/mac-arm64/DuoCLI.app。

set projectPath to system attribute "DUOCLI_PROJECT_DIR"
if projectPath is "" then
	set scriptPosix to POSIX path of (path to me)
	set projectPath to do shell script "/usr/bin/dirname " & quoted form of scriptPosix
end if

-- 桌面副本：脚本不在仓库内时，回退到本机固定项目目录（用户名从 HOME 取，避免硬编码）
try
	do shell script "test -f " & quoted form of projectPath & "/scripts/start-latest.sh"
on error
	set projectPath to (system attribute "HOME") & "/Documents/myDev/DuoCLI"
end try

try
	do shell script "test -f " & quoted form of projectPath & "/scripts/start-latest.sh"
on error
	display alert "DuoCLI 启动脚本不存在" message (projectPath & "/scripts/start-latest.sh")
	return
end try

set logPath to "/tmp/duocli-start.log"
set startCommand to "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH; /usr/bin/nohup /bin/bash " & quoted form of (projectPath & "/scripts/start-latest.sh") & " >>/dev/null 2>&1 &"

do shell script startCommand
display notification "正在拉取最新源码并启动 DuoCLI（日志 /tmp/duocli-start.log）" with title "DuoCLI"
