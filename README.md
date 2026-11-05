# Folio

Folio 是一个 Windows 桌面应用，把日常待办、额度和订阅集中在一个窗口里管理。所有数据都存在本机的 SQLite 数据库中，不需要注册账号，也不依赖任何云服务。

[下载最新版](https://github.com/galaxywk223/folio/releases/latest) · [更新日志](CHANGELOG.md) · [问题反馈](https://github.com/galaxywk223/folio/issues)

## 功能

- **待办**：有日期的事项排在前面，未定日期的随后；正文支持 Markdown，复选框会作为步骤勾选。完成的事项归档到「已完成」，步骤记录保留。
- **额度**：记录各平台的登录账号、余额、入口链接和备注。可以按分类筛选，用「官方 / 中转」区分来源，列表按余额从高到低排序。
- **订阅**：记录套餐、权益、费用、到期日和自动续费状态，同样可以按分类筛选。按到期日排序，14 天内到期的会高亮。自动续费只是一条记录，不会触发任何付款或续费。
- **管理分类**：额度和订阅各有一套分类，在列表顶部点「管理分类」就能新增、改名和删除。删掉一个分类后，其中的条目（包括回收站里的）会移到「其他」；「其他」本身不能删除。额度默认分类是 AI / 网络 / 其他，订阅默认是 AI / 开发与云 / 网络 / 办公 / 社交 / 其他。
- **回收站**：删除的条目可以随时恢复。
- **备份与导出**：一键生成带校验的完整备份（zip），也能从备份恢复，恢复前会自动备份当前数据。还可以把全部内容导出为 Markdown。
- **搜索**：`Ctrl+K` 同时搜索事项、额度和订阅。
- **自动更新**：安装版从 GitHub Releases 检查并安装新版本。
- 支持浅色和深色主题，跟随系统设置。

## 安装

1. 从 [Releases](https://github.com/galaxywk223/folio/releases/latest) 下载 `Folio-Setup-<版本>.exe`。
2. 运行安装程序。默认按当前用户安装，并创建桌面和开始菜单快捷方式。
3. 之后有新版本时，应用会在侧栏提示更新。

系统要求：Windows 10/11 x64。

## 数据存储

| 场景 | 位置 |
|---|---|
| 安装版 | `%LOCALAPPDATA%\Folio` |
| 开发环境 | 项目下的 `./data` |

目录里有数据库（`app/data/folio.sqlite`），以及 `附件`、`备份`、`导出` 等子目录。卸载时不会删除这些数据。

首次启动时，如果桌面上有旧版「日常事务」目录，Folio 会把其中的 SQLite 数据库和附件复制过来。已有的额度和订阅记录会保留；新建的数据库从空列表开始，只包含手动录入的记录。

### 数据库版本

| 版本 | 变更 |
|---|---|
| 1 | 旧版「日常事务」：事项、随手记、附件 |
| 2 | 新增额度与订阅表 |
| 3 | 订阅新增分类与自动续费状态；旧订阅归为 AI，自动续费记为「未记录」 |
| 4 | 额度新增分类；旧额度归为 AI |
| 5 | 额度新增账号；备注里恰好有一条独立的「账号：邮箱」行时，会把邮箱迁到账号字段 |
| 6 | 订阅分类改为可管理（`subscription_categories` 表） |
| 7 | 额度分类改为可管理（`quota_categories` 表），原有分类保持不变 |

应用启动时会自动把数据库升级到最新版本，也能恢复 Folio 2–8 版本的备份和旧版「日常事务」版本 1 的备份。

## 开发

需要 Node.js ≥ 22.12 和 npm ≥ 10。

```bash
npm install
npm run icon   # 生成应用图标
npm run dev    # 以开发模式启动
```

```bash
npm test       # 数据库迁移、额度/订阅字段、分类筛选、回收站、备份与导出相关测试，不需要打开应用
npm run typecheck
```

技术栈：Electron + React + TypeScript（electron-vite 构建），本地服务用 Express，存储用 Node 内置的 `node:sqlite`，打包和自动更新用 electron-builder / electron-updater。

```
src/
  main/       Electron 主进程与自动更新
  preload/    预加载脚本
  server/     本地 HTTP 服务、数据存储与迁移
  renderer/   React 界面
  shared/     主进程与界面共用的逻辑（分类、Markdown 解析、更新状态）
scripts/      图标生成与测试
```

## 构建与发布

```bash
npm run build          # 类型检查并构建
npm run dist           # 生成本地安装包到 release/，不发布
```

发布新版本：

1. 修改 `package.json` 里的 `version`，并在 `CHANGELOG.md` 中补上对应的更新内容。
2. 提交并推送到 `main`。
3. 运行 `npm run dist`，确认 `release/` 下有 `Folio-Setup-<版本>.exe`、`.exe.blockmap` 和 `latest.yml`。
4. 打标签并推送（`git tag v<版本> && git push origin v<版本>`），然后上传这三个文件并发布：

   ```bash
   gh release create v<版本> release/Folio-Setup-<版本>.exe release/Folio-Setup-<版本>.exe.blockmap release/latest.yml --title "Folio <版本>" --notes-file <发布说明> --latest
   ```

   也可以用 `GH_TOKEN=$(gh auth token) npm run dist:publish` 一步发布，但它偶尔会重复创建草稿，需要到 GitHub 上手动清理。

开发环境下侧栏会提示「仅正式安装版支持应用内更新」。

## 许可证

[MIT](LICENSE) © Wang Kai
