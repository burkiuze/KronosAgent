// Address the "Request a demo" form sends to. Leave empty until a real inbox exists.
const CONTACT_EMAIL = "";

const nav = document.querySelector(".nav");

// Announcement bar: dismissable, remembered for this browser session.
const announce = document.getElementById("announce");
try {
  if (sessionStorage.getItem("announce-closed")) announce.hidden = true;
} catch {}
announce.querySelector(".announce-close").addEventListener("click", () => {
  announce.hidden = true;
  try {
    sessionStorage.setItem("announce-closed", "1");
  } catch {}
});
const burger = document.querySelector(".burger");
const mobileMenu = document.querySelector(".mobile-menu");
const menuItem = document.querySelector(".has-menu");

// Nav border once the page scrolls.
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

// Mobile menu.
const closeMobile = () => {
  burger.setAttribute("aria-expanded", "false");
  mobileMenu.hidden = true;
};
burger.addEventListener("click", () => {
  const open = burger.getAttribute("aria-expanded") === "true";
  burger.setAttribute("aria-expanded", String(!open));
  mobileMenu.hidden = open;
});
mobileMenu.addEventListener("click", (e) => {
  if (e.target.closest("a, button")) closeMobile();
});

// Products dropdown: hover opens it via CSS; click and Escape for keyboard users.
const menuButton = menuItem.querySelector("button");
const closeMenu = () => {
  menuItem.classList.remove("open");
  menuButton.setAttribute("aria-expanded", "false");
};
menuButton.addEventListener("click", () => {
  const open = menuItem.classList.toggle("open");
  menuButton.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (!menuItem.contains(e.target)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

// Reveal on scroll.
const revealEls = document.querySelectorAll(".reveal, .industries, .r-list li, .post");
revealEls.forEach((el) => el.classList.add("reveal"));
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px" }
  );
  revealEls.forEach((el, i) => {
    el.style.transitionDelay = `${(i % 4) * 60}ms`;
    io.observe(el);
  });
} else {
  revealEls.forEach((el) => el.classList.add("in"));
}

// Stacked cards: each card is sticky, so the next one slides over it and leaves its
// label showing as a tab. Clicking a tab scrolls back to where that card is fully open.
const cards = [...document.querySelectorAll(".s-card")];
const isStacked = () => getComputedStyle(cards[0]).position === "sticky";
const stickTop = (card) => parseFloat(getComputedStyle(card).top) || 0;
// Where the card sits in normal flow (sticky offsets don't apply until it sticks).
const naturalTop = (i) => {
  const first = cards[0];
  const gap = parseFloat(getComputedStyle(first).marginBottom) || 0;
  const firstTop = first.parentElement.getBoundingClientRect().top + window.scrollY +
    parseFloat(getComputedStyle(first.parentElement).paddingTop);
  return firstTop + cards.slice(0, i).reduce((sum, c) => sum + c.offsetHeight + gap, 0);
};

cards.forEach((card, i) => {
  card.querySelector("[data-tab]").addEventListener("click", () => {
    const y = isStacked() ? naturalTop(i) - stickTop(card) : card.getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top: y, behavior: "smooth" });
  });
});

const updateCover = () => {
  if (!isStacked()) return;
  cards.forEach((card, i) => {
    const next = cards[i + 1];
    if (!next) return;
    const covered = (card.getBoundingClientRect().bottom - next.getBoundingClientRect().top) / card.offsetHeight;
    card.style.setProperty("--cover", Math.min(Math.max(covered, 0), 1).toFixed(3));
  });
};
updateCover();
window.addEventListener("scroll", updateCover, { passive: true });
window.addEventListener("resize", updateCover);

// Industries: the accordion picks which example decision the card shows.
const EXAMPLES = {
  finance: {
    title: "Transaction review",
    input: "Wire transfer of $48,200 to a new beneficiary, initiated outside business hours from a known device.",
    choice: "hold for review",
    conf: "0.81",
    reasons: [
      "New beneficiary combined with an unusual amount",
      "Off-hours initiation, but from a trusted device",
      "Below the auto-block threshold — route to an analyst",
    ],
  },
  public: {
    title: "Citizen request routing",
    input: "My building permit application has been pending for six weeks and the inspection date was never confirmed.",
    choice: "permits office",
    conf: "0.88",
    reasons: [
      "Refers to an existing building permit application",
      "Asks about an inspection date, not a new filing",
      "No safety issue reported — standard priority",
    ],
  },
  tech: {
    title: "Agent tool router",
    input: "Summarise last quarter’s churn by plan and draft an email to the three largest accounts that downgraded.",
    choice: "sql → frontier model",
    conf: "0.86",
    reasons: [
      "Churn figures need a database query first",
      "Email drafting benefits from a larger writing model",
      "No browsing or file access required",
    ],
  },
  support: {
    title: "Ticket triage",
    input: "I was charged twice for my March invoice and need a refund before Friday.",
    choice: "billing · urgent",
    conf: "0.92",
    reasons: [
      "Duplicate charge on a specific invoice",
      "Explicit refund request with a deadline",
      "No technical fault described",
    ],
  },
};

const indCard = document.querySelector(".ind-card");
const field = (name) => indCard.querySelector(`[data-field="${name}"]`);
const showExample = (key) => {
  const ex = EXAMPLES[key];
  if (!ex) return;
  indCard.classList.add("swap");
  setTimeout(() => {
    field("title").textContent = ex.title;
    field("input").textContent = ex.input;
    field("choice").textContent = ex.choice;
    field("conf").textContent = ex.conf;
    field("reasons").replaceChildren(
      ...ex.reasons.map((r) => Object.assign(document.createElement("li"), { textContent: r }))
    );
    indCard.classList.remove("swap");
  }, 200);
};

document.querySelectorAll(".acc-item").forEach((item) => {
  item.querySelector(".acc-head").addEventListener("click", () => {
    if (item.classList.contains("open")) return;
    document.querySelectorAll(".acc-item.open").forEach((other) => {
      other.classList.remove("open");
      other.querySelector(".acc-head").setAttribute("aria-expanded", "false");
    });
    item.classList.add("open");
    item.querySelector(".acc-head").setAttribute("aria-expanded", "true");
    showExample(item.dataset.key);
  });
});

// Demo request dialog.
const dialog = document.getElementById("demo");
const form = document.getElementById("demo-form");
const status = form.querySelector(".form-status");

document.querySelectorAll("[data-open-demo]").forEach((el) =>
  el.addEventListener("click", (e) => {
    e.preventDefault();
    closeMenu();
    status.textContent = "";
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
  })
);
dialog.querySelector(".demo-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  let ok = true;
  form.querySelectorAll("[required]").forEach((input) => {
    const valid = input.value.trim() && (input.type !== "email" || /.+@.+\..+/.test(input.value));
    input.classList.toggle("invalid", !valid);
    if (!valid) ok = false;
  });
  if (!ok) {
    status.textContent = "Please fill in your name, a valid work email and your company.";
    return;
  }
  const data = Object.fromEntries(new FormData(form));
  if (!CONTACT_EMAIL) {
    status.textContent = "Thanks! Demo requests open soon — please check back shortly.";
    return;
  }
  const subject = encodeURIComponent(`Navio request — ${data.company}`);
  const body = encodeURIComponent(
    `Name: ${data.name}\nEmail: ${data.email}\nCompany: ${data.company}\n\n${data.message || ""}`
  );
  window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
  status.textContent = "Opening your email app…";
});

document.getElementById("year").textContent = new Date().getFullYear();
