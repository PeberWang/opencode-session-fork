# Fork 写回：摘要模型解析失败

## 现象

铭培 2026-11-24 16:52 在一个大 Fork 里做了大量讨论与编辑，关闭后主会话没有任何写回，也没弹确认框。日志有且只有这一行：

```
[2026-11-24 16:52:20.619] [info] [session-fork] writeback skipped (ses_df425f4c3ffe9XEngCzMkzPkUY): summary failed: Model not found: deepseek/deepseek-flash
```

## 已排除的

1. **关闭钩子正常**。日志说明它跑到了摘要生成这一步，跳过分支也正确执行了，不是没触发。
2. **模型与凭据本身可用**。用同一个模型手动调接口，两种写法都返回成功：

```sh
opencode api post /api/experimental/generate/text -d '{"prompt":"reply ok","model":{"providerID":"deepseek","id":"deepseek-flash"}}'
# → {"data":{"text":"ok"}}

opencode api post /api/experimental/generate/text -d '{"prompt":"reply ok","model":{"providerID":"deepseek","id":"deepseek-flash","variant":"none"}}'
# → {"data":{"text":"ok"}}
```

3. **字段名正确**。`Model.Ref` 的 schema 是 `{id, providerID, variant?}`，插件传的就是这三个。
4. **项目配置无覆盖**。Fork 所在项目 `retiring-officials-innovation/opencode.json` 只配了 MCP 与 instructions，没有 providers 或 model 覆盖。

## 怀疑的方向

插件调用 `client.experimental.generate.text` 时，服务端在**该会话所在目录**的上下文里解析模型，与手动调用时的默认目录不同。可能是 directory 作用域下 provider 解析路径不一致，或 variant 在该路径下被丢弃/判无效。

## 要做的

1. **加一行诊断日志**（只在失败时打，不要刷屏）：在 `src/gui.tsx` 的 generate 接线处，catch 里输出实际传给 API 的 model 对象与当前 directory：

```
[session-fork] generate failed: model={"providerID":"deepseek","id":"deepseek-flash","variant":"none"} dir=/path model=deepseek/deepseek-flash
```

2. **逐个试三种写法**，确认哪一种在该调用路径下能通：
   - `{providerID:"deepseek", id:"deepseek-flash", variant:"none"}`
   - `{providerID:"deepseek", id:"deepseek-flash"}`（去掉 variant）
   - `{providerID:"deepseek", id:"deepseek-v4-pro"}`
   把结论写进 HANDOFF。

3. **配置兜底**：如果某种写法稳定，就把它设为默认，并在 `writeback.model` 解析里对 `#none` 这类平台不认的 variant 做降级（丢掉 variant 重试一次，成功也不报错）。

4. **验证方式**：改完后让铭培在一个 Fork 里改一个文件、关闭，确认弹出确认框且写回成功。若仍失败，把新的诊断日志原文给我。

## 边界

- 只改 `opencode-session-fork`
- 不改 OpenCode 全局配置里的 provider 定义（今天已改过一处：插件 entry 改成对象形式、model 去掉 #none，可以用，但不要依赖它）
- 不扩大范围到 UI 或布局
- 已有 32 项测试必须继续全绿，新增失败分支的测试
- 失败时仍然绝不阻塞关闭，这是硬约束
