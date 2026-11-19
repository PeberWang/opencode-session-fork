# PROGRESS（断点记录，换会话接手时先读）

- [x] 阶段一 DESIGN_FORK.md
- [x] 四项确认：② ③ ④ 通过；① resume:false 进 inbox 不进 /message → 已定改为草稿方案（验收 3 改写）
- [x] 插件代码 + 构建 + 类型检查 + 单测
- [x] 数据层验收（scripts/verify-fork.ts，两组）
- [x] 安装到 ~/.config/opencode/opencode.jsonc（备份 opencode.jsonc.bak-session-fork-20261119）；plugin.list 显示 active
- [x] 删除全部测试会话（5 个，逐个 404 核实）
- [ ] 界面层验收（1/3界面/6/7/8运行时）：需桌面端加载插件后人工点验，清单见 ACCEPTANCE.md
- [x] 文档与本地提交

注意：访问 ~/Desktop/Code工作区/openclaw-inbox、permission-notify、/Applications 会触发授权弹窗（无人值守会卡 5 分钟），本会话未再访问。
