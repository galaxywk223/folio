# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-11-04

- 「API 额度」更名为「额度」。
- 额度新增分类（AI / 网络 / 其他），列表顶部可按分类筛选，编辑器与详情页显示分类；「官方 / 中转」作为额度类型保留。
- 数据库升级到版本 4：已有额度记录自动归为 AI；仍可恢复版本 1–3 的旧备份。
- Markdown 导出的额度表格新增「分类」列。
- 仓库改为公开，安装版的自动更新可以正常访问 GitHub Releases。
- 补充 README、LICENSE 与本更新日志。

## [1.0.4] - 2026-10-19

- 界面重新设计：统一圆角、字号与配色，支持跟随系统的深色模式。
- 订阅、额度页顶部新增概览（到期提醒、已过期、自动续费等）。
- 订阅新增分类（AI / 网络 / 其他）与自动续费状态（数据库版本 3）。

## [1.0.3] - 2026-10-19

- 去掉窗口顶部默认的 File / Edit / View / Window 菜单栏。

## [1.0.2] - 2026-10-19

- 额度列表按余额排序，去掉列表头排序提示。
- 移除硬编码的服务示例数据，新数据库从空列表开始。

## [1.0.1] - 2026-10-18

- 视觉改版（圆角卡片 / 珊瑚橙）。
- 产品界面不再提供随手记与附件入口（数据仍保留在数据库和备份中）。

## [1.0.0] - 2026-10-17

- 首个正式版：日常事务与订阅合并，支持应用内更新。

[1.1.0]: https://github.com/galaxywk223/folio/releases/tag/v1.1.0
[1.0.4]: https://github.com/galaxywk223/folio/releases/tag/v1.0.4
[1.0.3]: https://github.com/galaxywk223/folio/releases/tag/v1.0.3
[1.0.2]: https://github.com/galaxywk223/folio/releases/tag/v1.0.2
[1.0.1]: https://github.com/galaxywk223/folio/releases/tag/v1.0.1
[1.0.0]: https://github.com/galaxywk223/folio/releases/tag/v1.0.0
