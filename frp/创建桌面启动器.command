#!/bin/bash
# 创建 DuoCLI Cloudflare Tunnel 桌面启动器

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRP_DIR="$SCRIPT_DIR"
DESKTOP_DIR="$HOME/Desktop"
APP_NAME="DuoCLI远程启动.app"

cd "$FRP_DIR"

echo "======================================"
echo "  创建 DuoCLI 远程启动器"
echo "======================================"
echo ""

if ! command -v osacompile &> /dev/null; then
    echo "❌ 错误：无法找到 osacompile，请确保系统完整"
    exit 1
fi

echo "📦 正在生成 AppleScript 应用..."

osacompile -o "$DESKTOP_DIR/$APP_NAME" -x "DuoCLI-远程启动.scpt"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ 桌面启动器已创建！"
    echo "📍 位置: $DESKTOP_DIR/$APP_NAME"
    echo ""
    echo "使用方法："
    echo "  1. 确保 DuoCLI 桌面应用已启动"
    echo "  2. 双击桌面上的「DuoCLI远程启动」"
    echo "  3. 在 DuoCLI 侧边栏确认远程同步状态"
    echo ""
else
    echo "❌ 创建失败"
    exit 1
fi

echo "📝 同时创建备用启动脚本..."

cat > "$DESKTOP_DIR/DuoCLI远程启动.command" << EOFSCRIPT
#!/bin/bash
cd "$FRP_DIR"
./start-cloudflared.sh
EOFSCRIPT

chmod +x "$DESKTOP_DIR/DuoCLI远程启动.command"

echo "✅ 备用脚本已创建: $DESKTOP_DIR/DuoCLI远程启动.command"
echo ""
echo "按回车键退出..."
read
