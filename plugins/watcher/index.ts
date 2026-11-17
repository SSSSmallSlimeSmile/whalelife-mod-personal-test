/*! WhaleLife「递话监听」插件：两路盯着我和妹妹之间那条通道。
 *
 * 一路——信匣。轮询 handoff\letters，发现新落的 .md 就记下来，等我去看。
 *   信怎么命名、正文怎么写，在《加密通话规则》第十节，本插件不猜格式。
 * 二路——递话。替我把话写进 outbox.json，从写进去到被取走之间计时；
 *   25 秒还没被取走就判桥断（判据照《加密通话规则》第四节）。
 *
 * 只读文件、只记账，不主动调模型叫醒谁——轮询不花钱，醒来才花钱。
 * 所以这里既不是闹钟，也不替谁做决定：新信只进账，读不读由我。
 */
import type { Context } from "../../core/context.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  enabled: false,
  /** 信匣。一封信一个 md，看完不删。 */
  letters_dir: "",
  /** 叫醒妹妹的口子。写进去两秒内该被取走。 */
  outbox_path: "",
  /** 多久看一次。只读目录，不调模型。 */
  poll_seconds: 20,
  /** 写进去多久还没被取走，就当桥断。 */
  bridge_timeout_seconds: 25,
  log: join(HERE, "data", "watcher.log"),
  state: join(HERE, "data", "state.json"),
};

type Config = typeof DEFAULTS;

/** 每封信记 mtime 和看没看过。mtime 变了算新内容。 */
type LetterState = { mtime: number; seen: boolean };
type State = {
  letters: Record<string, LetterState>;
  /** 正在等取走的那一封。null 表示手上没有在途的。 */
  outbox: { at: number; trace: string; bytes: number } | null;
  lastPoll: number | null;
  /** 第一次扫描只认账不报警，免得一上线就把旧信全当新信。 */
  baseline: boolean;
};

function emptyState(): State {
  return { letters: {}, outbox: null, lastPoll: null, baseline: false };
}

function trace(file: string, line: string): void {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 账写不进去不该拖垮轮询 */
  }
}

function loadState(path: string): State {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
    return {
      letters: raw.letters ?? {},
      outbox: raw.outbox ?? null,
      lastPoll: raw.lastPoll ?? null,
      baseline: raw.baseline === true,
    };
  } catch {
    return emptyState();
  }
}

function saveState(path: string, state: State): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* 见上 */
  }
}

/** 顶层目录里的 .md，不含 _archive 这类子目录。 */
function scanLetters(dir: string): Map<string, number> {
  const found = new Map<string, number>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) found.set(name, st.mtimeMs);
    } catch {
      /* 正被写、正被移的，下一轮再说 */
    }
  }
  return found;
}

/** 一封信的抬头，够认出是哪封就行。 */
function peek(path: string, limit = 140): string {
  try {
    const text = readFileSync(path, "utf8").replace(/\r/g, "");
    const body = text.split("\n").map((s) => s.trim()).filter(Boolean).join(" ");
    return body.slice(0, limit);
  } catch {
    return "";
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function apply(ctx: Context) {
  let saved: Partial<Config> | null = null;
  try {
    saved = await ctx.config.read<Partial<Config>>("config.json");
  } catch {
    saved = null;
  }
  const cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };
  const state = loadState(cfg.state);
  mkdirSync(dirname(cfg.log), { recursive: true });

  const log = (line: string) => trace(cfg.log, line);

  /** 扫一轮。返回这一轮新落（或改写）的信。 */
  const poll = (why: string): string[] => {
    const now = Date.now();
    const found = scanLetters(cfg.letters_dir);
    const fresh: string[] = [];

    if (!state.baseline) {
      // 头一次：把眼下的信全记成看过，不刷屏。基线只立一次。
      for (const [name, mtime] of found) state.letters[name] = { mtime, seen: true };
      state.baseline = true;
      log(`baseline ${found.size} 封，此后只报新落的`);
    } else {
      for (const [name, mtime] of found) {
        const prev = state.letters[name];
        if (!prev) {
          fresh.push(name);
          state.letters[name] = { mtime, seen: false };
        } else if (Math.abs(prev.mtime - mtime) > 1) {
          fresh.push(name);
          state.letters[name] = { mtime, seen: false };
        }
      }
      for (const name of fresh) log(`new letter ${name} (${why})`);
    }

    if (state.outbox) {
      const waited = (now - state.outbox.at) / 1000;
      let bytes = -1;
      try {
        bytes = statSync(cfg.outbox_path).size;
      } catch {
        bytes = -1;
      }
      if (bytes <= 0) {
        log(`outbox taken after ${waited.toFixed(1)}s trace=${state.outbox.trace}`);
        state.outbox = null;
      } else if (waited >= Number(cfg.bridge_timeout_seconds)) {
        log(`bridge suspect: ${waited.toFixed(0)}s 未取走 trace=${state.outbox.trace}`);
        // 只报一次，别每轮刷。也绝不自动重投——重投可能变成第二封。
        state.outbox = null;
      }
    }

    state.lastPoll = now;
    saveState(cfg.state, state);
    return fresh;
  };

  poll("startup");

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (cfg.enabled && !ctx.signal.aborted) poll("tick");
    }, Math.max(5, Number(cfg.poll_seconds)) * 1000);
    // 卸载时掐掉，别留第二条监听——AstrBot 那边为这个栽过。
    return { dispose: () => clearInterval(timer) };
  });

  const unread = () => Object.entries(state.letters).filter(([, v]) => !v.seen).map(([k]) => k);

  ctx.tools.register({
    name: "watcher_status",
    description: "看两路通道的现状：未读的来信、正在等取走的那封、上次扫描的时刻。不主动扫。",
    schema: { type: "object", properties: {}, required: [] },
    danger: "safe",
    run: async () => {
      const pending = state.outbox;
      const waited = pending ? ((Date.now() - pending.at) / 1000).toFixed(1) : null;
      return {
        letters_dir: cfg.letters_dir,
        unread: unread(),
        known: Object.keys(state.letters).length,
        outbox: pending ? { trace: pending.trace, waited_seconds: waited } : null,
        last_poll: state.lastPoll ? new Date(state.lastPoll).toISOString() : null,
      };
    },
  });

  ctx.tools.register({
    name: "watcher_check",
    description: "立刻扫一遍信匣，把新落的信报出来并标成已读。",
    schema: { type: "object", properties: {}, required: [] },
    danger: "safe",
    run: async () => {
      const fresh = poll("manual");
      const items = fresh.map((name) => {
        state.letters[name] = { ...(state.letters[name] ?? { mtime: 0, seen: false }), seen: true };
        return { name, peek: peek(join(cfg.letters_dir, name)) };
      });
      saveState(cfg.state, state);
      return { fresh: items.length, letters: items, unread_before: unread().length };
    },
  });

  ctx.tools.register({
    name: "watcher_send",
    description: "把一句话写进叫醒妹妹的口子（outbox.json），然后开始计时；25 秒没被取走算桥断。",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要说的话，原样写进去" },
      },
      required: ["text"],
    },
    danger: "ask",
    run: async (args: { text?: string }) => {
      const text = String(args?.text ?? "").trim();
      if (!text) return "没话可写";
      const waved = state.outbox
        ? ((Date.now() - state.outbox.at) / 1000).toFixed(0)
        : null;
      if (waved !== null) return `上一封还在等取走（${waved}s），先别叠第二封`;
      try {
        mkdirSync(dirname(cfg.outbox_path), { recursive: true });
        const payload = JSON.stringify({ text });
        writeFileSync(cfg.outbox_path, payload, "utf8");
        const at = Date.now();
        const mark = `watcher-${stamp()}`;
        state.outbox = { at, trace: mark, bytes: payload.length };
        saveState(cfg.state, state);
        log(`outbox written trace=${mark} bytes=${payload.length}`);
        return `已写入 outbox（trace ${mark}），开始计时`;
      } catch (error) {
        log(`outbox write failed: ${String(error)}`);
        return `写不进去：${String(error)}`;
      }
    },
  });
}
