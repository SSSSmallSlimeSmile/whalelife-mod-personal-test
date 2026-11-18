/*! WhaleLife「嗓子」插件页：管 GPT-SoVITS 进程的启停，和「随主程序起/停」两个开关。 */

export async function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: any) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/** 只收 gsv 里那几个字段。返回扁平 patch，由 index.ts 合并进 config.gsv。 */
export function sanitize(input: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = input && typeof input === "object" ? input : {};

  if ("auto_start" in src) {
    out.auto_start = src.auto_start === true || src.auto_start === "on" || src.auto_start === "true";
  }
  if ("stop_on_exit" in src) {
    out.stop_on_exit = src.stop_on_exit === true || src.stop_on_exit === "on" || src.stop_on_exit === "true";
  }
  if ("python" in src) out.python = String(src.python ?? "").trim();
  if ("cwd" in src) out.cwd = String(src.cwd ?? "").trim();
  if ("log" in src) out.log = String(src.log ?? "").trim();
  if ("host" in src) {
    const value = String(src.host ?? "").trim();
    if (/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) out.host = value;
  }
  if ("port" in src) {
    const n = Math.round(Number(src.port));
    if (Number.isFinite(n) && n >= 1 && n <= 65535) out.port = n;
  }
  if ("start_wait_ms" in src) {
    const n = Math.round(Number(src.start_wait_ms));
    if (Number.isFinite(n)) out.start_wait_ms = Math.min(600_000, Math.max(10_000, n));
  }
  if ("args" in src) {
    const raw = src.args;
    const list = Array.isArray(raw)
      ? raw.map((one: any) => String(one ?? "").trim()).filter(Boolean)
      : String(raw ?? "").trim().split(/\s+/).filter(Boolean);
    if (list.length) out.args = list.slice(0, 24);
  }
  return out;
}

const STYLE = `
.panel-body .pg-row{display:block;margin:0}
.panel-body .pg-label{display:block!important;font-size:15px!important;font-weight:700!important;color:inherit;margin:0 0 10px;line-height:1.45}
.panel-body .pg-row input[type=text],.panel-body .pg-row input[type=password],.panel-body .pg-row input[type=number]{display:block;width:100%;box-sizing:border-box;padding:10px 13px;font-size:14px;line-height:1.4;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-family:inherit}
.panel-body .pg-row input:focus{outline:none;border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.12)}
.panel-body .pg-row input:disabled{opacity:.55;cursor:not-allowed}
.panel-body .pg-check{display:flex!important;align-items:center;gap:10px}
.panel-body .pg-check .pg-label{margin:0}
.panel-body .pg-pair{display:grid;grid-template-columns:1fr 1fr;column-gap:36px;margin:0 0 30px}
.panel-body .pg-pair>.pg-item:only-child{grid-column:1/-1}
.panel-body .pg-item{min-width:0}
.panel-body .pg-hint{margin:10px 0 0;font-size:12px;line-height:1.65;color:#797e8c}
.pg-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
.pg-state{margin:0 0 22px;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.7;border:1px solid transparent}
.pg-state.on{background:rgba(5,150,105,.10);border-color:rgba(5,150,105,.35);color:#047857}
.pg-state.off{background:rgba(127,127,127,.10);border-color:rgba(127,127,127,.35);color:#5f6673}
.pg-result{margin:22px 0 0;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;border:1px solid transparent}
.pg-result.wait{background:rgba(124,92,255,.10);border-color:rgba(124,92,255,.35);color:#6d4aff}
.pg-result.ok{background:rgba(5,150,105,.10);border-color:rgba(5,150,105,.35);color:#047857}
.pg-result.err{background:rgba(220,38,38,.10);border-color:rgba(220,38,38,.35);color:#b91c1c}
.pg-tip{margin:0 0 26px;padding:14px 16px;border-radius:10px;font-size:13px;line-height:1.75;background:rgba(124,92,255,.08);border:1px solid rgba(124,92,255,.25);color:#6d4aff}
.pg-sub{margin:0 0 14px;font-size:12px;font-weight:700;color:#797e8c;letter-spacing:.06em}
.pg-btns{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 10px}
@media(max-width:760px){.panel-body .pg-pair{grid-template-columns:1fr}}
`;

export function renderPage(cfg: any, status: any = {}): string {
  const g = cfg?.gsv ?? {};
  const esc = (value: any) =>
    String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  const open = status?.open === true;
  const pids = Array.isArray(status?.pids) ? status.pids.join(", ") : "";
  const stateText = open ? `在运行（${esc(g.host)}:${esc(g.port)}）${pids ? "，PID：" + esc(pids) : ""}` : `没在运行（${esc(g.host)}:${esc(g.port)} 连不上）`;
  const argsText = Array.isArray(g.args) ? g.args.join(" ") : String(g.args ?? "");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>嗓子 · 配置</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>${STYLE}</style></head><body>
<main class="page">
<section class="panel">
<div class="panel-header"><h2>语音服务</h2><div class="pg-actions"><button class="btn primary" type="button" id="save">保存</button></div></div>
<div class="panel-body">
<div class="pg-state ${open ? "on" : "off"}" id="state">${stateText}</div>

<div class="pg-btns">
  <button class="btn primary" type="button" id="start">启动服务</button>
  <button class="btn" type="button" id="stop">停止服务</button>
  <button class="btn" type="button" id="refresh">刷新状态</button>
</div>
<p class="pg-hint" style="margin:0 0 26px">启动是异步的：命令发出去就返回，模型加载还要几十秒，用「刷新状态」看端口通没通。停止是按端口 ${esc(g.port)} 找进程，连子进程一起结束。</p>

<p class="pg-sub">伴随行为</p>
<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><div class="pg-check"><input type="checkbox" id="auto_start"${g.auto_start ? " checked" : ""}><label class="pg-label" for="auto_start">WhaleLife 开启时自动拉起语音合成</label></div><p class="pg-hint">勾上后，主程序起来就检查端口，已经在跑就不重复拉起。</p></div></div>
  <div class="pg-item"><div class="pg-row"><div class="pg-check"><input type="checkbox" id="stop_on_exit"${g.stop_on_exit ? " checked" : ""}><label class="pg-label" for="stop_on_exit">关闭 WhaleLife 时一并关掉语音合成</label></div><p class="pg-hint">不勾的话，主程序退了服务还留着，下次起来直接复用。</p></div></div>
</div>

<p class="pg-sub">服务进程</p>
<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="python">解释器</label><input type="text" id="python" value="${esc(g.python)}" placeholder="...\\venv\\Scripts\\pythonw.exe"><p class="pg-hint">用 pythonw.exe 不起黑窗。路径写错启动会静默失败，看日志。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="cwd">工作目录</label><input type="text" id="cwd" value="${esc(g.cwd)}" placeholder="...\\GPT-SoVITS\\repo"><p class="pg-hint">api_v2.py 所在目录，参数里的相对路径按这里算。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="host">监听地址</label><input type="text" id="host" value="${esc(g.host)}"><p class="pg-hint">一般 127.0.0.1，只给本机用。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="port">端口</label><input type="number" id="port" step="1" min="1" max="65535" value="${esc(g.port)}"><p class="pg-hint">默认 9880，要和「嘴巴」插件里的地址一致。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="args">启动参数</label><input type="text" id="args" value="${esc(argsText)}"><p class="pg-hint">空格分隔，例如 api_v2.py -a 127.0.0.1 -p 9880。</p></div></div>
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="log">日志文件</label><input type="text" id="log" value="${esc(g.log)}"><p class="pg-hint">启动失败先看这里，输出是追加的。</p></div></div>
</div>

<div class="pg-pair">
  <div class="pg-item"><div class="pg-row"><label class="pg-label" for="start_wait_ms">等待就绪上限（毫秒）</label><input type="number" id="start_wait_ms" step="1000" min="10000" max="600000" value="${esc(g.start_wait_ms)}"><p class="pg-hint">只在需要「等它真起来」时用，默认 180 秒。</p></div></div>
</div>

<div class="pg-result" id="out" hidden></div>
</div>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
function show(kind, text) {
  const box = $("out");
  box.hidden = false;
  box.className = "pg-result " + kind;
  box.textContent = text;
}
async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || value.reason || ("HTTP " + response.status));
  return value;
}
function paint(state) {
  const box = $("state");
  const open = state && state.open === true;
  box.className = "pg-state " + (open ? "on" : "off");
  box.textContent = open
    ? "在运行（" + state.host + ":" + state.port + "）" + (state.pids && state.pids.length ? "，PID：" + state.pids.join(", ") : "")
    : "没在运行（" + state.host + ":" + state.port + " 连不上）";
}
async function refresh() {
  try {
    const r = await post("/plugins/voice/status", {});
    paint(r.status || r);
    const at = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const live = r && r.status && r.status.open === true;
    const who = r && r.status && Array.isArray(r.status.pids) && r.status.pids.length ? "，PID：" + r.status.pids.join(", ") : "";
    show("ok", "已刷新 · " + at + " · " + (live ? "在运行" + who : "没在运行"));
  } catch (error) {
    show("err", "查状态失败：" + (error && error.message ? error.message : error));
  }
}
$("refresh").onclick = () => { refresh(); };
$("start").onclick = async () => {
  show("wait", "正在拉起…");
  try {
    const r = await post("/plugins/voice/start", {});
    show("ok", r.message || "已发出启动命令。");
    setTimeout(refresh, 1500);
  } catch (error) {
    show("err", "没起成：" + (error && error.message ? error.message : error));
  }
};
$("stop").onclick = async () => {
  show("wait", "正在停…");
  try {
    const r = await post("/plugins/voice/stop", {});
    show("ok", r.message || "已停。");
    setTimeout(refresh, 1200);
  } catch (error) {
    show("err", "没停成：" + (error && error.message ? error.message : error));
  }
};
$("save").onclick = async () => {
  show("wait", "保存中…");
  const body = {
    auto_start: $("auto_start").checked,
    stop_on_exit: $("stop_on_exit").checked,
    python: $("python").value,
    cwd: $("cwd").value,
    host: $("host").value,
    port: $("port").value,
    args: $("args").value,
    log: $("log").value,
    start_wait_ms: $("start_wait_ms").value,
  };
  try {
    await post("/plugins/voice/save", body);
    show("ok", "已保存。伴随开关下一次启动/退出才生效，服务参数下一次启动才用新的。");
  } catch (error) {
    show("err", "保存失败：" + (error && error.message ? error.message : error));
  }
};
refresh();
</script>
</body></html>`;
}
