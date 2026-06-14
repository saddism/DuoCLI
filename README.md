# DuoCLI

Desktop and mobile-synced terminal for AI coding CLIs, including Claude Code, Codex, GitHub Copilot CLI, Devin, OpenCode, Kiro, and custom commands.

## Features

- 🌊 **Streaming SSE proxy** – Local HTTP endpoint for IDE integration
- 💬 **Interactive chat** – `duo chat` for quick terminal conversations
- 🔍 **Built-in AI CLI presets** – Start Claude Code, Codex, GitHub Copilot CLI, Devin, OpenCode, Kiro, or custom commands
- ⚙️ **Persistent config** – `duo config` to set defaults

## Quick Start

```bash
# Install globally
pnpm install -g duocli

# Start chatting
duo chat

# Start proxy server for IDE integration
duo serve --port 8787

# GitHub Copilot CLI preset used by the desktop and mobile UI
copilot --allow-all --autopilot
```

## Configuration

```bash
# Show current config
duo config --show

# Auto-detect and save
duo config --detect
```

## Architecture

```
IDE (Cascade-compatible)
    │
    ▼
┌──────────────┐
│  DuoCLI Proxy │  ← HTTP/SSE on localhost:8787
└──────┬───────┘
       │
       ▼
   Claude Code / Codex / GitHub Copilot CLI / custom CLI
```

## Development

```bash
pnpm install
pnpm build
pnpm start
```
