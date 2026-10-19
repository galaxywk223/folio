# Folio

Local desk for tasks and subscriptions. Windows Electron app that merges daily affairs (todos, notes, attachments) with structured API quotas and subscription tracking.

## Features

- Tasks, notes, attachments, recycle bin, backup/export
- API quotas (official / relay) with balance and entry links
- Subscriptions grouped as AI, network, or other, with expiry highlighting (≤14 days) and recorded auto-renewal status
- Local SQLite storage, no account required

## Development

```bash
npm install
npm run icon
npm run dev
```

Data during development is stored under `./data`. Packaged installs use `%LOCALAPPDATA%\Folio`.

`npm test` checks subscription migration, API fields, category filtering, recycle-bin behavior, backups, and Markdown export without opening the app.

## Build

```bash
npm run build
npm run dist          # 本地安装包，不发布
npm run dist:publish  # 构建并发布到 GitHub Releases
```

安装版会通过 GitHub Releases 自动检查更新；开发态侧栏会提示「仅正式安装版支持应用内更新」。

## Migration

On first launch Folio copies SQLite and attachments from Desktop `日常事务` when present. Existing API quotas and subscriptions are preserved; new databases start with empty quota and subscription lists, populated only by manually entered records.

Database version 3 adds subscription categories and nullable auto-renewal status. Earlier subscription records migrate to AI with auto-renewal unrecorded. The application restores Folio version 2 and 3 backups and legacy daily-affairs version 1 backups. Auto-renewal status is informational and does not trigger payments or renewals.
