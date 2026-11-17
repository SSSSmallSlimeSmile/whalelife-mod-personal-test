/*! WhaleLife「提示音」插件：一轮任务真跑完、回复落地之后，在宿主电脑响一声。
 *
 * 移植自 AstrBot 的 astrbot_plugin_task_chime 1.0.3。钩子换了名字，判据没变：
 * 那边是 on_agent_begin + after_message_sent，这边对应「channel/message」用户消息
 * 落盘 与「channel/reply」回复落盘。从这句用户消息算起，到回复落地超过
 * min_seconds 才响——随口一问不滴滴叫。
 *
 * 原插件踩出来的三条，照搬：
 * 1. 只认「回复真的发出去」，不认「agent 跑完」——子代理跑完也会宣告结束，
 *    照那个响，你发一句能听两三次。
 * 2. 冷却和占用放在模块级 + 一个临时文件里。插件重载后老实例还挂在事件链上，
 *    两边各自计时就会两声叠一起，后一声把前一声掐断。
 * 3. 用另一个进程放音。同一个进程里两次 winsound 会抢同一个独占通道。
 */
import type { Context } from "../../core/context.ts";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  enabled: true,
  wav_path: join(HERE, "data", "done.wav"),
  /** 音效文件。wav 走 SoundPlayer，mp3 走 WPF MediaPlayer。留空则用 wav_path。 */
  sound_path: "",
  /** 少于这么多秒的回合不响。 */
  min_seconds: 8,
  cooldown_seconds: 3,
  /** 只在这些通道响；空数组表示全响。例：["web"] */
  channels: [] as string[],
  log: join(HERE, "data", "chime.log"),
};

type Config = typeof DEFAULTS;

// 模块级：活得比任何一个实例都长。跨进程重启靠文件里那道闸。
const GUARD_PATH = join(tmpdir(), "whalelife_chime.guard");
let LAST_PLAY = 0;
let BUSY_UNTIL = 0;

function guardLeft(): number {
  try {
    const until = Number(readFileSync(GUARD_PATH, "utf8").trim() || 0);
    return until - Date.now() / 1000;
  } catch {
    return -1;
  }
}

function guardSet(seconds: number): void {
  try {
    writeFileSync(GUARD_PATH, (Date.now() / 1000 + seconds).toFixed(3), "utf8");
  } catch {
    /* 闸写不进去就少一道保险，不该因此不响 */
  }
}

function trace(file: string, line: string): void {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志是证据，不是命门 */
  }
}

/** 读 wav 头算这一声多长；读不出来按一秒半算。 */
function wavSeconds(path: string, fallback = 1.5): number {
  try {
    const buf = readFileSync(path);
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return fallback;
    let at = 12;
    let byteRate = 0;
    while (at + 8 <= buf.length) {
      const id = buf.toString("ascii", at, at + 4);
      const size = buf.readUInt32LE(at + 4);
      if (id === "fmt " && at + 16 <= buf.length) byteRate = buf.readUInt32LE(at + 16);
      if (id === "data" && byteRate > 0) return size / byteRate;
      at += 8 + size + (size % 2);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** 另起一个进程去放。返回是否确实发出去了。 */
function play(path: string): boolean {
  const ok = Boolean(path) && existsSync(path);
  const q = path.replace(/'/g, "''");
  const script = !ok
    ? "[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 800"
    : /\.mp3$/i.test(path)
      // mp3: SoundPlayer 只认 wav，得用 WPF 的 MediaPlayer。起播是异步的，等两秒再收。
      ? `Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]'${q}'); $p.Play(); Start-Sleep -Milliseconds 2200; $p.Close()`
      : `(New-Object System.Media.SoundPlayer '${q}').PlaySync()`;
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, detached: true, stdio: "ignore" },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function apply(ctx: Context) {
  let saved: Partial<Config> | null = null;
  try {
    saved = await ctx.config.read<Partial<Config>>("config.json");
  } catch {
    saved = null;
  }
  const cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };
  const wav = String(cfg.sound_path || cfg.wav_path || "");
  const duration = wav && existsSync(wav) ? wavSeconds(wav) : 1.5;
  if (wav && !existsSync(wav)) ctx.logger.warn(`音效文件不存在，回退系统提示音：${wav}`);

  const starts = new Map<string, number>();
  const sessionOf = (event: any) => String(event?.session ?? event?.channel ?? "?");
  const allowed = (event: any) =>
    !cfg.channels.length || cfg.channels.includes(String(event?.channel ?? ""));

  // 用户那句话落地 = 这一轮开始
  ctx.on("channel/message", (event) => {
    if (event?.role !== "user" || !allowed(event)) return;
    const now = Date.now();
    starts.set(sessionOf(event), now);
    if (starts.size > 256) {
      for (const [key, at] of starts) if (now - at > 15 * 60_000) starts.delete(key);
    }
  });

  // 回复落地 = 这一轮真的发出去了
  ctx.on("channel/reply", (event) => {
    if (!cfg.enabled || !event || event.transient === true || !allowed(event)) return;
    const key = sessionOf(event);
    const began = starts.get(key);
    if (began === undefined) return;
    starts.delete(key);

    const elapsed = (Date.now() - began) / 1000;
    if (elapsed < Number(cfg.min_seconds)) return;

    const now = Date.now() / 1000;
    if (now - LAST_PLAY < Number(cfg.cooldown_seconds)) return;
    if (now < BUSY_UNTIL) return;
    const left = guardLeft();
    if (left > 0) {
      trace(cfg.log, `skip guard_left=${left.toFixed(2)}s`);
      return;
    }
    if (!play(wav)) {
      trace(cfg.log, "error spawn-failed");
      ctx.logger.warn("提示音播放失败：起不了 powershell");
      return;
    }
    LAST_PLAY = now;
    BUSY_UNTIL = now + duration + 0.05;
    guardSet(duration + 0.05);
    trace(cfg.log, `play dur=${duration.toFixed(2)}s elapsed=${elapsed.toFixed(1)}s`);
    ctx.logger.info(`提示音已响，本轮 ${elapsed.toFixed(1)}s`);
  });

  ctx.tools.register({
    name: "chime_test",
    description: "立刻在宿主电脑上放一次提示音，用来确认声音通道是否还通。不参与回合判定。",
    schema: { type: "object", properties: {}, required: [] },
    danger: "safe",
    run: async () => {
      const ok = play(wav);
      trace(cfg.log, `test ok=${ok}`);
      return ok ? "已发出提示音" : "播放失败：起不了 powershell";
    },
  });
}
