# WhaleLife 本地改动（未完成 / 需要动主干）

这个库放三类东西：

1. **还没完全验通的插件**——能独立加载，但装到别人机器上有已知风险
2. **需要动主干的补丁**——不是插件能解决的部分，只能改 `core/`
3. **改动说明文档**——每份都写现象、原因、修法、验证

成品插件在另一个库：[`whalelife-mod-personal`](https://github.com/SSSSmallSlimeSmile/whalelife-mod-personal)

**不是 WhaleLife 官方项目。** 上游是 [`iinukami/whalelife`](https://github.com/iinukami/whalelife)，AGPL-3.0 加附加条款，原文在 `上游许可/`。

---

## 先说清楚：验证范围

这个库里的插件和补丁，**只在本人那台 Windows 电脑上跑过**。没有在手机上跑过，也没有在第二台电脑上跑过。

下面每个插件都标了"验过什么、没验什么"。看到"能用"，意思是"在我这台机器上能用"，不是"在哪都能用"。补丁更是——基线绑死，换台机器、换个版本就可能全废。

---

## 一、插件

| 插件 | 版本 | 做什么 | 状态 |
|---|---|---|---|
| `ear` | 0.2.0 | 麦克风听写。按住热键说话，识别成字投进会话，可选让 `mouth` 念回复 | 能用（依赖本机模型） |
| `chime` | 0.2.0 | 提示音。一轮任务跑完、回复真的发出去后，在电脑上响一声 | 能用（本机验过出声） |
| `watcher` | 0.1.0 | 信匣监视 + 递话。默认关闭 | 未启用 |

这三个只放代码和示例配置，运行产物（音频缓存、截图、日志、`__pycache__`）没有入库。

### ear 麦克风听写

**装之前要准备三样东西**，缺一样就跑不起来：

1. **Python 环境**：SenseVoice 要 `funasr`、`torch`、`soundfile`、`sounddevice`、`scipy`、`numpy`。`sounddevice` 最容易漏，漏了边车自检会报 `No module named 'sounddevice'`
2. **SenseVoice 模型**：`SenseVoiceSmall` 那套权重，本地目录。配置里的 `sensevoice_dir` 指过去
3. **配置**：`data/config.example.json` 复制成 `data/config.json`，把 `python` 写成你的解释器绝对路径，`sensevoice_dir`、`device`（麦克风设备号）按自己机器填

```
copy plugins\ear\data\config.example.json plugins\ear\data\config.json
```

配置项：

| 字段 | 说明 |
|---|---|
| `python` | 跑边车的解释器。留空则用 PATH 里的 `python` |
| `sensevoice_dir` | SenseVoice 模型目录 |
| `device` | 麦克风设备号。`0` 常常不是你要的那个，先用 `python -c "import sounddevice; print(sounddevice.query_devices())"` 看清楚 |
| `engine` | 目前只有 `sensevoice` |
| `silence` | 静音多久算一句结束，秒 |
| `speak_reply` | 说完后要不要让 `mouth` 念回复（需要装 `mouth`） |
| `hotkey` | 全局热键，默认 `F9`，支持 `Ctrl+F9` 这类组合 |

**全局热键**需要一个外部小进程 `hold_to_talk.py`，在 `f9/` 下。它用 Windows `RegisterHotKey` 占住那个键——**游戏里原本用这个键的功能就用不了了**。页面上可以手动启动/停止，也能勾"随 WhaleLife 启动"。

没验过的：非 Windows；别的麦克风设备；whisper 分支代码在但没接过；长时间连续使用会不会积压。

### chime 提示音

任务完成后响一声。`sound_path` 可以指向单个文件，也可以指向目录——指向目录时每次随机抽一个。

```
copy plugins\chime\data\config.example.json plugins\chime\data\config.json
```

| 字段 | 说明 |
|---|---|
| `sound_path` | 音效文件或目录 |
| `min_seconds` | 两次提示音之间的最小间隔，防止连续响 |
| `channels` | 哪些通道的回复触发提示音 |

**长音频别直接放**：超过十秒的会一直占着，把后面的提示音全挡掉。切成 1–4 秒的独立短音丢进一个目录，让它随机抽。

没验过的：别的机器、别的音频驱动。声音出不来时先查 Windows 默认输出设备是不是空的——`SoundPlayer` 放不出来就是因为这个，不是插件没跑。

### watcher 信匣监视

盯两个目录，新文件落地就报一次；另有一路递话，写出去的信 25 秒没被取走就判「桥断」。默认 `enabled: false`。

```
copy plugins\watcher\data\config.example.json plugins\watcher\data\config.json
```

路径全部要自己填，示例里都是空的。

---

## 二、补丁

| 文件 | 内容 | 基线 |
|---|---|---|
| `all-20261117.patch` | 全部改动，202,898 字节，44 文件 | `2ee7b09` |
| `packages/01-generic.patch` | 只含插件看门狗（通用，谁都能用） | 同上 |
| `packages/02-local.patch` | 其余全部（本地扩展） | 同上 |

`all` 就是两份包首尾拼接，应用一份即可。三份都在 `2ee7b09` 干净树上 `git apply --check` 通过。

**注意**：这批量补丁截止到 2026-11-17，之后的改动（ENV 引用、念话按钮、账本插件化等）还没重打。

---

## 三、文档

每份都按同一结构写：现象（带日志原文）→ 触发原因 → 触发场景 → 修法 → 复现步骤 → 验证 → 应用注意。

| 目录 | 内容 |
|---|---|
| `前端/` | markdown 渲染、思考中颜文字、左侧分栏游标、会话改名、插队请求 |
| `日记/` | 预算死循环、输出截断、请求参数 |
| `交付回执/` | 程序回执、状态机、防止虚报 |
| `安全/` | `/api/file` 能读敏感配置 |
| `插件/` | 看门狗误杀、插件页面怎么写（`插件页面渲染.md`） |
| `上游/` | 我们与上游的三处分歧 |
| `legacy/` | 更早的改动清单与说明，只作记录 |

**`路由/` 那个目录不存在。** 之前有份清单提到它，是凭印象写的，实际磁盘上没有。分级思考那套改动在 `02-local.patch` 里，文档没单独成篇。

---

## 四、给别人用之前先读这段

**一、基线绑死。** 补丁对 `2ee7b09`。你那边版本不同就会冲突，`git apply` 直接失败。没有"自动适配"这回事。

**二、模型名是我们自己的。** 路由那套配置里写着 `mr-deepseek-v41-flash`、`mr-gpt-61-sol`、`mr-claude-haiku-55`——都是 MiraRouter 上的别名。代码里没有硬编码，全读 `config.json` 的 `model_router`，但你得改成你自己有的模型。启动时会自检，缺哪档会在日志里列出来。

**三、配置不在补丁里。** `config/` 在 `.gitignore`，`embed_route`、`judge_min_confidence`、`router-intents.json` 都不跟着走。装上等于半套。

**四、改的是 `core/`。** 上游一更新就全废。这是补丁不是插件，没有别的办法。

**五、验证范围。** 所有插件和补丁只在本人一台 Windows 电脑上跑过，没有跨机器验证。

---

## 五、许可

补丁改的是上游代码，受上游 AGPL-3.0 及附加条款约束。`上游许可/` 里放了原文。

分发时请：

- 保留原作者版权声明和项目名
- 清楚区分修改版与原版，不要用「官方」「原版」这类说法
- 同样以 AGPL-3.0 提供

附加条款允许商用、收费、改名字，也允许如实描述自己的贡献；禁止的是声称原项目是自己写的、把包含原项目实质部分的作品说成完全原创。
