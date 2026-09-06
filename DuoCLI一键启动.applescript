-- DuoCLI 一键启动器：运行与本脚本同目录下的项目源码。
-- 首次使用：若脚本不在仓库根目录，请设置环境变量 DUOCLI_PROJECT_DIR

set projectPath to system attribute "DUOCLI_PROJECT_DIR"
if projectPath is "" then
	set scriptPosix to POSIX path of (path to me)
	set projectPath to do shell script "/usr/bin/dirname " & quoted form of scriptPosix
end if

set logPath to "/tmp/duocli-start.log"

try
	do shell script "test -f " & quoted form of projectPath & "/package.json"
on error
	display alert "DuoCLI 项目不存在" message projectPath
	return
end try

set startCommand to "cd " & quoted form of projectPath & " && export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH && /usr/bin/nohup npm start >> " & quoted form of logPath & " 2>&1 &"
do shell script startCommand
display notification "正在编译并启动最新 DuoCLI" with title "DuoCLI"
