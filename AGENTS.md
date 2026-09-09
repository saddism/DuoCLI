# Repository Guidelines

## Project Structure & Module Organization
DuoCLI combines an Electron desktop workspace with a mobile PWA.
- `src/main/`: PTY sessions, restoration, remote HTTP/WebSocket services, and Android integration.
- `src/preload/`: the `window.duocli` IPC bridge.
- `src/renderer/`: desktop panes, terminal UI, HTML, and CSS.
- `mobile/client/`: mobile application, service worker, browser assets, and helper tests.
- `tests/`: unit/integration tests, `fixtures/terminal/`, and Puppeteer scenarios in `e2e/`.
- `native/android-media/`: optional Go media helper; `scripts/`: build utilities; `frp/`: tunnel configuration; `docs/`: design and release documentation.
Build output goes to `dist/`; installers go to `release/`.

## Build, Test, and Development Commands
Use Node.js 20, matching release CI.
- `npm install` — install dependencies.
- `npm run rebuild` — rebuild native modules for Electron after setup or ABI changes.
- `npm start` — compile, copy renderer assets, and launch Electron.
- `npm run build:ts` — compile main/preload with TypeScript and bundle the renderer with esbuild.
- `npm run test:unit` — compile the main process and run Node tests.
- `npm run test:e2e` — run mobile and desktop browser scenarios; `npm test` runs both suites.
- `npm run build:mac`, `build:win`, or `build:linux` — package platform installers.
- `npm run build:android-media` — build the optional helper; requires Go.

## Coding Style & Naming Conventions
Follow adjacent code: two-space indentation, single quotes, and semicolons in TypeScript/JavaScript. Use kebab-case filenames, camelCase functions/variables, and PascalCase types/classes. TypeScript uses strict mode. No dedicated formatter or lint script is configured. Keep changes focused and preserve main/preload/renderer boundaries.

## Testing Guidelines
Tests use `node:test` and `node:assert/strict`; browser scenarios use `puppeteer-core`. Name tests `tests/*.test.mjs`, mobile helpers `*.test.cjs`, and browser scenarios `*.e2e.mjs`. Add behavioral regression coverage for fixes. No numeric coverage threshold is configured. E2E requires installed Chrome/Chromium; set `CHROME_PATH` or `PUPPETEER_EXECUTABLE_PATH` if detection fails.

## Commit & Pull Request Guidelines
History commonly uses `feat:`, `fix:`, `chore:`, and `ci:` prefixes, with English or Chinese summaries. Follow that pattern with a concise description. PRs should explain the problem, resulting behavior, validation commands/results, and relevant issues. Include screenshots for desktop or mobile UI changes. Preserve unrelated uncommitted work.
