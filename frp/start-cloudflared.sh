#!/bin/bash
# Cloudflare Tunnel 启动脚本 - DuoCLI
# 将本地 DuoCLI (端口 9800) 穿透到你本机私有配置中的域名

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

if [ -z "$CONFIG_FILE" ]; then
    echo "❌ 找不到 Cloudflare 配置文件。"
    echo "请先创建以下任一文件："
    echo "   frp/cloudflared-config.local.yml"
    echo "   frp/cloudflared-config.private.yml"
    exit 1
fi

HOSTNAME=$(sed -n 's/^[[:space:]]*-[[:space:]]*hostname:[[:space:]]*//p' "$CONFIG_FILE" | head -1 | tr -d '\r')
if grep -q "YOUR_TUNNEL_NAME\\|YOUR_TUNNEL_ID\\|/ABSOLUTE/PATH/TO/\\|duocli.example.com" "$CONFIG_FILE"; then
    echo "❌ Cloudflare 配置仍是模板占位符：$CONFIG_FILE"
    echo "请填写 tunnel、credentials-file 和真实 hostname 后再启动。"
    exit 1
fi

# 检查 DuoCLI 是否已启动（端口 9800）
echo "正在检查 DuoCLI 服务状态..."
if [ -z "$LSOF_BIN" ] || ! "$LSOF_BIN" -i :9800 > /dev/null 2>&1; then
    echo "⚠️  警告：DuoCLI 服务（端口 9800）未启动！"
    echo "请先启动 DuoCLI 桌面应用，然后再运行此脚本。"
    echo ""
    read -p "是否仍要继续启动 Cloudflare Tunnel？(y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 检查是否已运行
if pgrep -f "cloudflared.*cloudflared-config" > /dev/null 2>&1; then
    echo "✅ Cloudflare Tunnel 已经在运行中，无需重复启动。"
    exit 0
fi

# 检查 cloudflared 是否安装
if ! command -v cloudflared &> /dev/null; then
    echo "❌ cloudflared 未安装，请先运行: brew install cloudflared"
    exit 1
fi

echo "🚀 正在启动 Cloudflare Tunnel..."
if [ -n "$HOSTNAME" ]; then
    echo "🔗 映射: 本地 9800 -> https://$HOSTNAME"
else
    echo "🔗 映射: 本地 9800 -> 你的 Cloudflare 域名"
fi
echo "🧩 配置文件: $CONFIG_FILE"
echo ""

# 启动 cloudflared（后台运行，日志追加到 cloudflared.log）
# 当前网络环境下 QUIC 经常超时，固定走 http2/TCP 443。
nohup cloudflared tunnel --protocol http2 --config "$CONFIG_FILE" run >> cloudflared.log 2>&1 &

sleep 3
if pgrep -f "cloudflared.*cloudflared-config" > /dev/null 2>&1; then
    echo "✅ Cloudflare Tunnel 已启动"
    if [ -n "$HOSTNAME" ]; then
        echo "🌐 手机访问地址: https://$HOSTNAME"
    fi
else
    echo "❌ Cloudflare Tunnel 启动失败，请查看 cloudflared.log"
fi
