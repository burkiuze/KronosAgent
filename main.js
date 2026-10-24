(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Commands point at whatever host serves this page, so they stay right on any domain.
  const ORIGIN = /^https?:$/.test(location.protocol) ? location.origin : "https://kronos-agent.vercel.app";

  // Social links under the logo. Until a URL is set, the icon points at the community footer.
  const SOCIAL = { discord: "", x: "" };
  $$("[data-social]").forEach((a) => {
    const url = SOCIAL[a.dataset.social];
    if (url) {
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
    } else {
      a.href = "#community";
    }
  });

  /* ───────────── mobile menu ───────────── */

  const burger = $("#burger");
  const menu = $("#mobile-menu");
  const setMenu = (open) => {
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    menu.hidden = !open;
  };
  burger.addEventListener("click", () => setMenu(menu.hidden));
  $$("a", menu).forEach((a) => a.addEventListener("click", () => setMenu(false)));

  /* ───────────── hero: terminal / cloud ───────────── */

  const showPanel = (name) => {
    $$(".action").forEach((btn) => {
      const active = btn.dataset.panel === name;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    $("#panel-terminal").hidden = name !== "terminal";
    $("#panel-cloud").hidden = name !== "cloud";
  };
  $$(".action").forEach((btn) => btn.addEventListener("click", () => showPanel(btn.dataset.panel)));
  $$("[data-open-panel]").forEach((a) => a.addEventListener("click", () => showPanel(a.dataset.openPanel)));

  const PLATFORMS = {
    unix: {
      prompt: "$",
      cmd: `curl -fsSL ${ORIGIN}/install.sh | bash`,
      note: "No prerequisites · Installs everything automatically · Free under the MIT license",
    },
    windows: {
      prompt: "PS>",
      cmd: `iex (irm ${ORIGIN}/install.ps1)`,
      note: "Run in PowerShell · Native Windows, no WSL required",
    },
    termux: {
      prompt: "$",
      cmd: `pkg install -y curl && curl -fsSL ${ORIGIN}/install.sh | bash`,
      note: "Run inside Termux on Android (aarch64)",
    },
  };

  const setPlatform = (key) => {
    const p = PLATFORMS[key];
    $("#cmd-prompt").textContent = p.prompt;
    $("#cmd-text").textContent = p.cmd;
    $("#cmd-note").textContent = p.note;
    $$(".os-tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.os === key));
  };
  $$(".os-tab").forEach((tab) => tab.addEventListener("click", () => setPlatform(tab.dataset.os)));
  $("#cloud-text").textContent = `ssh you@your-server 'curl -fsSL ${ORIGIN}/install.sh | bash'`;

  const ua = navigator.userAgent;
  const plat = navigator.platform || ua;
  const os = /Android/i.test(ua)
    ? "android"
    : /^Win|Windows/i.test(plat)
      ? "win"
      : /^Mac/i.test(plat) && !/iPhone|iPad/i.test(ua)
        ? "mac"
        : /Linux|X11/i.test(plat)
          ? "linux"
          : null;
  setPlatform(os === "win" ? "windows" : os === "android" ? "termux" : "unix");
  $(`.dcard[data-os="${os}"]`)?.classList.add("is-detected");

  /* ───────────── copy buttons ───────────── */

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  };

  $$(".copy").forEach((btn) => {
    const original = btn.textContent;
    btn.addEventListener("click", async () => {
      const ok = await copyText($(`#${btn.dataset.copyTarget}`).textContent.trim());
      btn.textContent = ok ? "Copied" : "Ctrl+C";
      btn.classList.toggle("is-copied", ok);
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("is-copied");
      }, 1600);
    });
  });

  /* ───────────── features rail ───────────── */

  const rail = $("#rail");
  const railBtns = $$(".rail-btn");
  const updateRail = () => {
    const max = rail.scrollWidth - rail.clientWidth - 2;
    railBtns[0].disabled = rail.scrollLeft <= 2;
    railBtns[1].disabled = rail.scrollLeft >= max;
  };
  railBtns.forEach((btn) =>
    btn.addEventListener("click", () => {
      const card = rail.querySelector(".card");
      const step = card ? card.getBoundingClientRect().width + parseFloat(getComputedStyle(rail).columnGap || 0) : 400;
      rail.scrollBy({ left: Number(btn.dataset.rail) * step, behavior: reduceMotion ? "auto" : "smooth" });
    })
  );
  rail.addEventListener("scroll", updateRail, { passive: true });
  window.addEventListener("resize", updateRail);
  updateRail();

  /* ───────────── reveal on scroll ───────────── */

  const reveals = $$(".reveal");
  if ("IntersectionObserver" in window && !reduceMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("is-in"));
  }

  $("#year").textContent = String(new Date().getFullYear());

  /* ───────────── terminal demo ───────────── */

  const term = $("#terminal");
  const SCRIPT = [
    { out: '<span class="t-prompt">~/projects</span> <span class="t-dim">$</span> <span class="t-user">kronos</span>', wait: 500 },
    { out: "", wait: 120 },
    { out: '<span class="t-badge">KRONOS AGENT</span>  <span class="t-dim">42 skills · memory on · gateway: telegram</span>', wait: 700 },
    { out: "", wait: 200 },
    { type: "Every weekday at 8:30, summarise my GitHub notifications and send them to Telegram." },
    { out: "", wait: 300 },
    { out: '  <span class="t-tool">⚙ cron.create</span>  <span class="t-dim">schedule="30 8 * * 1-5" deliver=telegram</span>', wait: 650 },
    { out: '  <span class="t-ok">✓</span> Job <span class="t-head">morning-github-digest</span> scheduled <span class="t-dim">· next run Mon 08:30</span>', wait: 550 },
    { out: '  <span class="t-tool">⚙ skill.create</span>  <span class="t-dim">github-digest (learned from this task)</span>', wait: 650 },
    { out: '  <span class="t-ok">✓</span> Skill saved — reused automatically next time', wait: 600 },
    { out: "", wait: 150 },
    { out: '<span class="t-head">Done.</span> Every weekday at 08:30 you\'ll get a digest of reviews,', wait: 120 },
    { out: "mentions and failing checks in Telegram.", wait: 900 },
    { out: "", wait: 200 },
    { type: "/recall what did we decide about the release branch?" },
    { out: "", wait: 300 },
    { out: '  <span class="t-tool">⚙ session.search</span>  <span class="t-dim">"release branch" · 3 matches · 12 days</span>', wait: 650 },
    { out: '<span class="t-head">On the 12th</span> we agreed to cut <span class="t-head">release/1.4</span> on Fridays only.', wait: 400 },
  ];

  let runId = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const addLine = (html) => {
    const line = document.createElement("div");
    line.innerHTML = html || "&nbsp;";
    term.appendChild(line);
    while (term.scrollHeight > term.clientHeight && term.children.length > 1) {
      term.removeChild(term.firstElementChild);
    }
    return line;
  };

  const cursor = () => {
    const c = document.createElement("span");
    c.className = "t-cursor";
    return c;
  };

  const runDemo = async () => {
    const id = ++runId;
    term.textContent = "";
    for (const step of SCRIPT) {
      if (id !== runId) return;
      if (step.type) {
        const line = addLine('<span class="t-prompt">❯</span> ');
        const text = document.createElement("span");
        text.className = "t-user";
        const c = cursor();
        line.append(text, c);
        for (const ch of step.type) {
          if (id !== runId) return;
          text.textContent += ch;
          await sleep(reduceMotion ? 0 : 18 + Math.random() * 38);
        }
        await sleep(350);
        c.remove();
      } else {
        addLine(step.out);
        await sleep(reduceMotion ? 0 : step.wait);
      }
    }
    if (id !== runId) return;
    addLine('<span class="t-prompt">❯</span> ').appendChild(cursor());
  };

  if ("IntersectionObserver" in window) {
    const tio = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          tio.disconnect();
          runDemo();
        }
      },
      { threshold: 0.3 }
    );
    tio.observe(term);
  } else {
    runDemo();
  }

  $("#terminal-replay").addEventListener("click", runDemo);
})();
