/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export async function api(path, data, signal) {
  const response = await fetch(
    path,
    data === undefined
      ? { cache: "no-store", signal }
      : {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || "请求失败，请重试");
    error.status = response.status;
    if (Array.isArray(value.rolledBack)) error.rolledBack = value.rolledBack;
    throw error;
  }
  return value;
}
export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
export const typeNames = {
  chat: "对话",
  diary: "日记整理",
  embedding: "向量 / Embedding",
  rerank: "重排序",
  image: "图像生成",
  stt: "语音识别",
  tts: "语音合成",
  custom: "其他",
};
export const uid = (prefix) =>
  prefix + "_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);

export const coreChatModel = (config, model) =>
  model.type === "chat" &&
  (config.providers.find((p) => p.id === model.provider)?.protocol ?? "openai-compatible") === "openai-compatible";

export const availableModels = (config) =>
  config.models.filter(
    (m) =>
      ["chat", "embedding"].includes(m.type) &&
      (m.type === "chat" ? coreChatModel(config, m) :
        ["openai-compatible", "dashscope"].includes(config.providers.find((p) => p.id === m.provider)?.protocol ?? "openai-compatible")) &&
      m.enabled &&
      !m.configuration_error &&
      config.providers.find((p) => p.id === m.provider)?.enabled,
  );
export const extensionPlugins = (status) =>
  status.plugins.filter((p) => !p.builtin);

export const viewedSession = (state) => state.memorySession || state.session;
export const sessionName = (state, id = state.session) =>
  state.sessions?.find(item => item.id === id)?.name ||
  (id === state.session && state.sessionName) ||
  state.memoryCatalog?.sessions?.items?.find(item => item.id === id)?.name || id || "尚未选择";
