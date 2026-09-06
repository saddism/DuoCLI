-- AppleScript: DuoCLI Cloudflare Tunnel 启动器
-- 双击即可启动远程访问，无需打开终端

set frpPath to do shell script "/usr/bin/dirname " & quoted form of (POSIX path of (path to me))

-- 检查 DuoCLI 是否运行
try
	do shell script "lsof -i :9800 > /dev/null 2>&1"
	set duoCLIStatus to true
on error
	set duoCLIStatus to false
end try

if not duoCLIStatus then
	display alert "DuoCLI 未启动" message "请先启动 DuoCLI 桌面应用，然后再运行此启动器。" buttons {"知道了"} default button "知道了"
	return
end if

-- 检查 Cloudflare Tunnel 是否已在运行
try
	do shell script "pgrep -f 'cloudflared.*cloudflared-config' > /dev/null 2>&1 || pgrep -f 'cloudflared.*duocli-tunnel/config.yml' > /dev/null 2>&1"
	display notification "Cloudflare Tunnel 已经在运行中" with title "DuoCLI 远程启动器"
	return
on error
	-- 未运行，继续启动
end try

-- 启动 Cloudflare Tunnel（后台运行）
try
	do shell script "cd " & quoted form of frpPath & " && nohup ./start-cloudflared.sh > /dev/null 2>&1 &"
	
	-- 等待 3 秒检查是否启动成功
	delay 3
	
	try
		do shell script "pgrep -f 'cloudflared.*cloudflared-config' > /dev/null 2>&1 || pgrep -f 'cloudflared.*duocli-tunnel/config.yml' > /dev/null 2>&1"
		display notification "Cloudflare Tunnel 已启动，请在 DuoCLI 侧边栏查看公网地址" with title "DuoCLI 远程启动器"
	on error
		display alert "启动失败" message "Cloudflare Tunnel 未能正常启动，请检查网络连接与本地私有配置。" buttons {"确定"} default button "确定"
	end try
	
on error errMsg
	display alert "启动出错" message errMsg buttons {"确定"} default button "确定"
end try
