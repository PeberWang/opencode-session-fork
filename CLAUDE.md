# CLAUDE.md — opencode-session-fork

OpenCode Desktop 插件。在助手消息里划选一段文字，选择 Fork，把该段以及此前的上下文分叉成一个新会话，并与原会话并排显示。

## 硬约束

- 只在本仓库工作，不改 `/Applications/OpenCode.app` 内任何文件，不 patch app.asar。
- 不改其他插件仓库（openclaw-inbox、permission-notify、docket）。
- 不新增任务书以外的功能（不做分支树、不做历史管理、不做多级 fork 可视化）。
- 提交可以，推送不做。不改插件版本号除非任务书要求发版。
- 本机 OpenCode 版本 v2.2.7，插件 API 见 `@opencode/plugin` 2.2.7 的 `dist/gui/*.d.ts`。

## 参考实现

- `~/Desktop/Code工作区/openclaw-inbox` 是同类 GUI 插件的可用脚手架（vite + solid，`Plugin.define({ setup, main })`，dist 输出 `gui-experimental.cjs`）。
- `~/Desktop/Code工作区/permission-notify` 是用原生模块与宿主交互的先例。

## 交付规范

- 阶段一先出 `DESIGN_FORK.md`，写清在哪里扩展、证据、方案排序、风险，再动手写实现。
- 阶段二实现最小可用版本，附真机验收记录。
- 文档写给接手的人看，不写过程流水账。
