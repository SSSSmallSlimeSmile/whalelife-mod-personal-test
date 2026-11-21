/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { api, escapeHTML as e, availableModels } from "./api.js";
import { icon, whale } from "./icons.js";
import { renderModels, bindModels } from "./models.js";
import { renderPersonas, bindPersonas } from "./personas.js";
import { renderMemory, bindMemory, loadMemory } from "./memory.js";
import { renderContextMeter } from "./context.js";
import { renderStore, bindStore } from "./plugin-store.js";
import { bindHostUpdate, resetHostUpdateSession } from "./host-updates.js";
import { extensionPage, extensionNavigation, extensionActiveKey, extensionSignature, updateExtensionContent } from "./extensions.js";
import {
  renderOverview,
  renderBindings,
  bindBindings,
  renderPlugins,
  bindPlugins,
  renderChat,
  bindChat,
  renderLogs,
  bindLogs,
} from "./views.js";

const pages = {
  memory: { name: "记忆管理", render: renderMemory, bind: bindMemory },
  personas: { name: "人格配置", render: renderPersonas, bind: bindPersonas },
  overview: { name: "概览", render: renderOverview, bind: bindHostUpdate },
  models: { name: "模型服务", render: renderModels, bind: bindModels },
  bindings: { name: "使用配置", render: renderBindings, bind: bindBindings },
  chat: { name: "对话", render: renderChat, bind: bindChat },
  plugins: { name: "插件管理", render: renderPlugins, bind: bindPlugins },
  logs: { name: "运行日志", render: renderLogs, bind: bindLogs },
};
const thinkingFaces = ["(｡•ᴗ•｡)","(´｡• ᵕ •｡`)","(๑•̀ㅂ•́)و","(￣▽￣)","(＝ω＝)","(っ˘ω˘ς)","(๑´ω`๑)","(・ω・)","(๑•́ ₃ •̀๑)","( ˘ω˘ )","(´▽`)","(･ω･)ﾉ"];
const pickThinkingFace = () => thinkingFaces[Math.floor(Math.random() * thinkingFaces.length)];
const $ = (id) => document.getElementById(id);
const storeRoute = () => /^#market(?:\/([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*))?$/.exec(location.hash);
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
document
  .querySelectorAll("[data-whale]")
  .forEach((el) => (el.innerHTML = whale));

class ConsoleApp {
  content = $("content");
  chatWS = null;
  logWS = null;
  reply = null;
  authenticated = false;
  generation = 0;
  toastTimer = null;
  sessionSync = 0;
  sessionReady = false;
  sessionChanging = false;
  state = {
    page: "overview",
    config: null,
    status: null,
    probes: {},
    messages: [],
    logs: [],
    logFollow: true,
    chatBusy: false,
    chatDraft: "",
    pendingImages: [],
    session: null,
    sessions: [],
    memorySession: null,
  };
  constructor() {
    this.state.page = this.pageFromHash();
    window.addEventListener("hashchange", () => {
      this.storeNavigating = false;
      const route = storeRoute();
      const page = this.pageFromHash();
      if (route && this.authenticated) {
        if (page !== this.state.page) {
          this.hideStore();
          this.state.page = page;
          this.render();
        }
        this.restoreStoreRoute(route);
        return;
      }
      if ($("store-drawer").open) {
        this.hideStore();
        if (page === this.state.page) return;
      }
      this.state.page = page;
      this.bindingsDirty = false;
      if (this.state.page === "memory") this.state.memoryLoadedTab = null;
      document.body.classList.remove("sidebar-open");
      $("sidebar-scrim").hidden = true;
      if (this.authenticated) {
        this.render();
        this.syncView();
        if (this.state.page === "memory") loadMemory(this);
      }
    });
    this.content.addEventListener("click", event => {
      const link = event.target.closest('a[href="#market"]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      this.storeTrigger = link;
      history.pushState({ storeOrigin: this.state.page }, "", "#market");
      this.displayStore(null);
    });
    const drawer = $("store-drawer");
    drawer.addEventListener("cancel", event => {
      event.preventDefault();
      this.leaveStore(false);
    });
    drawer.addEventListener("click", event => {
      if (event.target !== drawer) return;
      const r = drawer.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX >= r.right || event.clientY < r.top || event.clientY >= r.bottom) this.leaveStore(true);
    });
    window.addEventListener("focus", () => this.syncView());
    window.addEventListener("focus", () => this.refreshOnFocus());
    $("login-form").onsubmit = (event) => {
      event.preventDefault();
      this.login();
    };
    $("refresh").onclick = () => this.reload();
    $("menu-toggle").onclick = () => {
      if (innerWidth <= 760) {
        document.body.classList.toggle("sidebar-open");
        $("sidebar-scrim").hidden =
          !document.body.classList.contains("sidebar-open");
      } else document.body.classList.toggle("collapsed");
    };
    $("sidebar-scrim").onclick = () => {
      document.body.classList.remove("sidebar-open");
      $("sidebar-scrim").hidden = true;
    };
    $("dialog").addEventListener("click", (event) => {
      if (event.target === $("dialog") && !this.dialogBusy) this.closeDialog();
    });
    $("dialog").addEventListener("cancel", (event) => {
      if (this.dialogBusy) event.preventDefault();
    });
  }
  pageFromHash() {
    if (storeRoute()) return history.state?.storeOrigin === "overview" ? "overview" : "plugins";
    const key = location.hash.slice(1);
    return pages[key] || key.startsWith("extension:") || key.startsWith("plugin:") ? key : "overview";
  }
  restoreStoreRoute(route) {
    // Give a bookmarked drawer the same return path as a visit from the console.
    if (!history.state?.storeOrigin) {
      const origin = this.state.page;
      history.replaceState(null, "", "#" + origin);
      history.pushState({ storeOrigin: origin }, "", "#market");
      if (route[1]) history.pushState({ storeOrigin: origin }, "", "#market/" + route[1]);
    }
    this.displayStore(route[1] || null);
  }
  showStoreDetail(id) {
    history.pushState({ storeOrigin: this.state.page }, "", "#market/" + id);
    this.displayStore(id);
  }
  leaveStore(all) {
    if (this.storeNavigating) return;
    this.storeNavigating = true;
    history.go(all && this.state.storeDetail ? -2 : -1);
  }
  displayStore(id) {
    const drawer = $("store-drawer");
    const previous = this.state.storeDetail;
    const opening = !drawer.open;
    if (opening) {
      this.storeScroll = 0;
      this.storeTrigger ??= this.content.querySelector('a[href="#market"]');
      drawer.innerHTML = `<header class="store-drawer-bar">
        <button type="button" data-store-back></button>
        <button type="button" data-store-close>关闭商店 ${icon("close")}</button>
      </header><div class="store-drawer-body"></div>`;
      drawer.querySelector("[data-store-back]").onclick = () => this.leaveStore(false);
      drawer.querySelector("[data-store-close]").onclick = () => this.leaveStore(true);
      drawer.showModal();
    } else if (!previous && id) {
      this.storeScroll = drawer.querySelector("[data-store-scroll]")?.scrollTop || 0;
    }
    this.state.storeDetail = id;
    const backLabel = id ? "插件商店" : pages[this.state.page].name;
    drawer.querySelector("[data-store-back]").innerHTML = icon("back") + "返回" + backLabel;
    const container = drawer.querySelector(".store-drawer-body");
    container.innerHTML = renderStore(this);
    bindStore(this, container, opening);
    const scroll = container.querySelector("[data-store-scroll]");
    if (scroll && !id) scroll.scrollTop = this.storeScroll;
    const card = !id && previous ? container.querySelector(`[data-store-entry="${CSS.escape(previous)}"]`) : null;
    (card || container.querySelector("#store-heading") || drawer.querySelector("[data-store-back]")).focus({ preventScroll: true });
    document.title = "插件商店 · WhaleLife";
  }
  hideStore() {
    const drawer = $("store-drawer");
    if (!drawer.open) return;
    if ($("dialog").open) this.closeDialog();
    drawer.close();
    drawer.replaceChildren();
    this.storeOfficialChange = null;
    this.state.storeDetail = null;
    if (this.storeNeedsRefresh) {
      this.storeNeedsRefresh = false;
      const expanded = new Set([...this.content.querySelectorAll(".plugin-card-children[open]")]
        .map(detail => detail.closest(".plugin-card").querySelector("[data-official-manage-slot]")?.dataset.officialManageSlot));
      const scrollY = window.scrollY;
      this.render();
      for (const detail of this.content.querySelectorAll(".plugin-card-children")) {
        const owner = detail.closest(".plugin-card").querySelector("[data-official-manage-slot]");
        if (owner && expanded.has(owner.dataset.officialManageSlot)) detail.open = true;
      }
      window.scrollTo({ top: scrollY, behavior: "instant" });
    }
    const trigger = this.storeTrigger?.isConnected ? this.storeTrigger : this.content.querySelector('a[href="#market"]');
    trigger?.focus({ preventScroll: true });
    this.storeTrigger = null;
    document.title = pages[this.state.page].name + " · WhaleLife";
  }
  get chatConnected() {
    return this.chatWS?.readyState === WebSocket.OPEN;
  }
  get logConnected() {
    return this.logWS?.readyState === WebSocket.OPEN;
  }
  async start() {
    try {
      await this.load();
      await this.enter();
    } catch (error) {
      if (error.status !== 401)
        $("login-error").textContent = "连接控制台失败：" + error.message;
    }
  }
  async load() {
    const config = await api("/api/model-config");
    const status = await api("/api/status");
    this.state.status = status;
    this.state.config = config;
    await this.syncSession();
  }
  async login() {
    const button = $("login-form").querySelector("button");
    button.disabled = true;
    $("login-error").textContent = "";
    try {
      await api("/api/login", { password: $("password").value });
      $("password").value = "";
      if (this.reloadAfterHostUpdate) {
        // The restarted server can ship different console modules.
        location.reload();
        return;
      }
      await this.load();
      await this.enter();
    } catch (error) {
      $("login-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  async enter() {
    this.authenticated = true;
    $("login").hidden = true;
    $("shell").hidden = false;
    this.render();
    const route = storeRoute();
    if (route) this.restoreStoreRoute(route);
    this.connect("chat");
    this.connect("logs");
  }
  async refreshStatus() {
    this.state.status = await api("/api/status");
  }
  async useSession(id) {
    if (this.state.chatBusy || this.sessionChanging) throw Error("请等待当前操作结束后切换会话");
    this.sessionChanging = true;
    this.updateChatControls();
    try {
      await this.syncSession({ id });
      this.state.chatDraft = "";
      this.render();
    } finally {
      this.sessionChanging = false;
      this.updateChatControls();
    }
  }
  async renameSession() {
    const id = this.state.session;
    if (!id) return;
    const current = this.state.sessionName || "";
    this.dialog(
      "会话改名",
      `<label for="rename-session-name">名称</label><input id="rename-session-name" name="name" maxlength="80" required value="${e(current)}" placeholder="给这个会话取个名字">`,
      async (data) => {
        const name = String(data.get("name") || "").trim();
        if (!name) throw Error("名称不能为空");
        await api("/api/memory/session/rename", { id, name });
        this.state.sessionName = name;
        const item = (this.state.sessions || []).find((x) => x.id === id);
        if (item) item.name = name;
        if (this.state.page === "chat") this.render();
        this.toast("会话名称已保存");
      },
      "保存名称",
    );
  }
  async syncSession(input) {
    if (this.state.chatBusy || (!input && this.sessionChanging)) return;
    const sequence = ++this.sessionSync;
    const { id } = await api("/api/session/current", input ??
      (this.sessionReady ? undefined : { legacyId: localStorage.whaleSession }));
    const [page, choices] = await Promise.all([
      api("/api/session?id=" + encodeURIComponent(id) + "&limit=" + PAGE_SIZE),
      api("/api/session/list"),
    ]);
    if (sequence !== this.sessionSync || this.state.chatBusy) return;
    this.sessionReady = true;
    if (this.state.session !== id) this.state.sessionContext = null;
    this.state.session = id;
    this.state.sessions = choices.items;
    this.state.sessionName = choices.items.find(item => item.id === id)?.name || id;
    if (this.state.memorySession && !choices.items.some(item => item.id === this.state.memorySession)) {
      this.state.memorySession = null;
      this.state.memoryContext = null;
      this.state.memoryLoadedTab = null;
    }
    localStorage.whaleSession = id;
    this.state.msgStart = page.start;
    this.state.msgTotal = page.total;
    this.state.msgHasMore = page.hasMore;
    this.olderLoading = false;
    this.state.messages = page.items
      .filter((r) => r.type === "message")
      .map((r) => ({
        role: r.role,
        text: r.text,
        protocolOriginal: r.tool_protocol_original,
        personaName: r.persona_name,
        at: r.ts,
        files: r.files,
      }));
  }
  /** 往上翻一页：用加载行撑住高度，翻完还原滚动位置，不跳。 */
  async loadOlder() {
    if (this.olderLoading || !this.state.msgHasMore || this.state.chatBusy) return;
    const box = $("messages");
    if (!box) return;
    this.olderLoading = true;
    const more = box.querySelector(".chat-history-more");
    if (more) more.textContent = "加载中…";
    const id = this.state.session;
    try {
      const page = await api(
        "/api/session?id=" + encodeURIComponent(id) +
          "&limit=" + PAGE_SIZE + "&before=" + this.state.msgStart,
      );
      if (id !== this.state.session) return;
      const height = box.scrollHeight;
      const older = page.items
        .filter((r) => r.type === "message")
        .map((r) => ({
          role: r.role,
          text: r.text,
          personaName: r.persona_name,
          at: r.ts,
          files: r.files,
        }));
      this.state.messages = older.concat(this.state.messages);
      this.state.msgStart = page.start;
      this.state.msgTotal = page.total;
      this.state.msgHasMore = page.hasMore;
      this.olderLoading = false;
      this.renderMessages();
      const grow = box.scrollHeight - height;
      box.scrollTop += grow;
      requestAnimationFrame(() => { box.scrollTop += grow; });
      return;
    } catch (error) {
      this.toast(error.message, true);
    } finally {
      this.olderLoading = false;
      const stale = $("messages")?.querySelector(".chat-history-more");
      if (stale) stale.textContent = "加载更早的 " + PAGE_SIZE + " 条";
    }
  }
  /** 左侧段落目录：满 20 条或隔 30 分钟切一段，点一下跳到那段。 */
  /** 左侧导航轨：一条用户请求一节。轨道上只画刻度，摘要放进悬浮卡（勘 2026-11-16）。 */
  renderOutline() {
    const rail = $("chat-rail");
    if (!rail) return;
    this.railTurns = [];
    let turn = null;
    (this.state.messages || []).forEach((m, index) => {
      if (m.role === "user") {
        turn = { from: index, ask: plainText(m.text), answers: [] };
        this.railTurns.push(turn);
        return;
      }
      if (turn && m.text) turn.answers.push(plainText(m.text));
    });
    if (this.railTurns.length < 3) {
      rail.hidden = true;
      rail.innerHTML = "";
      this.hideRailCard();
      return;
    }
    rail.hidden = false;
    rail.innerHTML =
      this.railTurns
        .map(
          (t, i) =>
            '<button type="button" class="chat-rail-tick" data-turn="' + i +
            '" aria-label="' + e(clip(t.ask, 40)) + '"><i></i></button>',
        )
        .join("");
    rail.querySelectorAll("[data-turn]").forEach((tick) => {
      tick.onmouseenter = () => this.showRailCard(tick);
      tick.onmouseleave = () => this.hideRailCard();
      tick.onfocus = () => this.showRailCard(tick);
      tick.onblur = () => this.hideRailCard();
      tick.onclick = () => this.jumpToTurn(Number(tick.dataset.turn));
    });
    this.watchRail();
  }
  railCard() {
    let card = document.getElementById("chat-rail-card");
    if (!card) {
      card = document.createElement("div");
      card.id = "chat-rail-card";
      card.className = "chat-rail-card";
      card.hidden = true;
      document.body.appendChild(card);
    }
    return card;
  }
  /** 悬浮卡贴在刻度右边，纵向不许出窗口。 */
  showRailCard(tick) {
    const turn = (this.railTurns || [])[Number(tick.dataset.turn)];
    if (!turn) return;
    const card = this.railCard();
    const answer = turn.answers.join(" ");
    card.innerHTML =
      "<b>" + e(clip(turn.ask, 120)) + "</b>" +
      "<span>" + e(clip(answer || "（这一节没有回答）", 260)) + "</span>" +
      '<span class="chat-rail-card-meta">' + (1 + turn.answers.length) + " 条</span>";
    card.hidden = false;
    const rect = tick.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const left = Math.min(rect.right + 12, window.innerWidth - box.width - 12);
    const top = Math.max(12, Math.min(rect.top - 8, window.innerHeight - box.height - 12));
    card.style.left = Math.max(12, left) + "px";
    card.style.top = top + "px";
  }
  hideRailCard() {
    const card = document.getElementById("chat-rail-card");
    if (card) card.hidden = true;
  }
  jumpToTurn(index) {
    const turn = (this.railTurns || [])[index];
    if (!turn) return;
    const nodes = $("messages")?.querySelectorAll(".message") || [];
    nodes[turn.from]?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  /** 滚动或窗口尺寸一变就重排：刻度按消息的真实位置摆，紫色只留一个（勘 2026-11-16）。
      旧版一边画按比例插值的游标、一边画按消息判定的高亮，两者位置不一致，
      看着就是"对不上"；窗口一改尺寸还会同时看到两条紫线。现在只保留刻度本身。 */
  watchRail() {
    const rail = $("chat-rail");
    const box = $("messages");
    if (!rail || !box) return;
    // 每次 render() 都会用整页 markup 重建 #messages，拿到的是新节点；
    // 旧监听还挂在被摘下来的那个节点上，此后滚动手势再也送不到轨道，
    // 高亮就永远停在最后一次算出来的位置（勘 2026-11-16 修）。
    if (this.railBox !== box) {
      if (this.railBox && this.railScrollHandler)
        this.railBox.removeEventListener("scroll", this.railScrollHandler);
      this.railScrollHandler = () => this.syncRail();
      box.addEventListener("scroll", this.railScrollHandler, { passive: true });
      this.railBox = box;
    }
    if (!this.railWatched) {
      this.railWatched = true;
      window.addEventListener("resize", () => this.syncRail(), { passive: true });
      // 切窗口回来时，尺寸没变、滚动没变，一个事件都不会来。
      // 上一轮若是趁容器被隐藏时算过一遍，高亮就钉死了，得给个重新对账的机会（勘 2026-11-16 修）。
      window.addEventListener("focus", () => this.syncRail());
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.syncRail();
      });
    }
    // ResizeObserver 每次都要盯住"当前的"内容节点。
    // 旧写法只在第一次 observe：一旦 #messages 的内层被整体换掉，
    // 观察者盯的就是已经摘下来的节点，此后永不触发（勘 2026-11-16 修）。
    if (typeof ResizeObserver === "function") {
      const target = box.firstElementChild || box;
      if (this.railObserverTarget !== target) {
        if (!this.railObserver) this.railObserver = new ResizeObserver(() => this.syncRail());
        this.railObserver.disconnect();
        this.railObserver.observe(target);
        this.railObserverTarget = target;
      }
    }
    this.syncRail();
  }
  syncRail() {
    const rail = $("chat-rail");
    const box = $("messages");
    if (!rail || !box || rail.hidden) return;
    // 窗口最小化、切到后台、渲染中途容器被隐藏时，所有 rect 都是 0。
    // 那时"每条消息都顶在阈值上方"会把高亮钉死在最后一格，
    // 而尺寸恢复后往往又没有事件再来纠正——干脆不在这时候算（勘 2026-11-16 修）。
    if (document.hidden || box.clientHeight < 1 || rail.clientHeight < 1) return;
    const ticks = [...rail.querySelectorAll(".chat-rail-tick")];
    if (!ticks.length) return;
    const nodes = [...box.querySelectorAll(".message")];
    const boxRect = box.getBoundingClientRect();
    const pad = 12;
    const usable = Math.max(1, rail.clientHeight - pad * 2);
    // 刻度等距排开，看着整齐；位置只表示"第几节"，不再对应真实滚动偏移（勘 2026-11-16）
    const count = ticks.length;
    const stepRaw = count > 1 ? usable / (count - 1) : 0;
    const step = Math.max(6, stepRaw);
    const total = step * Math.max(0, count - 1);
    const start = pad + (step > stepRaw ? Math.max(0, (usable - total) / 2) : 0);
    ticks.forEach((tick, i) => {
      tick.style.top = Math.round((start + i * step) * 10) / 10 + "px";
    });
    // 当前那一节：直接拿消息相对视口的位置比，不再掺 scrollTop。
    // 旧写法假设滚动一定发生在这个容器上；实际一旦滚动落在祖先元素，
    // scrollTop 恒为 0、每条消息的 rect 却已经在动，于是"全都不超过阈值"，
    // 高亮永远停在最后一格（勘 2026-11-16 修）。
    const liveBox = box.getBoundingClientRect();
    const head = liveBox.top + Math.min(120, box.clientHeight * 0.3);
    let active = -1;
    (this.railTurns || []).forEach((turn, i) => {
      const node = nodes[turn.from];
      if (!node || !node.isConnected) return;
      const rect = node.getBoundingClientRect();
      if (!rect.height && !rect.width) return; // 还没量出来的节点不算
      if (rect.top <= head) active = i;
    });
    if (active < 0) return; // 一个都量不准，就别动上一轮的结果
    ticks.forEach((tick, i) => tick.classList.toggle("active", i === active));
  }
  async refreshSessionContext() {
    const id = this.state.session;
    try {
      const value = await api(
        "/api/session/context?id=" + encodeURIComponent(id),
      );
      if (id !== this.state.session) return;
      this.state.sessionContext = value;
      if ($("chat-context"))
        $("chat-context").innerHTML = renderContextMeter(value, true);
    } catch (error) {
      if (id === this.state.session && $("chat-context"))
        $("chat-context").textContent = error.message;
    }
  }
  /** 切回窗口只轻刷状态和上下文，不再走 syncView→load()。
      旧版那条路会顺带重新 syncSession()：把已经翻出来的历史丢掉、只剩最后 40 条，
      再按"原来在底部"把滚动条按到最后，看着就是一切窗口就跳回最新（勘 2026-11-16 修）。 */
  async refreshOnFocus() {
    if (!this.authenticated) return;
    try {
      await this.refreshStatus();
      this.updateConnection();
      if (this.state.page === "chat") await this.refreshSessionContext();
    } catch {
      // 切窗口不该弹错，刷新失败就保持原样
    }
    this.syncRail();
  }
  async syncView() {
    if ($("store-drawer").open) return;
    const page = this.state.page;
    if (this.authenticated && (page.startsWith("extension:") || page.startsWith("plugin:")) && !this.syncing) {
      this.syncing = true;
      try {
        const before = extensionSignature(this.state.status);
        await this.refreshStatus();
        if (this.state.page === page && before !== extensionSignature(this.state.status)) this.render(true);
      } catch (error) { this.toast(error.message, true); }
      finally { this.syncing = false; }
      return;
    }
    if (
      !this.authenticated ||
      this.state.chatBusy ||
      this.syncing ||
      (page === "bindings" && this.bindingsDirty) ||
      !["overview", "plugins", "chat", "memory", "bindings"].includes(page)
    )
      return;
    this.syncing = true;
    try {
      await this.load();
      if (this.state.page === page && !this.state.chatBusy) this.render();
    } catch (error) {
      if (error.status === 401) this.requireLogin();
      else this.toast(error.message, true);
    } finally {
      this.syncing = false;
    }
  }
  async reload() {
    const button = $("refresh");
    button.disabled = true;
    try {
      await this.load();
      if (this.state.page === "memory") await loadMemory(this);
      this.render(extensionActiveKey(this.state.status, this.state.page).startsWith("plugin:"));
      this.toast("状态已刷新");
    } catch (error) {
      this.toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }
  render(preserveExtension = false) {
    if ($("store-drawer").open) return;
    if (!this.state.config || !this.state.status) return;
    const page = pages[this.state.page] || extensionPage(this);
    const navigation = extensionNavigation(this.state.status);
    $("extension-nav").innerHTML = navigation;
    $("extension-nav-group").hidden = !navigation;
    $("breadcrumb").textContent = page.name;
    document.title = page.name + " · WhaleLife";
    const active = extensionActiveKey(this.state.status, this.state.page);
    document.querySelectorAll("[data-page]").forEach((a) => {
      a.classList.toggle("active", a.dataset.page === active);
      if (a.dataset.page === active)
        a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    const count = availableModels(this.state.config).length;
    $("nav-model-count").textContent = count;
    $("nav-model-count").title = `${count} 个已启用且配置有效的模型`;
    $("nav-model-count").setAttribute("aria-label", `${count} 个可用模型`);
    const markup = page.render(this);
    if (!preserveExtension || !updateExtensionContent(this.content, markup)) this.content.innerHTML = markup;
    page.bind?.(this);
    this.updateConnection();
  }
  configDraft() {
    const c = structuredClone(this.state.config);
    return {
      revision: c.revision,
      timezone: c.timezone,
      providers: c.providers,
      models: c.models,
      bindings: c.bindings,
      personaModels: Object.fromEntries(
        c.personas.map((p) => [p.id, p.model || null]),
      ),
    };
  }
  async saveConfig(next) {
    const result = await api("/api/model-config", next);
    this.state.config = result;
    this.state.probes = {};
    await this.refreshStatus();
    this.render();
    this.toast("配置已保存，将用于下一次请求");
  }
  toast(message, error = false) {
    clearTimeout(this.toastTimer);
    $("toast").textContent = message;
    $("toast").classList.toggle("error", error);
    $("toast").hidden = false;
    this.toastTimer = setTimeout(
      () => ($("toast").hidden = true),
      error ? 9000 : 4000,
    );
  }
  dialog(title, body, submit, label = "保存", danger = false) {
    if ($("dialog").open) this.closeDialog();
    this.dialogBusy = false;
    $("dialog-content").innerHTML =
      `<form id="dialog-form"><div class="dialog-head"><h2 id="dialog-title">${e(title)}</h2><button type="button" class="icon-btn" id="dialog-close" aria-label="关闭对话框">${icon("close")}</button></div><div class="dialog-body">${body}<div id="dialog-error" class="form-error" role="alert"></div></div><div class="dialog-foot"><button type="button" class="btn" id="dialog-cancel">${submit ? "取消" : "关闭"}</button>${submit ? `<button type="submit" class="btn ${danger ? "danger" : "primary"}">${label}</button>` : ""}</div></form>`;
    $("dialog-close").onclick = () => this.closeDialog();
    $("dialog-cancel").onclick = () => this.closeDialog();
    $("dialog-form").onsubmit = async (event) => {
      event.preventDefault();
      if (!submit || this.dialogBusy) return;
      const form = event.currentTarget;
      const button = form.querySelector("[type=submit]");
      const data = new FormData(form);
      this.dialogBusy = true;
      button.disabled = true;
      $("dialog-error").textContent = "";
      try {
        await submit(data);
        this.dialogBusy = false;
        this.closeDialog();
      } catch (error) {
        $("dialog-error").textContent = error.message;
        this.dialogBusy = false;
        button.disabled = false;
      }
    };
    $("dialog").showModal();
  }
  closeDialog() {
    if (this.dialogBusy) return;
    $("dialog").close();
    $("dialog-content").replaceChildren();
  }
  connect(kind, attempt = 0) {
    const generation = this.generation;
    const ws = new WebSocket(
      location.origin.replace(/^http/, "ws") + "/ws/" + kind,
    );
    if (kind === "chat") this.chatWS = ws;
    else this.logWS = ws;
    ws.onopen = () => {
      if (kind === "logs") this.state.logs = [];
      this.updateConnection();
      if (this.state.page === "chat") this.updateChatControls();
      if (this.state.page === "logs") this.render();
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (kind === "logs") {
        this.state.logs.push(data.line);
        if (this.state.logs.length > 1000) this.state.logs.shift();
        if (this.state.page === "logs") this.renderLogs();
        return;
      }
      if (data.type === "append") {
        if (data.status === "accepted") this.toast("已并入本轮");
        else if (data.status === "duplicate") this.toast("这句已经并进去了");
        else if (data.status === "full") this.toast("本轮补充已满，这句没进去", true);
        else if (data.status === "closed") this.toast("这一轮刚好收尾了，再发一次就成新的一轮", true);
        else this.toast(data.error || "补充没送进去", true);
        return;
      }
      if (data.type === "context") {
        if (data.queued) {
          this.toast("当前会话正在处理其他请求，已排队等待");
          return;
        }
        // Usage arrives at the end of a turn; merge it into the cached context and repaint.
        if (data.usage) {
          const merged = { ...(this.state.sessionContext || {}), usage: data.usage };
          this.state.sessionContext = merged;
          if ($("chat-context")) $("chat-context").innerHTML = renderContextMeter(merged, true);
          return;
        }
        if (data.files) {
          if (this.reply) this.reply.files = data.files;
          if (this.state.page === "chat") this.renderMessages();
          return;
        }
        this.replyPersonaName = data.personaName;
        this.state.status.persona = data.personaId;
        this.state.status.personaName = data.personaName;
        if (data.contextReset) {
          this.toast("人格已更新，本轮使用新的人格上下文；旧记录保留");
          if (this.state.page === "chat") this.render();
        }
        return;
      }
      if (data.type === "chunk") {
        if (!this.reply) {
          this.reply = {
            role: "assistant",
            text: "",
            personaName: this.replyPersonaName,
          };
          this.state.messages.push(this.reply);
        }
        this.reply.text += data.text;
        if (this.state.page === "chat") {
          this.patchReply();
          return;
        }
      } else if (data.type === "done" || data.type === "error") {
        // 这一轮正文里出现过工具协议标记，后端已把它换成了说明：
        // 只在气泡下面加一行灰字，不往正文里塞任何内容。
        if (data.type === "done" && data.protocol === "projected" && this.reply) this.reply.protocolNote = true;
        if (data.type === "error") {
          this.state.messages.push({ role: "error", text: data.error });
          this.toast(data.error, true);
        }
        this.state.chatBusy = false;
        this.reply = null;
        this.syncView();
        this.updateChatControls();
      }
      if (this.state.page === "chat") this.renderMessages();
    };
    ws.onclose = () => {
      if (generation !== this.generation) return;
      this.updateConnection();
      if (kind === "chat" && this.state.chatBusy) {
        this.state.messages.push({
          role: "error",
          text: "连接已断开，本次回复可能尚未完成。重新连接后可刷新页面查看保存记录。",
        });
        this.state.chatBusy = false;
        this.reply = null;
        if (this.state.page === "chat") this.renderMessages();
      }
      this.updateChatControls();
      if (this.authenticated)
        setTimeout(
          async () => {
            if (generation !== this.generation) return;
            try {
              await api("/api/status");
              this.connect(kind, Math.min(attempt + 1, 4));
            } catch (error) {
              if (error.status === 401) this.requireLogin();
              else this.connect(kind, Math.min(attempt + 1, 4));
            }
          },
          Math.min(1000 * 2 ** attempt, 10000),
        );
    };
  }
  requireLogin() {
    if (!this.authenticated) return;
    const wasUpdating = resetHostUpdateSession(this);
    this.reloadAfterHostUpdate = wasUpdating;
    this.authenticated = false;
    this.hideStore();
    this.generation++;
    this.chatWS?.close();
    this.logWS?.close();
    $("shell").hidden = true;
    $("login").hidden = false;
    $("login-error").textContent = wasUpdating
      ? "请重新进入控制台，在概览中查看本次更新结果。"
      : "服务已重启或登录已过期，请重新进入。";
  }
  updateConnection() {
    const online = this.chatConnected && this.logConnected;
    $("connection-state").innerHTML =
      `<i class="status-dot" style="${online ? "" : "background:#c5ac72"}"></i> ${online ? "核心已连接" : "正在连接"}`;
  }
  updateChatControls() {
    const activePersona = $("active-persona");
    if (activePersona)
      activePersona.disabled =
        this.state.chatBusy || !this.state.config.personas.length;
    const button = $("send");
    if (button) {
      const persona = this.state.config.personas.find(
        (p) => p.id === this.state.status.persona,
      );
      const selected = this.state.config.models.find(
        (m) =>
          m.id === (persona?.model || this.state.config.bindings.chat) &&
          m.enabled,
      );
      button.disabled = this.sessionChanging || !this.state.session || !this.chatConnected || !selected;
      button.innerHTML =
        (this.state.chatBusy ? "补充" : "发送") + " " + icon("send");
    }
    if ($("new-session")) $("new-session").disabled = this.state.chatBusy || this.sessionChanging;
  }
  sendMessage() {
    const text = ($("chat-input")?.value || "").trim();
    const images = this.state.pendingImages.slice();
    if ((!text && !images.length) || !this.chatConnected || $("send").disabled) return;
    // 本轮还在跑：不排队，直接并进当前回合，让它中途改方向（勘 2026-11-16）
    if (this.state.chatBusy) {
      if (images.length) return this.toast("补充消息先别带图，等这轮跑完再发", true);
      this.chatWS.send(
        JSON.stringify({ append: true, session: this.state.session, text }),
      );
      this.state.messages.push({ role: "user", text, nudge: true });
      this.state.chatDraft = "";
      $("chat-input").value = "";
      this.renderMessages();
      return;
    }
    this.state.messages.push({ role: "user", text, images: images.map((image) => image.dataUrl) });
    this.state.chatBusy = true;
    this.state.chatDraft = "";
    this.state.pendingImages = [];
    this.reply = null;
    $("chat-input").value = "";
    this.renderPendingImages();
    this.replyPersonaName = this.state.status.personaName;
    this.chatWS.send(
      JSON.stringify({
        session: this.state.session,
        expectedSession: this.state.session,
        text,
        persona: this.state.status.persona,
        ...(images.length
          ? { images: images.map((image) => ({ mimeType: image.mimeType, data: image.base64 })) }
          : {}),
      }),
    );
    this.updateChatControls();
    this.renderMessages();
  }
  /** 粘贴、拖拽、文件选择都走这里；超出 4 张或格式不对当场说清楚，不悄悄丢。 */
  async addImages(files, source = "pick") {
    const room = 4 - this.state.pendingImages.length;
    if (room <= 0) return this.toast("一次最多发送 4 张图片", true);
    const usable = [...files].filter(
      (file) =>
        ["image/png", "image/jpeg", "image/webp", "image/bmp"].includes(file.type) ||
        (source === "paste" && !file.type && file.size > 0),
    );
    if (!usable.length) return this.toast("只支持 PNG、JPEG、WebP、BMP 图片", true);
    if (usable.length > room) this.toast(`只收下前 ${room} 张，一次最多 4 张`, true);
    let failed = null;
    for (const file of usable.slice(0, room)) {
      try {
        this.state.pendingImages.push(await shrinkImage(file));
      } catch (error) {
        failed = error;
      }
    }
    if (failed && source === "paste") {
      try {
        this.state.pendingImages.push(await clipboardImage());
        failed = null;
      } catch (error) {
        failed = Error(`${failed.message}；系统剪贴板也没取到：${error.message}`);
      }
    }
    if (failed) this.toast(failed.message, true);
    this.renderPendingImages();
  }
  renderPendingImages() {
    const strip = $("composer-images");
    if (!strip) return;
    strip.innerHTML = this.state.pendingImages
      .map(
        (image, index) =>
          `<figure class="pending-image"><img src="${image.dataUrl}" alt="待发送图片"><button type="button" data-drop="${index}" title="移除">×</button></figure>`,
      )
      .join("");
    strip.querySelectorAll("[data-drop]").forEach((button) => {
      button.onclick = () => {
        this.state.pendingImages.splice(Number(button.dataset.drop), 1);
        this.renderPendingImages();
      };
    });
    strip.hidden = !this.state.pendingImages.length;
  }
  bindImageComposer() {
    const form = $("chat-form"), input = $("chat-input"), picker = $("image-input");
    const box = $("messages");
    if (box)
      box.onscroll = () => {
        if (box.scrollTop < 48 && this.state.msgHasMore && !this.olderLoading) this.loadOlder();
      };
    if (!form || !input) return;
    this.renderPendingImages();
    if (picker) {
      picker.onchange = () => {
        const files = [...picker.files];
        picker.value = "";
        this.addImages(files);
      };
    }
    input.onpaste = (event) => {
      const files = [...(event.clipboardData?.files || [])].filter(
        (file) => file.type.startsWith("image/") || (!file.type && file.size > 0),
      );
      if (!files.length) return;
      event.preventDefault();
      this.addImages(files, "paste");
    };
    form.ondragover = (event) => {
      event.preventDefault();
      form.classList.add("dragging");
    };
    form.ondragleave = () => form.classList.remove("dragging");
    form.ondrop = (event) => {
      const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      form.classList.remove("dragging");
      this.addImages(files);
    };
  }
  async newSession() {
    if (this.state.chatBusy || this.sessionChanging) return;
    this.sessionChanging = true;
    this.updateChatControls();
    try {
      await this.syncSession({ create: true });
      this.state.chatDraft = "";
      this.render();
    } catch (error) {
      this.toast(error.message, true);
    } finally {
      this.sessionChanging = false;
      this.updateChatControls();
    }
  }

  renderMessages() {
    this.replyEl = null;
    const personaName = this.state.status.personaName || "助手";
    const box = $("messages");
    if (!box) return;
    this.renderOutline();
    if (!this.state.messages.length) {
      box.innerHTML = `<div class="chat-empty"><span class="brand-mark">${whale}</span><h3>今天想和${e(personaName)}聊点什么？</h3><p>从一句问候开始，或试试「记下这个」。</p></div>`;
      return;
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || !box.childElementCount;
    box.innerHTML = this.state.messages
      .map(
        (m) =>
          `<div class="message ${m.role === "user" ? "user" : m.role === "error" ? "error" : ""}${m.nudge ? " nudge" : ""}"><span class="mini-avatar" title="${e(m.personaName || "助手")}">${m.role === "user" ? "你" : m.role === "error" ? "!" : e((m.personaName || "助手").slice(0, 1))}</span><div class="bubble">${renderRich(m.text)}${(m.images || []).map((url) => `<img class="msg-media" src="${url}" alt="图片">`).join("")}${renderFiles(m.files)}${m.protocolOriginal ? `<details><summary>查看模型原文</summary><div>${e(m.protocolOriginal)}</div></details>` : ""}${m.protocolNote ? '<div class="protocol-note">本轮模型把工具调用写成了文字，已替换为说明，没有执行任何工具。</div>' : ""}${m.role === "user" || m.role === "error" ? "" : '<div class="say-row"><button class="say-btn" title="念出来"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg></button></div>'}</div></div>`,
      )
      .join("");
    if (this.state.chatBusy && !this.reply) {
      box.insertAdjacentHTML(
        "beforeend",
        `<div class="message"><span class="mini-avatar">…</span><div class="bubble thinking"><i>·</i><i>·</i><i>·</i><span>思考中 <em class="think-face">${pickThinkingFace()}</em></span></div></div>`,
      );
    }
    if (this.state.msgHasMore)
      box.insertAdjacentHTML(
        "afterbegin",
        '<div class="chat-history-more">' +
          (this.olderLoading ? "加载中…" : "加载更早的 " + PAGE_SIZE + " 条") +
          "</div>",
      );
    const more = box.querySelector(".chat-history-more");
    if (more) more.onclick = () => this.loadOlder();
    if (nearBottom) {
      box.scrollTop = box.scrollHeight;
      requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    }
  }
  /** 只更新最后一条回复的气泡，避免整段重建把滚动条打回顶部。 */
  patchReply() {
    const box = $("messages");
    if (!box || !this.reply) return;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const thinking = box.querySelector(".bubble.thinking");
    if (thinking) thinking.closest(".message")?.remove();
    if (!this.replyEl || !box.contains(this.replyEl)) {
      const wrap = document.createElement("div");
      wrap.className = "message";
      wrap.innerHTML = `<span class="mini-avatar" title="${e(this.replyPersonaName || "助手")}">${e((this.replyPersonaName || "助手").slice(0, 1))}</span><div class="bubble"></div>`;
      box.appendChild(wrap);
      this.replyEl = wrap.querySelector(".bubble");
    }
    this.replyEl.innerHTML = renderRich(this.reply.text) + renderFiles(this.reply.files) + '<div class="say-row"><button class="say-btn" title="念出来"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg></button></div>';
    if (stick) box.scrollTop = box.scrollHeight;
  }
  filteredLogs() {
    return this.state.logs.filter(
      (line) =>
        (!this.state.logLevel ||
          this.state.logLevel === "all" ||
          line.includes("[" + this.state.logLevel + "]")) &&
        line.toLowerCase().includes((this.state.logSearch || "").toLowerCase()),
    );
  }
  renderLogs() {
    const box = $("log-output");
    if (!box) return;
    const lines = this.filteredLogs();
    box.innerHTML = lines
      .map(
        (line) =>
          `<div class="log-line ${line.includes("[ERROR]") ? "error" : line.includes("[WARN]") ? "warn" : "info"}">${e(line)}</div>`,
      )
      .join("");
    if (this.state.logFollow) box.scrollTop = box.scrollHeight;
    $("log-meta").textContent =
      `显示 ${lines.length} / ${this.state.logs.length} 条 · ${this.logConnected ? "实时推送中" : "正在重新连接"}`;
  }
}
/** 一页多少条。服务端上限 200，这里改得比它大没用。 */
const PAGE_SIZE = 40;

/** 压平成一句：去掉图片标记、markdown 符号和换行。 */
function plainText(text) {
  return String(text || "")
    .replace(/\[\[img:[^\]]+\]\]/g, "［图］")
    .replace(/[#*`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 截短，超了就加省略号。 */
function clip(text, max) {
  const flat = String(text || "").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** 点图片开遮罩看原图，再点一下或按 Esc 关掉。 */
function installImageZoom() {
  const box = document.createElement("div");
  box.className = "image-zoom";
  box.hidden = true;
  box.innerHTML = '<img alt="放大查看">';
  document.body.appendChild(box);
  const close = () => { box.hidden = true; box.querySelector("img").src = ""; };
  box.onclick = close;
  document.addEventListener("keydown", (evt) => { if (evt.key === "Escape") close(); });
  document.addEventListener("click", (evt) => {
    const img = evt.target.closest && evt.target.closest(".bubble img, .messages img");
    if (!img || !img.src) return;
    evt.preventDefault();
    box.querySelector("img").src = img.src;
    box.hidden = false;
  });
}

const app = new ConsoleApp();
installImageZoom();
app.start();
installSayButton();

/** 浏览器解不开时，回头问系统剪贴板要图：服务端用 GDI+ 存成 PNG 再送回来。 */
async function clipboardImage() {
  const value = await api("/api/clipboard-image", {});
  const blob = await (await fetch(value.dataUrl)).blob();
  return await shrinkImage(new File([blob], "clipboard.png", { type: "image/png" }));
}

/** 读成 data URL。 */
function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

/** 裸 DIB（缺 "BM" 文件头的位图）补一个文件头，浏览器才认得。微信截图走剪贴板常常给的是这个。 */
async function dibToBmp(file) {
  if (file.size < 64) return null;
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (head[0] === 0x42 && head[1] === 0x4d) return null;
  const view = new DataView(head.buffer);
  const headerSize = view.getUint32(0, true);
  const bits = view.getUint16(14, true);
  const compression = view.getUint32(16, true);
  if (![40, 108, 124].includes(headerSize) || ![24, 32].includes(bits) || compression !== 0) return null;
  const dib = new Uint8Array(await file.arrayBuffer());
  const bmp = new Uint8Array(14 + dib.length);
  const out = new DataView(bmp.buffer);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  out.setUint32(2, bmp.length, true);
  out.setUint32(10, 14 + headerSize, true);
  bmp.set(dib, 14);
  return new Blob([bmp], { type: "image/bmp" });
}

/** 解一张图：先 createImageBitmap，再 <img>，最后试修补裸 DIB。三条都挂才报错。 */
async function decodeImage(file, dataUrl) {
  const viaBitmap = async (source) => {
    if (typeof createImageBitmap !== "function") throw Error("no createImageBitmap");
    const bitmap = await createImageBitmap(source);
    return {
      width: bitmap.width,
      height: bitmap.height,
      trust: source === file,
      draw: (context, w, h) => context.drawImage(bitmap, 0, 0, w, h),
    };
  };
  const viaImage = async (url) => {
    const element = await new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve(probe);
      probe.onerror = () => reject(Error("decode"));
      probe.src = url;
    });
    return {
      width: element.naturalWidth,
      height: element.naturalHeight,
      trust: url === dataUrl,
      draw: (context, w, h) => context.drawImage(element, 0, 0, w, h),
    };
  };
  try {
    return await viaBitmap(file);
  } catch {}
  try {
    return await viaImage(dataUrl);
  } catch {}
  const repaired = await dibToBmp(file);
  if (repaired) {
    try {
      return await viaBitmap(repaired);
    } catch {}
    try {
      return await viaImage(await readDataUrl(repaired));
    } catch {}
  }
  const hint = repaired ? "已试过补文件头修裸位图" : "剪贴板给的图数据常是残缺的";
  throw Error(
    `图片无法解码（${file.type || "类型未知"}，${Math.max(1, Math.round(file.size / 1024))} KB）——${hint}，改用「图片」按钮直接选文件试试`,
  );
}

/** 超过 1600px 或 2MiB 才重编码；小图原样送，截图里的字不会被压糊。 */
async function shrinkImage(file) {
  if (file.size > 6 * 1024 * 1024) throw Error("单张图片需在 6MiB 以内");
  const dataUrl = await readDataUrl(file);
  const image = await decodeImage(file, dataUrl);
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  const passThrough = ["image/png", "image/jpeg", "image/webp"].includes(file.type);
  if (image.trust && passThrough && scale === 1 && file.size <= 2 * 1024 * 1024)
    return { mimeType: file.type, dataUrl, base64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!image.trust) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  image.draw(context, canvas.width, canvas.height);
  const type = file.type === "image/png" || !image.trust ? "image/png" : "image/jpeg";
  const shrunk = canvas.toDataURL(type, 0.9);
  if (shrunk.length * 0.75 > 4 * 1024 * 1024) throw Error("图片压缩后仍超过 4MiB");
  return { mimeType: type, dataUrl: shrunk, base64: shrunk.slice(shrunk.indexOf(",") + 1) };
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const CODE_FENCE = /^\s*```/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const LINK = /\[([^\]\n]*)\]\(([^()\s]*)\)/g;
const SAFE_URL = /^(https?:\/\/|mailto:|\/|#|\.{1,2}\/)/i;

/** [[img:路径]] / [[voice:路径]] 标记换成媒体元素；入参必须已经过转义。 */
function inlineRich(escaped) {
  const media = (path) => `/api/media?path=${encodeURIComponent(path)}`;
  return escaped
    .replace(/\[\[img:([^\]]+)\]\]/g, (_, path) =>
      `<img class="msg-media" src="${media(path.replace(/&amp;/g, "&"))}" alt="图片" loading="lazy">`)
    .replace(/\[\[voice:([^\]]+)\]\]/g, (_, path) =>
      `<audio class="msg-audio" controls preload="none" src="${media(path.replace(/&amp;/g, "&"))}"></audio>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(LINK, (whole, label, url) => {
      const target = url.replace(/&amp;/g, "&").trim();
      if (!SAFE_URL.test(target)) return whole;
      return `<a href="${target}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/(^|[\s(（])_([^_\n]+)_(?=[\s)）.。，,！!？?]|$)/g, "$1<em>$2</em>");
}

function splitTableRow(line) {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.trim());
}

function renderTable(header, aligns, rows) {
  const cell = (tag, text, index) => {
    const align = aligns[index];
    return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inlineRich(e(text))}</${tag}>`;
  };
  const head = `<thead><tr>${header.map((text, index) => cell("th", text, index)).join("")}</tr></thead>`;
  const body = rows
    .map((row) => `<tr>${header.map((_, index) => cell("td", row[index] ?? "", index)).join("")}</tr>`)
    .join("");
  return `<div class="md-table"><table>${head}<tbody>${body}</tbody></table></div>`;
}

/** 列表：按缩进决定嵌套层级，<ul>/<ol> 由相邻项的有序性切换。 */
function renderListBlock(items) {
  let html = "";
  const stack = [];
  for (const item of items) {
    const tag = item.ordered ? "ol" : "ul";
    while (stack.length && item.indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop().tag}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || item.indent > top.indent) {
      const start = item.ordered && item.start !== 1 ? ` start="${item.start}"` : "";
      html += `<${tag}${start}>`;
      stack.push({ tag, indent: item.indent });
    } else if (top.tag !== tag) {
      html += `</li></${stack.pop().tag}><${tag}>`;
      stack.push({ tag, indent: item.indent });
    } else {
      html += "</li>";
    }
    html += `<li>${inlineRich(e(item.text))}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

/** 块级：代码围栏、GFM 表格、标题、分割线、引用、列表；其余文字按整段转义。 */
/** 回复末尾「本轮文件」：只列文件名和打开入口；核验没过就写原因，不给链接。 */
function renderFiles(files) {
  if (!files || !files.length) return "";
  const rows = files.map((file) =>
    file.ok
      ? `<a class="msg-file" href="/api/file?path=${encodeURIComponent(file.path)}" target="_blank" rel="noopener">${e(file.name)} · 打开</a>`
      : `<span class="msg-file failed">${e(file.name)} · ${e(file.error || "未通过核验")}</span>`,
  );
  return `<div class="msg-files">${rows.join("")}</div>`;
}

function renderRich(text) {
  const lines = String(text).split("\n");
  const out = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    out.push(inlineRich(e(buffer.join("\n"))));
    buffer = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];

    if (CODE_FENCE.test(line)) {
      flush();
      const lang = line.trim().slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !CODE_FENCE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      const cls = lang ? ` class="lang-${e(lang)}"` : "";
      out.push(`<pre class="md-pre"><code${cls}>${e(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.includes("|") && next !== undefined && next.includes("-") && TABLE_SEPARATOR.test(next)) {
      flush();
      const header = splitTableRow(line);
      const aligns = splitTableRow(next).map((mark) => {
        const left = mark.startsWith(":");
        const right = mark.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return "";
      });
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      out.push(renderTable(header, aligns, rows));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = Math.min(6, Math.max(3, heading[1].length + 1));
      out.push(`<h${level}>${inlineRich(e(heading[2]))}</h${level}>`);
      continue;
    }

    if (HR.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const parts = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        parts.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      i -= 1;
      out.push(`<blockquote>${inlineRich(e(parts.join("\n")))}</blockquote>`);
      continue;
    }

    const ulItem = UL_ITEM.exec(line);
    const olItem = OL_ITEM.exec(line);
    if (ulItem || olItem) {
      flush();
      const items = [];
      while (i < lines.length) {
        const ul = UL_ITEM.exec(lines[i]);
        const ol = OL_ITEM.exec(lines[i]);
        const m = ul || ol;
        if (!m) break;
        items.push({
          indent: (ul ? m[1] : m[1]).replace(/\t/g, "  ").length,
          ordered: Boolean(ol),
          start: ol ? Number(ol[2]) : 1,
          text: ul ? ul[2] : ol[3],
        });
        i += 1;
      }
      i -= 1;
      out.push(renderListBlock(items));
      continue;
    }

    buffer.push(line);
  }
  flush();
  return out.join("\n");
}


/** 每条回复旁的「念」按钮：交给嘴巴插件合成并播放。 */
function installSayButton() {
  document.addEventListener("click", async (evt) => {
    const btn = evt.target.closest && evt.target.closest(".say-btn");
    if (!btn || btn.disabled) return;
    evt.preventDefault();
    const holder = btn.closest(".message");
    const bubble = holder && holder.querySelector(".bubble");
    let text = "";
    if (bubble) {
      const copy = bubble.cloneNode(true);
      copy.querySelectorAll(".say-btn, .msg-media, .msg-files").forEach((n) => n.remove());
      text = (copy.innerText || "").trim();
    }
    if (!text) {
      app.toast("这条消息没有可念的文字", true);
      return;
    }
    btn.disabled = true;
    btn.classList.add("saying");
    btn.title = "正在合成并播放…";
    try {
      const r = await api("/plugins/mouth/say", { text });
      app.toast(`念出来了：${r.segments} 段，${r.chars} 字，用时 ${(r.ms / 1000).toFixed(1)} 秒`);
    } catch (error) {
      app.toast("没念成：" + String((error && error.message) || error), true);
    } finally {
      btn.classList.remove("saying");
      btn.disabled = false;
      btn.title = "念出来";
    }
  });
}
