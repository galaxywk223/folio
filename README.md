# Folio

Local desk for tasks and subscriptions. Windows Electron app that merges daily affairs (todos, notes, attachments) with structured API quotas and AI subscription tracking.

## Features

- Tasks, notes, attachments, recycle bin, backup/export
- API quotas (official / relay) with balance and entry links
- AI subscriptions with expiry highlighting (≤14 days)
- Local SQLite storage, no account required

## Development

```bash
npm install
npm run icon
npm run dev
```

Data during development is stored under `./data`. Packaged installs use `%LOCALAPPDATA%\Folio`.

## Build

```bash
npm run build
npm run dist          # 本地安装包，不发布
npm run dist:publish  # 构建并发布到 GitHub Releases
```

安装版会通过 GitHub Releases 自动检查更新；开发态侧栏会提示「仅正式安装版支持应用内更新」。

## Migration

On first launch Folio copies SQLite and attachments from Desktop `日常事务` when present, and seeds API quotas / subscriptions from the former `网站与服务` records.
