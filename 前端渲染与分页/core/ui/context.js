/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e, viewedSession, sessionName } from "./api.js";
const number = (value) => Number(value).toLocaleString();
const currencies = Intl.supportedValuesOf?.("currency");
const diaryEnabled = (policy = {}) => policy.diary_enabled ?? policy.memory_mode === "diary";
const percentage = (value, limit) => limit > 0 && Number.isFinite(value) ? value.toFixed(2) + "%" : null;
function requestMetrics(usage) {
  const cache = usage?.cache, cost = usage?.cost;
  const cachePercent = Number.isFinite(cache?.hit_percent) && cache.hit_percent >= 0 && cache.hit_percent <= 100
    ? cache.hit_percent.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + "%" : null;
  const tokens = value => Number.isSafeInteger(value) && value >= 0 ? number(value) + " tokens" : "未报告";
  const cacheDetail = `最近一次请求缓存：命中 ${tokens(cache?.hit_tokens)}；未命中 ${tokens(cache?.miss_tokens)}；命中率 ${cachePercent || "未报告"}。`;
  const validMoney = value => Number.isFinite(value) && value >= 0;
  // 价目表按供应商本币记账：DeepSeek 官方是 CNY，MiraRouter 与 Gemini 是 USD。
  const reported = usage?.reported_cost;
  const reportedAmount = validMoney(reported?.amount) && typeof reported.currency === "string" &&
    (currencies ? currencies.includes(reported.currency) : /^[A-Z]{3}$/.test(reported.currency))
    ? `${reported.amount} ${reported.currency}` : null;
  const symbol = cost?.currency === "USD" ? "$" : "¥";
  const money = value => value > 0 && value < 0.000001 ? `<${symbol}0.000001` :
    symbol + value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
  const priced = cost?.basis === "reference" && (cost?.currency === "CNY" || cost?.currency === "USD");
  const amount = priced ?
    validMoney(cost.amount) ? money(cost.amount) : validMoney(cost.min) && validMoney(cost.max) && cost.max >= cost.min ?
      `${money(cost.min)}–${money(cost.max)}` : null : null;
  const costDetail = reportedAmount ? `接口回传费用：${reportedAmount}。实际扣款以服务商账单为准。` : amount
    ? `参考费用：${amount}；参考价日期 ${cost.price_date} · ${cost.period === "off_peak" ? "低峰时段" : "高峰或节假日"}。仅作参考，不等于账单。`
    : "参考费用：价格未知，暂不估算费用。";
  const scope = "以上缓存与费用仅对应最近一次模型请求，不含同轮其他工具调用或日记整理请求。";
  const costLabel = reportedAmount ? "本次回传 " + reportedAmount : amount ? "估算" + amount : "价格未知";
  return { compact: `缓存${cachePercent ? " " + cachePercent : "未报告"} · ${costLabel}`,
    cacheDetail, costDetail, scope };
}
export function renderContextMeter(value, compact = false) {
  const usage = value?.usage, estimate = value?.context_estimate,
    limit = value?.model?.context_window,
    percent = percentage(estimate ? estimate.percent : usage?.percent, limit),
    source = estimate ? "当前估算" : "最近实测";
  const metrics = requestMetrics(usage);
  const measured = usage
    ? `最近请求实测：输入 ${number(usage.input_tokens)} + 输出 ${number(usage.output_tokens)} = ${number(usage.used_tokens)} tokens；${new Date(usage.measured_at).toLocaleString()}${usage.settings_changed ? "；设置已变更" : ""}`
    : "尚无此模型和人格的实测记录；下一次对话后显示服务返回的 token 用量。";
  if (compact) {
    const label = !value
      ? "正在读取上下文…"
      : value.error
        ? value.error
        : `上下文 ${percent || (limit ? "未统计" : "容量未知")} · ${source} · ${metrics.compact}${usage?.settings_changed ? " · 设置已变更" : ""}`;
    const detail = estimate
      ? `当前估算：输入 ${number(estimate.input_tokens)} + 预留输出 ${number(estimate.reserved_output_tokens)} tokens。${measured}`
      : `${measured}${usage && percent ? `；${number(usage.used_tokens)} / ${number(limit)} tokens · ${percent}` : ""}`;
    return `<div class="chat-context-compact"><span title="${e(`${detail} ${metrics.cacheDetail}${metrics.costDetail}${metrics.scope}`)}">${e(label)}</span>${value && !value.error && !limit ? '<a href="#models">填写模型容量</a>' : '<a href="#memory">会话与上下文设置</a>'}</div>`;
  }
  if (!value) return '<p class="muted">正在读取上下文统计…</p>';
  if (value.error) return `<p class="muted">${e(value.error)}</p>`;
  return `<div class="context-meter"><div class="row"><strong>${percent || (limit ? "暂无占用统计" : "上下文容量未知")} · ${source}</strong><div class="spacer"></div><span>${e(value.model?.name || "当前模型")} · ${limit ? number(limit) + " tokens" : "上限未提供"}</span></div>${percent ? `<progress max="100" value="${Math.max(0, Math.min(100, estimate ? estimate.percent : usage.percent))}" aria-label="上下文${source}占用">${percent}</progress>` : ""}${estimate ? `<p>当前估算：输入 ${number(estimate.input_tokens)} + 预留输出 ${number(estimate.reserved_output_tokens)} = ${number(estimate.total_tokens)} tokens。包含已保存上下文；新输入与工具结果会继续增加占用。</p>` : ""}<p>${e(measured)}${!limit ? ' <a href="#models">填写模型上下文上限</a>后才能计算占比和判断压缩时机。' : ""}</p><p>${e(metrics.cacheDetail)} ${e(metrics.costDetail)}</p><p>${e(metrics.scope)}</p></div>`;
}
function renderDiarySettings(p, mergeChars) {
  return `<div class="row context-options"><label><input id="context-diary-enabled" type="checkbox" name="diary_enabled" ${diaryEnabled(p) ? "checked" : ""}>自动整理为日记</label><small>默认关闭。只控制后续生成；已有有效日记仍按历史范围用于上下文。</small></div><p class="muted">上下文保留有效日记与尚未覆盖的原文；没有日记时带入完整有效历史。开启自动整理后，占用达到触发比例时，将较早的原始对话写成一篇新日记，保留近期原文。已有日记按篇追加，不重新总结；原始档案始终保留。超出模型容量时会明确提示。</p><div data-diary-settings ${diaryEnabled(p) ? "" : "hidden"}><div class="context-fields"><label>开始整理的占用比例（%）<input name="compression_trigger_percent" type="number" required min="10" max="95" step="1" value="${e(p.compression_trigger_percent ?? 80)}"></label><label>整理后的目标占用比例（%）<input name="compression_target_percent" type="number" required min="5" max="94" step="1" value="${e(p.compression_target_percent ?? 50)}"></label></div><div class="context-fields"><label>日记合并阈值（字）<input name="diary_merge_chars" type="number" min="2000" max="500000" step="1000" placeholder="40000" value="${mergeChars ?? ""}"></label></div><p class="muted">日记总字数到线时，把最早的若干篇合成一篇，原文移入备份目录；最新一篇不参与。全局设置，不分会话。</p><div class="row"><button class="btn small" type="button" data-diary-defaults>恢复推荐值 80% / 50%</button><small>目标比例须低于触发比例。修改后点击保存才生效。</small></div></div>`;
}
function renderDiaryState(current) {
  const diary = current?.diary;
  if (!diary) return "";
  return `<div class="context-diary-state"><p class="muted">日记 ${number(diary.count ?? diary.entries?.length ?? 0)} 篇 · 覆盖 ${number(diary.covered_messages ?? 0)} 条原文 · 剩余 ${number(diary.remaining_messages ?? current.available_messages ?? 0)} 条原文 · 日记正文 ${number(diary.chars ?? 0)} 字符${diary.enabled === false ? "；自动整理已关闭，已有有效日记仍按历史设置使用" : ""}${Number.isFinite(diary.budget_remaining) ? `。今日整理剩余额度 ${number(diary.budget_remaining)} tokens` : ""}。</p>${diary.invalid ? '<p class="muted">部分日记的来源已变化，暂不带入上下文，需根据有效原文重建。</p>' : ""}${diary.notice ? `<p class="muted">${e(diary.notice)}</p>` : ""}${diary.paused ? `<p class="form-error">日记整理已暂停；保留原文与已保存日记。${diary.paused.reason ? e(diary.paused.reason) : ""}</p><button class="btn small" type="button" data-diary-retry>恢复日记整理</button>` : ""}</div>`;
}
export function renderContextPanel(app) {
  const s = app.state, current = s.memoryContext, selected = viewedSession(s);
  const items = s.sessions?.length ? s.sessions : s.memoryCatalog?.sessions?.items || [];
  const choices = [
    { id: selected, name: current?.name || sessionName(s, selected) },
    ...items.filter((x) => x.id !== selected),
  ];
  const p = current?.policy;
  return `<section class="panel panel-body session-context-panel"><div class="row"><h2>所选档案的上下文</h2><div class="spacer"></div><a href="#bindings" class="btn small">切换使用的会话</a></div><div class="context-session-select"><label for="context-session">查看会话档案</label><select id="context-session">${choices.map((item) => `<option value="${e(item.id)}" ${item.id === selected ? "selected" : ""}>${e(item.name || item.id)}${item.id === s.session ? "（正在使用）" : ""}</option>`).join("")}</select><small>仅切换查看的档案，不改变当前使用的会话。</small></div>${renderContextMeter(current)}${p ? `<form id="context-form"><div class="context-session-select"><label for="context-history-scope">历史范围</label><select id="context-history-scope" name="history_scope"><option value="persona" ${p.history_scope === "persona" ? "selected" : ""}>仅当前人格版本</option><option value="session" ${p.history_scope !== "persona" ? "selected" : ""}>此会话全部历史（含旧人格）</option></select></div>${renderDiarySettings(p, s.diarySettings?.merge_chars)}<div class="row context-options"><label><input type="checkbox" name="history_enabled" ${(p.history_enabled ?? p.recent_lines !== 0) ? "checked" : ""}>带入历史消息</label><label><input type="checkbox" name="include_facts" ${p.include_facts ? "checked" : ""}>带入共享事实</label><div class="spacer"></div><button class="btn primary small" type="submit" ${s.chatBusy ? "disabled" : ""}>保存所选档案设置</button></div><p class="muted">当前范围内有 ${number(current.available_messages ?? 0)} 条有效历史消息（档案共 ${number(current.stored_messages ?? 0)} 条）。设置仅在点击保存后生效。</p>${renderDiaryState(current)}<p class="form-error" id="context-error" role="alert"></p></form>` : ""}</section>`;
}
export function bindContextSettings(app, reload) {
  const select = app.content.querySelector("#context-session");
  if (select)
    select.onchange = async () => {
      try {
        app.state.memorySession = select.value;
        app.state.memoryContext = null;
        await reload();
      } catch (error) {
        app.toast(error.message, true);
      }
    };
  const form = app.content.querySelector("#context-form");
  const mergeInput = app.content.querySelector('[name="diary_merge_chars"]');
  if (mergeInput)
    api("/api/memory/diary/settings").then((value) => {
      app.state.diarySettings = value;
      mergeInput.value = String(value.merge_chars);
    }).catch(() => {});
  const loaded = app.state.memoryLoadedSession;
  const diarySwitch = app.content.querySelector("#context-diary-enabled");
  const bindDefaults = () => {
    const reset = app.content.querySelector("[data-diary-defaults]");
    if (reset) reset.onclick = () => {
      form.querySelector('[name="compression_trigger_percent"]').value = "80";
      form.querySelector('[name="compression_target_percent"]').value = "50";
    };
  };
  if (diarySwitch) diarySwitch.onchange = () => {
    form.querySelector("[data-diary-settings]").hidden = !diarySwitch.checked;
  };
  bindDefaults();
  const retry = app.content.querySelector("[data-diary-retry]");
  if (retry) retry.onclick = async () => {
    retry.disabled = true;
    try {
      if (loaded !== viewedSession(app.state)) throw Error("正在查看的档案已改变，请重新读取后操作");
      await api("/api/memory/diary/retry", { id: loaded });
      await reload();
    } catch (error) {
      form.querySelector("#context-error").textContent = error.message;
      retry.disabled = false;
    }
  };
  if (form)
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      const data = new FormData(form);
      try {
        if (loaded !== viewedSession(app.state)) throw Error("正在查看的档案已改变，请重新读取后操作");
        const mergeRaw = data.get("diary_merge_chars");
        if (mergeRaw !== null && mergeRaw !== undefined && String(mergeRaw).trim() !== "") {
          const next = Number(mergeRaw);
          if (!Number.isInteger(next) || next < 2000 || next > 500000)
            throw Error("日记合并阈值须为 2000–500000 之间的整数。");
          if (next !== app.state.diarySettings?.merge_chars) {
            app.state.diarySettings = await api("/api/memory/diary/settings", { merge_chars: next });
            if (mergeInput) mergeInput.value = String(app.state.diarySettings.merge_chars);
          }
        }
        const context = {
          history_enabled: data.has("history_enabled"),
          include_facts: data.has("include_facts"),
          history_scope: data.get("history_scope"),
          diary_enabled: data.has("diary_enabled"),
          compression_trigger_percent: Number(data.get("compression_trigger_percent") ?? 80),
          compression_target_percent: Number(data.get("compression_target_percent") ?? 50),
        };
        if (!Number.isInteger(context.compression_trigger_percent) ||
             !Number.isInteger(context.compression_target_percent) ||
             context.compression_target_percent < 5 || context.compression_trigger_percent < 10 || context.compression_trigger_percent > 95 ||
             context.compression_target_percent >= context.compression_trigger_percent)
          throw Error("整理比例须为整数：触发比例为 10%–95%，目标至少为 5% 且低于触发比例。");
        const value = await api("/api/session/context", {
          id: loaded,
          context,
        });
        if (loaded === viewedSession(app.state)) app.state.memoryContext = value;
        if (loaded === app.state.session) app.state.sessionContext = value;
        await reload();
        app.toast("所选档案的上下文已保存，该会话下轮生效");
      } catch (error) {
        form.querySelector("#context-error").textContent = error.message;
        button.disabled = false;
      }
    };
}
