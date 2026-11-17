/*! 递话监听插件的配置页：出表单、收表单、把提交上来的值洗一遍。
 *
 * 洗的逻辑必须在这边——页面是明文的，谁都改得了。
 */

/** 可编辑字段。没列在这里的一律拒收。 */
const FIELDS = {
  enabled: {
    kind: "boolean",
    label: "启用",
    hint: "默认关着。打开后开始按下面的间隔扫描信匣和递话出口。",
  },
  letters_dir: {
    kind: "text",
    label: "信匣目录",
    hint: "一封信一个 .md。第一次扫描只记账不报警，此后只报新落进来的。",
  },
  outbox_path: {
    kind: "text",
    label: "递话出口",
    hint: "写进去之后开始计时；超过下面的时长还没被取走，就判桥断。",
  },
  poll_seconds: {
    kind: "number", min: 5, max: 3600,
    label: "多久看一次（秒）",
    hint: "扫描间隔。调小报得及时，调大更省。20 秒是常用的值。",
  },
  bridge_timeout_seconds: {
    kind: "number", min: 5, max: 600,
    label: "多久没被取走算桥断（秒）",
    hint: "递话写出去后等这么久还没人取，就报一次桥断。只报一次，不会自动重投。",
  },
} as const;

type FieldKey = keyof typeof FIELDS;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** 读 POST 请求体，限 64KB。 */
export async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("提交的内容太大了");
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("提交的内容不是合法 JSON");
  }
}

/** 只留白名单里的字段，数字钳制，布尔转真布尔，列表拆成数组。 */
export function sanitize(input: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, spec] of Object.entries(FIELDS)) {
    if (!(key in input)) continue;
    const value = (input as any)[key];
    const s: any = spec;
    if (s.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      const step = Number(s.step ?? 1);
      const clamped = Math.max(s.min, Math.min(s.max, n));
      out[key] = step >= 1 ? Math.round(clamped) : Number((Math.round(clamped / step) * step).toFixed(3));
    } else if (s.kind === "boolean") {
      out[key] = value === true || value === "true" || value === "on" || value === 1;
    } else if (s.kind === "select") {
      const text = String(value ?? "").trim();
      if ((s.options as readonly string[]).includes(text)) out[key] = text;
    } else if (s.kind === "list") {
      const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,，\s]+/);
      out[key] = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))].slice(0, 16);
    } else {
      out[key] = String(value ?? "").trim().slice(0, 500);
    }
  }
  return out;
}

function field(key: FieldKey, cfg: any): string {
  const spec: any = FIELDS[key];
  const value = cfg?.[key];
  const name = esc(key);
  const label = esc(spec.label);
  const hint = spec.hint ? `<p class="pg-hint">${esc(spec.hint)}</p>` : "";
  let control: string;
  if (spec.kind === "boolean") {
    control = `<label class="pg-row pg-check"><input type="checkbox" name="${name}"${value ? " checked" : ""}><span class="pg-label">${label}</span></label>`;
  } else if (spec.kind === "select") {
    const opts = spec.options
      .map((o: any) => {
        const v = typeof o === "string" ? o : o.value;
        const t = typeof o === "string" ? o : o.label;
        return `<option value="${esc(v)}"${String(value) === v ? " selected" : ""}>${esc(t)}</option>`;
      })
      .join("");
    control = `<label class="pg-row"><span class="pg-label">${label}</span><select name="${name}">${opts}</select></label>`;
  } else if (spec.kind === "number") {
    control = `<label class="pg-row"><span class="pg-label">${label}</span><input type="number" name="${name}" value="${esc(value)}" min="${spec.min}" max="${spec.max}" step="${spec.step ?? 1}"></label>`;
  } else {
    control = `<label class="pg-row"><span class="pg-label">${label}</span><input type="text" name="${name}" value="${esc(value)}"></label>`;
  }
  return `<div class="pg-item">${control}${hint}</div>`;
}
/** 渲染配置页：结构和配色都走 /ui/styles.css，跟管理页同一套。 */
export function renderPage(cfg: any): string {
  const items = (Object.keys(FIELDS) as FieldKey[]).map((k) => field(k, cfg));
  const editable = items
    .reduce<string[]>((acc, cur, i) => {
      if (i % 2 === 0) acc.push(`<div class="pg-pair">${cur}`);
      else acc[acc.length - 1] += `${cur}</div>`;
      return acc;
    }, [])
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>递话监听 · 配置</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>
.panel-body .pg-row{display:block;margin:0}
.panel-body .pg-label{display:block!important;font-size:15px!important;font-weight:700!important;color:inherit;margin:0 0 10px;line-height:1.45}
.panel-body .pg-row input[type=text],.panel-body .pg-row input[type=number],.panel-body .pg-row select{display:block;width:100%;box-sizing:border-box;padding:10px 13px;font-size:14px;line-height:1.4;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-family:inherit}
.panel-body .pg-row input:focus,.panel-body .pg-row select:focus{outline:none;border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.12)}
.panel-body .pg-check{display:flex!important;align-items:center;gap:10px;padding-top:2px}
.panel-body .pg-check .pg-label{margin:0}
.panel-body .pg-pair{display:grid;grid-template-columns:1fr 1fr;column-gap:36px;margin:0 0 30px}
.panel-body .pg-pair:last-child{margin-bottom:0}
.panel-body .pg-pair>.pg-item:only-child{grid-column:1/-1}
.panel-body .pg-item{min-width:0}
.panel-body .pg-hint{margin:10px 0 0;font-size:12px;line-height:1.65;color:#797e8c}
.panel-body .pg-ro{display:grid;grid-template-columns:150px 1fr;gap:16px;margin:14px 0;font-size:13px;align-items:baseline}
.panel-body .pg-ro b{font-weight:600;color:#797e8c}
.panel-body .pg-ro code{background:rgba(127,127,127,.12);padding:2px 6px;border-radius:5px;word-break:break-all;font-size:12px}
.pg-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
#msg{font-size:13px;color:#059669}
#msg.err{color:#dc2626}
@media(max-width:760px){.panel-body .pg-pair{grid-template-columns:1fr}}
</style></head><body>
<form id="f">
<section class="panel"><div class="panel-header"><h2>可编辑</h2><div class="pg-actions"><button class="btn primary" type="submit" form="f" id="ok">保存</button><span id="msg"></span></div></div><div class="panel-body">
${editable}
</div></section>
</form>
<script type="module">
const form = document.getElementById("f");
const msg = document.getElementById("msg");
const ok = document.getElementById("ok");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    data[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  ok.disabled = true; msg.className = ""; msg.textContent = "保存中…";
  try {
    const res = await fetch("/plugins/watcher/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    msg.textContent = "已保存，下一轮轮询生效";
  } catch (error) {
    msg.className = "err";
    msg.textContent = "没存上：" + (error?.message || error);
  } finally { ok.disabled = false; }
});
</script></body></html>`;
}
