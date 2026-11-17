/*! WhaleLife「耳朵」插件：麦克风 -> SenseVoice 边车 -> 投进会话。
 *
 * 麦克风采集与识别放在 Python 边车里（本机没有 Node 侧的等价库）。
 * 这边只管三件事：拉起、读 stdout、把每句话当一条用户消息送进会话。
 *
 * 默认闭嘴：auto_start 是 false，要用 ear_start 才开。
 */
import type { Context } from "../../core/context.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  python: "D:\\AstrBot\\backend\\python\\python.exe",
  script: join(HERE, "ear_sidecar.py"),
  device: 1,
  engine: "sensevoice",
  model: "base",
  sensevoice_dir:
    "K:\\AstrBotData\\projects\\project_eea8e91a\\models\\sensevoice\\models\\iic--SenseVoiceSmall\\snapshots\\master",
  language: "zh",
  initial_prompt: "勘，誊，astrbot，whalelife，Minecraft，ComfyUI，Lora，表情包，插件，麦克风",
  silence: 0.8,
  max_len: 30,
  /** 空 = 用当前会话。 */
  target_session: "",
  /** 把回复念出来（走 GSV 9880），默认不念。 */
  speak_reply: false,
  gsv_url: "http://127.0.0.1:9880",
  gsv_ref_audio: "K:\\GPT-SoVITS\\refs\\furina_ref23.wav",
  gsv_prompt_text: "或许我也曾向往过这种力量，但那更像是一种讽刺。",
  /** WhaleLife 启动时自动开始监听。 */
  auto_start: false,
};

type Config = typeof DEFAULTS;

export async function apply(ctx: Context) {
  let saved: Partial<Config> | null = null;
  try {
    saved = (await ctx.config.read("config.json")) as Partial<Config> | null;
  } catch {
    saved = null;
  }
  const cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };

  let child: ChildProcessWithoutNullStreams | null = null;
  let listening = false;
  let ready = false;
  let turns = 0;
  let last = "";
  let lastError = "";
  let buf = "";

  const speak = async (text: string) => {
    if (!cfg.speak_reply) return;
    try {
      const q = new URLSearchParams({
        text: text.slice(0, 160),
        text_lang: "zh",
        ref_audio_path: cfg.gsv_ref_audio,
        prompt_lang: "zh",
        prompt_text: cfg.gsv_prompt_text,
        text_split_method: "cut5",
        media_type: "wav",
        streaming_mode: "false",
      });
      const res = await fetch(`${cfg.gsv_url}/tts?${q.toString()}`);
      if (!res.ok) return;
      await res.arrayBuffer(); // 合成出来就够；播放由本机另走，不在这里卡住
    } catch {
      // 没开 GSV 就当没这回事
    }
  };

  /** 把一句话当用户消息投进会话。 */
  const deliver = async (text: string) => {
    const sessionId = cfg.target_session || (await ctx.sessions.current());
    turns += 1;
    last = text;
    ctx.logger.info(`耳朵 #${turns}：${text}`);
    try {
      const reply = await ctx.sessions.run({
        sessionId,
        text,
        origin: { kind: "channel", name: "ear" } as any,
      });
      ctx.logger.info(`耳朵回复 ${String(reply ?? "").length} 字`);
      if (reply) await speak(String(reply));
    } catch (error: any) {
      lastError = error?.message ?? String(error);
      ctx.logger.warn(`耳朵投递失败：${lastError}`);
    }
  };

  const handleLine = async (line: string) => {
    const s = line.trim();
    if (!s) return;
    let msg: any;
    try {
      msg = JSON.parse(s);
    } catch {
      // 边车偶尔会往 stdout 漏非 JSON 的行，跳过就行
      return;
    }
    if (msg.event === "ready") {
      ready = true;
      ctx.logger.info(`耳朵就绪：引擎 ${msg.engine}，阈值 ${msg.threshold}`);
      return;
    }
    if (msg.event === "selftest") {
      ctx.logger.info(`耳朵自检：${msg.ok ? "通过" : "失败 " + (msg.error ?? "")}`);
      return;
    }
    if (msg.event === "closed") {
      listening = false;
      ready = false;
      return;
    }
    if (msg.event === "utterance" && typeof msg.text === "string") {
      await deliver(msg.text);
    }
  };

  const start = async () => {
    if (child) return { ok: false, reason: "已经在听了" };
    const args = [
      cfg.script,
      "--start",
      "--device", String(cfg.device),
      "--engine", String(cfg.engine),
      "--model", String(cfg.model),
      "--sensevoice_dir", String(cfg.sensevoice_dir),
      "--language", String(cfg.language),
      "--initial_prompt", String(cfg.initial_prompt),
      "--silence", String(cfg.silence),
      "--max_len", String(cfg.max_len),
    ];
    const c = spawn(cfg.python, args, {
      cwd: HERE,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    }) as ChildProcessWithoutNullStreams;
    child = c;
    listening = true;
    ready = false;
    buf = "";

    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        void handleLine(line);
      }
    });
    c.stderr.setEncoding("utf8");
    c.stderr.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (text) ctx.logger.info(`[ear] ${text.slice(0, 400)}`);
    });
    c.on("exit", (code) => {
      ctx.logger.info(`耳朵边车退出，code=${code}`);
      child = null;
      listening = false;
      ready = false;
    });
    const pid = c.pid ?? null;
    ctx.logger.info(`耳朵拉起，pid=${pid}`);
    return { ok: true, pid };
  };

  const stop = async () => {
    const c = child;
    if (!c) return { ok: false, reason: "没在听" };
    try {
      c.stdin.write("quit\n");
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    if (child) {
      try {
        c.kill();
      } catch {}
    }
    return { ok: true };
  };

  ctx.tools.register({
    name: "ear_start",
    description: "开始听麦克风：拉起识别边车，把每句话当成一条用户消息投进会话。加载模型要几十秒。",
    schema: { type: "object", properties: {} },
    danger: "ask",
    run: async () => {
      const r = await start();
      if (!r.ok) return `没做：${r.reason}`;
      return `耳朵开了（边车 pid=${r.pid ?? "?"}）。模型加载几十秒，就绪后每说一句话都会被投进会话。`;
    },
  });

  ctx.tools.register({
    name: "ear_stop",
    description: "停止听麦克风，边车连模型一起收掉。",
    schema: { type: "object", properties: {} },
    danger: "ask",
    run: async () => {
      const r = await stop();
      if (!r.ok) return `没做：${r.reason}`;
      return "耳朵收了，麦克风关了。";
    },
  });

  ctx.tools.register({
    name: "ear_status",
    description: "看耳朵状态：边车在不在、引擎就绪没有、已经转了几句。",
    schema: { type: "object", properties: {} },
    danger: "safe",
    run: async () => {
      const parts = [
        listening ? (ready ? "在听（引擎已就绪）" : "在听（模型还在加载）") : "闭嘴",
        `已转 ${turns} 句`,
      ];
      if (last) parts.push(`最后一句：${last}`);
      if (lastError) parts.push(`上次出错：${lastError}`);
      if (child?.pid) parts.push(`pid=${child.pid}`);
      return parts.join("｜");
    },
  });

  if (cfg.auto_start) {
    ctx.on("whalelife/ready", async () => {
      const r = await start();
      ctx.logger.info(r.ok ? "耳朵已随主程序开始监听" : `耳朵未开：${r.reason}`);
    });
  }

  ctx.effect(() => () => {
    if (child) {
      try {
        child.stdin.write("quit\n");
      } catch {}
      try {
        child.kill();
      } catch {}
      child = null;
    }
    ctx.logger.info("ear 已清理");
  });
}
