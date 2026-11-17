# WhaleLife 原生代码改动说明

> 整理时间：2026-11-15　｜　改动范围：仅 `core/` 与 `config/config.json`，不含任何第三方插件。
> 环境：Windows 11 / Node v24.21.0 / WhaleLife 本地部署于 `<WhaleLife 根目录>`。
> 目的：让 WhaleLife 在本地作为主对话环境时，能显示工具产出的图片与语音、修掉两处交互与协议误判。以下每条都可独立回退。

---

## 一、改动总览

| # | 文件 | 类型 | 摘要 | 影响面 |
| --- | --- | --- | --- | --- |
| 1 | `core/llm.ts` | 协议兼容 | 不再按模型名推断是否要求 `reasoning_content`；兼容 `reasoning` 别名字段 | 所有 thinking 模型 + 工具调用 |
| 2 | `core/web.ts` | 新增端点 | `GET /api/media`：鉴权 + 根目录白名单 + 扩展名白名单 | Web 控制台 |
| 3 | `core/ui/app.js` | 渲染 | 支持 `[[img:路径]]` / `[[voice:路径]]` 标记；流式回复改为增量更新 | 对话页 |
| 4 | `core/ui/app.js` | 交互修复 | 重绘前才判断"是否贴底"；`context` 事件不再整页重绘 | 对话页滚动 |
| 5 | `core/ui/styles.css` | 样式 | 去掉 `scroll-behavior: smooth`；新增媒体与"思考中"样式 | 对话页 |
| 6 | `config/config.json` | 配置 | 新增 `web.media_roots`，允许媒体端点读取表情库等外部目录 | 启动校验 |

---

## 二、逐项说明

### 1. `core/llm.ts` — 思考模式判定过宽

**现象**

使用第三方 OpenAI 兼容网关（本例为 MiraRouter）时，只要模型名形如 `deepseek-*`，带工具的请求就会失败：

```
回复失败：思考模式工具响应缺少 reasoning_content，未执行本次工具调用
```

**原因**

`thinkingToolHistory()` 的判定是：

```ts
return provider.parameters?.thinking?.type === "enabled" ||
  host === "api.deepseek.com" || /^deepseek[-/]/i.test(provider.model ?? "");
```

最后那半句按模型名猜测"该模型一定会返回思考内容"。但实测该网关的流式 `delta` 只有 `role` / `content` / `tool_calls` 三个字段，没有 `reasoning_content`，于是主干判定为协议缺失并中断工具调用。

实测请求（`stream: true` + 一个 function tool）返回的 delta 字段集合：

```
{role, content, tool_calls}
```

**改动**

```ts
// 只有官方端点或显式开启 thinking 时才强制要求 reasoning_content；
// 第三方网关常把思考段吞掉或不返回，按模型名猜会误判。
return provider.parameters?.thinking?.type === "enabled" || host === "api.deepseek.com";
```

另外在解析处兼容别名字段：

```ts
const reasoningDelta =
  typeof delta?.reasoning_content === "string" ? delta.reasoning_content
    : typeof delta?.reasoning === "string" ? delta.reasoning
      : undefined;
if (reasoningDelta) reasoning = (reasoning ?? "") + reasoningDelta;
```

**兼容性**

- 官方 `api.deepseek.com`：行为不变（仍强制要求）。
- 显式 `thinking.type = "enabled"`：行为不变。
- 第三方网关：不再因缺 reasoning 中断；若网关给了 `reasoning` 别名，也能正确记录。
- 风险点：若某网关确实要求回传 reasoning 却没返回，主干不会提前拦截，错误会推迟到下一次请求。是否保留这层"提前拦截"的判断，需要作者定。

### 2. `core/web.ts` — 新增 `GET /api/media`

工具（表情、语音）产出的本地文件无法在对话页显示，因为 Web 层只服务 `/`、`/ui/*` 与 JSON API，没有文件出口。

新增路由，位于鉴权之后、`/api/logs` 之前：

- 参数：`?path=<绝对路径>`
- 白名单：`memory/`、`plugins/`，外加 `config.web.media_roots` 中声明的目录
- 类型白名单：png / jpg / jpeg / gif / webp / wav / mp3 / ogg
- 响应头：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`
- 越界返回 403，不支持的类型返回 415，文件不存在返回 404

**原因**

表情库位于 AstrBot 数据目录，不在 WhaleLife 项目内，所以需要配置项扩展白名单：

```json
"web": {
  "media_roots": ["C:\\Users\\<用户>\\.astrbot\\data\\plugin_data\\meme_manager\\packs"]
}
```

**安全考虑**

- 端点强制登录（沿用现有 cookie token 校验）。
- 路径 `resolve` 后做前缀比对，禁止 `..` 穿越。
- 只认扩展名白名单，避免把任意文件当文本吐出。
- 仍有一个已知边界：白名单内任何文件都可读取，若白名单指向过宽的目录（例如整个用户目录），风险由配置承担。

**建议**：如果作者愿意收编这个端点，建议把 `media_roots` 做成正式配置项并加上大小上限（例如单文件 20 MB）。

### 3. `core/ui/app.js` — 媒体标记渲染

工具返回的文本里可以携带：

```
[[img:绝对路径]]
[[voice:绝对路径]]
```

前端把这两类标记渲染成 `<img class="msg-media">` 与 `<audio class="msg-audio" controls>`，其余文本仍然整体 `escapeHTML` 后再替换标记，避免 XSS。

```js
function renderRich(text) {
  const media = (path) => `/api/media?path=${encodeURIComponent(path)}`;
  return e(text)
    .replace(/\[\[img:([^\]]+)\]\]/g, (_, path) =>
      `<img class="msg-media" src="${media(path.replace(/&amp;/g, "&"))}" alt="图片" loading="lazy">`)
    .replace(/\[\[voice:([^\]]+)\]\]/g, (_, path) =>
      `<audio class="msg-audio" controls preload="none" src="${media(path.replace(/&amp;/g, "&"))}"></audio>`);
}
```

**为什么用标记而不是结构化附件**

流式回复是纯文本增量，用标记可以不改动消息协议与历史存储格式；渲染时再解析，历史回放同样生效。若作者更倾向结构化附件，这一层可以整体替换。

### 4. `core/ui/app.js` — 两处滚动/重绘修复

**4.1 重绘后回不到原位、或停在顶部**

`renderMessages()` 里原本在 `box.innerHTML = ...` **之后**才计算"用户是否贴底"。但给 `innerHTML` 赋值会把 `scrollTop` 重置为 0，此后再算，永远不会判定为贴底，于是停在顶部。

改法：把判断提前到赋值之前，并补一帧修正（图片/音频加载会改变高度）：

```js
const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || !box.childElementCount;
box.innerHTML = ...;
if (nearBottom) {
  box.scrollTop = box.scrollHeight;
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}
```

**4.2 每轮回复开始时整页重绘**

服务端在每轮开始会推一个 `context` 事件，前端原来收到就 `this.render()`，整页重建，消息列表被清空重排，滚动位置归零。

改法：只在 `contextReset` 为真（人格真的切换）时才重绘；平时只更新状态字段。

**4.3 流式增量**

原来每个 `chunk` 都整段重建消息列表。改为只更新最后一条回复气泡（`patchReply()`），并保持"仅当用户在底部时才跟随滚动"。

```js
this.reply.text += data.text;
if (this.state.page === "chat") { this.patchReply(); return; }
```

**4.4 思考中提示**

发送后、首字到达前，在消息流末尾插入一个临时气泡（三个点 + 「思考中」），收到首个 `chunk` 时移除。

### 5. `core/ui/styles.css`

- `.messages` 的 `scroll-behavior: smooth` 改为 `auto`。平滑滚动会让每次重绘都"从头顶滑到底"，视觉上像被拖着跑。
- 新增：

```css
.msg-media { display: block; max-width: min(360px, 100%); margin-top: 8px; border-radius: 10px; }
.msg-audio { display: block; width: min(320px, 100%); margin-top: 8px; }
.bubble.thinking { display: inline-flex; align-items: center; gap: 5px; color: #8a8f98; }
.bubble.thinking i { font-style: normal; animation: think-dot 1.2s infinite ease-in-out; }
/* …三点与文字的 keyframes，见文件末尾… */
```

### 6. `config/config.json`

新增 `web.media_roots`（数组，绝对路径）。未配置时媒体端点只允许项目内的 `memory/` 与 `plugins/`。

---

## 三、需要作者确认的四点

1. **reasoning 判定策略**：改为"只认官方端点或显式开启"，是否会影响作者对第三方网关的预期行为？是否需要保留一个更强的校验开关？
2. **`/api/media` 是否收编**：目前是本地补丁。若收编，建议加单文件大小上限、可选的目录白名单默认值，以及更严格的 MIME 探测（不只依赖扩展名）。
3. **消息标记语法**：`[[img:路径]]` 与 `[[voice:路径]]` 是临时约定。若作者计划做原生附件消息，这一层应替换，而不是并存。
4. **thinking 气泡的呈现**：现在只有文字与三个点，没有语气词轮换。是否要跟作者既有的 UI 语言统一。

---

## 附：一条功能建议（非此次改动）

### 建议支持 MCP client，作为与外部 agent 对话的标准通道

**背景**：本地同时运行了 AstrBot（带完整插件生态与记忆库）与 WhaleLife。希望 WhaleLife 能把一个问题转给 AstrBot 的 agent，再拿回答案，并且能延续上下文。当前只能走 AstrBot 的 HTTP OpenAPI（`POST /api/v1/chat`）——能用，但每次都要自己处理鉴权、会话 id、SSE 解析与超时重试。

**现状核对**（2026-11-15，对应 commit `631fbca`）：

- 仓库 177 个文件中无任何 MCP 相关模块；
- `architecture/` 五份文档零提及 MCP / A2A；
- issues 中搜 `MCP` 为 0 条；
- 仓库里现有的 “桥” 是 `plugin-rpc.ts` 与 `plugin-http-bridge.ts`，服务于宿主与插件子进程之间的调用，不对外。

**建议形态**：在主干增加 MCP client（连接管理 + 工具发现 + 生命周期），让插件或对话可以声明「连接某个 MCP server」。这样两端不必互相写适配器：AstrBot 已支持 MCP，WhaleLife 一旦有 client，能力就能双向流动。

**最小可行边界**（供参考，避免一次性做太大）：

- 只支持 stdio 与 streamable HTTP 两种传输；
- 连接配置放在 `config`，支持启停；
- 工具清单进入 `ctx.tools`，命名加前缀（如 `mcp__<server>__<tool>`）避免撞名；
- 连接失败只影响该 server，不牵连主干；
- 对外发起的调用沿用现有 `danger` 判定与 `signal` 取消。

**替代方案**：若短期不打算做 client，也可以把 WhaleLife 的插件能力封成 MCP server，让 AstrBot 侧作为 client 调用——方向相反，但对生态同样有价值。

---

## 四、验证情况

| 项目 | 结果 |
| --- | --- |
| 修改后启动 | 正常，`核心就绪`，6 个外部插件全部 active |
| `/api/media` 读表情图 | 200，`image/jpeg`，89 KB |
| `/api/media` 读语音 wav | 200，`audio/wav`，198 KB |
| `/api/media` 越界读 `C:\Windows\win.ini` | 403 |
| `thinkingToolHistory` 三种场景 | MiraRouter → false；官方 DeepSeek → true；显式开启 → true |
| 前端语法 | `node --check` 通过 |
| 滚动与思考气泡 | 人工确认正常（无平滑滚动、结束后不再跳顶） |

---

## 五、备份与回滚

改动前的原文件均留有副本，命名规则为 `<原文件名>.bak-kan-<YYYYMMDD-HHMMSS>`，位于同目录：

- `core/llm.ts.bak-kan-*`
- `core/web.ts.bak-kan-*`
- `core/ui/app.js.bak-kan-*`
- `core/ui/styles.css.bak-kan-*`

回滚方式：把对应 `.bak` 文件覆盖回原名，重启主干即可。`config/config.json` 中新增的 `web.media_roots` 可整键删除，不影响启动。

---

## 六、未改动但值得记录的两处

1. **插件工具异常会撤销整个插件**：`plugin-worker.ts` 把工具抛出的异常视为插件故障（`fault`），一次报错会让该插件的所有工具入口消失，之后调用统一报「工具不存在」。这对插件作者不太友好，建议在文档里明确写出"工具必须自行收口异常"。
2. **`approval` 仍是空实现**：`permission.ts` 的 `approval.request()` 固定返回未批准，`danger` 不为 `safe` 的工具在 `ask` 模式下无法执行。文档已注明 M0 限制，此处仅确认现状。

---

## 七、流程缺口：改完 `config/config.json` 之后，控制台里无法重启

### 现象

改一项必须在启动时读入的配置（本次是 `config.timezone`：`Asia/Shanghai` → `Australia/Brisbane`），文件已经改对、JSON 校验通过，但当前进程仍在用旧值。Web 控制台没有任何重启入口，页面上也看不出「配置已改、尚未生效」这件事，容易误判为改动失败。

### 试过、都不成立的三条路

1. **刷新页面**：不成立。刷新只让前端重连，`core/index.ts` 的进程与读配置的时机都没变。
2. **平台自带的启动脚本**（`启动WhaleLife.bat`）：不成立。脚本开头先探测 9270 端口，若已在监听就只打开浏览器然后退出——恰恰是「正在运行，需要重启」这个场景下它什么都不做。
3. **让 agent 自己重启**：缺原语。进程结束的瞬间，正在生成的回复也随之消失，调用方收不到任何结果，所以无法在对话内闭环；而且没有可用的 detached 子进程 spawn 接口。

唯一可行的绕法是在外面写一个独立脚本（结束占用 9270 的进程 → 等端口释放 → 重新 `node core/index.ts`），并且依赖几个平台细节：Windows 下 cmd 默认按 GBK 读批处理，脚本必须存成 GBK 才不乱码；日志要落到项目内可写目录，否则 `>>` 重定向在目录尚不存在时静默失败。

### 建议（按成本从低到高）

- **最小改动**：给 `启动WhaleLife.bat` 加一个 `--force` / `/restart` 参数，跳过端口探测，直接结束占用者再启动。
- **推荐**：主干加 `POST /api/restart`（沿用现有 cookie token 鉴权）。实现要点：先回 202，延后约 1 秒再自我结束；重启命令必须用 detached 子进程（Windows 上 `detached: true` + `stdio: "ignore"` + `unref()`，否则父进程一死子进程跟着没），或者交给外部 supervisor 拉起。当前进程的最后一行写进 `logs/`，供重启后核对是否真的起来了。
- **配套**：UI 上显示「配置文件已变更，需要重启才生效」——只要记录启动时读到的 mtime/hash，与磁盘上的比一下就能判断。这条比按钮本身更重要，能消掉大半误判。

### 一个相关但不同的点

`hands` 类插件把 `restart`、关机等命令列进拒绝清单，这是保护用户机器的合理设计，不是能力缺口；但它也意味着「让 agent 重启自己」这条路在设计上就是关的，上面那个端点应当只对**操作者本人**开放，不要暴露成 agent 可调用的工具。

---

## 八、模型分级路由（功能新增，非修补）

### 一、这是什么

按回合内容自动选择模型档位，用判官（judge）把每条用户消息分成 HIGH / MID / FAST 三档，映射到配置里三个模型池，省成本也省时延。移植自 AstrBot 的 `astrbot_plugin_judge`（魔改版），按使用者指定的档位配置：

| 档位 | 用途 | 模型 |
| --- | --- | --- |
| FAST | 闲聊、寒暄 | `mr-deepseek-v41-none`（不思考） |
| MID | 一般任务、低级思考 | `mr-deepseek-v41-low`（低推理） |
| HIGH | 多步推理、写代码 | `mr-gpt-61-sol`（低推理），仅 20% 概率真放行 |
| 判官 | 只输出一个词的分类器 | `mr-claude-haiku-55` |

### 二、为什么落在主干，而不是做成插件

两处过不去的墙，都在现有架构里：

1. **事件系统只通知、不拦截**。`plugin-events.ts` 写明 `Notifications run after their source operation`——钩子跑在源操作完成之后，没有“回合开始前”这个位置。插件拿不到能在发请求之前改写路由的入口。
2. **模型在回合开始时解析一次**。`session.ts` 每轮走 `persona()` → `resolveChatModel()`，优先 `personas[id].model`，缺省用 `model_bindings.chat`；一个回合从头到尾只有这一个 provider，中途没有换模型的接口。

所以“按提问内容挑模型”只能在 `persona()` 之后、发请求之前插一刀。若日后给插件层加上 `before-turn` 这类可拦截、可改写上下文的钩子，这段逻辑可以整体搬出去。**这是本次改动里对上游最有参考价值的一点**。

### 三、改动位置

- **新增** `core/model-router.ts`（约 350 行，自包含，除 `resolveModel` 外无主干依赖）
- `core/index.ts`：构造 `ModelRouter`，挂进服务，随开关热读
- `core/session.ts`：`persona()` 之后、发请求之前调用 `route()`，命中则用返回的 provider 覆盖本轮；transient 回合（内部工具调用）不路由，避免内部活儿也去问判官
- `config/config.json`：新增 `model_router` 段

原文件均备份为 `.bak-kan-20261115-route`。

### 四、配置段

```json
"model_router": {
  "enabled": true,
  "judge_model": "mr-claude-haiku-55",
  "pools": { "fast": "...", "mid": "...", "high": "..." },
  "high_ratio": 20,
  "fallback_decision": "MID",
  "rule_prejudge": true,
  "skip_judge_after_fast": true,
  "carry_seconds": 600,
  "carry_max_chars": 24,
  "cache_ttl_seconds": 600,
  "cache_max_entries": 500,
  "judge_timeout_ms": 4000,
  "simple_max_chars": 20
}
```

`enabled: false` 即刻退出，行为与该功能不存在时一致；`route()` 返回 `null`，沿用人格默认模型。

### 五、判档流程

1. **规则预判**（`rule_prejudge`）：长文、代码块、强关键词、短问号句，命中即定档，不调模型。
2. **决策缓存**：同文本命中缓存（默认 600 秒），跳过判官。
3. **连续闲聊沿用**（`skip_judge_after_fast`）：上一轮判成 FAST、间隔在 `carry_seconds` 内、且本句不超过 `carry_max_chars`，直接沿用 FAST，不调判官。
4. **判官**：输出单个词，8 token，`judge_timeout_ms` 超时；解析不出就进保底。
5. **保底**：`fallback_decision`（默认 MID）。
6. **预算**：判成 HIGH 也只有 `high_ratio`% 的机会真的用高级池，其余降到 MID。

### 六、已知代价

**判官调用是这次改动唯一的新增延迟。** 实测一次约 1.6 秒。规则命中的句子（闲聊、短问、代码块）不走判官，所以日常对话基本无感；但“有点内容、又没命中任何关键词”的句子会明显慢半拍。若不能接受，可考虑把判官换成更快的本地小模型，代价是判得糙一点。

### 七、移植时修掉的一处逻辑缺陷

原插件把日常词（`今天`、`明天`、`天气`、`几点`、`你好` 等）放在强关键词之前**全量命中**，只要句子里出现就判 FAST。结果是：

> `今天帮我把桌面上那个 bat 改一下` → FAST（本应 MID/HIGH）

长句里的“今天”多半只是时间状语。改法：日常词只在**短句**（默认 20 字，`simple_max_chars` 可调）且**不含强/弱复杂关键词**时才生效。改后同一句落 MID（`kw:改一下:soft`），而“今天天气怎么样”“今天累不累”仍是 FAST。

这条建议回馈给插件原作者：**规则预判里日常词应当做长度与共现约束，而不是无条件命中。**

### 八、验证

| 用例 | 结果 |
| --- | --- |
| `在吗` | FAST（规则，1ms） |
| `今天天气怎么样` / `今天累不累` | FAST（规则） |
| `嘶还是我来重启吧` | 规则不命中 → 判官 1.6s → FAST |
| `为什么进程杀不掉` | MID soft |
| `今天帮我把桌面上那个 bat 改一下` | MID（修复前为 FAST） |
| 连续三句闲聊 | 后三句 `carry`，不再调判官 |
| 判成 HIGH 跑 40 次 | 高级池 6 次 / 中档 34 次（≈15%，符合 20% 预算） |
| `tsc --noEmit` | 通过 |

## 九、网页端图片上传（功能新增，非修补）

### 原状：不是"发不出去"，是没有通道

查过三层，三处都缺：

- **前端**：`views.js` 的输入区只有一个 `<textarea>`，`sendMessage()` 只读 `#chat-input` 的文本，任何图片都被丢掉。
- **传输**：WebSocket 只发 `{session, expectedSession, text, persona}` 四个字段；服务端 `wss` 的 `maxPayload` 是 65536，连一张截图都传不进来。
- **服务端**：`/api/media` 只处理 GET，用来读已经存在的文件；没有上传入口。`channels.web` / `sessions.chat` / `runChat` 整条链路都是 `text: string`。

也就是说：多模态的能力其实已经有了（工具返回的图片走 `tool-content.ts`，`ChatContentPart` 支持 `image_url` data URI），缺的只是"人这一侧"没有入口。

### 改动

新增的入口保持最小，不动既有链路语义：

1. **前端**
   - 输入区加"图片"按钮，同时支持**粘贴**和**拖拽**（`bindImageComposer`）。
   - 选了图先进待发区，可单张移除；超过 4 张、格式不对、解码失败一律 `toast` 明说，不静默丢弃。
   - 超过 1600px 或 2MiB 才重编码（`shrinkImage`，PNG 保持 PNG）；小图原样送，避免截图里的文字被二次压缩糊掉。
   - 发送时把 `images` 与文本一起放进 WebSocket 帧；本地气泡先用 data URL 显示，刷新后走历史。

2. **服务端 `web.ts`**
   - `maxPayload` 65536 → 32MiB。
   - 新增 `saveUploads()`：校验数量/MIME/大小 → **复用 `toolContentSnapshot()` 做文件头与 MIME 一致性校验**（PNG/JPEG/WebP）→ 落盘到 `memory/uploads/<sessionId>/<时间戳>-<n>.<ext>`。
   - 落盘后把路径以 `[[img:...]]` 标记追加到用户文本里，历史与刷新后的渲染都靠它；同时把图片字节作为独立参数传给 `channels.web`。
   - 限制：一次最多 4 张、单张 4MiB、合计 8MiB。会话 ID 只接受 `[A-Za-z0-9_-]`，防路径穿越。

3. **签名透传**
   - `channels.web(id, text, onChunk, onContext, expectedPersona, images?)` → `generate()` → `sessions.chat(..., queue, images?)` → `runChat(..., input?, images?)`。
   - 只在 `assemble()` 组装真正要发的那条 `user` 消息时展开成 `[{type:"text"}, {type:"image_url", image_url:{url:"data:...", detail:"auto"}}]`。

4. **预算安全（这一条是必须的）**
   - `capacity()` 原来用 `JSON.stringify(assembled(...))` 估 token。base64 data URI 会直接把它撑爆，导致上下文预算算成负值、触发不必要的压缩甚至拒答。
   - 改成 `promptText(assembled(...))`——项目里本来就有这个函数，它会把 `image_url` 段替换成 `[图片：token用量由模型服务报告]`。这样所有估算路径都看不到 base64，只有最后一刻发请求时才展开。其余调用点（`promptText(assembled())`）本来就已经走这个函数了。

### 给作者的建议

- **多模态入站值得做进主干**，而不是让每个通道插件自己做一遍。现在 `tool-content.ts` 已经统一定义了图片块的校验与转换，只要在 `ChannelRoute` 或 `chat()` 这一层接受一个 `images` 参数，就能让所有通道共享同一套限制和同一套 MIME 校验。
- **持久化建议改成结构化字段**：目前是把路径写进文本（`[[img:...]]`），优点是零迁移、历史渲染直接可用；缺点是模型读历史时只能看到路径，看不到图。若要"之后还能回看图片内容"，得在事件行上加 `media: [{path, mimeType, bytes}]`，并在 `renderHistory` 里对老图做降级描述。
- **`maxPayload` 是硬卡点**：65536 对纯文本够用，对任何媒体都不够。建议把 WebSocket 的 payload 上限做成配置项，并给出默认值与拒绝时的明确错误，否则前端只会看到连接被关掉。
- **估算函数要成对出现**：凡是用 `JSON.stringify(messages)` 估 token 的地方，都该有一个 `promptText` 式的降级版本；这次就是因为只在一个地方直接 `JSON.stringify`，才差点被图片撑爆。

### 九之一、剪贴板裸位图（粘贴截图解码失败）——甲方实战反馈

上线当晚就撞上：用户用微信截图（Alt+A）复制，在输入框 Ctrl+V，前端提示"图片无法解码"。文件选择器选图正常，只有粘贴这条路断。

**查到的原因**：抓了那一刻的剪贴板，可用格式是 `QQ_Unicode_RichEdit_Format, HTML Format, Preferred DropEffect, FileDrop, FileNameW, FileName, System.Drawing.Bitmap, Bitmap, DeviceIndependentBitmap, Format17`——**没有注册 `PNG` 格式，只有 CF_DIB / CF_DIBV5**。浏览器拿不到现成 PNG，只能自己从 DIB 合成一个 `Blob`（类型标为 `image/png`），而这批合成出来的字节经 `new Image()` 解码失败。同一份画面上限并没有问题（2037×1449，另存为 PNG 正常），所以不是尺寸或内存，是那条合成路径本身不可靠。

**修法**（`core/ui/app.js`，只动前端）：

1. 解码拆成三层链，任一成功即止：`createImageBitmap(file)` → `<img src=dataURL>` → 若识别为裸 DIB 则补 14 字节 `BITMAPFILEHEADER` 转成 BMP 再试前两层。
2. `dibToBmp()` 的判定：头四字节是 40/108/124（`BITMAPINFOHEADER`/V4/V5）、位深 24 或 32、`biCompression === 0`。满足才修补，不满足不动。BMP 的像素偏移写成 `14 + headerSize`。
3. 修补出来的位图不信任原始 data URL：一律走 canvas 重编码成 PNG，并且在画之前先铺白底。原因是 32bpp DIB 没有 `BI_ALPHABITFIELDS` 时 alpha 字节无意义（常见全是 0），不铺白底会得到一张全透明图。
4. 输入白名单加了 `image/bmp`，提示语同步改成"PNG、JPEG、WebP、BMP"。
5. 失败时的报错带上了实际拿到的东西：`图片无法解码（image/png，214 KB）——剪贴板给的图数据常是残缺的，改用「图片」按钮直接选文件试试`。带 MIME、带大小、带"是不是修补过裸位图"，下次再出问题不用重头猜。

**给作者的建议**：

- 网页端做粘贴入口，别假设 `clipboardData.files[0]` 一定是可解码的图片。Windows 上大量截图工具（微信、QQ、部分终端）只往剪贴板放 CF_DIB，浏览器得到的是二手合成数据，格式标签与真实字节不一定对得上。稳妥做法是：按魔数嗅探再决定解码器，而不是信 `file.type`。
- 裸 DIB 补文件头这招很便宜（十几行），值得写进通用工具函数。它同时能兜住"用户直接选了 .bmp 文件"的情况。
- 报错信息里塞进 MIME + 字节数 + 修复尝试，是这次能一次定位的原因；反之如果只吐"图片无法解码"四个字，得从头复现。建议凡是媒体入站的失败路径都这么写。

### 验收

- `tsc --noEmit` 通过；`node --check` 过前端两个模块。
- 落盘路径、标记渲染、预算降级三处均按上述方式核对。

## 九之二、粘贴图片的第二道兜底：直接问 Windows 要位图

**背景**：上面那三层解码修补之后，微信截图仍然失败。复核时确认报错文案来自**旧版**代码（全新文案带 MIME 和字节数），说明前端模块没被重新加载；但也意味着**浏览器侧的 DIB 合成路径本身不可依赖**——它是 Chromium 内部行为，没有规范保证，也没法调试。

**改法**：不再试图在浏览器里修那张坏图，改为在失败时回头问系统要原始位图。

- 新增 `core/clipboard-image.ps1`：`-STA` 取 `[Windows.Forms.Clipboard]::GetImage()`，用 GDI+ 存成 PNG，base64 打到 stdout。取不到图时输出 `NOIMAGE`，异常输出 `ERROR:`。必须 `-STA`，否则剪贴板 API 直接抛。
- 新增 `POST /api/clipboard-image`（`core/web.ts`，走既有 cookie 鉴权）：`execFile` 调上面那个脚本，15s 超时、`windowsHide`、`maxBuffer` 64MiB，成功回 `{ dataUrl }`，`NOIMAGE` 回 409。
- 前端（`core/ui/app.js`）：`addImages(files, source)` 增加来源参数，粘贴路径传 `"paste"`。解码失败时先不弹提示，改调上面那个接口，拿到 PNG 后当作普通文件重新走 `shrinkImage`；这条也失败才把两条错误拼成一条报出来。粘贴入口同时放宽：`file.type` 为空但有字节的文件也收下（部分工具就是不给 MIME）。

**为什么不在服务端解码原字节**：项目里没有 `sharp`，本机也没有可用的 Python；Node 侧要解 DIB 就得自己写位深和调色板处理。GDI+ 是这台机器上现成的、唯一靠得住的解码器，走系统剪贴板比走字节流短。

**给作者的建议**：

- 「浏览器解码失败 → 由宿主回取同一份剪贴板」这条兜底很值得内建。它把平台差异关在一个小脚本里，且不依赖浏览器的 DIB 合成实现。
- `core/clipboard-image.ps1` 是 Windows 专属。跨平台版本应该按 `process.platform` 分派：macOS 走 `osascript`/`pbpaste`，Linux 走 `xclip -selection clipboard -t image/png -o`。接口形状可以不变，都是「给我剪贴板里的图」。
- 剪贴板读取存在**时序假设**：用户粘贴到前端失败、前端再请求后台去读剪贴板，这中间剪贴板内容必须没变。正常操作下成立，但如果用户在这几秒里复制了别的东西，拿到的就是错的图。更严格的做法是前端把原始字节一起送上来，后台只在「字节解不开」时才补读剪贴板，并比对尺寸做一次自检。

## 十、网页对话界面的两处体验修正

**背景**：迁移完成后，用户反馈两条——(1) 消息里的截图按原始尺寸铺开，一张 2037×1449 的图直接把对话区撑满，左侧目录被挤到几乎看不见；(2) 左侧段落目录的标题被截成固定 26 字，看不出这一段在说什么。

**改法**（只动前端静态文件，不涉及主干逻辑）：

- `core/ui/styles.css`：新增 `.bubble img` 统一约束——`max-width: min(320px,100%)`、`max-height: 220px`、`object-fit: cover`、加 `cursor: zoom-in`。之前只有 `.msg-media` 一条规则，而 markdown 图片、工具回传图片走的是别的渲染路径，类名对不上，等于没约束。
- `core/ui/app.js`：装一个全局灯箱 `installImageZoom()`，点气泡里任意图片开全屏遮罩看原图，再点一次或按 Esc 关闭。
- `core/ui/app.js`：`segmentLabel()` 不再自己截断，返回完整首句；目录项显示前 12 字加省略号，完整摘要放进 `title`，悬停即见，并附「N 条 · 第 M 条起」的定位信息。

**给作者的建议**：

- 消息里的媒体元素应该只有一处渲染入口。现在 markdown 图、`[[img:]]` 标记、工具回传图各走各的，样式规则很容易漏。建议在 `renderRich` 出口统一给媒体节点加类名，样式只管一个类。
- 各种 `slice(0, N)` 式的截断应该和展示层分开：数据层保留全文，截断只发生在渲染时，并且把全文挂到 `title` 或 `aria-label` 上。否则一段话的重要信息常常正好落在第 27 个字。

## 十一、左侧导航轨：两条紫线的问题

**背景**：把左栏改成「刻度 + 悬浮卡」之后，用户反馈滚动时紫色刻度和实际对话对不上，窗口一改尺寸还会同时出现两条紫线。

**成因**（两处，都在前端 `core/ui/app.js`）：

1. 轨道上有两套指示互相独立。`.chat-rail-cursor` 是一条按 `scrollTop / (scrollHeight - clientHeight)` **线性插值**的游标；`.chat-rail-tick.active` 则是逐个比较消息节点位置（`node.top - box.top <= 40`）挑出来的。线性插值和真实消息位置不成比例——一条长回答会把后面的内容整体压低——两者必然错位，看着就像"对不上"。
2. 刻度的纵向排布用的是 `flex: 1 1 auto` **等分**，位置本身就不是按消息位置来的。窗口缩放、`rail.clientHeight` 变化后，插值游标立刻跳到别处，而等分刻度不动，于是同一屏里出现两处紫。

**改法**：

- 删掉 `.chat-rail-cursor` 元素和它的 CSS，只保留刻度一种指示，「当前」就由那一格刻度变紫、变长表示。
- 刻度改为 `position: absolute` + `transform: translateY(-50%)`，`top` 由 `syncRail()` 按**消息在滚动内容里的真实偏移**算：`(node.top - box.top + box.scrollTop) / box.scrollHeight`，再映射到轨道可用高度（扣掉上下 12px 内边距）。
- 高亮取「离当前滚动比例位置最近的那一格」，因此任何时刻只有一格是紫的，且它的纵向位置与滚动位置一致。
- 补三个重排触发点：`scroll`、`window.resize`，以及 `ResizeObserver` 监听消息容器——图片加载完会把后面内容整体推下去，只靠 scroll 事件追不上。
- 悬停不再用紫色（改成灰色加宽），免得和「当前」混淆。

**给作者的建议**：

- 一个滚动指示上不要同时叠「线性插值游标」和「按节点判定的高亮」。两者语义不同，比例也不同，迟早会错位。要精度就用节点位置，要平滑就用插值，选一个。
- 绝对定位 + 真实偏移 比 `flex` 等分更能反映文档结构，且天然适配容器尺寸变化。等分只在「每项高度相同」时等价。
- 内容高度会异步变化的场景（图片、代码块、字体加载）不能只监听 `scroll`；`ResizeObserver` 是这里唯一稳的触发源。

## 十二、轨道等距、图片缩略、剪贴板兜底，以及「这些为什么只能落主干」

**现象**：三件事收尾——左侧轨道刻度按节数等距排开；对话里的图片收成缩略图、点击才看原图；微信截图粘贴后浏览器解不出码，改从系统剪贴板取。

**改动**：`core/ui/app.js`、`core/ui/styles.css`、`core/web.ts`、新增 `core/clipboard-image.ps1`。

1. **轨道等距**。刻度位置不再按消息在滚动内容里的真实偏移算，改成按节的序号等距排开（最小间距 6px，挤不下整体压短并上下居中）。紫线仍是「离当前滚动位置最近的那一格」，任何时刻只有一条。这一点要说明白：等距之后刻度只表示「第几节」，不再代表滚动实况。视觉整齐和位置真实，只能选一个。
2. **图片缩略**。原来只有 `.msg-media` 一条约束规则，而 markdown 图、`[[img:]]` 标记、工具回传的图走的是另外两条渲染路径，类名对不上，等于没有约束，大图会按原始尺寸铺开，把对话区整个撑满。改成在媒体容器上统一约束（320×220，超出裁剪），点击打开遮罩看原图，Esc 关闭。
3. **剪贴板兜底**。微信截图复制进剪贴板后，可用格式是 `System.Drawing.Bitmap` / `DeviceIndependentBitmap` / `Format17`，**不含 PNG**。浏览器只能自己把 DIB 合成成 PNG，而合成结果解码失败。改法：前端解码失败时回调 `POST /api/clipboard-image`，服务端起 GDI+ 从剪贴板直接取位图存 PNG。这条同时把 `file.type` 为空但有字节的情况也收下来了。

**给作者的建议**：

- **前端被写死了，插件接不进来**。`core/web.ts` 里的 `assets` 是一个手写的 Set，只有 11 个文件名，`/ui/` 前缀只放行这些；聊天界面本身也没有任何插槽、挂载点或扩展回调，`app.js` 是整体渲染的。插件能注册 HTTP 路由，也能通过 `pluginPages` 挂自己的页面（iframe），但那是**另一个页面**，不是往聊天界面里塞东西。结果是：凡涉及对话界面的体验改动，插件一律做不了，只能落主干。如果希望界面上能做插件，得先有钩子——哪怕只是「消息渲染前」「轨道渲染后」两个回调，或者允许插件声明 `ui/` 目录里的资源并自动并入 `assets` 白名单。
- **多模态入站应该做进主干**。现在图片上传的前端捕获、大小限制、落盘、`[[img:]]` 标记注入全在 web 层手写。每加一个通道（QQ、Discord、邮件）就要抄一遍。建议把「收图」抽象成独立一步，通道只负责把字节交上来。
- **凡是拿 `JSON.stringify(messages)` 估算 token 的地方，都该配一个降级版本**。图片 base64 会把估算撑爆，导致预算算成负数、触发不必要的压缩甚至拒答。项目里 `promptText()` 已经是正确做法（把图片段换成占位符，最后一刻才展开），应该推广到所有预算判断处。
- **粘贴入口不要信 `file.type`**。按魔数嗅探，失败信息要带 MIME 和字节数，别只写「无法解码」四个字——一句话能省掉一整轮排查。

## 十三、切走再切回来，高亮钉死在最后一格

**现象**：左侧轨道的「当前」高亮，正常滚动时跟着走；但把浏览器切到别的窗口、再切回来，它就永久停在最后一格，点哪一节都不动。刷新页面即恢复。

**根因是两处叠加**：

1. `syncRail()` 靠 `getBoundingClientRect()` 取每条消息的纵向位置。窗口最小化、页面切到后台、或渲染中途容器被隐藏时，**所有 rect 都是 0**。判定条件是「`rect.top <= 阈值` 的最后一个」，于是零值全部命中，落点必然是最后一格。
2. 纠正的机会被自己掐掉了。`ResizeObserver` 只在**第一次** `observe(box.firstElementChild)`，此后 `#messages` 的内层一旦被整体替换（切回窗口会触发一次 `syncView` → `render`），观察者盯住的就是已经摘下来的旧节点，**从此永不触发**。而切窗口回来时容器尺寸、滚动位置都没变，`resize` 和 `scroll` 也一个都不来。于是那一次算错的落点就永久留着。

**改法**（只动 `core/ui/app.js`）：

- `syncRail()` 开头加守卫：`document.hidden`、`box.clientHeight < 1`、`rail.clientHeight < 1` 三者任一成立，直接返回，不算。宁可留着上一轮的结果，也不要用零尺寸算出一个必然错误的答案。
- 逐条判定时跳过 `!node.isConnected` 和宽高皆为 0 的节点；若最后 `active < 0`（一个都量不准），同样不动上一轮的高亮。
- `ResizeObserver` 改成每次 `watchRail()` 都核对一次目标节点，换了就 `disconnect()` 再 `observe()` 新节点（用一个 `railObserverTarget` 字段记住上次观察的是谁）。
- 补两个「切回来」的触发点：`window.focus` 和 `document.visibilitychange`（`hidden` 为假时）。这类场景尺寸和滚动都不变，只有这两个事件能兜住。

**给作者的建议**：

- **凡是把 `getBoundingClientRect()` 的返回值当坐标用，都要先问「容器此刻是不是可见」**。隐藏状态下它返回的是一组 0，不是「未知」，代码会当成合法坐标一路算下去，得到一个看似正常、实际荒谬的结果。加个尺寸守卫的成本极低。
- **`ResizeObserver` 不要只 `observe` 一次**。只要你的渲染层会整块替换子节点（虚拟 DOM、`innerHTML =` 都算），观察者就会盯在一个已经脱离文档的节点上，静默失效——它不报错，只是再也不响应。把「盯谁」当成每次渲染后要核对的状态。
- **「用户切走再回来」是独立的一类时序**：尺寸没变、滚动没变、focus 之前还可能被节流掉一批动画帧。只监听 `scroll` / `resize` 的界面逻辑，在这条路径上一律会留下陈旧状态。

## 十四、切窗口回来高亮钉死：监听挂在死节点上

现象：对话页左侧轨道，切走再切回来之后，紫色刻度不再跟着滚动走，点别的段也不动。

两处叠加：

1. **`render()` 会用整页 markup 重建 `#messages`**（`views.js` 里对话页的字符串里就含 `<div id="messages">`），所以每次渲染拿到的是新节点。`watchRail()` 里那句 `box.addEventListener("scroll", …)` 被 `this.railWatched` 守着只绑一次，绑的是第一次那个节点；节点一换，监听就落在被摘下来的死节点上，此后滚动手势再也送不到轨道，高亮停在最后一次算出来的值。
2. **`window.addEventListener("focus", () => this.syncView())`** 那条：`syncView → load() → syncSession()` 会把已翻出来的历史丢掉、只留最后 40 条，再按"原来在底部"把滚动条按到底部。于是每切一次窗口就跳回最新。

改法：

- 监听改成跟着节点走：记住当前 `box`，节点变了就摘旧监听、绑新监听。
- 新增 `refreshOnFocus()`：切回来只刷状态、上下文和轨道，不再整份 `load()`。

两条建议给主干：

1. **凡是往"当前 DOM 节点"上挂监听的地方，都要能识别节点被整体替换**。`railWatched` 这类一次性布尔标志在整页重建的渲染方式下是定时炸弹；`ResizeObserver` 已经是这么修的，`addEventListener` 却漏了。
2. **`focus` 事件不该等价于"重新加载数据"**。窗口聚焦只意味着人回来了，不代表数据变了；用一次全量 `load()` 响应它，代价是丢掉用户当前的阅读位置。要刷新状态就只刷状态。

## 十五、本轮图片总量守卫（勘 2026-11-16）

网页上传那条链，原来有三个各自为政的数字：单张 4MiB、合计 8MiB、WebSocket `maxPayload` 32MiB。前两个只在上传口判，进了会话就没人再管；一旦同一条消息带 4 张大图，base64 撑到 21MB 左右，有的 provider 直接 413，有的悄悄截断一部分图——截断这条路最糟，模型看到的是半张图，还照样答。

改动两处：

- `core/session.ts`：进请求前算一次本轮图片总字节。超 8MiB，整批 `detail` 从 `auto` 降 `low`；超 16MiB 直接拒，报「本轮图片合计 X MiB，超过 16MiB 上限」。常量放在文件头 `IMAGE_LIMITS`。
- `core/web.ts`：上传合计上限从 8MiB 提到 16MiB。不改这一步的话，8MiB 的降级线永远够不着，等于死代码。`maxPayload` 32MiB 未动——16MiB 原图 base64 后约 21.3MiB，加上 JSON 外壳仍在窗内。

两处都只覆盖**本轮随消息发的图**。工具回传的图走另一条路（`tool-content.ts`），那边自带 16 张 / 16MiB 的聚合上限，各自判各自的。要合并成一本账，得把工具图也挂到同一个预算对象上。

建议：

1. 多模态入站的总量预算应该只有一个出处，别让上传口、会话层、通道层各写一份常量。
2. 触发降级或拒绝时，最好在回复里明说一句，而不是只抛错。用户贴了四张图、只回「超限」，很难猜到是哪一步拦的。
