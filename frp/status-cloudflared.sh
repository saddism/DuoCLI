#!/bin/bash
# Cloudflare Tunnel 状态检查

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LSOF_BIN="$(command -v lsof || true)"
if [ -z "$LSOF_BIN" ] && [ -x /usr/sbin/lsof ]; then
    LSOF_BIN="/usr/sbin/lsof"
fi

CONFIG_FILE=""
for candidate in "cloudflared-config.local.yml" "cloudflared-config.private.yml" "cloudflared-config.yml"; do
    if [ -f "$candidate" ]; then
        CONFIG_FILE="$candidate"
        break
    fi
done

HOSTNAME=""
if [ -n "$CONFIG_FILE" ]; then
    HOSTNAME=$(sed -n 's/^[[:space:]]*-[[:space:]]*hostname:[[:space:]]*//p' "$CONFIG_FILE" | head -1 | tr -d '\r')
fi

echo "═══════════════════════════════════════"
echo "  Cloudflare Tunnel 状态"
echo "═══════════════════════════════════════"

# 检查 cloudflared 进程
echo ""
echo "📊 进程状态:"
if pgrep -f "cloudflared.*cloudflared-config" > /dev/null 2>&1; then
    CF_PID=$(pgrep -f "cloudflared.*cloudflared-config")
    echo "   ✅ Cloudflare Tunnel 运行中 (PID: $CF_PID)"
else
    echo "   ❌ Cloudflare Tunnel 未运行"
fi

echo ""
echo "🧩 配置文件:"
if [ -n "$CONFIG_FILE" ]; then
    echo "   $SCRIPT_DIR/$CONFIG_FILE"
    if grep -q "YOUR_TUNNEL_NAME\\|YOUR_TUNNEL_ID\\|/ABSOLUTE/PATH/TO/\\|duocli.example.com" "$CONFIG_FILE"; then
        echo "   ⚠️  当前仍是模板占位符，不能用于真实访问"
    fi
else
    echo "   ❌ 未找到配置文件"
fi

echo ""
echo "🔗 本地服务:"
# 检查 DuoCLI
if [ -n "$LSOF_BIN" ] && "$LSOF_BIN" -i :9800 > /dev/null 2>&1; then
    echo "   ✅ DuoCLI (9800): 运行中"
else
    echo "   ❌ DuoCLI (9800): 未启动"
fi

echo ""
echo "🌐 访问地址:"
if [ -n "$HOSTNAME" ]; then
    echo "   https://$HOSTNAME"
else
    echo "   未配置 hostname"
fi
echo ""
echo "═══════════════════════════════════════"
