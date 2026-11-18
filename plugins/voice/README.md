# voice · 嗓子

用本地 GPT-SoVITS 合成语音，可直接从音箱播放并保留文件。带配置页，能在页面上启动、停止 GPT-SoVITS 服务。

## 来源：本机自建

**这个插件没有上游仓库。** 搬进 WhaleLife 时从 AstrBot 那边的语音能力并过来的，GPT-SoVITS 服务、参考音频、参数都出自我们自己的环境。

作者公开的仓库一共 8 个（主仓库 `whalelife`、`plugin-vision`、`plugin-surf`、`plugin-bilibili`、`plugin-qq`、`plugin-qzone`、`plugin-gallery`、`plugin-autonomy`），主仓库的 `plugins/` 下只有一份 `AGENTS.md`，没有任何插件源码。**里面没有 voice。**

所以没有“上游原版”可附 diff，下面那节写的是相对这份代码最初搬进来时的样子。将来若发现某部分确实来自别处，按那边的许可补声明。

## 我们动过什么

| 位置 | 改动 |
|---|---|
| `ui.ts` | 新增文件，11,775 字节。嗓子配置页：状态条、启动/停止/刷新、两个伴随开关、服务参数表 |
| `index.ts` | 新增 `ctx.web.page("/plugins/voice/")` 与四个 api：`status` / `start` / `stop` / `save` |
| `index.ts` | 修 `pidByPort()` 取列错位。`netstat -ano` 的列是 `0=协议 1=本地地址 2=对端地址 3=状态 4=PID`，原代码用 `cols[1]` 判 `LISTENING`、`cols[2]` 取地址，永远匹配不到，返回空数组 |
| `index.ts` | 修页面「刷新状态」无可见反馈：补一行带时间戳的结果文字，状态没变也能看出点过 |
| `index.ts` | `DEFAULTS` 里四处本机绝对路径清空（`ref_audio`、`gsv.python`、`gsv.cwd`、`gsv.log`），改由配置提供 |
| `plugin.yaml` | 名称改「嗓子」，版本升 0.2.0，描述补上配置页与起停能力 |

**`pidByPort` 那处是上游代码里的 bug，不是我们改出来的。** 只是以前没人按 PID 停服务，脚踩不到；加了配置页才暴露。

## 工具

| 工具 | 说明 |
|---|---|
| `speak` | 合成一段话（160 字以内），可选本机播放，返回 `[[voice:路径]]` 标记 |
| `gsv_status` | 服务在不在、端口通不通、PID 是哪些 |
| `gsv_start` | 拉起 `api_v2.py`，默认不等加载完；`wait:true` 等到端口通（最多 3 分钟） |
| `gsv_stop` | 按端口找 PID，连子进程一起结束 |

## 装法

1. 把整个目录放进 `plugins/`
2. `cp data/config.example.json data/config.json`
3. 填三项必需的：
   - `gsv.python`：能跑 GPT-SoVITS 的 python 解释器
   - `gsv.cwd`：GPT-SoVITS 代码目录（`api_v2.py` 在那儿）
   - `ref_audio`：参考音频的绝对路径
4. 可选：`prompt_text`（参考音频对应的文字，留空也能跑但音色可能偏）
5. 重启 WhaleLife，左侧出现「嗓子」

## 参数

| 键 | 默认 | 说明 |
|---|---|---|
| `url` | `http://127.0.0.1:9880` | GPT-SoVITS 服务地址 |
| `ref_audio` | 空 | 参考音频路径，必填 |
| `prompt_text` | 空 | 参考音频说的话 |
| `text_lang` / `prompt_lang` | `zh` | 文本与参考音频语言 |
| `speed` | 1.2 | 语速倍率 |
| `max_chars` | 160 | 单次合成长度上限 |
| `timeout_ms` | 120000 | 合成超时 |
| `gsv.auto_start` | `false` | WhaleLife 启动时是否自动拉起服务 |
| `gsv.stop_on_exit` | `true` | WhaleLife 退出时是否一并关掉服务 |
| `gsv.python` / `cwd` / `log` | 空 | 解释器、代码目录、日志文件 |
| `gsv.start_wait_ms` | 180000 | 等端口就绪的上限 |

## 已知短板

- **没在别人机器上试过。** 只在本人那台 Windows 上跑过，GPT-SoVITS 是现成的本地部署。
- **播放依赖系统默认输出设备。** 用 `System.Media.SoundPlayer`，认不出指定设备；系统默认输出端点为空时不出声，也不报错。
- **`auto_start` 打开时启动慢。** 服务加载模型要几十秒，插件不等它，端口没通之前 `speak` 会报错。
- 页面只做了状态查看与启停，没有做「试听一句」。

## 许可

上游插件按其原许可使用；本目录的改动的用法与本仓库 `personal-test` 相同（AGPL-3.0）。原作者的版权归原作者。
