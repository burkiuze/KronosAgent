(() => {
  "use strict";

  /* ═══════════════ config ═══════════════ */

  const CLERK_PK = "pk_live_Y2xlcmsuaGV5bmF2aW8uY29tJA";
  const CLERK_JS = "https://clerk.heynavio.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js";

  // Hosted models. Ids match api/_lib/plans.js.
  const KRONOS_MODELS = [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "Open Inference" },
    { id: "minimax-3.1-flash", name: "MiniMax 3.1 Flash", provider: "Nebius Token Factory" },
    { id: "nemotron-3.5-super-vl", name: "Nemotron 3.5 Super VL", provider: "Crusoe" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "Wafer" },
  ];

  const TIERS = [
    { id: "lite", name: "Lite", mult: "¼× Pro", tokens: 250_000 },
    { id: "pro", name: "Pro", mult: "Baseline", tokens: 1_000_000 },
    { id: "max", name: "Max", mult: "2× Pro", tokens: 2_000_000 },
    { id: "max5", name: "Max 5", mult: "5× Pro", tokens: 5_000_000 },
  ];
  const tierName = (id) => TIERS.find((t) => t.id === id)?.name || "";

  // Bring-your-own-key providers. All requests go from the browser straight to the provider.
  const PROVIDERS = {
    openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", kind: "openai", link: "https://openrouter.ai/keys" },
    openai: { name: "OpenAI", base: "https://api.openai.com/v1", kind: "openai", link: "https://platform.openai.com/api-keys", filter: /^(gpt|o\d|chatgpt)/ },
    anthropic: { name: "Anthropic", base: "https://api.anthropic.com/v1", kind: "anthropic", link: "https://console.anthropic.com/settings/keys" },
    gemini: { name: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", kind: "openai", link: "https://aistudio.google.com/apikey", filter: /gemini/ },
    custom: { name: "Custom (OpenAI-compatible)", base: "", kind: "openai", custom: true },
  };

  /* ═══════════════ helpers ═══════════════ */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        toast("Browser storage is full or blocked.");
      }
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };

  let toastTimer;
  function toast(text) {
    const t = $("#toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  /* ═══════════════ state ═══════════════ */

  const S = {
    clerk: null,
    user: null, // { id, name, email, image }
    guest: false,
    me: null, // { tier, expiresAt, usedToday, dailyTokens }
    keys: store.get("kronos.keys", {}),
    models: store.get("kronos.models", {}), // provider -> [ids]
    chats: [],
    chatId: null,
    model: store.get("kronos.model", null), // "k:<id>" | "b:<provider>:<model>"
    abort: null,
  };

  const scope = () => (S.user ? S.user.id : "guest");
  const chatsKey = () => `kronos.chats.${scope()}`;
  const saveChats = () => store.set(chatsKey(), S.chats);
  const loadChats = () => {
    S.chats = store.get(chatsKey(), []);
    S.chatId = null;
  };
  const current = () => S.chats.find((c) => c.id === S.chatId) || null;

  /* ═══════════════ clerk ═══════════════ */

  function loadClerk() {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = CLERK_JS;
      s.async = true;
      s.crossOrigin = "anonymous";
      s.dataset.clerkPublishableKey = CLERK_PK;
      s.onload = () => resolve(window.Clerk);
      s.onerror = () => reject(new Error("clerk_unreachable"));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error("clerk_timeout")), 12000);
    }).then(async (Clerk) => {
      await Clerk.load({
        appearance: {
          variables: {
            colorPrimary: "#2626ea",
            colorBackground: "#0f1328",
            colorText: "#f1f1f1",
            colorTextSecondary: "#9fa1c0",
            colorInputBackground: "#070917",
            colorInputText: "#ffffff",
            colorNeutral: "#d6d6ea",
            borderRadius: "4px",
            fontFamily: "Lexend, system-ui, sans-serif",
          },
          elements: {
            rootBox: { width: "100%" },
            cardBox: { width: "100%", boxShadow: "none", border: "1px solid rgba(214,214,255,0.12)" },
            card: { boxShadow: "none" },
          },
        },
      });
      return Clerk;
    });
  }

  const userFromClerk = (u) =>
    u && {
      id: u.id,
      name: u.fullName || u.username || u.primaryEmailAddress?.emailAddress?.split("@")[0] || "Account",
      email: u.primaryEmailAddress?.emailAddress || "",
      image: u.hasImage ? u.imageUrl : "",
    };

  async function token() {
    try {
      return (await S.clerk?.session?.getToken()) || "";
    } catch {
      return "";
    }
  }

  async function api(path, opts = {}) {
    const t = await token();
    const res = await fetch(path, {
      ...opts,
      headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}), ...(opts.headers || {}) },
    });
    return res;
  }

  async function refreshMe() {
    if (!S.user) {
      S.me = null;
      renderMe();
      return;
    }
    try {
      const res = await api("/api/kronos/me");
      S.me = res.ok ? await res.json() : null;
    } catch {
      S.me = null;
    }
    renderMe();
    renderPicker();
  }

  /* ═══════════════ auth screen ═══════════════ */

  let authMode = "sign-in";

  function mountAuth() {
    const el = $("#clerk-mount");
    if (!S.clerk) return;
    try {
      S.clerk.unmountSignIn?.(el);
      S.clerk.unmountSignUp?.(el);
    } catch {}
    el.textContent = "";
    const opts = { routing: "virtual", forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href };
    if (authMode === "sign-in") S.clerk.mountSignIn(el, opts);
    else S.clerk.mountSignUp(el, opts);
  }

  function showAuth(mode) {
    if (mode) authMode = mode;
    $$(".auth-tab").forEach((b) => {
      const on = b.dataset.auth === authMode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    $("#app").hidden = true;
    $("#auth").hidden = false;
    mountAuth();
  }

  function showApp() {
    $("#auth").hidden = true;
    $("#app").hidden = false;
    renderMe();
    renderChats();
    renderPicker();
    openChat(S.chats[0]?.id || null);
    $("#input").focus({ preventScroll: true });
  }

  $$(".auth-tab").forEach((b) => b.addEventListener("click", () => showAuth(b.dataset.auth)));
  $("#guest-btn").addEventListener("click", () => {
    S.guest = true;
    store.set("kronos.guest", true);
    loadChats();
    showApp();
  });

  /* ═══════════════ sidebar & identity ═══════════════ */

  function renderMe() {
    const av = $("#me-avatar");
    if (S.user) {
      $("#me-name").textContent = S.user.name;
      av.innerHTML = S.user.image ? `<img src="${esc(S.user.image)}" alt="" />` : esc(S.user.name[0].toUpperCase());
      $("#me-plan").textContent = S.me?.tier ? `${tierName(S.me.tier)} plan` : "No membership";
    } else {
      $("#me-name").textContent = "Guest";
      av.textContent = "G";
      $("#me-plan").textContent = "Sign in for Kronos models";
    }
    const pill = $("#usage-pill");
    if (S.me?.tier) {
      pill.hidden = false;
      pill.textContent = `${fmt(S.me.usedToday)} / ${fmt(S.me.dailyTokens)} today`;
    } else pill.hidden = true;
  }

  function renderChats() {
    const nav = $("#chats");
    if (!S.chats.length) {
      nav.innerHTML = `<p class="chats-group">No chats yet</p>`;
      return;
    }
    const day = 86400000;
    const now = Date.now();
    const groups = [["Today", []], ["Previous 7 days", []], ["Older", []]];
    for (const c of [...S.chats].sort((a, b) => b.updated - a.updated)) {
      const age = now - c.updated;
      groups[age < day ? 0 : age < 7 * day ? 1 : 2][1].push(c);
    }
    nav.innerHTML = groups
      .filter(([, list]) => list.length)
      .map(
        ([label, list]) =>
          `<p class="chats-group">${label}</p>` +
          list
            .map(
              (c) => `<div class="chat-item${c.id === S.chatId ? " is-active" : ""}" data-id="${c.id}">
                <a href="#" data-open>${esc(c.title || "New chat")}</a>
                <button class="chat-del" data-del aria-label="Delete chat">✕</button>
              </div>`
            )
            .join("")
      )
      .join("");
  }

  $("#chats").addEventListener("click", (e) => {
    const item = e.target.closest(".chat-item");
    if (!item) return;
    e.preventDefault();
    if (e.target.closest("[data-del]")) {
      S.chats = S.chats.filter((c) => c.id !== item.dataset.id);
      saveChats();
      if (S.chatId === item.dataset.id) openChat(null);
      renderChats();
      return;
    }
    openChat(item.dataset.id);
    closeSide();
  });

  $("#new-chat").addEventListener("click", () => {
    openChat(null);
    closeSide();
    $("#input").focus();
  });

  const side = $("#side");
  const scrim = $("#scrim");
  const openSide = () => {
    side.classList.add("is-open");
    scrim.hidden = false;
  };
  const closeSide = () => {
    side.classList.remove("is-open");
    scrim.hidden = true;
  };
  $("#side-open").addEventListener("click", openSide);
  $("#side-close").addEventListener("click", closeSide);
  scrim.addEventListener("click", closeSide);
  $("#me-btn").addEventListener("click", () => openSettings(S.user ? "membership" : "account"));
  $("#top-settings").addEventListener("click", () => openSettings(S.user ? "membership" : "keys"));

  /* ═══════════════ models & picker ═══════════════ */

  function kronosState() {
    if (!S.user) return { ok: false, why: "Sign in" };
    if (!S.me?.tier) return { ok: false, why: "Membership" };
    if (S.me.usedToday >= S.me.dailyTokens) return { ok: false, why: "Limit reached" };
    return { ok: true };
  }

  function byokModels() {
    const out = [];
    for (const [pid, p] of Object.entries(PROVIDERS)) {
      const key = S.keys[pid];
      if (!key || (p.custom && !key.base)) continue;
      for (const m of S.models[pid] || []) out.push({ pid, id: m, provider: p.name });
    }
    return out;
  }

  function modelLabel(sel) {
    if (!sel) return "Choose a model";
    if (sel.startsWith("k:")) return KRONOS_MODELS.find((m) => `k:${m.id}` === sel)?.name || "Choose a model";
    return sel.split(":").slice(2).join(":");
  }

  function setModel(sel) {
    S.model = sel;
    store.set("kronos.model", sel);
    $("#picker-label").textContent = modelLabel(sel);
    const c = current();
    if (c) {
      c.model = sel;
      saveChats();
    }
  }

  let pickerFilter = "";
  const LOCK = `<svg class="pm-lock" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

  function renderPicker() {
    $("#picker-label").textContent = modelLabel(S.model);
    const menu = $("#picker-menu");
    if (menu.hidden) return;
    const ks = kronosState();
    const f = pickerFilter.toLowerCase();
    const own = byokModels().filter((m) => !f || m.id.toLowerCase().includes(f) || m.provider.toLowerCase().includes(f));
    let html = `<p class="pm-group">Kronos models</p>`;
    html += KRONOS_MODELS.map((m) => {
      const sel = `k:${m.id}`;
      return `<button class="pm-item${S.model === sel ? " is-active" : ""}${ks.ok ? "" : " is-locked"}" role="option" data-sel="${sel}" data-locked="${ks.ok ? "" : "1"}">
        <span class="pm-main"><span class="pm-name">${esc(m.name)}</span><span class="pm-sub">${esc(m.provider)}</span></span>
        ${ks.ok ? `<span class="pm-badge">Kronos</span>` : `<span class="pm-badge">${ks.why}</span>${LOCK}`}
      </button>`;
    }).join("");
    html += `<p class="pm-group">Your API keys</p>`;
    const total = byokModels().length;
    if (total > 12) html += `<input class="pm-search" id="pm-search" placeholder="Search your models" value="${esc(pickerFilter)}" />`;
    html += own.length
      ? own
          .slice(0, 200)
          .map((m) => {
            const sel = `b:${m.pid}:${m.id}`;
            return `<button class="pm-item${S.model === sel ? " is-active" : ""}" role="option" data-sel="${esc(sel)}">
              <span class="pm-main"><span class="pm-name">${esc(m.id)}</span><span class="pm-sub">${esc(m.provider)}</span></span>
            </button>`;
          })
          .join("")
      : `<p class="pm-empty">${total ? "No match." : "No keys yet."}</p>`;
    html += `<button class="pm-link" data-go="keys">+ Connect an API key</button>`;
    if (!ks.ok) html += `<button class="pm-link" data-go="${S.user ? "membership" : "signin"}">${S.user ? "Unlock Kronos models with a membership" : "Sign in to use Kronos models"}</button>`;
    menu.innerHTML = html;
    const search = $("#pm-search");
    if (search) {
      search.addEventListener("input", () => {
        pickerFilter = search.value;
        renderPicker();
        $("#pm-search")?.focus();
        const s2 = $("#pm-search");
        s2?.setSelectionRange(s2.value.length, s2.value.length);
      });
    }
  }

  function togglePicker(open) {
    const menu = $("#picker-menu");
    const btn = $("#picker-btn");
    const next = open ?? menu.hidden;
    menu.hidden = !next;
    btn.setAttribute("aria-expanded", String(next));
    if (next) renderPicker();
  }

  $("#picker-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    togglePicker();
  });
  $("#picker-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    const go = e.target.closest("[data-go]");
    if (go) {
      togglePicker(false);
      if (go.dataset.go === "signin") return signIn();
      return openSettings(go.dataset.go);
    }
    const item = e.target.closest("[data-sel]");
    if (!item) return;
    if (item.dataset.locked) {
      togglePicker(false);
      if (!S.user) return signIn();
      return openSettings("membership");
    }
    setModel(item.dataset.sel);
    togglePicker(false);
    $("#input").focus();
  });
  document.addEventListener("click", () => togglePicker(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") togglePicker(false);
  });

  function signIn(mode = "sign-in") {
    S.guest = false;
    store.del("kronos.guest");
    if (!S.clerk) return toast("Sign-in is unavailable right now. Please try again shortly.");
    showAuth(mode);
  }

  /* ═══════════════ markdown ═══════════════ */

  function inline(s) {
    return s
      .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function md(src) {
    const out = [];
    const parts = src.split(/^```/m);
    parts.forEach((part, i) => {
      if (i % 2) {
        const nl = part.indexOf("\n");
        const lang = nl > -1 ? part.slice(0, nl).trim() : "";
        const code = nl > -1 ? part.slice(nl + 1) : "";
        out.push(`<pre><button class="copy-code" type="button">Copy</button><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(code.replace(/\n$/, ""))}</code></pre>`);
        return;
      }
      const lines = esc(part).split("\n");
      let list = null;
      let para = [];
      const flushPara = () => {
        if (para.length) out.push(`<p>${inline(para.join("<br />"))}</p>`);
        para = [];
      };
      const flushList = () => {
        if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`);
        list = null;
      };
      for (const line of lines) {
        let m;
        if (!line.trim()) {
          flushPara();
          flushList();
        } else if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
          flushPara();
          flushList();
          out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
        } else if ((m = line.match(/^\s*[-*+]\s+(.*)/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
          flushPara();
          const tag = /^\s*\d/.test(line) ? "ol" : "ul";
          if (!list || list.tag !== tag) {
            flushList();
            list = { tag, items: [] };
          }
          list.items.push(m[1]);
        } else if ((m = line.match(/^&gt;\s?(.*)/))) {
          flushPara();
          flushList();
          out.push(`<blockquote>${inline(m[1])}</blockquote>`);
        } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
          flushPara();
          flushList();
          out.push("<hr />");
        } else {
          flushList();
          para.push(line);
        }
      }
      flushPara();
      flushList();
    });
    return out.join("");
  }

  $("#thread").addEventListener("click", (e) => {
    const b = e.target.closest(".copy-code");
    if (!b) return;
    navigator.clipboard?.writeText(b.nextElementSibling.textContent).then(() => {
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1200);
    });
  });

  /* ═══════════════ thread ═══════════════ */

  const thread = $("#thread");

  function openChat(id) {
    if (S.abort) S.abort.abort();
    S.chatId = id;
    const c = current();
    if (c?.model) {
      S.model = c.model;
      $("#picker-label").textContent = modelLabel(S.model);
    }
    renderThread();
    renderChats();
  }

  function msgHtml(m) {
    if (m.role === "user") return `<div class="msg msg-user"><div class="bubble">${esc(m.content)}</div></div>`;
    const think = m.reasoning ? `<details class="think"><summary>Reasoning</summary>${esc(m.reasoning)}</details>` : "";
    const err = m.error ? `<div class="msg-err">${esc(m.error)}</div>` : "";
    return `<div class="msg msg-ai"><div class="who"><b>${esc(m.modelName || "Kronos")}</b></div>${think}<div class="md">${md(m.content || "")}</div>${err}</div>`;
  }

  function renderThread() {
    const c = current();
    if (!c || !c.messages.length) {
      const ks = kronosState();
      const hasOwn = byokModels().length > 0;
      const hint = !S.model
        ? hasOwn || ks.ok
          ? "Pick a model above and start typing."
          : S.user
            ? "Connect an API key, or redeem a membership code for Kronos models."
            : "Connect your own API key in Settings, or sign in for Kronos models."
        : "Ask anything. Kronos keeps the conversation on this device.";
      thread.innerHTML = `<div class="empty"><div><h2 class="empty-title">What should Kronos do?</h2><p class="muted">${hint}</p></div></div>`;
      return;
    }
    thread.innerHTML = c.messages.map(msgHtml).join("");
    thread.scrollTop = thread.scrollHeight;
  }

  /* ═══════════════ streaming ═══════════════ */

  async function* sse(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) > -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {}
      }
    }
  }

  const ERRORS = {
    no_membership: "Kronos models need a membership. Redeem a code in Settings → Membership.",
    limit_reached: "You have used today's allowance. It resets at 00:00 UTC.",
    signed_out: "Your session expired. Please sign in again.",
    service_unavailable: "Kronos models are temporarily unavailable.",
    upstream: "The model provider did not respond. Please try again.",
  };

  async function request(model, messages, signal) {
    if (model.startsWith("k:")) {
      const res = await api("/api/kronos/chat", {
        method: "POST",
        signal,
        body: JSON.stringify({ model: model.slice(2), messages }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        if (e.error === "no_membership" || e.error === "limit_reached") refreshMe();
        throw new Error(ERRORS[e.error] || `Request failed (${res.status}).`);
      }
      return { res, kind: "openai" };
    }

    const [, pid, ...rest] = model.split(":");
    const id = rest.join(":");
    const p = PROVIDERS[pid];
    const key = S.keys[pid];
    if (!p || !key) throw new Error("This model's API key was removed. Add it again in Settings → API keys.");

    if (p.kind === "anthropic") {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const res = await fetch(`${p.base}/messages`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: id,
          max_tokens: 8192,
          stream: true,
          ...(system ? { system } : {}),
          messages: messages.filter((m) => m.role !== "system"),
        }),
      });
      if (!res.ok) throw new Error(await providerError(res, p.name));
      return { res, kind: "anthropic" };
    }

    const base = p.custom ? key.base.replace(/\/+$/, "") : p.base;
    const secret = p.custom ? key.key : key;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(pid === "openrouter" ? { "http-referer": location.origin + "/kronosagent/app", "x-title": "Kronos Agent" } : {}),
      },
      body: JSON.stringify({ model: id, messages, stream: true }),
    });
    if (!res.ok) throw new Error(await providerError(res, p.name));
    return { res, kind: "openai" };
  }

  async function providerError(res, name) {
    const body = await res.json().catch(() => null);
    const msg = body?.error?.message || body?.message || body?.error || "";
    if (res.status === 401 || res.status === 403) return `${name} rejected the API key. Check it in Settings → API keys.`;
    return `${name}: ${typeof msg === "string" && msg ? msg : `request failed (${res.status})`}`;
  }

  let renderQueued = false;
  function scheduleRender(node, msg) {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
      const body = node.querySelector(".md");
      body.innerHTML = md(msg.content);
      body.classList.add("cursor");
      if (msg.reasoning) {
        let think = node.querySelector(".think");
        if (!think) {
          think = document.createElement("details");
          think.className = "think";
          think.open = !msg.content;
          think.innerHTML = "<summary>Reasoning</summary><span></span>";
          node.insertBefore(think, body);
        }
        think.lastChild.textContent = msg.reasoning;
      }
      if (nearBottom) thread.scrollTop = thread.scrollHeight;
    });
  }

  async function send(text) {
    if (!S.model) {
      togglePicker(true);
      return toast("Choose a model first.");
    }
    if (S.model.startsWith("k:") && !kronosState().ok) {
      if (!S.user) return signIn();
      return openSettings("membership");
    }

    let c = current();
    if (!c) {
      c = { id: uid(), title: text.slice(0, 60), model: S.model, messages: [], updated: Date.now() };
      S.chats.unshift(c);
      S.chatId = c.id;
    }
    c.model = S.model;
    c.messages.push({ role: "user", content: text });
    const modelName = modelLabel(S.model);
    const reply = { role: "assistant", content: "", modelName };
    c.messages.push(reply);
    c.updated = Date.now();
    saveChats();
    renderChats();
    renderThread();

    const node = thread.lastElementChild;
    const history = c.messages.slice(0, -1).filter((m) => !m.error || m.content).map((m) => ({ role: m.role, content: m.content }));
    const ctrl = new AbortController();
    S.abort = ctrl;
    setBusy(true);

    try {
      const { res, kind } = await request(S.model, history, ctrl.signal);
      for await (const ev of sse(res)) {
        if (kind === "anthropic") {
          if (ev.type === "content_block_delta") {
            if (ev.delta?.type === "text_delta") reply.content += ev.delta.text;
            else if (ev.delta?.type === "thinking_delta") reply.reasoning = (reply.reasoning || "") + ev.delta.thinking;
          } else if (ev.type === "error") throw new Error(ev.error?.message || "Anthropic error");
        } else {
          if (ev.error) throw new Error(ev.error.message || "Provider error");
          const d = ev.choices?.[0]?.delta;
          if (d?.content) reply.content += d.content;
          const r = d?.reasoning || d?.reasoning_content;
          if (r) reply.reasoning = (reply.reasoning || "") + r;
        }
        scheduleRender(node, reply);
      }
      if (!reply.content && !reply.reasoning) reply.error = "The model returned an empty reply.";
    } catch (e) {
      if (e.name !== "AbortError") reply.error = e.message || "Something went wrong.";
    } finally {
      S.abort = null;
      setBusy(false);
      c.updated = Date.now();
      saveChats();
      requestAnimationFrame(() => {
        if (S.chatId === c.id) {
          node.outerHTML = msgHtml(reply);
          thread.scrollTop = thread.scrollHeight;
        }
      });
      if (S.model.startsWith("k:")) refreshMe();
    }
  }

  function setBusy(on) {
    const b = $("#send");
    b.classList.toggle("is-busy", on);
    b.setAttribute("aria-label", on ? "Stop" : "Send");
  }

  const input = $("#input");
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
  };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (S.abort) return S.abort.abort();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    send(text);
  });

  /* ═══════════════ settings ═══════════════ */

  const dlg = $("#settings");

  function openSettings(tab = "membership") {
    selectTab(tab);
    if (!dlg.open) dlg.showModal();
    if (S.user) refreshMe().then(() => tab === "membership" && renderMembership());
  }
  $$("[data-close]", dlg).forEach((b) => b.addEventListener("click", () => dlg.close()));
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  $$(".tab", dlg).forEach((t) => t.addEventListener("click", () => selectTab(t.dataset.tab)));

  function selectTab(tab) {
    $$(".tab", dlg).forEach((t) => t.classList.toggle("is-active", t.dataset.tab === tab));
    $$(".pane", dlg).forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (tab === "membership") renderMembership();
    if (tab === "keys") renderKeys();
    if (tab === "account") renderAccount();
  }

  function renderMembership() {
    const now = $("#plan-now");
    const promo = $("#promo");
    if (!S.user) {
      now.innerHTML = `<div class="plan-now-top"><span class="plan-now-name">Guest</span></div>
        <p class="plan-now-exp">Memberships belong to an account. Sign in or create one to unlock Kronos models.</p>
        <div class="row-btns"><button class="btn btn-blue" data-auth-go="sign-up">Create account</button><button class="btn btn-ghost" data-auth-go="sign-in">Sign in</button></div>`;
      promo.hidden = true;
    } else if (S.me?.tier) {
      const pct = Math.min(100, (S.me.usedToday / S.me.dailyTokens) * 100);
      now.innerHTML = `<div class="plan-now-top"><span class="plan-now-name">${tierName(S.me.tier)}</span>
          <span class="plan-now-exp">Active until ${new Date(S.me.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</span></div>
        <div class="meter"><span style="width:${pct.toFixed(1)}%"></span></div>
        <div class="meter-text"><span>${fmt(S.me.usedToday)} used today</span><span>${fmt(S.me.dailyTokens)} daily</span></div>`;
      promo.hidden = false;
    } else {
      now.innerHTML = `<div class="plan-now-top"><span class="plan-now-name">No membership</span></div>
        <p class="plan-now-exp">Redeem a promo code below to unlock GLM 5.3 Flash, MiniMax 3.1 Flash, Nemotron 3.5 Super VL and DeepSeek V4.1 Flash.</p>`;
      promo.hidden = false;
    }
    $("#plans").innerHTML = TIERS.map(
      (t) => `<div class="plan${S.me?.tier === t.id ? " is-current" : ""}">
        <span class="plan-name">${t.name}</span><span class="plan-mult">${t.mult}</span><span class="plan-tok">${fmt(t.tokens)} tokens / day</span>
      </div>`
    ).join("");
  }

  dlg.addEventListener("click", (e) => {
    const go = e.target.closest("[data-auth-go]");
    if (!go) return;
    dlg.close();
    signIn(go.dataset.authGo);
  });

  const REDEEM_ERRORS = {
    invalid: "That code is not valid.",
    expired: "That code has expired.",
    used_up: "That code has reached its limit.",
    already_redeemed: "You have already used this code.",
    higher_plan_active: "You already have a higher plan active.",
    signed_out: "Please sign in again.",
  };

  $("#promo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#promo-msg");
    const btn = e.submitter || $("#promo button");
    const code = $("#promo-input").value.trim().toUpperCase();
    if (!code) return;
    msg.className = "form-msg";
    msg.textContent = "Checking…";
    btn.disabled = true;
    try {
      const res = await api("/api/kronos/redeem", { method: "POST", body: JSON.stringify({ code }) });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        msg.className = "form-msg ok";
        msg.textContent = `${tierName(data.tier)} is active until ${new Date(data.expires_at).toLocaleDateString()}.`;
        $("#promo-input").value = "";
        await refreshMe();
        renderMembership();
      } else {
        msg.className = "form-msg err";
        msg.textContent = REDEEM_ERRORS[data.error] || "Could not redeem the code.";
      }
    } catch {
      msg.className = "form-msg err";
      msg.textContent = "Network error. Please try again.";
    } finally {
      btn.disabled = false;
    }
  });

  function renderKeys() {
    $("#keys").innerHTML = Object.entries(PROVIDERS)
      .map(([pid, p]) => {
        const k = S.keys[pid];
        const has = p.custom ? !!k?.base : !!k;
        const count = (S.models[pid] || []).length;
        return `<form class="key" data-pid="${pid}">
          <div class="key-top"><span class="key-name">${p.name}</span>
            <span class="key-state${has ? " ok" : ""}" data-state>${has ? `${count} models` : "Not connected"}</span></div>
          ${p.custom ? `<input type="url" name="base" placeholder="https://your-endpoint/v1" value="${esc(k?.base || "")}" autocomplete="off" />` : ""}
          <div class="key-row">
            <input type="password" name="key" placeholder="${has ? "••••••••  saved" : p.custom ? "API key (optional)" : "Paste API key"}" autocomplete="off" spellcheck="false" />
            <button class="btn btn-light" type="submit">${has ? "Update" : "Connect"}</button>
            ${has ? `<button class="btn btn-ghost" type="button" data-remove>Remove</button>` : ""}
          </div>
          ${p.link ? `<a href="${p.link}" target="_blank" rel="noopener noreferrer">Get a ${p.name} key →</a>` : ""}
        </form>`;
      })
      .join("");
  }

  async function listModels(pid, key) {
    const p = PROVIDERS[pid];
    if (p.kind === "anthropic") {
      const res = await fetch(`${p.base}/models?limit=100`, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      });
      if (!res.ok) throw new Error(await providerError(res, p.name));
      return (await res.json()).data.map((m) => m.id);
    }
    const base = p.custom ? key.base.replace(/\/+$/, "") : p.base;
    const secret = p.custom ? key.key : key;
    const res = await fetch(`${base}/models`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
    if (!res.ok) throw new Error(await providerError(res, p.name));
    const body = await res.json();
    let ids = (body.data || body.models || []).map((m) => (m.id || m.name || "").replace(/^models\//, "")).filter(Boolean);
    if (p.filter) ids = ids.filter((id) => p.filter.test(id));
    return ids.sort();
  }

  $("#keys").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const pid = form.dataset.pid;
    const p = PROVIDERS[pid];
    const state = form.querySelector("[data-state]");
    const raw = form.key.value.trim();
    let key;
    if (p.custom) {
      const base = (form.base.value || "").trim();
      if (!/^https:\/\//.test(base)) {
        state.className = "key-state err";
        state.textContent = "Use an https:// URL";
        return;
      }
      key = { base, key: raw || S.keys.custom?.key || "" };
    } else {
      key = raw || S.keys[pid];
      if (!key) return;
    }
    state.className = "key-state";
    state.textContent = "Checking…";
    try {
      const ids = await listModels(pid, key);
      S.keys[pid] = key;
      S.models[pid] = ids;
      store.set("kronos.keys", S.keys);
      store.set("kronos.models", S.models);
      renderKeys();
      renderPicker();
      toast(`${p.name} connected — ${ids.length} models.`);
    } catch (err) {
      state.className = "key-state err";
      state.textContent = "Failed";
      toast(err.message || "Could not reach the provider.");
    }
  });

  $("#keys").addEventListener("click", (e) => {
    if (!e.target.closest("[data-remove]")) return;
    const pid = e.target.closest("form").dataset.pid;
    delete S.keys[pid];
    delete S.models[pid];
    store.set("kronos.keys", S.keys);
    store.set("kronos.models", S.models);
    if (S.model?.startsWith(`b:${pid}:`)) setModel(null);
    renderKeys();
  });

  function renderAccount() {
    const el = $("#account");
    if (S.user) {
      el.innerHTML = `<div class="account">
        <div class="account-id"><span class="me-avatar">${S.user.image ? `<img src="${esc(S.user.image)}" alt="" />` : esc(S.user.name[0].toUpperCase())}</span>
          <div><div class="me-name">${esc(S.user.name)}</div><div class="muted">${esc(S.user.email)}</div></div></div>
        <div class="row-btns"><button class="btn btn-dark" id="manage-account">Manage account</button><button class="btn btn-danger" id="sign-out">Sign out</button></div>
      </div>`;
      $("#manage-account").addEventListener("click", () => {
        dlg.close();
        S.clerk.openUserProfile();
      });
      $("#sign-out").addEventListener("click", async () => {
        dlg.close();
        await S.clerk.signOut();
      });
    } else {
      el.innerHTML = `<div class="account"><p class="muted">You are using Kronos as a guest. Your chats and keys stay in this browser.</p>
        <div class="row-btns"><button class="btn btn-blue" data-auth-go="sign-up">Create account</button><button class="btn btn-ghost" data-auth-go="sign-in">Sign in</button></div></div>`;
    }
  }

  $("#export-chats").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(S.chats, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kronos-chats-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("#clear-chats").addEventListener("click", () => {
    if (!confirm("Delete every chat stored in this browser?")) return;
    S.chats = [];
    saveChats();
    openChat(null);
  });

  /* ═══════════════ boot ═══════════════ */

  function finishBoot() {
    $("#boot").classList.add("is-done");
    setTimeout(() => $("#boot").remove(), 400);
  }

  async function boot() {
    S.guest = store.get("kronos.guest", false);
    try {
      S.clerk = await loadClerk();
    } catch {
      S.clerk = null;
    }

    if (S.clerk) {
      let lastId = undefined;
      const onAuth = () => {
        const u = userFromClerk(S.clerk.user);
        const id = u ? u.id : null;
        if (id === lastId) {
          S.user = u;
          renderMe();
          return;
        }
        lastId = id;
        S.user = u;
        if (u) {
          S.guest = false;
          store.del("kronos.guest");
        }
        loadChats();
        if (u || S.guest) {
          showApp();
          refreshMe();
        } else showAuth();
      };
      S.clerk.addListener(onAuth);
      onAuth();
    } else {
      $("#clerk-status").textContent = "Secure sign-in could not be reached. You can still continue without an account.";
      loadChats();
      if (S.guest) showApp();
      else {
        $("#auth").hidden = false;
      }
    }
    finishBoot();
  }

  boot();
})();
