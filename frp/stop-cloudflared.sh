#!/bin/bash
# 停止 Cloudflare Tunnel

echo "🛑 正在停止 Cloudflare Tunnel..."
pkill -f "cloudflared.*cloudflared-config" 2>/dev/null
pkill -f "cloudflared.*duocli-tunnel/config.yml" 2>/dev/null
sleep 1
if pgrep -f "cloudflared.*cloudflared-config" > /dev/null 2>&1 || pgrep -f "cloudflared.*duocli-tunnel/config.yml" > /dev/null 2>&1; then
    pkill -9 -f "cloudflared.*cloudflared-config" 2>/dev/null
    pkill -9 -f "cloudflared.*duocli-tunnel/config.yml" 2>/dev/null
fi
echo "✅ Cloudflare Tunnel 已停止"
