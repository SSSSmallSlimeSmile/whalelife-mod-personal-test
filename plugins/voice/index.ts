/*! WhaleLife「嗓子」插件：GPT-SoVITS 语音合成 + 本机播放 + 服务进程托管。
 * 服务地址与参考音频沿用 AstrBot 那边调好的参数。
 */
import type { Context } from "../../core/context.ts";
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile, open } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readBody, renderPage, sanitize } from "./ui.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  url: "http://127.0.0.1:9880",
  ref_audio: "",
  prompt_text: "或许我也曾向往过这种力量，但那更像是一种讽刺。",
  text_lang: "zh",
  prompt_lang: "zh",
  speed: 1.2,
  max_chars: 160,
  out_dir: join(HERE, "data", "voice"),
  timeout_ms: 120_000,
  gsv: {
    auto_start: true,
    stop_on_exit: true,
    python: "",
    args: ["api_v2.py", "-a", "127.0.0.1", "-p", "9880"],
    cwd: "",
    host: "127.0.0.1",
    port: 9880,
    log: "",
    start_wait_ms: 180_000,
  },
};

type GsvConfig = typeof DEFAULTS.gsv;
type Config = Omit<typeof DEFAULTS, "gsv"> & { gsv: GsvConfig };

const safe = <A, S>(fn: (args: A, session: S) => Promise<unknown> | unknown) =>
  async (args: A, session: S) => {
    try {
      return await fn(args, session);
    } catch (error: any) {
      return `错误：${error?.message ?? String(error)}`;
    }
  };

function replyJson(res: any, code: number, body: any) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function play(file: string) {
  return new Promise<void>((ok) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`],
      { windowsHide: true, timeout: 120_000 },
      () => ok(),
    );
  });
}

/** 端口有没有人在听。只看 TCP 连通，不问对方是谁。 */
function portOpen(port: number, host = "127.0.0.1", timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (v: boolean) => {
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** 按端口找 PID。netstat 是系统自带的，不依赖 PowerShell 编码。 */
function pidByPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("netstat.exe", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const pids = new Set<number>();
      for (const line of stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        if (cols[3] !== "LISTENING") continue;
        const local = cols[1] ?? "";
        if (!local.endsWith(`:${port}`)) continue;
        const pid = Number(cols[4]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      resolve([...pids]);
    });
  });
}

async function gsvStatus(cfg: GsvConfig) {
  const open = await portOpen(cfg.port, cfg.host);
  const pids = open ? await pidByPort(cfg.port) : [];
  return { open, pids };
}

/** 拉起服务。detached，输出追加进日志，不等模型加载完。 */
async function gsvStart(cfg: GsvConfig, logger: { info: (m: string) => void; warn: (m: string) => void }) {
  if (await portOpen(cfg.port, cfg.host)) return { started: false, reason: "已经在跑了" };

  const handle = await open(cfg.log, "a").catch(() => null);
  const stamp = `[${new Date().toISOString()}] ===== whalelife start =====\n`;
  await writeFile(cfg.log, stamp, { flag: "a" }).catch(() => {});

  const child = spawn(cfg.python, cfg.args, {
    cwd: cfg.cwd,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", handle ? handle.fd : "ignore", handle ? handle.fd : "ignore"],
  });
  child.unref();
  if (handle) await handle.close().catch(() => {});
  logger.info(`GSV 启动中，pid=${child.pid ?? "?"}`);
  return { started: true, pid: child.pid ?? null };
}

/** 按端口杀。先 SIGTERM 式 taskkill，不收再 /F。 */
function gsvStop(cfg: GsvConfig) {
  return new Promise<{ stopped: boolean; pids: number[] }>((resolve) => {
    pidByPort(cfg.port).then((pids) => {
      if (!pids.length) return resolve({ stopped: false, pids: [] });
      let left = pids.length;
      for (const pid of pids) {
        execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
          if (--left === 0) resolve({ stopped: true, pids });
        });
      }
    });
  });
}

async function waitPort(cfg: GsvConfig, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portOpen(cfg.port, cfg.host)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export async function apply(ctx: Context) {
  let cfg: Config;
  let g: GsvConfig;

  async function reload() {
    let saved: any = null;
    try {
      saved = await ctx.config.read("config.json");
    } catch {
      saved = null;
    }
    cfg = {
      ...DEFAULTS,
      ...(saved ?? {}),
      gsv: { ...DEFAULTS.gsv, ...((saved?.gsv as Partial<GsvConfig>) ?? {}) },
    };
    g = cfg.gsv;
  }
  await reload();

  ctx.tools.register({
    name: "speak",
    description:
      "把一段话合成为语音。play 为 true 时同时在本机音箱播放。返回一个 [[voice:路径]] 标记，把标记原样写进回复，页面上会出现播放器。",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要念的话，160 字以内" },
        play: { type: "boolean", description: "是否立即播放，默认 true" },
        speed: { type: "number", description: "语速倍率，默认 1.2" },
      },
      required: ["text"],
    },
    danger: "ask",
    run: safe(async (args: any) => {
      const text = String(args?.text ?? "").trim().slice(0, cfg.max_chars);
      if (!text) throw new Error("text 不能为空");
      if (!(await portOpen(g.port, g.host))) {
        throw new Error(`GPT-SoVITS 没在跑（${g.host}:${g.port}）。用 gsv_start 起它。`);
      }

      const q = new URLSearchParams({
        text,
        text_lang: cfg.text_lang,
        ref_audio_path: cfg.ref_audio,
        prompt_lang: cfg.prompt_lang,
        prompt_text: cfg.prompt_text,
        text_split_method: "cut5",
        media_type: "wav",
        streaming_mode: "false",
        speed_factor: String(Number(args?.speed ?? cfg.speed)),
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);
      let res: Response;
      try {
        res = await fetch(`${cfg.url}/tts?${q.toString()}`, { signal: controller.signal });
      } catch (error: any) {
        throw new Error(
          controller.signal.aborted
            ? "语音合成超时"
            : `连不上 GPT-SoVITS（${cfg.url}）：${error?.message ?? error}`,
        );
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`语音合成失败 HTTP ${res.status}：${detail.slice(0, 120)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error("返回的音频太小，可能合成失败");

      await mkdir(cfg.out_dir, { recursive: true });
      const file = join(cfg.out_dir, `${Date.now()}.wav`);
      await writeFile(file, buf);

      const wantPlay = args?.play !== false;
      if (wantPlay) await play(file).catch(() => {});
      return `${wantPlay ? "已播放" : "已生成"}：${text.slice(0, 40)}${text.length > 40 ? "…" : ""}\n把下面这行原样放进回复就能在页面里播放：\n[[voice:${file}]]`;
    }),
  });

  ctx.tools.register({
    name: "gsv_status",
    description: "查 GPT-SoVITS 服务在不在：端口通不通、占用端口的 PID 是哪些。",
    schema: { type: "object", properties: {} },
    danger: "safe",
    run: async () => {
      const s = await gsvStatus(g);
      if (!s.open) return `未在运行（${g.host}:${g.port} 连不上）`;
      return `在运行（${g.host}:${g.port}），PID：${s.pids.join(", ") || "查不到"}`;
    },
  });

  ctx.tools.register({
    name: "gsv_start",
    description:
      "按配置拉起 GPT-SoVITS 服务（python api_v2.py），默认不等模型加载完就返回。wait 为 true 时等到端口通，最多 3 分钟。",
    schema: {
      type: "object",
      properties: { wait: { type: "boolean", description: "是否等到端口可用，默认 false" } },
    },
    danger: "ask",
    run: safe(async (args: any) => {
      const r = await gsvStart(g, { info: (m) => ctx.logger.info(m), warn: (m) => ctx.logger.warn(m) });
      if (!r.started) return `没做：${r.reason}`;
      if (args?.wait !== true) return `已拉起（pid=${r.pid ?? "?"}），模型加载要几十秒，用 gsv_status 看。`;
      const up = await waitPort(g, g.start_wait_ms);
      return up ? `已就绪（${g.host}:${g.port}）` : `已拉起，但 3 分钟内端口还没通，看日志 ${g.log}`;
    }),
  });

  ctx.tools.register({
    name: "gsv_stop",
    description: "按端口 9880 找 PID 并结束 GPT-SoVITS 进程（连子进程一起）。",
    schema: { type: "object", properties: {} },
    danger: "ask",
    run: async () => {
      const r = await gsvStop(g);
      if (!r.stopped) return `端口 ${g.port} 上没有进程，没什么可停的`;
      return `已结束：${r.pids.join(", ")}`;
    },
  });

  // ── 插件页：管进程启停 + 两个伴随开关 ──────────────────────
  ctx.web.page(
    "/plugins/voice/",
    async (_req: any, res: any) => {
      await reload();
      const status = { ...(await gsvStatus(g)), host: g.host, port: g.port };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(cfg, status));
    },
    { title: "嗓子", navigation: true },
  );

  ctx.web.api("/plugins/voice/status", async (_req: any, res: any) => {
    try {
      await reload();
      const s = await gsvStatus(g);
      return replyJson(res, 200, { ok: true, status: { ...s, host: g.host, port: g.port } });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/voice/start", async (_req: any, res: any) => {
    try {
      await reload();
      const r = await gsvStart(g, { info: (m) => ctx.logger.info(m), warn: (m) => ctx.logger.warn(m) });
      return replyJson(res, 200, {
        ok: true,
        started: r.started,
        message: r.started
          ? `已发出启动命令（pid=${r.pid ?? "?"}）。模型加载要几十秒，稍后刷新状态。日志：${g.log}`
          : `没有启动：${r.reason}`,
      });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/voice/stop", async (_req: any, res: any) => {
    try {
      await reload();
      const r = await gsvStop(g);
      return replyJson(res, 200, {
        ok: true,
        stopped: r.stopped,
        message: r.stopped ? `已结束：${r.pids.join(", ")}` : `端口 ${g.port} 上没有进程`,
      });
    } catch (error: any) {
      return replyJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.api("/plugins/voice/save", async (req: any, res: any) => {
    try {
      const patch = sanitize(await readBody(req));
      if (!Object.keys(patch).length) throw new Error("没有可保存的字段");
      const saved: any = (await ctx.config.read<any>("config.json").catch(() => null)) ?? {};
      const merged = { ...saved, gsv: { ...((saved?.gsv as any) ?? {}), ...patch } };
      await ctx.config.save("config.json", merged);
      await reload();
      return replyJson(res, 200, { ok: true, saved: Object.keys(patch), gsv: g });
    } catch (error: any) {
      return replyJson(res, 400, { ok: false, error: error?.message ?? String(error) });
    }
  });

  // 伴随 WhaleLife 启动：只补缺，不重复拉起。
  ctx.on("whalelife/ready", async () => {
    if (!g.auto_start) return;
    if (await portOpen(g.port, g.host)) {
      ctx.logger.info(`GSV 已在运行，不重复拉起（${g.host}:${g.port}）`);
      return;
    }
    const r = await gsvStart(g, { info: (m) => ctx.logger.info(m), warn: (m) => ctx.logger.warn(m) });
    ctx.logger.info(r.started ? `GSV 已随主程序拉起（pid=${r.pid ?? "?"}）` : `GSV 未拉起：${r.reason}`);
  });

  if (g.stop_on_exit) {
    ctx.on("whalelife/shutdown", async () => {
      const r = await gsvStop(g);
      ctx.logger.info(r.stopped ? `GSV 已随主程序结束：${r.pids.join(", ")}` : "GSV 本来就停着");
    });
  }

  ctx.effect(() => () => {
    ctx.logger.info("voice 已清理");
  });
}
