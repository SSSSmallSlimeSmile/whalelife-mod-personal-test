# 前端渲染与分页（完整源码）

这是给 iinukami/whalelife 的**前端渲染增强 + 会话分页**改动，按文件原样放出来，方便直接读源码。

对应 PR：<https://github.com/iinukami/whalelife/pull/10>
分支：`SSSSmallSlimeSmile/whalelife` 的 `feat/frontend-pagination`
基线：上游 `181a5eb`
提交：`649e92a`

---

## 这些文件是什么

一共 7 个，都是**改完之后**的完整文件，不是 diff。直接覆盖到对应路径即可，或者单独读也行。

| 文件 | 字节 | 改了什么 |
|---|---:|---|
| `core/ui/app.js` | 60,399 | 消息渲染重写：Markdown、表格、代码块、思考中动画、念话按钮、图片/文件卡片；滚到顶部加载上一页，加载后保持阅读位置 |
| `core/ui/styles.css` | 66,909 | 上面这些的样式，含深色主题变量 |
| `core/ui/views.js` | 19,509 | 视图层配套调整 |
| `core/ui/context.js` | 15,059 | 上下文面板配套调整 |
| `core/ui/api.js` | 2,427 | 请求封装：`/api/session` 支持 `before` / `limit` |
| `core/web.ts` | 32,689 | 会话分页、`/api/media`、`/api/file` 三条路由 |
| `core/clipboard-image.ps1` | 812 | 新增，Windows 剪贴板取图兜底 |

---

## 分页的接口约定

```
GET /api/session?id=<会话>&limit=40              最近 40 条
GET /api/session?id=<会话>&before=<序号>&limit=40  该序号之前的 40 条

返回 { items, start, end, hasMore }
```

**兼容性**：不传 `before` 也不传 `limit` 时，仍返回原来的数组结构，旧调用方不受影响。

---

## 验证情况

在纯净 clone 上只打这一个补丁：

```
tsc --noEmit        0 error
git apply --check   干净通过
```

分页用一份 3,820 条真实消息的会话验过四个边界：

```
?limit=40            40 条  start 3780  end 3820  hasMore true
?before=3780         40 条  start 3740  end 3780  hasMore true
?before=40           40 条  start    0  end   40  hasMore false
?before=0             0 条  hasMore false
```

---

## 没验的

- 只在 Windows 上跑过
- 长会话（上千条）滚动时的性能没测
- 没有截图，视觉效果要实际打开看

---

## 一处破坏性改动

`/api/session` 改成返回对象是**破坏性**的——依赖旧数组结构的第三方代码要跟着改。如果不想动这个，可以只取前面五个 `core/ui/` 文件，分页部分跳过。

---

## 想拆开的话

PR 正文里也写了：如果渲染改动太多不好审核，可以拆成两个 PR——一个纯视觉（`core/ui/*`），一个分页（`core/web.ts` + `api.js` 的请求部分）。
