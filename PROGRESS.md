# PROGRESS（第一轮断点记录；当前状态以 HANDOFF.md 与 ACCEPTANCE.md 为准）

- [x] 阶段一 DESIGN_FORK.md
- [x] 四项确认：② ③ ④ 通过；① resume:false 进 inbox 不进 /message → 已定改为草稿方案（验收 3 改写）
- [x] 插件代码 + 构建 + 类型检查 + 单测
- [x] 数据层验收（scripts/verify-fork.ts，两组）
- [x] 安装到 ~/.config/opencode/opencode.jsonc（备份 opencode.jsonc.bak-session-fork-20261119）；plugin.list 显示 active
- [x] 删除全部测试会话（5 个，逐个 404 核实）
- [ ] 界面层验收（1/3界面/6/7/8运行时）：第一轮未点验；第四轮已在真机确认执行链、单行输入框、引用卡片（见 ACCEPTANCE「第四轮」），其余与第五轮写回待点验
- [x] 文档与本地提交

注意：访问 ~/Desktop/Code工作区/openclaw-inbox、permission-notify、/Applications 会触发授权弹窗（无人值守会卡 5 分钟），本会话未再访问。
