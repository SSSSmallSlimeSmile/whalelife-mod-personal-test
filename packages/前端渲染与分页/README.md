# WhaleLife 前端渲染增强 + 会话分页

一份对主干前端（`core/ui/`）与会话接口（`core/web.ts`）的补丁，**只改前端呈现和会话读取，不动记忆、模型、路由、工具协议等核心逻辑**。

基线：`iinukami/whalelife` @ `f209799`（2026-11-21 之后的上游主干）
实测环境：同一提交的纯净 clone，应用后 `tsc --noEmit` 零错误，页面与接口实跑通过。

---

## 一、应用方式

```bash
cd <WhaleLife 根目录>
git apply --check frontend-pagination.patch   # 先确认能干净打上
git apply frontend-pagination.patch
```

然后重启宿主。**不需要改配置，不需要新依赖。**

回滚：

```bash
git checkout -- core/ui core/web.ts
rm core/clipboard-image.ps1
```

---

## 二、改了什么（7 个文件）

```
core/ui/app.js            816 行   会话渲染、消息列表、输入区、滚动刻度轨
core/ui/styles.css        366 行   对应样式
core/ui/views.js           21 行   视图注册
core/ui/context.js         33 行   上下文面板
core/ui/api.js              1 行   接口封装
core/web.ts                2 段    会话分页 + 媒体/文件读取
core/clipboard-image.ps1   21 行   新增，Windows 剪贴板取图兜底
```

### 前端呈现

- **Markdown 渲染**：粗体、斜体、行内代码、代码块、列表、引用、标题、表格、链接、分隔线。代码块带语言标签和复制按钮。
- **工具调用折叠**：工具调用与结果默认收起成一行摘要，点开看详情；不折叠时正文容易被长输出淹没。
- **思考中动画**：等待模型回复期间显示颜文字轮播，而不是一行静止的「思考中…」。
- **语音播报按钮**：消息旁一个按钮，把这条回复送去念。
- **图片与文件**：回复里的图片走 `/api/media` 内联显示，点击放大；末尾「本轮文件」列表里的文件可点开。
- **左侧刻度轨**：长会话左侧 18px 窄条，一屏一个刻度，当前视口那一段高亮，点刻度跳转。原 200px 摘要栏收掉了，窄屏下聊天区不再被压。
- **粘贴截图**：直接从剪贴板粘图（Chromium 读不了微信截图那种裸 DIB 时，走 PowerShell 兜底）。

### 会话分页

`GET /api/session` 的返回从**裸数组**改成**分页对象**：

```
旧   [ {...}, {...}, ... ]                     最后 100 条，无法往前翻
新   { items, total, start, end, hasMore }     默认 40 条一页
```

参数：`id`（必填）、`limit`（1–200，默认 40）、`before`（游标，省略=最新一页）。

前端滚到顶部自动加载上一页，加载后保持当前阅读位置不跳动。

### 媒体与文件读取

```
GET /api/media?path=…     内联图片/音频，限定在 memory/、plugins/、config.web.media_roots
GET /api/file?path=…      只读工作目录内普通文件，隐藏目录与密钥文件一律拒绝
POST /api/clipboard-image Windows 剪贴板取图，返回 data URL
```

三者都有路径白名单，不通过直接 400/403。

---

## 三、实测记录

在纯净上游（同一提交、无任何其它改动）上应用后：

```
tsc --noEmit                0 error
GET /                       200，引用 /ui/app.js
GET /ui/app.js              200   56,566 B
GET /ui/styles.css          200   66,303 B
GET /ui/views.js            200   17,436 B
GET /ui/api.js              200    2,353 B
GET /ui/context.js          200   13,129 B
```

分页（用一份 3,820 条真实消息的会话）：

```
?limit=40                 items 40  total 3820  start 3780  end 3820  hasMore true
?limit=40&before=3780     items 40  total 3820  start 3740  end 3780  hasMore true
?limit=40&before=40       items 40  total 3820  start    0  end   40  hasMore false
?limit=40&before=0        items  0  hasMore false        （空页，符合预期）
不传 limit                 默认 40，行为同上
```

```
GET /api/media?path=nope.png   403  路径不在允许范围（白名单生效）
GET /api/file?path=nope.txt    404  文件不存在或读不到（路由生效）
```

---

## 四、已知限制

**一、`/api/session` 的返回结构变了，这是破坏性改动。**

任何依赖旧行为的代码（外部脚本、第三方插件、自建面板）都要跟着改。如果只想保留旧结构，可以只取 `core/ui/` 那部分，但分页就没法用——前端会等一个对象而拿到数组。

**二、`clipboard-image.ps1` 只对 Windows 有意义。**

其它平台没有这个兜底；粘贴走浏览器自己的剪贴板 API。不想要可以直接删掉这个文件，路由里那段会返回 500，不影响其它功能。

**三、左侧刻度轨只在长会话有意义。**

少于十几条的会话看不到刻度，属正常。

**四、没做虚拟滚动。**

几千条消息的会话里，一次 `items` 只有 40 条，但**已加载**的会累积在 DOM 里。翻十几页之后滚动手感会下降。要彻底解决需要虚拟列表，那是更大的改动。

**五、只在这台机器（Windows）实测过。**

Linux / macOS 上 `clipboard-image.ps1` 那一段不可用，其余部分是纯前端和 Node 标准库，理论上通用，但没有实跑过。

---

## 五、来源

这些改动来自我们自己长期使用中累积的问题，不是凭空设计：

```
Markdown          模型回复里的表格和代码块原样显示成竖线，读不了
工具折叠          一次工具调用几百行输出，把对话冲散
刻度轨            几百条消息回看只能一直往上滚
分页              一百条以前的内容根本翻不到
粘贴截图          微信截图在 Chromium 里读不出来
```

每条都对应一个具体场景，不是「觉得应该有」。
