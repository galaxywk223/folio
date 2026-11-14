# Folio

Folio 是一个 Windows 桌面应用，把日程、待办、额度和订阅集中在一个窗口里管理，也可以让本地智能体用 `folio` 命令直接读写。所有数据都存在本机的 SQLite 数据库中，不需要注册账号，也不依赖任何云服务。

[下载最新版](https://github.com/galaxywk223/folio/releases/latest) · [更新日志](CHANGELOG.md) · [问题反馈](https://github.com/galaxywk223/folio/issues)

## 功能

- **今天**：打开就是今天的日程、今天到期或已逾期的待办，以及 7 天内到期的订阅。
- **日程与提醒**：日程有日期、可选的开始/结束时间、地点和备注，可以每天或每周几重复。任何日程（重复或不重复）都能「跳过这一次」：不会提醒，列表里变灰并标「已跳过」，随时可以「恢复这一次」。每条日程可以设置提醒（准时，或提前 10、30 分钟、1、1.5、2 小时），到时间弹出 Windows 通知；订阅到期前 7 天和 1 天也会各通知一次。Folio 在托盘里运行就能收到。「日程」页按天列出今天起的全部日程（重复日程只展开未来两周）。
- **待办**：有日期的事项排在前面，未定日期的随后；正文支持 Markdown，复选框会作为步骤勾选。完成的事项归档到「已完成」，步骤记录保留。
- **额度**：记录各平台的登录账号、余额、入口链接和备注。可以按分类筛选，用「官方 / 中转」区分来源，列表按余额从高到低排序。
- **订阅**：记录套餐、权益、费用、到期日和自动续费状态，同样可以按分类筛选。按到期日排序，14 天内到期的会高亮。自动续费只是一条记录，不会触发任何付款或续费。
- **管理分类**：额度和订阅各有一套分类，分类竖着列在侧栏的「额度」「订阅」下面，点分类旁的齿轮就能新增、改名和删除。删掉一个分类后，其中的条目（包括回收站里的）会移到「其他」；「其他」本身不能删除。额度默认分类是 AI / 网络 / 其他，订阅默认是 AI / 开发与云 / 网络 / 办公 / 社交 / 其他。
- **Logo**：待办、日程、额度、订阅都可以设一张 logo（PNG、JPG、WebP、SVG 或 ICO，最大 1 MB），在编辑器里选图，或用 `folio logo` 命令设置。没设的条目显示首字母头像，英文取大写首字母，中文取第一个字。同一张图给多个条目用时只存一份。
- **回收站**：删除的条目可以随时恢复。
- **备份与导出**：一键生成带校验的完整备份（zip），也能从备份恢复，恢复前会自动备份当前数据。还可以把全部内容导出为 Markdown。
- **搜索**：`Ctrl+K` 同时搜索事项、日程、额度和订阅。
- **命令行 / 给智能体用**：`folio` 命令可以列出、查看、新建、修改、删除和恢复各类内容，输出 JSON，见下文「用命令行或智能体写入」。
- **改动记录**：应用内和命令行的每次新建、修改、删除、恢复都会记一条，能看到是谁（应用内 / 命令行）改了哪些字段。命令行写入后，打开的窗口几秒内会自动刷新。
- **托盘常驻**：关闭窗口后 Folio 留在系统托盘，单击托盘图标恢复窗口，右键菜单「退出」才真正退出。
- **自动更新**：安装版从 GitHub Releases 检查并安装新版本。
- 支持浅色和深色主题，跟随系统设置。

## 安装

1. 从 [Releases](https://github.com/galaxywk223/folio/releases/latest) 下载 `Folio-Setup-<版本>.exe`。
2. 运行安装程序。默认按当前用户安装，并创建桌面和开始菜单快捷方式。
3. 之后有新版本时，应用会在侧栏提示更新。

系统要求：Windows 10/11 x64。

## 用命令行或智能体写入

安装版第一次启动时会把 `folio` 命令加到当前用户的 PATH（卸载时移除），之后新开的终端里就能用。Folio 没在运行时，命令会自动在后台启动它（只进托盘，不弹窗口）。

```bash
folio help                 # 全部命令
folio help event           # 日程的全部字段、可选值和例子
folio today
folio list event --from 2026-11-01 --to 2026-11-30
folio add event --title "家教：初一数学" --date 2026-11-07 --start-time 19:00 --end-time 21:00 --repeat weekly --repeat-days 5 --reminder-minutes 90
folio add task --title "提交推免材料" --date-text "2026-11-10 17:00前"
folio update subscription 2699d9a8 --expires-at 2026-12-31
folio logo subscription 2699d9a8 ./logos/claude.png   # 设置 logo；--remove 移除
folio skip 98d9c89c --date 2026-11-16      # 跳过某一次；folio unskip 恢复
folio log --limit 10
```

- 输出都是 JSON；出错时在 stderr 输出 `{"error": "…", "code": "…"}`，退出码为 1。错误信息会说明哪里不对、可以填什么。
- 多行或带引号的内容用 `--json -`，把 JSON 从标准输入传进去，例如 `echo '{"title":"…","date":"2026-11-07"}' | folio add event --json -`。
- id 可以写唯一前缀（至少 6 位）；`category` 可以直接写分类名，比如「AI」「云服务」；修改时只需要给出要改的字段。
- 给智能体用时不需要专门的提示词：让它先运行 `folio help` 和 `folio help <类型>`，就能知道怎么写。写入的内容可以在「改动记录」里核对。

命令行通过 Folio 的本地服务（只监听 127.0.0.1）读写，和界面用的是同一套接口与校验。

## 数据存储

| 场景 | 位置 |
|---|---|
| 安装版 | `%LOCALAPPDATA%\Folio` |
| 开发环境 | 项目下的 `./data` |

目录里有数据库（`app/data/folio.sqlite`），以及 `附件`、`图标`（logo 图片）、`备份`、`导出` 等子目录。卸载时不会删除这些数据。

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
| 8 | 分类支持排序 |
| 9 | 新增日程（`events`）和改动记录（`activity_log`） |
| 10 | 待办、日程、额度、订阅新增 `logo` 列；图片存放在 `图标` 目录，备份时一起打包 |

应用启动时会自动把数据库升级到最新版本，也能恢复 Folio 2–10 版本的备份和旧版「日常事务」版本 1 的备份。

## 开发

需要 Node.js ≥ 22.12 和 npm ≥ 10。

```bash
npm install
npm run icon   # 生成应用图标
npm run dev    # 以开发模式启动
```

```bash
npm test       # 数据库迁移、各类字段、日程重复与提醒、回收站、备份与导出、改动记录和 folio 命令的测试，不需要打开应用
npm run cli -- help   # 构建并运行开发版 folio 命令（需要先用 npm run dev 打开应用，并用 FOLIO_DATA_DIR 或 --data-dir 指向 ./data）
npm run typecheck
```

技术栈：Electron + React + TypeScript（electron-vite 构建），本地服务用 Express，存储用 Node 内置的 `node:sqlite`，打包和自动更新用 electron-builder / electron-updater。

```
src/
  main/       Electron 主进程、托盘、提醒通知与自动更新
  cli/        folio 命令行
  preload/    预加载脚本
  server/     本地 HTTP 服务、数据存储与迁移
  renderer/   React 界面
  shared/     主进程、界面和命令行共用的逻辑（分类、Markdown 解析、日程重复与提醒、字段说明、更新状态）
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
