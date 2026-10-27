(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const TIER = { lite: "Lite", pro: "Pro", max: "Max", max5: "Max 5" };
  let codes = [];

  const call = (path, method = "GET", body) =>
    fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

  let t;
  const toast = (msg) => {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(t);
    t = setTimeout(() => (el.hidden = true), 2600);
  };

  const showGate = () => {
    $("#admin").hidden = true;
    $("#gate").hidden = false;
    $("#login").password.focus();
  };

  async function load() {
    const res = await call("/api/babo/codes");
    if (res.status === 401) return showGate();
    if (!res.ok) return toast("Could not load data.");
    const data = await res.json();
    codes = data.codes || [];
    const m = data.members || {};
    const total = Object.values(m).reduce((a, b) => a + b, 0);
    $("#stats").innerHTML = [
      ["Active members", total],
      ["Lite", m.lite || 0],
      ["Pro", m.pro || 0],
      ["Max", m.max || 0],
      ["Max 5", m.max5 || 0],
      ["Requests today", data.requests_today || 0],
    ]
      .map(([k, v]) => `<div class="stat"><b>${Number(v).toLocaleString()}</b><span>${k}</span></div>`)
      .join("");
    renderCodes();
    $("#gate").hidden = true;
    $("#admin").hidden = false;
  }

  function renderCodes() {
    const f = $("#filter").value.trim().toUpperCase();
    const rows = codes.filter((c) => !f || c.code.includes(f) || (c.note || "").toUpperCase().includes(f));
    $("#codes").innerHTML = rows.length
      ? rows
          .map((c) => {
            const expired = c.valid_until && new Date(c.valid_until) < new Date();
            const used = c.max_uses && c.uses >= c.max_uses;
            const status = !c.active ? ["off", "Disabled"] : expired ? ["off", "Expired"] : used ? ["", "Used up"] : ["on", "Active"];
            return `<tr class="${c.active ? "" : "off"}" data-code="${esc(c.code)}">
              <td class="mono">${esc(c.code)}</td>
              <td>${TIER[c.tier] || esc(c.tier)}</td>
              <td>${c.duration_days} days</td>
              <td class="mono">${c.uses}${c.max_uses ? ` / ${c.max_uses}` : " / ∞"}</td>
              <td>${c.valid_until ? new Date(c.valid_until).toLocaleDateString() : "—"}</td>
              <td>${esc(c.note || "")}</td>
              <td><span class="tag ${status[0]}">${status[1]}</span></td>
              <td><div class="actions">
                <button data-act="copy">Copy</button>
                <button data-act="toggle">${c.active ? "Disable" : "Enable"}</button>
                <button data-act="delete" class="del">Delete</button>
              </div></td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="8" class="muted">No codes yet.</td></tr>`;
  }

  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#login-msg");
    msg.textContent = "";
    const btn = e.submitter;
    btn.disabled = true;
    const res = await call("/api/babo/session", "POST", { password: e.target.password.value });
    btn.disabled = false;
    if (res.ok) {
      e.target.reset();
      return load();
    }
    const data = await res.json().catch(() => ({}));
    msg.textContent = data.error === "too_many_attempts" ? "Too many attempts. Try again in 15 minutes." : "Wrong password.";
  });

  $("#logout").addEventListener("click", async () => {
    await call("/api/babo/session", "DELETE");
    showGate();
  });

  const form = $("#create");
  form.preset.addEventListener("change", () => {
    const custom = form.preset.value === "custom";
    $(".custom-days").hidden = !custom;
    if (!custom) form.days.value = form.preset.value;
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#create-msg");
    const days = form.preset.value === "custom" ? Number(form.days.value) : Number(form.preset.value);
    const body = {
      tier: form.tier.value,
      days,
      maxUses: form.maxUses.value ? Number(form.maxUses.value) : null,
      validUntil: form.validUntil.value ? new Date(`${form.validUntil.value}T23:59:59`).toISOString() : null,
      code: form.code.value.trim(),
      note: form.note.value.trim(),
    };
    const res = await call("/api/babo/codes", "POST", body);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return showGate();
    if (!res.ok) {
      msg.className = "form-msg err";
      msg.textContent = data.error === "exists" ? "That code already exists." : `Could not create the code (${data.error || res.status}).`;
      return;
    }
    msg.className = "form-msg ok";
    msg.textContent = `Created ${data.code} — ${TIER[data.tier]} for ${data.duration_days} days.`;
    navigator.clipboard?.writeText(data.code).then(() => toast(`${data.code} copied`), () => {});
    form.code.value = "";
    form.note.value = "";
    load();
  });

  $("#filter").addEventListener("input", renderCodes);

  $("#codes").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const code = btn.closest("tr").dataset.code;
    const c = codes.find((x) => x.code === code);
    if (btn.dataset.act === "copy") {
      navigator.clipboard?.writeText(code).then(() => toast("Copied"));
      return;
    }
    if (btn.dataset.act === "toggle") {
      await call("/api/babo/codes", "PATCH", { code, active: !c.active });
      return load();
    }
    if (btn.dataset.act === "delete") {
      if (!confirm(`Delete ${code}? Memberships already granted stay active.`)) return;
      await call("/api/babo/codes", "DELETE", { code });
      return load();
    }
  });

  load().catch(showGate);
})();
