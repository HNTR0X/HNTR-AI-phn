// Marketplace — installed extensions/integrations (#panel-marketplace):
// browse/install/uninstall, reviews, creator publish flow, per-space
// extension toggles, plus the generic cross-panel extension-host
// mechanism (SPACE_HOSTS/EXT_REGISTRY/hostMountExtensions) and every
// mounted extension's own mini-app (Pomodoro, Flashcards, Citations,
// Calendar, Kanban-plus, Agency OS CRM, Trading Journal). Backend for the
// install/review/publish side lives in routes/marketplace.py.
//
// This is NOT the same system as js/features/agents.js (the agent-template
// marketplace) — confirmed zero cross-calls between the two on any layer.
// They share the "Marketplace" label in product copy only.
//
// hostMountExtensions()/openSpaceSettings() are generic, not marketplace-
// owned in spirit (see the comment at SPACE_HOSTS below: "generic mount
// across ALL space types... add a new space type = add a host"), but they
// physically live here since they read this file's own mktExtEnabled/
// mktItems state. js/features/org.js and js/features/academic.js both call
// into them as globals — this file must load before both in
// templates/index.html for that reason (safe regardless of exact order in
// practice, since every file loads with `defer` and these are only called
// well after all deferred scripts have executed, but keep the ordering
// documented and consistent with that existing convention anyway).
//
// mktSeedItems() (below) is still the sole, fake/static data source for
// this panel's catalog — unlike agents.js's browse/discovery, which is
// fully API-backed, there is no backend "list marketplace items" route at
// all (only install/uninstall/reviews/publish/my-listings exist). Not
// fixed as part of this extraction, moved verbatim — flagging since it's
// easy to assume this was migrated to real data already.
//
// NOT moved here despite living nearby in the original app.js: a ~160-line
// island (sbRestoreSections, cmdPushRecent/cmdRecentHTML/cmdRunNamed, and
// Settings-panel functions stExtrasRestore/stToggleNotifCh/stExportData/
// stClearChat/stDeleteAccount) that happened to sit physically between two
// marketplace sections — genuinely unrelated (sidebar/cmd-palette/Settings
// code), confirmed via each function's actual callers, left in app.js.


/* ═══════════════════════════════════════════════════════════
   SIVARR — Marketplace (Extensions / Integrations / Templates)
   Adapted to Sivarr: nav() switcher, toast(), localStorage persistence,
   integrations deep-link to the real panel, injection deferred. PREVIEW.
═══════════════════════════════════════════════════════════ */
function mktEsc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function mktToast(m) {
  if (typeof toast === "function") toast(m);
}

let mktItems = [];
let mktInstalled = []; // [{id, installed_at}]
let mktFilter = {
  type: "all",
  category: "",
  sort: "featured",
  search: "",
  view: "browse",
};
let mktCurrentItem = null;
let mktPublishType = null;
let mktReviewStar = 0;
let mktAllReviews = {}; // { itemId: [review,...] }
let mktExtEnabled = {}; // { spaceId: [extId,...] }
let mktSpaceCur = null;

const MKT_INSTALLED_KEY = "sivarr_mkt_installed";
const MKT_EXT_KEY = "sivarr_mkt_ext_enabled";

const INT_CATALOGUE = [
  {
    id: "google-calendar",
    name: "Google Calendar",
    icon: "📅",
    desc: "Sync events and deadlines",
    category: "productivity",
    provides: ["calendar"],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    icon: "💾",
    desc: "Attach and browse files",
    category: "productivity",
  },
  {
    id: "notion",
    name: "Notion",
    icon: "📝",
    desc: "Import pages and databases",
    category: "productivity",
  },
  {
    id: "slack",
    name: "Slack",
    icon: "💬",
    desc: "Send notifications to channels",
    category: "communication",
  },
  {
    id: "github",
    name: "GitHub",
    icon: "🐙",
    desc: "Link repos and track issues",
    category: "developer",
  },
  {
    id: "paystack",
    name: "Paystack",
    icon: "💳",
    desc: "Financial data (read-only)",
    category: "finance",
  },
  {
    id: "zoom",
    name: "Zoom",
    icon: "🎥",
    desc: "Schedule and join meetings",
    category: "communication",
  },
  {
    id: "trello",
    name: "Trello",
    icon: "📋",
    desc: "Import boards and cards",
    category: "productivity",
  },
];

// Catalogue ids that have a real backend to connect to. The rest are roadmap
// entries (no OAuth/server) and can't be enabled per-space yet.
const INT_CONNECTABLE = new Set(["google-calendar", "github", "paystack"]);
// Real per-integration connection state — the SINGLE source of truth, read
// from the same globals integrationsRender() uses. Per-space toggles must never
// enable an integration the user hasn't actually connected (backlog 4d).
function intIsConnected(intId) {
  switch (intId) {
    case "google-calendar":
      return !!(typeof _GCAL_CONNECTED !== "undefined" && _GCAL_CONNECTED);
    case "github":
      return !!(typeof _GITHUB_CONNECTED !== "undefined" && _GITHUB_CONNECTED);
    case "paystack":
      return (
        typeof _BILLING_STATUS !== "undefined" &&
        (_BILLING_STATUS?.plan || "free") !== "free"
      );
    default:
      return false;
  }
}

function mktSeedItems() {
  const ext = (
    id,
    name,
    icon,
    author,
    category,
    desc,
    rating,
    installs,
    price,
    official,
  ) => ({
    id,
    type: "extension",
    name,
    icon,
    author,
    category,
    desc,
    rating,
    installs,
    price,
    official,
  });
  const tmpl = (
    id,
    name,
    icon,
    author,
    category,
    desc,
    rating,
    installs,
    official,
    tt,
  ) => ({
    id,
    type: "template",
    name,
    icon,
    author,
    category,
    desc,
    rating,
    installs,
    price: 0,
    official,
    tmpl_type: tt,
  });
  const items = [
    ext(
      "ext-pomodoro",
      "Pomodoro Pro",
      "⏱",
      "Sivarr",
      "productivity",
      "Advanced Pomodoro with ambient sounds and session logging.",
      4.8,
      2400,
      0,
      true,
    ),
    ext(
      "ext-mindmap",
      "Mind Map Builder",
      "🧠",
      "Sivarr",
      "productivity",
      "Drag-and-drop mind mapping inside any Space.",
      4.6,
      1800,
      0,
      true,
    ),
    ext(
      "ext-flashcards",
      "Smart Flashcards",
      "📇",
      "Sivarr",
      "academic",
      "AI-powered spaced-repetition flashcards.",
      4.9,
      3200,
      0,
      true,
    ),
    ext(
      "ext-habit",
      "Habit Streak Widget",
      "🔥",
      "Kehinde A.",
      "productivity",
      "A visual habit streak widget for any Space.",
      4.5,
      980,
      0,
      false,
    ),
    ext(
      "ext-kanban-plus",
      "Kanban Plus",
      "📊",
      "Tunde O.",
      "productivity",
      "Enhanced Kanban with swimlanes and WIP limits.",
      4.7,
      1200,
      1500,
      false,
    ),
    ext(
      "ext-citation",
      "Citation Engine",
      "📚",
      "Sivarr",
      "academic",
      "APA/MLA/IEEE citations via Scholar.",
      4.8,
      2100,
      0,
      true,
    ),
    ext(
      "ext-finance-dash",
      "Finance Dashboard",
      "💰",
      "Adaeze N.",
      "finance",
      "Expense tracker + budget widget in ₦.",
      4.4,
      750,
      2500,
      false,
    ),
    ext(
      "ext-code-runner",
      "Code Runner",
      "⚡",
      "Emeka J.",
      "developer",
      "Run Python/JS/SQL snippets inline.",
      4.6,
      640,
      0,
      false,
    ),
    ext(
      "ext-calendar",
      "Calendar",
      "📅",
      "Sivarr",
      "productivity",
      "Your Google Calendar: upcoming events in any space.",
      4.8,
      0,
      0,
      true,
    ),
    ext(
      "ext-agency-os",
      "Agency OS",
      "🎨",
      "Sivarr",
      "work",
      "Client workspace, brief→delivery pipeline, and revision tracking for agencies.",
      4.8,
      0,
      0,
      true,
    ),
    ext(
      "ext-trading-journal",
      "Trading Journal",
      "📈",
      "Sivarr",
      "finance",
      "Log trades, journal your psychology, size positions, and track win-rate & R:R.",
      4.9,
      0,
      0,
      true,
    ),
    ...INT_CATALOGUE.map((i) => ({
      ...i,
      type: "integration",
      author: "Sivarr",
      official: true,
      rating: 4.7,
      installs: 1200,
      price: 0,
    })),
    tmpl(
      "tmpl-academic-student",
      "Academic OS: Student",
      "🎓",
      "Sivarr",
      "academic",
      "Student dashboard: Lecture Vault, Exam Sprint, Research.",
      4.9,
      4100,
      true,
      "space",
    ),
    tmpl(
      "tmpl-academic-lect",
      "Academic OS: Lecturer",
      "📋",
      "Sivarr",
      "academic",
      "Lecturer dashboard: courses, roster, AI tools.",
      4.8,
      1900,
      true,
      "space",
    ),
    tmpl(
      "tmpl-startup",
      "Startup OS",
      "🚀",
      "Sivarr",
      "work",
      "OKRs, sprint board, team comms, investor tracker.",
      4.7,
      2300,
      true,
      "space",
    ),
    tmpl(
      "tmpl-freelance",
      "Freelance Hub",
      "💼",
      "Chioma E.",
      "work",
      "Client tracker, invoice log, project board.",
      4.6,
      1400,
      false,
      "space",
    ),
    tmpl(
      "tmpl-weekly-review",
      "Weekly Review",
      "🔄",
      "Sivarr",
      "productivity",
      "Structured weekly review doc.",
      4.8,
      3100,
      true,
      "doc",
    ),
    tmpl(
      "tmpl-budget",
      "Monthly Budget",
      "💳",
      "Sivarr",
      "finance",
      "Naira-first budget tracker.",
      4.7,
      1700,
      true,
      "tracker",
    ),
  ];
  const INJ = {
    "ext-pomodoro": { label: "Pomodoro", icon: "ti-clock" },
    "ext-mindmap": { label: "Mind Map", icon: "ti-hierarchy" },
    "ext-flashcards": { label: "Flashcards", icon: "ti-cards" },
    "ext-habit": { label: "Habit Streak", icon: "ti-flame" },
    "ext-kanban-plus": { label: "Kanban+", icon: "ti-layout-kanban" },
    "ext-citation": { label: "Citations", icon: "ti-file-text" },
    "ext-finance-dash": { label: "Finance", icon: "ti-coin" },
    "ext-code-runner": { label: "Code Runner", icon: "ti-code" },
    "ext-calendar": { label: "Calendar", icon: "ti-calendar" },
    "ext-agency-os": { label: "Agency OS", icon: "ti-briefcase" },
    "ext-trading-journal": {
      label: "Trading Journal",
      icon: "ti-chart-candle",
    },
  };
  items.forEach((i) => {
    if (i.type === "extension" && INJ[i.id])
      i.inject = Object.assign({ type: "tab" }, INJ[i.id]);
  });
  return items;
}

// ── Init ──
// Lazy-load seed items + per-space enabled exts from localStorage (used by the
// injection engine even when the Marketplace panel was never opened this session).
function mktEnsureLoaded() {
  if (!mktItems.length) mktItems = mktSeedItems();
  try {
    mktExtEnabled = JSON.parse(localStorage.getItem(MKT_EXT_KEY) || "{}");
  } catch (e) {
    mktExtEnabled = {};
  }
}
// Server is the source of truth for installs (Postgres); localStorage is a cache/fallback.
async function mktLoadInstalled() {
  try {
    const r = await fetch("/api/marketplace/installed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: getToken() }),
    });
    if (r.ok) {
      const d = await r.json();
      if (d && Array.isArray(d.installed)) {
        mktInstalled = d.installed.map((x) => ({
          id: x.id,
          installed_at: x.ts || "",
        }));
        mktSaveInstalled();
        return;
      }
    }
  } catch (e) {}
  try {
    mktInstalled = JSON.parse(localStorage.getItem(MKT_INSTALLED_KEY) || "[]");
  } catch (e) {
    mktInstalled = [];
  }
}
// Set by nav()'s "library" redirect to land Marketplace straight on the
// Integrations & Library tab instead of the Browse default — consumed
// (and cleared) once mktInit()'s own async setup has finished, so it can't
// race mktInit()'s view:"browse" reset below.
let _mktPendingView = null;
async function mktInit() {
  mktEnsureLoaded();
  await mktLoadInstalled();
  mktSyncSpacePrefs();
  mktFilter = {
    type: "all",
    category: "",
    sort: "featured",
    search: "",
    view: "browse",
  };
  mktRenderFeatured();
  mktRenderGrid();
  mktUpdateInstalledCount();
  if (_mktPendingView) {
    const v = _mktPendingView;
    _mktPendingView = null;
    mktSetView(v, document.getElementById(`mkt-subnav-${v}-btn`));
  }
}
function mktSaveInstalled() {
  localStorage.setItem(MKT_INSTALLED_KEY, JSON.stringify(mktInstalled));
}
function mktSaveExt() {
  localStorage.setItem(MKT_EXT_KEY, JSON.stringify(mktExtEnabled));
}

// Per-space prefs (enabled extensions + integrations) are persisted server-side
// so they follow the user across devices. Hydrate the local maps (server wins),
// then re-inject the open space.
async function mktSyncSpacePrefs() {
  try {
    const r = await fetch("/api/space/prefs/get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: getToken() }),
    });
    if (!r.ok) return;
    const d = await r.json();
    if (!d || !d.prefs) return;
    mktEnsureLoaded();
    mktLoadSpaceInts();
    Object.entries(d.prefs).forEach(([spId, p]) => {
      if (p && Array.isArray(p.exts)) mktExtEnabled[spId] = p.exts;
      if (p && Array.isArray(p.ints)) mktSpaceInts[spId] = p.ints;
    });
    mktSaveExt();
    localStorage.setItem(
      "sivarr_space_integrations",
      JSON.stringify(mktSpaceInts),
    );
    const cur = window.currentSpace || window.currentAcademicSpace;
    if (cur && typeof extReinjectCurrent === "function") extReinjectCurrent();
  } catch (e) {}
}
function _mktPushSpacePrefs(spaceId, patch) {
  if (!spaceId) return;
  fetch("/api/space/prefs/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      Object.assign({ token: getToken(), space_id: spaceId }, patch),
    ),
  }).catch(() => {});
}

// ── Filtering ──
function mktGetFiltered() {
  return mktItems
    .filter((i) => {
      if (mktFilter.type !== "all" && i.type !== mktFilter.type) return false;
      if (mktFilter.category && i.category !== mktFilter.category) return false;
      if (
        mktFilter.search &&
        !(i.name + i.desc + i.author)
          .toLowerCase()
          .includes(mktFilter.search.toLowerCase())
      )
        return false;
      if (mktFilter.sort === "free" && i.price !== 0) return false;
      return true;
    })
    .sort((a, b) =>
      mktFilter.sort === "popular"
        ? b.installs - a.installs
        : (b.official ? 1 : 0) - (a.official ? 1 : 0),
    );
}

function mktRenderFeatured() {
  const strip = document.getElementById("mktFeaturedStrip");
  if (!strip) return;
  const f = mktItems.filter((i) => i.official).slice(0, 4);
  strip.innerHTML = `<div class="mkt-featured-label">Featured</div><div class="mkt-featured-cards">${f.map((i) => `<div class="mkt-featured-card" data-onclick="mktOpenDetail" data-onclick-arg0="${mktEsc(i.id)}"><div class="mkt-item-icon mkt-icon-${i.type}">${i.icon}</div><div><div class="mkt-item-name">${mktEsc(i.name)}</div><span class="mkt-item-type-badge mkt-type-${i.type}">${i.type}</span></div></div>`).join("")}</div>`;
}

function mktItemBtn(i) {
  if (i.type === "integration")
    return `<button class="mkt-install-btn mkt-install-btn--installed" data-onclick="nav" data-onclick-arg0="library">Connect →</button>`;
  if (i.type === "template")
    return `<button class="mkt-install-btn" data-onclick="mktUseTemplate" data-onclick-arg0="${mktEsc(i.id)}">Use</button>`;
  const inst = mktInstalled.find((x) => x.id === i.id);
  // This catalogue is seed/preview content (see the "Preview" badge on the
  // panel header) — no real checkout ever runs, so the button must never
  // say "Buy"/show a price as if clicking it charges anything.
  return `<button class="mkt-install-btn ${inst ? "mkt-install-btn--installed" : ""}" data-onclick="${inst ? "mktUninstall" : "mktInstall"}" data-onclick-arg0="${mktEsc(i.id)}">${inst ? "Installed ✓" : "Install"}</button>`;
}

function mktRenderGrid() {
  const grid = document.getElementById("mktGrid");
  if (!grid) return;
  const items = mktGetFiltered();
  if (!items.length) {
    grid.innerHTML = `<div class="mkt-empty-state" style="grid-column:1/-1"><i class="ti ti-search" style="font-size:28px;opacity:.2"></i><div>No items match your search</div></div>`;
    return;
  }
  grid.innerHTML = items
    .map(
      (i) =>
        `<div class="mkt-card" data-onclick="mktOpenDetail" data-onclick-arg0="${mktEsc(i.id)}"><div class="mkt-card-top"><div class="mkt-item-icon mkt-icon-${i.type}">${i.icon}</div><span class="mkt-item-type-badge mkt-type-${i.type}">${i.type}</span></div><div class="mkt-card-body"><div class="mkt-item-name">${mktEsc(i.name)}</div><div class="mkt-item-author">${i.official ? '<i class="ti ti-rosette-discount-check mkt-verified" aria-hidden="true"></i> Sivarr Official' : mktEsc(i.author)}</div><div class="mkt-item-desc">${mktEsc(i.desc)}</div><div class="mkt-card-footer"><div class="mkt-item-stats"><span>★ ${i.rating}</span><span>${i.installs.toLocaleString()}</span></div>${mktItemBtn(i)}</div></div></div>`,
    )
    .join("");
}

function mktRenderInstalled() {
  const list = document.getElementById("mktInstalledList");
  if (!list) return;
  const items = mktInstalled
    .map((x) => mktItems.find((i) => i.id === x.id))
    .filter(Boolean);
  if (!items.length) {
    list.innerHTML = `<div class="mkt-empty-state"><i class="ti ti-puzzle" style="font-size:32px;opacity:.2"></i><div>Nothing installed yet</div></div>`;
    return;
  }
  list.innerHTML = items
    .map(
      (i) =>
        `<div class="mkt-installed-row"><div class="mkt-item-icon" style="font-size:20px">${i.icon}</div><div style="flex:1"><div class="mkt-item-name">${mktEsc(i.name)}</div><div class="mkt-item-author">${i.type} · ${i.official ? "Sivarr" : mktEsc(i.author)}</div></div><button class="mkt-btn-ghost mkt-btn-sm mkt-btn-danger" data-onclick="mktUninstall" data-onclick-arg0="${mktEsc(i.id)}">Remove</button></div>`,
    )
    .join("");
}
function mktUpdateInstalledCount() {
  const el = document.getElementById("mktInstalledCount");
  if (el) el.textContent = mktInstalled.length;
}

// ── Filter actions ──
function mktSetType(t, btn) {
  mktFilter.type = t;
  document
    .querySelectorAll("#mktTypeTabs .mkt-type-tab")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  mktRenderGrid();
}
function mktSetCategory(c, btn) {
  mktFilter.category = c;
  document
    .querySelectorAll("#mktCategoryRow .mkt-cat-pill")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  mktRenderGrid();
}
// CSP migration: takes the element instead of the raw value string.
function mktSearch(el) {
  mktFilter.search = el.value;
  mktRenderGrid();
}
// CSP migration: takes the element instead of the raw value string.
function mktSetSort(el) {
  mktFilter.sort = el.value;
  mktRenderGrid();
}
function mktSetView(view, btn) {
  mktFilter.view = view;
  document
    .querySelectorAll(".mkt-subnav-btn")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  ["browse", "installed", "published", "integrations"].forEach((v) => {
    const el = document.getElementById(`mktView-${v}`);
    if (el) el.style.display = v === view ? "block" : "none";
  });
  if (view === "installed") mktRenderInstalled();
  if (view === "published") creatorInit();
  if (view === "integrations") integrationsRender();
}

// ── Install / use ──
function mktInstall(id) {
  const item = mktItems.find((i) => i.id === id);
  if (!item || mktInstalled.find((i) => i.id === id)) return;
  mktInstalled.push({ id, installed_at: new Date().toISOString() });
  mktSaveInstalled();
  mktUpdateInstalledCount();
  mktRenderGrid();
  mktToast(`${item.name} installed`);
  fetch("/api/marketplace/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: getToken(), item_id: id }),
  }).catch(() => {});
  if (item.type === "extension" && typeof extShowOnboarding === "function")
    extShowOnboarding(item);
}
function mktUninstall(id) {
  const item = mktItems.find((i) => i.id === id);
  mktInstalled = mktInstalled.filter((i) => i.id !== id);
  mktSaveInstalled();
  mktUpdateInstalledCount();
  mktRenderGrid();
  if (mktFilter.view === "installed") mktRenderInstalled();
  mktToast(`${item ? item.name : "Item"} removed`);
  fetch("/api/marketplace/uninstall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: getToken(), item_id: id }),
  }).catch(() => {});
}
async function mktUseTemplate(id) {
  const item = mktItems.find((i) => i.id === id);
  if (!item) return;
  const name =
    typeof siModal !== "undefined" && siModal.input
      ? await siModal.input(
          "Create space from template",
          "Name your new space",
          item.name,
          { confirmLabel: "Create space" },
        )
      : prompt("Name your new space", item.name);
  if (!name || !name.trim()) return;
  // Academic templates → academic space (with role); everything else → personal.
  let type = "personal",
    role = null;
  if (item.id === "tmpl-academic-student") {
    type = "academic";
    role = "student";
  } else if (item.id === "tmpl-academic-lect") {
    type = "academic";
    role = "lecturer";
  } else if (item.category === "academic") {
    type = "academic";
    role = "student";
  }
  const sid = `sp_${Date.now()}`;
  const space = {
    id: sid,
    name: name.trim(),
    type,
    icon: type === "academic" ? "🎓" : "👤",
    from_template: item.id,
  };
  if (role) space.academic_role = role;
  try {
    const spaces = getSpaces();
    spaces.push(space);
    saveSpaces(spaces);
    if (typeof syncSpaceMeta === "function") syncSpaceMeta(space);
    // Pre-populate the new space with the template's fitting FREE extensions, so a
    // "Freelance Hub" lands you in a space with Agency OS already on, etc. (paid
    // extensions are never auto-enabled — they require purchase via the marketplace).
    const TMPL_EXTS = {
      "tmpl-freelance": ["ext-agency-os"],
      "tmpl-academic-student": ["ext-flashcards", "ext-citation"],
    };
    const preExts = TMPL_EXTS[item.id] || [];
    if (preExts.length && typeof mktExtEnabled !== "undefined") {
      if (!mktExtEnabled[sid]) mktExtEnabled[sid] = [];
      mktExtEnabled[sid] = [...new Set([...mktExtEnabled[sid], ...preExts])];
      if (typeof mktSaveExt === "function") mktSaveExt();
    }
    if (typeof spaceRenderSidebar === "function") spaceRenderSidebar();
    mktCloseDetail();
    mktToast(`"${space.name}" created from ${item.name}`);
    if (typeof openSpace === "function") openSpace(sid);
  } catch (e) {
    mktToast("Could not create the space");
  }
  fetch("/api/marketplace/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: getToken(), item_id: id }),
  }).catch(() => {});
}

// ── Detail modal ──
function mktOpenDetail(id) {
  const item = mktItems.find((i) => i.id === id);
  if (!item) return;
  mktCurrentItem = item;
  const modal = document.getElementById("mktDetailModal");
  if (!modal) return;
  document.getElementById("mktDetailIcon").textContent = item.icon;
  document.getElementById("mktDetailName").textContent = item.name;
  document.getElementById("mktDetailAuthor").textContent = item.official
    ? "✦ Sivarr Official"
    : item.author;
  document.getElementById("mktDetailMeta").innerHTML =
    `<span class="mkt-item-type-badge mkt-type-${item.type}">${item.type}</span><span class="mkt-meta-stat">★ ${item.rating}</span><span class="mkt-meta-stat">${item.installs.toLocaleString()} installs</span><span class="mkt-meta-stat">${item.price > 0 ? "₦" + item.price.toLocaleString() : "Free"}</span>`;
  document.getElementById("mktDetailActions").innerHTML =
    item.type === "integration"
      ? `<button class="mkt-install-btn mkt-btn-lg" data-onclick="_mktCloseDetailThenNav" data-onclick-arg0="library">Open Integrations →</button>`
      : item.type === "template"
        ? `<button class="mkt-install-btn mkt-btn-lg" data-onclick="mktUseTemplate" data-onclick-arg0="${mktEsc(item.id)}">Use template</button>`
        : (() => {
            const inst = mktInstalled.find((i) => i.id === item.id);
            // See mktItemBtn() — no real checkout runs for this preview
            // catalogue, so the button must never say "Buy" as if it does.
            return `<button class="mkt-install-btn ${inst ? "mkt-install-btn--installed" : ""} mkt-btn-lg" data-onclick="_mktInstallToggleAndClose" data-onclick-args="${mktEsc(JSON.stringify([item.id, !!inst]))}">${inst ? "✓ Installed · Remove" : "Install"}</button>`;
          })();
  document
    .querySelectorAll("#mktDetailModal .mkt-modal-tab")
    .forEach((b) => b.classList.remove("active"));
  document
    .querySelector("#mktDetailModal .mkt-modal-tab")
    ?.classList.add("active");
  mktDetailTab("overview", null);
  modal.style.display = "flex";
}
function mktCloseDetail(e) {
  if (e && e.target !== document.getElementById("mktDetailModal")) return;
  const m = document.getElementById("mktDetailModal");
  if (m) m.style.display = "none";
  mktCurrentItem = null;
}

// CSP migration: both were multi-statement inline handlers (close the modal,
// then do something else) -- delegate.js only dispatches to single named
// functions (js/core/delegate.js's own header), so these are real wrappers.
window._mktCloseDetailThenNav = function (panel) {
  mktCloseDetail();
  nav(panel);
};
window._mktInstallToggleAndClose = function (id, isInstalled) {
  if (isInstalled) mktUninstall(id);
  else mktInstall(id);
  mktCloseDetail();
};
window._mktCloseDetailThenAddOrgExt = function () {
  mktCloseDetail();
  if (typeof orgAddExtension === "function") orgAddExtension();
};
function mktDetailTab(tab, btn) {
  document
    .querySelectorAll("#mktDetailModal .mkt-modal-tab")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  const content = document.getElementById("mktDetailContent");
  if (!content || !mktCurrentItem) return;
  if (tab === "reviews") {
    mktRenderReviews(mktCurrentItem.id);
    return;
  }
  if (tab === "changelog") {
    content.innerHTML = `<div class="mkt-empty-state" style="padding:20px 0"><div>No changelog entries yet</div></div>`;
    return;
  }
  content.innerHTML = `<p class="mkt-item-desc" style="font-size:13px;line-height:1.6;margin-bottom:12px">${mktEsc(mktCurrentItem.desc)}</p><div class="mkt-detail-tags"><span class="mkt-cat-pill" style="cursor:default">${mktCurrentItem.category}</span>${mktCurrentItem.official ? '<span class="mkt-cat-pill mkt-cat-pill--official" style="cursor:default">Official</span>' : ""}</div>`;
}

// ── Reviews ──
function mktRenderReviews(itemId) {
  const content = document.getElementById("mktDetailContent");
  if (!content) return;
  const reviews = mktAllReviews[itemId] || [];
  content.innerHTML = `<div class="mkt-reviews-section"><div class="mkt-review-form"><div class="mkt-section-label" style="margin-bottom:8px">Leave a review</div><div class="mkt-star-row" id="mktStarRow">${[1, 2, 3, 4, 5].map((n) => `<button class="mkt-star" data-val="${n}" data-onclick="mktSetStar" data-onclick-args="[${n}]">★</button>`).join("")}</div><textarea class="mkt-review-input" id="mktReviewText" placeholder="What do you think? How did you use it?"></textarea><button class="mkt-btn-teal mkt-btn-sm" data-onclick="mktSubmitReview" data-onclick-arg0="${mktEsc(itemId)}"><i class="ti ti-send" aria-hidden="true"></i> Submit review</button></div><div id="mktReviewsList">${_mktReviewsListHTML(reviews)}</div></div>`;
  mktReviewStar = 0;
  mktLoadReviews(itemId);
}
function _mktReviewsListHTML(reviews) {
  return reviews.length
    ? reviews
        .map((r) => {
          const rt = Math.max(
            0,
            Math.min(5, Math.round(Number(r.rating) || 0)),
          );
          return `<div class="mkt-review-item"><div class="mkt-review-header"><div class="mkt-review-avatar">${mktEsc((r.author || "U")[0].toUpperCase())}</div><div><div class="mkt-review-author">${mktEsc(r.author)}</div><div class="mkt-review-stars">${"★".repeat(rt)}${"☆".repeat(5 - rt)}</div></div><div class="mkt-review-date">${mktEsc(r.date)}</div></div><div class="mkt-review-body">${mktEsc(r.body)}</div></div>`;
        })
        .join("")
    : `<div class="mkt-empty-state" style="padding:20px 0"><div>No reviews yet. Be the first!</div></div>`;
}
async function mktLoadReviews(itemId) {
  try {
    const r = await fetch("/api/marketplace/reviews/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: getToken(), item_id: itemId }),
    });
    if (r.ok) {
      const d = await r.json();
      if (d && Array.isArray(d.reviews)) {
        mktAllReviews[itemId] = d.reviews;
        const el = document.getElementById("mktReviewsList");
        if (el && mktCurrentItem && mktCurrentItem.id === itemId)
          el.innerHTML = _mktReviewsListHTML(d.reviews);
      }
    }
  } catch (e) {}
}
function mktSetStar(v) {
  mktReviewStar = v;
  document
    .querySelectorAll(".mkt-star")
    .forEach((s) =>
      s.classList.toggle("mkt-star--active", parseInt(s.dataset.val) <= v),
    );
}
function mktSubmitReview(itemId) {
  const text = (document.getElementById("mktReviewText")?.value || "").trim();
  if (!text || mktReviewStar === 0) {
    mktToast("Pick a star rating and write a review");
    return;
  }
  const review = {
    item_id: itemId,
    rating: mktReviewStar,
    body: text,
    author: (window.S && S.name) || "You",
    date: new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
  };
  if (!mktAllReviews[itemId]) mktAllReviews[itemId] = [];
  mktAllReviews[itemId].unshift(review);
  const listEl = document.getElementById("mktReviewsList");
  if (listEl) listEl.innerHTML = _mktReviewsListHTML(mktAllReviews[itemId]);
  const ta = document.getElementById("mktReviewText");
  if (ta) ta.value = "";
  mktReviewStar = 0;
  document
    .querySelectorAll(".mkt-star")
    .forEach((s) => s.classList.remove("mkt-star--active"));
  mktToast("Review submitted, thank you!");
  fetch("/api/marketplace/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: getToken(), ...review }),
  })
    .then(() => mktLoadReviews(itemId))
    .catch(() => {});
}

// ── Publish modal ──
function mktOpenPublish() {
  const m = document.getElementById("mktPublishModal");
  if (m) m.style.display = "flex";
}
function mktClosePublish(e) {
  if (e && e.target !== document.getElementById("mktPublishModal")) return;
  const m = document.getElementById("mktPublishModal");
  if (m) m.style.display = "none";
}
function mktSelectPublishType(t, btn) {
  mktPublishType = t;
  document
    .querySelectorAll(".mkt-publish-type-card")
    .forEach((c) => c.classList.remove("active"));
  if (btn) btn.classList.add("active");
}
function mktSubmitPublish() {
  const name = (document.getElementById("pubName")?.value || "").trim();
  const desc = (document.getElementById("pubDesc")?.value || "").trim();
  if (!name || !desc || !mktPublishType) {
    mktToast("Fill in name, description, and pick a type");
    return;
  }
  mktToast("Submitted for review, you'll hear back within 48 hours");
  mktClosePublish();
  fetch("/api/marketplace/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: getToken(),
      type: mktPublishType,
      name,
      description: desc,
      category: document.getElementById("pubCategory")?.value,
      pricing: document.getElementById("pubPrice")?.value,
      price: parseInt(document.getElementById("pubAmount")?.value || "0"),
      repo_url: document.getElementById("pubRepo")?.value,
    }),
  }).catch(() => {});
}

// ── Creator dashboard (My Listings) — honest empty until real listings exist ──
let creatorListings = [];
async function creatorInit() {
  try {
    const r = await fetch("/api/marketplace/my-listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: getToken() }),
    });
    if (r.ok) {
      const d = await r.json();
      creatorListings = d.listings || [];
    }
  } catch (e) {}
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  const installs = creatorListings.reduce((s, l) => s + (l.installs || 0), 0);
  set("creatorTotalInstalls", installs || "–");
  set("creatorListingCount", creatorListings.length || "–");
  set(
    "creatorAvgRating",
    creatorListings.length
      ? "★ " +
          (
            creatorListings.reduce((s, l) => s + (l.rating || 0), 0) /
            creatorListings.length
          ).toFixed(1)
      : "–",
  );
  set(
    "creatorRevenue",
    "₦" +
      Math.round(
        creatorListings.reduce(
          (s, l) => s + (l.price || 0) * (l.installs || 0) * 0.9,
          0,
        ),
      ).toLocaleString(),
  );
  // listings list stays as empty-state until real data exists
}

// ── Space Settings modal (sidebar ⋮ menu for any space + academic gear) ──
function openSpaceSettingsById(id) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const sp = getSpaces().find((s) => s.id === id);
  if (sp) openSpaceSettings(sp);
}
function openSpaceSettings(space) {
  mktSpaceCur =
    space || window.currentSpace || window.currentAcademicSpace || null;
  const modal = document.getElementById("spaceSettingsModal");
  if (!modal) return;
  document.getElementById("spaceSettingsTitle").textContent =
    (mktSpaceCur?.name || "Space") + " settings";
  document.getElementById("spaceSettingsSubtitle").textContent =
    mktSpaceCur?.type || "";
  const rn = document.getElementById("spaceRenameInput");
  if (rn) rn.value = mktSpaceCur?.name || "";
  spaceSettingsTab(
    "extensions",
    document.querySelector("#spaceSettingsModal .mkt-modal-tab"),
  );
  modal.style.display = "flex";
}
function closeSpaceSettings(e) {
  if (e && e.target !== document.getElementById("spaceSettingsModal")) return;
  const m = document.getElementById("spaceSettingsModal");
  if (m) m.style.display = "none";
}

// CSP migration: multi-statement (close the modal, then navigate).
window._closeSpaceSettingsThenNav = function (panel) {
  closeSpaceSettings();
  nav(panel);
};
function spaceSettingsTab(tab, btn) {
  document
    .querySelectorAll("#spaceSettingsModal .mkt-modal-tab")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  ["extensions", "integrations", "danger"].forEach((t) => {
    const el = document.getElementById(`spaceSettingsTab-${t}`);
    if (el) el.style.display = t === tab ? "block" : "none";
  });
  if (tab === "extensions") spaceSettingsRenderExtensions();
  if (tab === "integrations") spaceSettingsRenderIntegrations();
}
function spaceSettingsRenderExtensions() {
  const list = document.getElementById("spaceSettingsExtList");
  if (!list || !mktSpaceCur) return;
  const sid = mktSpaceCur.id;
  const exts = mktInstalled
    .map((x) => mktItems.find((i) => i.id === x.id))
    .filter((i) => i && i.type === "extension");
  if (!exts.length) return; // keep empty state
  const enabled = mktExtEnabled[sid] || [];
  list.innerHTML = exts
    .map(
      (i) =>
        `<div class="sset-toggle-row"><div class="mkt-item-icon" style="font-size:16px">${i.icon}</div><div style="flex:1"><div class="mkt-item-name" style="font-size:12px">${mktEsc(i.name)}</div><div class="mkt-item-author">Adds a tab (coming soon)</div></div><label class="sset-toggle"><input type="checkbox" ${enabled.includes(i.id) ? "checked" : ""} data-onchange="_mktExtToggleFromEl" data-onchange-args="${mktEsc(JSON.stringify([i.id, sid]))}" data-onchange-this/><span class="sset-toggle-track"></span></label></div>`,
    )
    .join("");
}
let mktSpaceInts = {};
function mktLoadSpaceInts() {
  try {
    mktSpaceInts = JSON.parse(
      localStorage.getItem("sivarr_space_integrations") || "{}",
    );
  } catch (e) {
    mktSpaceInts = {};
  }
}
function spaceSettingsRenderIntegrations() {
  const list = document.getElementById("spaceSettingsIntList");
  if (!list || !mktSpaceCur) return;
  mktLoadSpaceInts();
  const sid = mktSpaceCur.id;
  // Prune stale enablement: if an integration was disconnected since it was
  // toggled on, drop it so a space can't silently keep "using" a dead account.
  const raw = mktSpaceInts[sid] || [];
  const enabled = raw.filter(intIsConnected);
  if (enabled.length !== raw.length) {
    mktSpaceInts[sid] = enabled;
    localStorage.setItem(
      "sivarr_space_integrations",
      JSON.stringify(mktSpaceInts),
    );
    _mktPushSpacePrefs(sid, { ints: enabled });
  }
  const connected = INT_CATALOGUE.filter((c) => intIsConnected(c.id));
  const available = INT_CATALOGUE.filter((c) => !intIsConnected(c.id));
  const row = (c, isOn, off) =>
    `<div class="sset-toggle-row${off ? " sset-row-off" : ""}">` +
    `<div class="mkt-item-icon" style="font-size:16px">${c.icon}</div>` +
    `<div style="flex:1"><div class="mkt-item-name" style="font-size:12px">${mktEsc(c.name)}</div>` +
    `<div class="mkt-item-author">${off ? (INT_CONNECTABLE.has(c.id) ? "Not connected" : "Coming soon") : mktEsc(c.desc)}</div></div>` +
    (off
      ? INT_CONNECTABLE.has(c.id)
        ? `<a class="sset-int-connect" data-onclick="_closeSpaceSettingsThenNav" data-onclick-arg0="library">Connect</a>`
        : `<span class="sset-int-soon">Soon</span>`
      : `<label class="sset-toggle"><input type="checkbox" ${isOn ? "checked" : ""} data-onchange="_spaceIntToggleFromEl" data-onchange-args="${mktEsc(JSON.stringify([c.id, sid]))}" data-onchange-this/><span class="sset-toggle-track"></span></label>`) +
    `</div>`;
  let html = connected.length
    ? connected.map((c) => row(c, enabled.includes(c.id), false)).join("")
    : `<div class="mkt-empty-state" style="padding:14px 0"><div>No integrations connected yet.</div></div>`;
  if (available.length)
    html +=
      `<div class="sset-int-divider">Available to connect</div>` +
      available.map((c) => row(c, false, true)).join("");
  list.innerHTML =
    html +
    `<div class="mkt-brief-desc" style="margin-top:10px">Connect accounts in the <a data-onclick="_closeSpaceSettingsThenNav" data-onclick-arg0="library" style="color:var(--teal);cursor:pointer">Integrations</a> panel. Toggles here choose which apply to this Space.</div>`;
}
// CSP migration: delegate.js has no this.checked-read grammar; read it
// here instead (data-onchange-this passes the checkbox element last).
window._spaceIntToggleFromEl = function (intId, spaceId, el) {
  spaceIntToggle(intId, spaceId, el.checked);
};

function spaceIntToggle(intId, spaceId, enable) {
  if (enable && !intIsConnected(intId)) {
    mktToast("Connect this integration first in the Integrations panel");
    spaceSettingsRenderIntegrations();
    return;
  }
  mktLoadSpaceInts();
  if (!mktSpaceInts[spaceId]) mktSpaceInts[spaceId] = [];
  mktSpaceInts[spaceId] = enable
    ? [...new Set([...mktSpaceInts[spaceId], intId])]
    : mktSpaceInts[spaceId].filter((i) => i !== intId);
  localStorage.setItem(
    "sivarr_space_integrations",
    JSON.stringify(mktSpaceInts),
  );
  _mktPushSpacePrefs(spaceId, { ints: mktSpaceInts[spaceId] });
  const c = INT_CATALOGUE.find((i) => i.id === intId);
  mktToast(
    `${c ? c.name : "Integration"} ${enable ? "enabled" : "disabled"} for this Space`,
  );
}
// CSP migration: same this.checked-read wrapper pattern as spaceIntToggle above.
window._mktExtToggleFromEl = function (extId, spaceId, el) {
  mktExtToggle(extId, spaceId, el.checked);
};

function mktExtToggle(extId, spaceId, enable) {
  if (!mktExtEnabled[spaceId]) mktExtEnabled[spaceId] = [];
  mktExtEnabled[spaceId] = enable
    ? [...new Set([...mktExtEnabled[spaceId], extId])]
    : mktExtEnabled[spaceId].filter((i) => i !== extId);
  mktSaveExt();
  _mktPushSpacePrefs(spaceId, { exts: mktExtEnabled[spaceId] });
  const item = mktItems.find((i) => i.id === extId);
  mktToast(
    `${item ? item.name : "Extension"} ${enable ? "enabled" : "disabled"} for this Space`,
  );
  // Live-remount if the toggled space is the one currently open (any type).
  const cur = window.currentSpace || window.currentAcademicSpace;
  if (typeof extReinjectCurrent === "function" && cur && cur.id === spaceId)
    extReinjectCurrent();
}
function spaceRename() {
  const val = (document.getElementById("spaceRenameInput")?.value || "").trim();
  if (!val || !mktSpaceCur) return;
  try {
    const spaces = getSpaces();
    const sp = spaces.find((s) => s.id === mktSpaceCur.id);
    if (sp) {
      sp.name = val;
      saveSpaces(spaces);
      syncSpaceMeta(sp);
      spaceRenderSidebar();
    }
    mktSpaceCur.name = val;
    ["ac-space-name", "acadSpaceNameLabel"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    });
    document.getElementById("spaceSettingsTitle").textContent =
      val + " settings";
    mktToast("Space renamed");
  } catch (e) {
    mktToast("Could not rename");
  }
}
function spaceDelete() {
  if (!mktSpaceCur) return;
  if (!confirm(`Delete "${mktSpaceCur.name}"? This cannot be undone.`)) return;
  const id = mktSpaceCur.id;
  try {
    saveSpaces(getSpaces().filter((s) => s.id !== id));
    spaceRenderSidebar();
    fetch("/api/spaces/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: getToken(), space_id: id }),
    }).catch(() => {});
  } catch (e) {}
  closeSpaceSettings();
  mktToast("Space deleted");
  if (typeof nav === "function") nav("home");
}

// Publish price field visibility
document.addEventListener("change", function (e) {
  if (e.target && e.target.id === "pubPrice") {
    const f = document.getElementById("pubPriceField");
    if (f) f.style.display = e.target.value === "paid" ? "block" : "none";
  }
});

/* ── Extension host: registry + generic mount across ALL space types ──
   A space "host descriptor" tells the injector how that dashboard's tab
   system works (tab/pane classes, id conventions, switcher, show/hide
   strategy). One code path mounts the extensions enabled for a space
   (mktExtEnabled[spaceId]) into Personal, Academic, or Org — instead of
   the old academic-only hardcoding. Add a new space type = add a host. */
const SPACE_HOSTS = {
  "academic:student": {
    barId: "studentTabBar",
    containerId: "acadStudentDash",
    tabClass: "acad-tab",
    paneClass: "acad-tab-content",
    paneIdPrefix: "tab-",
    switch: "sSwitchTab",
    inlineHide: true,
  },
  "academic:lecturer": {
    barId: "lecturerTabBar",
    containerId: "acadLecturerDash",
    tabClass: "acad-tab",
    paneClass: "acad-tab-content",
    paneIdPrefix: "tab-",
    switch: "lSwitchTab",
    inlineHide: true,
  },
  personal: {
    barSel: "#panel-personal .sp-tabs",
    containerSel: "#panel-personal",
    tabClass: "sp-tab",
    paneClass: "sp-pane",
    paneIdPrefix: "ps-pane-",
    switch: "spTabPersonalHost",
    inlineHide: false,
  },
  org: {
    barSel: "#panel-org .os-tabs",
    containerSel: "#panel-org",
    tabClass: "os-tab",
    tabIdPrefix: "os-tab-",
    paneClass: "os-pane",
    paneIdPrefix: "os-pane-",
    switch: "orgTab",
    inlineHide: false,
  },
};
// Personal space uses spTab(prefix,pane,btn); wrap it so the generic injector can call switch(name,btn).
function spTabPersonalHost(name, btn) {
  if (typeof spTab === "function") spTab("ps", name, btn);
}
// Registry: per-extension mount rules (which space types; optional custom render).
// Default: mounts everywhere ('*'), rendered by extGetTabHTML.
const EXT_REGISTRY = {
  "ext-pomodoro": { spaceTypes: ["*"] },
  "ext-mindmap": { spaceTypes: ["*"] },
  "ext-flashcards": { spaceTypes: ["*"], render: (item) => extFcShell(item) },
  "ext-habit": { spaceTypes: ["*"] },
  "ext-kanban-plus": { spaceTypes: ["*"], render: (item) => extKbShell(item) },
  "ext-citation": { spaceTypes: ["*"], render: (item) => extCiteShell(item) },
  "ext-finance-dash": { spaceTypes: ["*"] },
  "ext-code-runner": { spaceTypes: ["*"] },
  "ext-calendar": { spaceTypes: ["*"], render: (item) => extCalShell(item) },
  "ext-agency-os": { spaceTypes: ["*"], render: (item) => extAgShell(item) },
  "ext-trading-journal": {
    spaceTypes: ["*"],
    render: (item) => extTjShell(item),
  },
};
function _hostKeyFor(space) {
  if (!space) return null;
  if (space.type === "academic")
    return (
      "academic:" +
      (typeof acadRole !== "undefined" && acadRole === "lecturer"
        ? "lecturer"
        : "student")
    );
  if (space.type === "personal") return "personal";
  if (space.type === "org") return "org";
  return null;
}
// Mount the extensions enabled for `space` into whatever dashboard hosts it.
function hostMountExtensions(space) {
  const key = _hostKeyFor(space);
  if (key) extInjectIntoSpace(key, space);
}
function extInjectIntoSpace(hostKey, space) {
  const h = SPACE_HOSTS[hostKey];
  if (!h || !space) return;
  const bar = h.barId
    ? document.getElementById(h.barId)
    : document.querySelector(h.barSel);
  const container = h.containerId
    ? document.getElementById(h.containerId)
    : document.querySelector(h.containerSel);
  if (!bar || !container) return;
  mktEnsureLoaded();
  // Idempotent: clear prior injected nodes before re-rendering.
  bar.querySelectorAll("[data-injected]").forEach((e) => e.remove());
  container
    .querySelectorAll("." + h.paneClass + "[data-injected]")
    .forEach((e) => e.remove());
  (mktExtEnabled[space.id] || []).forEach((extId) => {
    const item = mktItems.find((i) => i.id === extId);
    if (!item || item.type !== "extension" || !item.inject) return;
    const reg = EXT_REGISTRY[extId] || {};
    if (
      reg.spaceTypes &&
      !reg.spaceTypes.includes("*") &&
      !reg.spaceTypes.includes(space.type)
    )
      return;
    const name = "xt-" + extId;
    const btn = document.createElement("button");
    btn.className = h.tabClass;
    btn.dataset.injected = "1";
    btn.dataset.tab = name;
    if (h.tabIdPrefix) btn.id = h.tabIdPrefix + name;
    btn.innerHTML = `<i class="ti ${item.inject.icon}" aria-hidden="true" style="font-size:12px;"></i> ${mktEsc(item.inject.label)}`;
    btn.onclick = () => {
      if (typeof window[h.switch] === "function") window[h.switch](name, btn);
    };
    bar.appendChild(btn);
    const pane = document.createElement("div");
    pane.className = h.paneClass;
    pane.dataset.injected = "1";
    pane.id = h.paneIdPrefix + name;
    if (h.inlineHide) pane.style.display = "none";
    pane.innerHTML = reg.render ? reg.render(item, space) : extGetTabHTML(item);
    container.appendChild(pane);
  });
}
// Re-inject the currently open space (any type) — used after toggling in Space Settings.
function extReinjectCurrent() {
  hostMountExtensions(window.currentSpace || window.currentAcademicSpace);
}

function extGetTabHTML(item) {
  const shell = (inner) =>
    `<div class="ext-tab-shell"><div class="ext-tab-icon">${item.icon}</div><div class="ext-tab-name">${mktEsc(item.name)}</div><div class="ext-tab-desc">${mktEsc(item.desc)}</div>${inner}</div>`;
  if (item.id === "ext-pomodoro") {
    return shell(
      `<div class="ext-pomo-display" id="extPomo-${item.id}">25:00</div><div style="display:flex;gap:8px;justify-content:center;margin-top:8px"><button class="mkt-btn-teal" data-onclick="extPomoStart" data-onclick-arg0="${mktEsc(item.id)}"><i class="ti ti-player-play" aria-hidden="true"></i> Start</button><button class="mkt-btn-ghost" data-onclick="extPomoReset" data-onclick-arg0="${mktEsc(item.id)}"><i class="ti ti-refresh" aria-hidden="true"></i></button></div>`,
    );
  }
  const empties = {
    "ext-mindmap": "ti-hierarchy",
    "ext-flashcards": "ti-cards",
    "ext-kanban-plus": "ti-layout-kanban",
    "ext-citation": "ti-file-text",
    "ext-finance-dash": "ti-coin",
    "ext-code-runner": "ti-code",
    "ext-habit": "ti-flame",
  };
  const ic = empties[item.id] || "ti-puzzle";
  return shell(
    `<div class="mkt-empty-state" style="margin-top:14px"><i class="ti ${ic}" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>This extension's workspace is coming soon.</div></div>`,
  );
}

// This widget doesn't run its own timer — it mirrors the single shared
// Pomodoro engine in academic.js (sPomo*). There is only ever one Pomodoro
// running at a time, so a second independent countdown here would just
// drift out of sync with it.
function extPomoStart(extId) {
  sPomoRegisterMirror(`extPomo-${extId}`);
  if (!sPomoRunning) sPomoToggle();
}
function extPomoReset(extId) {
  sPomoReset();
  sPomoRegisterMirror(`extPomo-${extId}`);
}

/* ── Real extensions: per-space storage + Flashcards + Citations ─────
   Make installed extensions actually work in ANY space. Data persists in
   the space's own blob (getSpaceData/setSpaceData → _ext[extId]); Citations
   reuse the existing acadAsk(/api/chat) engine. One space open at a time, so
   a single root id per extension is safe across host types. ───────── */
function _extSpaceId() {
  return (
    (window.currentSpace && window.currentSpace.id) ||
    (window.currentAcademicSpace && window.currentAcademicSpace.id) ||
    "personal"
  );
}
function extData(spaceId, extId) {
  const d = getSpaceData(spaceId) || {};
  return (d._ext && d._ext[extId]) || {};
}
function extSave(spaceId, extId, val) {
  const d = getSpaceData(spaceId) || {};
  d._ext = d._ext || {};
  d._ext[extId] = val;
  setSpaceData(spaceId, d);
}

// ── Flashcards (self-contained spaced drill) ──
let _extFcIdx = 0,
  _extFcFlip = false;
function extFcShell(item) {
  _extFcIdx = 0;
  _extFcFlip = false;
  return `<div class="ext-tab-shell" style="max-width:600px"><div class="ext-tab-icon">${item.icon}</div><div class="ext-tab-name">${mktEsc(item.name)}</div><div class="ext-tab-desc">${mktEsc(item.desc)}</div><div id="extfc-root" style="width:100%;margin-top:14px">${extFcInner()}</div></div>`;
}
function extFcInner() {
  const cards = extData(_extSpaceId(), "ext-flashcards").cards || [];
  const top = `<div style="display:flex;gap:8px;justify-content:center;margin-bottom:12px"><button class="mkt-btn-teal" data-onclick="extFcAdd"><i class="ti ti-plus" aria-hidden="true"></i> Add card</button>${cards.length ? `<button class="mkt-btn-ghost mkt-btn-danger" data-onclick="extFcDelete"><i class="ti ti-trash" aria-hidden="true"></i> Delete</button>` : ""}</div>`;
  if (!cards.length)
    return (
      top +
      `<div class="mkt-empty-state"><i class="ti ti-cards" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>No flashcards yet. Add your first card.</div></div>`
    );
  const i = ((_extFcIdx % cards.length) + cards.length) % cards.length;
  const c = cards[i];
  return (
    top +
    `<div data-onclick="extFcFlip" style="cursor:pointer;border:1px solid var(--border);border-radius:14px;padding:28px 18px;min-height:120px;display:flex;align-items:center;justify-content:center;text-align:center;background:var(--card)"><div><div class="acad-label" style="margin-bottom:8px">${_extFcFlip ? "Answer" : "Question"}</div><div style="font-size:15px;font-weight:600;color:var(--text)">${mktEsc(_extFcFlip ? c.a || "–" : c.q)}</div><div style="font-size:10px;color:var(--muted2);margin-top:10px">tap to flip</div></div></div><div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px"><button class="mkt-btn-ghost mkt-btn-sm" data-onclick="extFcNav" data-onclick-args="[-1]">‹ Prev</button><span style="font-size:11px;color:var(--muted)">${i + 1} / ${cards.length}</span><button class="mkt-btn-ghost mkt-btn-sm" data-onclick="extFcNav" data-onclick-args="[1]">Next ›</button></div>`
  );
}
function extFcRender() {
  const r = document.getElementById("extfc-root");
  if (r) r.innerHTML = extFcInner();
}
function extFcFlip() {
  _extFcFlip = !_extFcFlip;
  extFcRender();
}
function extFcNav(d) {
  _extFcFlip = false;
  _extFcIdx += d;
  extFcRender();
}
async function extFcAdd() {
  const f = await siModal.form("Add flashcard", [
    { id: "q", label: "Question", required: true },
    { id: "a", label: "Answer", required: true },
  ]);
  if (!f || !f.q) return;
  const sid = _extSpaceId();
  const cards = extData(sid, "ext-flashcards").cards || [];
  cards.push({ q: f.q, a: f.a || "" });
  extSave(sid, "ext-flashcards", { cards });
  _extFcIdx = cards.length - 1;
  _extFcFlip = false;
  extFcRender();
}
function extFcDelete() {
  const sid = _extSpaceId();
  const cards = extData(sid, "ext-flashcards").cards || [];
  if (!cards.length) return;
  const i = ((_extFcIdx % cards.length) + cards.length) % cards.length;
  cards.splice(i, 1);
  extSave(sid, "ext-flashcards", { cards });
  _extFcFlip = false;
  extFcRender();
}

// ── Citations (AI via acadAsk) ──
let _extCiteFmt = "APA";
function extCiteShell(item) {
  return `<div class="ext-tab-shell" style="max-width:640px"><div class="ext-tab-icon">${item.icon}</div><div class="ext-tab-name">${mktEsc(item.name)}</div><div class="ext-tab-desc">${mktEsc(item.desc)}</div><div id="extcite-root" style="width:100%;margin-top:14px">${extCiteInner()}</div></div>`;
}
function extCiteInner() {
  const items = extData(_extSpaceId(), "ext-citation").items || [];
  const fmts = ["APA", "MLA", "IEEE", "Harvard"]
    .map(
      (f) =>
        `<button class="mkt-cat-pill ${_extCiteFmt === f ? "active" : ""}" data-onclick="extCiteFmt" data-onclick-arg0="${f}">${f}</button>`,
    )
    .join("");
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${fmts}</div><div style="display:flex;gap:8px;margin-bottom:12px"><input id="extcite-q" class="mkt-review-input" style="min-height:0;flex:1" placeholder="Paste a title, URL, or DOI…"><button class="mkt-btn-teal" data-onclick="extCiteGen"><i class="ti ti-bolt" aria-hidden="true"></i> Cite</button></div><div>${items.length ? items.map((c, idx) => `<div class="mkt-review-item"><div class="mkt-review-body">${mktEsc(c.text)}</div><div style="display:flex;gap:6px;margin-top:6px;align-items:center"><span class="mkt-cat-pill" style="cursor:default">${mktEsc(c.fmt)}</span><button class="mkt-btn-ghost mkt-btn-sm" data-onclick="extCiteCopy" data-onclick-args="[${idx}]">Copy</button><button class="mkt-btn-ghost mkt-btn-sm mkt-btn-danger" data-onclick="extCiteDel" data-onclick-args="[${idx}]">Delete</button></div></div>`).join("") : `<div class="mkt-empty-state"><i class="ti ti-file-text" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>No citations yet.</div></div>`}</div>`;
}
function extCiteRender() {
  const r = document.getElementById("extcite-root");
  if (r) r.innerHTML = extCiteInner();
}
function extCiteFmt(f) {
  _extCiteFmt = f;
  extCiteRender();
}
async function extCiteGen() {
  const inp = document.getElementById("extcite-q");
  const q = inp ? inp.value.trim() : "";
  if (!q) return;
  if (inp) {
    inp.value = "Generating…";
    inp.disabled = true;
  }
  let text = "";
  try {
    text = await acadAsk(
      `Generate a ${_extCiteFmt} citation for: "${q}". Return ONLY the formatted citation, no commentary.`,
      "citation_engine",
    );
  } catch (e) {}
  if (inp) inp.disabled = false;
  if (!text) {
    mktToast("Citation failed, try again");
    if (inp) inp.value = q;
    return;
  }
  const sid = _extSpaceId();
  const items = extData(sid, "ext-citation").items || [];
  items.unshift({ text: String(text).trim(), fmt: _extCiteFmt });
  extSave(sid, "ext-citation", { items });
  extCiteRender();
}
function extCiteCopy(i) {
  const items = extData(_extSpaceId(), "ext-citation").items || [];
  const c = items[i];
  if (c && navigator.clipboard) {
    navigator.clipboard.writeText(c.text);
    mktToast("Copied");
  }
}
function extCiteDel(i) {
  const sid = _extSpaceId();
  const items = extData(sid, "ext-citation").items || [];
  items.splice(i, 1);
  extSave(sid, "ext-citation", { items });
  extCiteRender();
}

/* ── Integration capability spine ────────────────────────────────────
   Integrations 'provide' capabilities (INT_CATALOGUE[].provides); extensions
   consume them via spaceHasCapability(cap). Real connection state is per
   provider (e.g. Google Calendar = OAuth refresh token on the server). The
   Calendar extension below is the first real consumer: it shows the user's
   actual Google Calendar events in ANY space. ───────────────────────── */
function intCapProviders(cap) {
  return INT_CATALOGUE.filter((i) => (i.provides || []).includes(cap));
}
async function spaceHasCapability(cap) {
  if (cap === "calendar") {
    try {
      const r = await fetch(
        "/api/integrations/gcal/status?token=" +
          encodeURIComponent(getToken() || ""),
      );
      if (r.ok) return !!(await r.json()).connected;
    } catch (e) {}
    return false;
  }
  return false;
}

// Calendar extension — real consumer of the 'calendar' capability (Google Calendar).
function extCalShell(item) {
  setTimeout(extCalLoad, 0);
  return `<div class="ext-tab-shell" style="max-width:600px"><div class="ext-tab-icon">${item.icon}</div><div class="ext-tab-name">${mktEsc(item.name)}</div><div class="ext-tab-desc">${mktEsc(item.desc)}</div><div id="extcal-root" style="width:100%;margin-top:14px"><div class="mkt-empty-state"><div>Loading…</div></div></div>`;
}
async function extCalLoad() {
  const root = document.getElementById("extcal-root");
  if (!root) return;
  const tok = encodeURIComponent(getToken() || "");
  const connected = await spaceHasCapability("calendar");
  if (!connected) {
    root.innerHTML = `<div class="mkt-empty-state"><i class="ti ti-calendar" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>Google Calendar isn't connected.</div><a class="mkt-btn-teal" style="margin-top:10px;text-decoration:none" href="/auth/google/calendar"><i class="ti ti-plug" aria-hidden="true"></i> Connect Google Calendar</a></div>`;
    return;
  }
  let events = [];
  try {
    const r = await fetch(
      "/api/integrations/gcal/events?token=" +
        tok +
        "&time_min=" +
        encodeURIComponent(new Date().toISOString()),
    );
    if (r.ok) events = (await r.json()).events || [];
  } catch (e) {}
  if (!events.length) {
    root.innerHTML = `<div class="mkt-empty-state"><i class="ti ti-calendar" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>No upcoming events.</div></div>`;
    return;
  }
  root.innerHTML = events
    .slice(0, 15)
    .map((ev) => {
      const d = ev.start ? new Date(ev.start) : null;
      const when =
        d && !isNaN(d)
          ? d.toLocaleString("en-GB", {
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: ev.allDay ? undefined : "2-digit",
              minute: ev.allDay ? undefined : "2-digit",
            })
          : "";
      return `<div class="mkt-installed-row"><div class="mkt-item-icon" style="font-size:16px">📅</div><div style="flex:1"><div class="mkt-item-name">${mktEsc(ev.title)}</div><div class="mkt-item-author">${mktEsc(when)}${ev.allDay ? " · all day" : ""}</div></div>${ev.htmlLink ? `<a class="mkt-btn-ghost mkt-btn-sm" style="text-decoration:none" href="${mktEsc(safeUrl(ev.htmlLink))}" target="_blank">Open</a>` : ""}</div>`;
    })
    .join("");
}

/* ── Real extension: Kanban+ (self-contained per-space board) ── */
function extKbCols() {
  const d = extData(_extSpaceId(), "ext-kanban-plus");
  return d.cols || { todo: [], doing: [], done: [] };
}
function extKbShell(item) {
  return `<div class="ext-tab-shell" style="max-width:820px;align-items:stretch"><div style="text-align:center"><div class="ext-tab-icon">${item.icon}</div><div class="ext-tab-name">${mktEsc(item.name)}</div><div class="ext-tab-desc">${mktEsc(item.desc)}</div></div><div id="extkb-root" style="width:100%;margin-top:14px">${extKbInner()}</div></div>`;
}
function extKbInner() {
  const cols = extKbCols();
  const COL = [
    ["todo", "To do"],
    ["doing", "Doing"],
    ["done", "Done"],
  ];
  return `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">${COL.map(
    ([k, label]) => `
    <div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;min-height:160px">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--border)"><span style="font-size:12px;font-weight:700;color:var(--text)">${label}</span><span class="mkt-count-badge">${(cols[k] || []).length}</span></div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:6px;flex:1">${
        (cols[k] || [])
          .map(
            (c) => `
        <div style="background:var(--card);border:1px solid var(--border);border-radius:9px;padding:9px">
          <div style="font-size:12px;color:var(--text);margin-bottom:6px">${mktEsc(c.title)}</div>
          <div style="display:flex;gap:5px">${k !== "done" ? `<button class="mkt-btn-ghost mkt-btn-sm" data-onclick="extKbMove" data-onclick-arg0="${mktEsc(c.id)}">Move →</button>` : ""}<button class="mkt-btn-ghost mkt-btn-sm mkt-btn-danger" data-onclick="extKbDel" data-onclick-arg0="${mktEsc(c.id)}">✕</button></div>
        </div>`,
          )
          .join("") ||
        '<div class="mkt-brief-desc" style="padding:6px">No cards.</div>'
      }</div>
      <div style="padding:8px;border-top:1px solid var(--border)"><button class="mkt-btn-ghost mkt-btn-sm" style="width:100%" data-onclick="extKbAdd" data-onclick-arg0="${k}">+ Add</button></div>
    </div>`,
  ).join("")}</div>`;
}
function extKbRender() {
  const r = document.getElementById("extkb-root");
  if (r) r.innerHTML = extKbInner();
}
async function extKbAdd(col) {
  const title = await siModal.input("New card", "Card title", "", {
    confirmLabel: "Add",
  });
  if (!title) return;
  const sid = _extSpaceId();
  const cols = extKbCols();
  (cols[col] = cols[col] || []).push({ id: "k_" + Date.now(), title });
  extSave(sid, "ext-kanban-plus", { cols });
  extKbRender();
}
function extKbMove(id) {
  const order = ["todo", "doing", "done"];
  const sid = _extSpaceId();
  const cols = extKbCols();
  for (let i = 0; i < order.length - 1; i++) {
    const k = order[i],
      arr = cols[k] || [];
    const idx = arr.findIndex((c) => c.id === id);
    if (idx > -1) {
      const [card] = arr.splice(idx, 1);
      (cols[order[i + 1]] = cols[order[i + 1]] || []).push(card);
      break;
    }
  }
  extSave(sid, "ext-kanban-plus", { cols });
  extKbRender();
}
function extKbDel(id) {
  const sid = _extSpaceId();
  const cols = extKbCols();
  ["todo", "doing", "done"].forEach((k) => {
    cols[k] = (cols[k] || []).filter((c) => c.id !== id);
  });
  extSave(sid, "ext-kanban-plus", { cols });
  extKbRender();
}
/* ── Stage 4: Agency OS (Org extension) — clients · brief→delivery pipeline · revisions ── */
function extAgData() {
  const d = extData(_extSpaceId(), "ext-agency-os");
  return {
    clients: d.clients || [],
    pipeline: d.pipeline || { brief: [], doing: [], review: [], done: [] },
  };
}
function extAgSave(v) {
  extSave(_extSpaceId(), "ext-agency-os", v);
}
let _extAgSeg = "pipeline";
function extAgShell(item) {
  return `<div class="ext-tab-shell" style="max-width:900px;align-items:stretch"><div style="text-align:center"><div class="ext-tab-icon">${item.icon}</div><div class="ext-tab-name">${mktEsc(item.name)}</div><div class="ext-tab-desc">${mktEsc(item.desc)}</div></div><div id="extag-root" style="width:100%;margin-top:14px">${extAgInner()}</div></div>`;
}
function extAgInner() {
  const segs = [
    ["clients", "Clients"],
    ["pipeline", "Pipeline"],
    ["revisions", "Revisions"],
  ];
  const bar = `<div style="display:flex;gap:6px;justify-content:center;margin-bottom:14px">${segs.map(([k, l]) => `<button class="mkt-cat-pill ${_extAgSeg === k ? "active" : ""}" data-onclick="extAgSetSeg" data-onclick-arg0="${k}">${l}</button>`).join("")}</div>`;
  return (
    bar +
    (_extAgSeg === "clients"
      ? extAgClients()
      : _extAgSeg === "revisions"
        ? extAgRevisions()
        : extAgPipeline())
  );
}
function extAgRender() {
  const r = document.getElementById("extag-root");
  if (r) r.innerHTML = extAgInner();
}
function extAgSetSeg(s) {
  _extAgSeg = s;
  extAgRender();
}
function extAgClients() {
  const d = extAgData();
  const top = `<div style="display:flex;justify-content:center;margin-bottom:12px"><button class="mkt-btn-teal" data-onclick="extAgAddClient"><i class="ti ti-plus" aria-hidden="true"></i> Add client</button></div>`;
  if (!d.clients.length)
    return (
      top +
      `<div class="mkt-empty-state"><i class="ti ti-users" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>No clients yet.</div></div>`
    );
  return (
    top +
    d.clients
      .map(
        (c) =>
          `<div class="mkt-installed-row"><div style="flex:1"><div class="mkt-item-name">${mktEsc(c.name)}</div><div class="mkt-item-author">${mktEsc(c.status || "active")}</div></div><button class="mkt-btn-ghost mkt-btn-sm mkt-btn-danger" data-onclick="extAgDelClient" data-onclick-arg0="${mktEsc(c.id)}">Remove</button></div>`,
      )
      .join("")
  );
}
async function extAgAddClient() {
  const name = await siModal.input("New client", "Client / company name", "", {
    confirmLabel: "Add",
  });
  if (!name) return;
  const d = extAgData();
  d.clients.push({ id: "c_" + Date.now(), name, status: "active" });
  extAgSave(d);
  extAgRender();
}
function extAgDelClient(id) {
  const d = extAgData();
  d.clients = d.clients.filter((c) => c.id !== id);
  extAgSave(d);
  extAgRender();
}
function extAgPipeline() {
  const d = extAgData();
  const COL = [
    ["brief", "Brief"],
    ["doing", "In progress"],
    ["review", "Review"],
    ["done", "Delivered"],
  ];
  return `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">${COL.map(([k, label]) => `<div style="background:rgba(127,127,127,.05);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;min-height:150px"><div style="display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-bottom:1px solid var(--border)"><span style="font-size:11px;font-weight:700;color:var(--text)">${label}</span><span class="mkt-count-badge">${(d.pipeline[k] || []).length}</span></div><div style="padding:8px;display:flex;flex-direction:column;gap:6px;flex:1">${(d.pipeline[k] || []).map((c) => `<div style="background:var(--card);border:1px solid var(--border);border-radius:9px;padding:8px"><div style="font-size:11.5px;font-weight:600;color:var(--text);margin-bottom:3px">${mktEsc(c.title)}</div><div style="font-size:9.5px;color:var(--muted)">${mktEsc(c.client || "")}${c.revisions ? ` · ${c.revisions} rev` : ""}</div><div style="display:flex;gap:5px;margin-top:6px">${k !== "done" ? `<button class="mkt-btn-ghost mkt-btn-sm" data-onclick="extAgMove" data-onclick-arg0="${mktEsc(c.id)}">Move →</button>` : ""}<button class="mkt-btn-ghost mkt-btn-sm" data-onclick="extAgRev" data-onclick-arg0="${mktEsc(c.id)}" title="Log a revision">↻</button><button class="mkt-btn-ghost mkt-btn-sm mkt-btn-danger" data-onclick="extAgDel" data-onclick-arg0="${mktEsc(c.id)}">✕</button></div></div>`).join("") || '<div class="mkt-brief-desc" style="padding:6px">–</div>'}</div><div style="padding:8px;border-top:1px solid var(--border)"><button class="mkt-btn-ghost mkt-btn-sm" style="width:100%" data-onclick="extAgAddCard" data-onclick-arg0="${k}">+ Add</button></div></div>`).join("")}</div>`;
}
async function extAgAddCard(col) {
  const title = await siModal.input(
    "New project",
    "Project / brief title",
    "",
    { confirmLabel: "Add" },
  );
  if (!title) return;
  const d = extAgData();
  (d.pipeline[col] = d.pipeline[col] || []).push({
    id: "p_" + Date.now(),
    title,
    client: "",
    revisions: 0,
  });
  extAgSave(d);
  extAgRender();
}
function extAgMove(id) {
  const order = ["brief", "doing", "review", "done"];
  const d = extAgData();
  for (let i = 0; i < order.length - 1; i++) {
    const arr = d.pipeline[order[i]] || [];
    const idx = arr.findIndex((c) => c.id === id);
    if (idx > -1) {
      const [c] = arr.splice(idx, 1);
      (d.pipeline[order[i + 1]] = d.pipeline[order[i + 1]] || []).push(c);
      break;
    }
  }
  extAgSave(d);
  extAgRender();
}
function extAgRev(id) {
  const d = extAgData();
  ["brief", "doing", "review", "done"].forEach((k) =>
    (d.pipeline[k] || []).forEach((c) => {
      if (c.id === id) c.revisions = (c.revisions || 0) + 1;
    }),
  );
  extAgSave(d);
  extAgRender();
}
function extAgDel(id) {
  const d = extAgData();
  ["brief", "doing", "review", "done"].forEach(
    (k) => (d.pipeline[k] = (d.pipeline[k] || []).filter((c) => c.id !== id)),
  );
  extAgSave(d);
  extAgRender();
}
function extAgRevisions() {
  const d = extAgData();
  const all = [];
  ["brief", "doing", "review", "done"].forEach((k) =>
    (d.pipeline[k] || []).forEach((c) =>
      all.push(Object.assign({ col: k }, c)),
    ),
  );
  const withRev = all
    .filter((c) => (c.revisions || 0) > 0)
    .sort((a, b) => b.revisions - a.revisions);
  if (!withRev.length)
    return `<div class="mkt-empty-state"><i class="ti ti-refresh" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>No revisions logged yet. Use ↻ on a project card.</div></div>`;
  return (
    withRev
      .map(
        (c) =>
          `<div class="mkt-installed-row"><div style="flex:1"><div class="mkt-item-name">${mktEsc(c.title)}</div><div class="mkt-item-author">${mktEsc(c.client || c.col)}</div></div><span class="mkt-count-badge">${c.revisions} rev</span></div>`,
      )
      .join("") +
    `<div style="font-size:.7rem;color:var(--muted);margin-top:10px;opacity:.7">Invoices coming soon.</div>`
  );
}

/* ── Stage 7: Trading Journal (Personal extension) — trades · journal · risk · stats ──
   In-app core (per Hunter): manual + CSV entry, P&L/R tracking, position sizing,
   psychology journaling, win-rate/R:R stats + equity curve. External ingestion
   (MT5/MT4 EA, TradingView webhook, broker API) and WhatsApp reports are NOTED for
   later — they need external infra + the WhatsApp integration (currently a stub). */
function extTjData() {
  const d = extData(_extSpaceId(), "ext-trading-journal");
  return {
    trades: d.trades || [],
    settings: d.settings || { account: 1000, riskPct: 1 },
  };
}
function extTjSave(v) {
  extSave(_extSpaceId(), "ext-trading-journal", v);
}
let _extTjSeg = "trades";
const _tjNum = (v) => {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
};
// Derive R-multiple, P&L and outcome from a trade's prices/size.
function _tjDerive(t) {
  const entry = _tjNum(t.entry),
    exit = _tjNum(t.exit),
    stop = _tjNum(t.stop),
    size = _tjNum(t.size);
  const long = (t.dir || "long") === "long";
  let r = null,
    pnl = null;
  if (entry != null && exit != null) {
    const moveFor = long ? exit - entry : entry - exit;
    if (size != null) pnl = +(moveFor * size).toFixed(2);
    if (stop != null) {
      const risk = long ? entry - stop : stop - entry;
      if (risk > 0) r = +(moveFor / risk).toFixed(2);
    }
  }
  // Trades imported from a broker (e.g. MetaTrader) carry realized P&L directly
  // rather than entry/stop prices — honor it so stats and badges still work.
  if (pnl == null && _tjNum(t.pnlOverride) != null) pnl = _tjNum(t.pnlOverride);
  let outcome = "be";
  // R is the normalized truth; prefer it (small forex P&L can round to 0). Fall back to P&L.
  const basis = r != null ? r : pnl != null ? pnl : 0;
  if (basis > 0) outcome = "win";
  else if (basis < 0) outcome = "loss";
  return { r, pnl, outcome };
}
function extTjShell(item) {
  return `<div class="ext-tab-shell" style="max-width:900px;align-items:stretch"><div style="text-align:center"><div class="ext-tab-icon">${item.icon}</div><div class="ext-tab-name">${mktEsc(item.name)}</div><div class="ext-tab-desc">${mktEsc(item.desc)}</div></div><div id="exttj-root" style="width:100%;margin-top:14px">${extTjInner()}</div></div>`;
}
function extTjInner() {
  const segs = [
    ["live", "Live"],
    ["trades", "Trades"],
    ["journal", "Journal"],
    ["risk", "Risk"],
    ["stats", "Stats"],
  ];
  const liveDot = _MT_CONNECTED
    ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green,#16a34a);margin-left:4px;vertical-align:middle"></span>'
    : "";
  const bar = `<div style="display:flex;gap:6px;justify-content:center;margin-bottom:14px;flex-wrap:wrap">${segs.map(([k, l]) => `<button class="mkt-cat-pill ${_extTjSeg === k ? "active" : ""}" data-onclick="extTjSetSeg" data-onclick-arg0="${k}">${l}${k === "live" ? liveDot : ""}</button>`).join("")}</div>`;
  const body =
    _extTjSeg === "live"
      ? extTjLive()
      : _extTjSeg === "journal"
        ? extTjJournal()
        : _extTjSeg === "risk"
          ? extTjRisk()
          : _extTjSeg === "stats"
            ? extTjStats()
            : extTjTrades();
  return bar + body;
}
function extTjRender() {
  const r = document.getElementById("exttj-root");
  if (r) r.innerHTML = extTjInner();
}
function extTjSetSeg(s) {
  _extTjSeg = s;
  extTjRender();
  // Refresh live data on demand when the user opens the Live tab.
  if (s === "live" && _MT_CONNECTED && typeof mtLoadAccount === "function")
    mtLoadAccount();
}
function _tjRBadge(t) {
  const d = _tjDerive(t);
  const col =
    d.outcome === "win"
      ? "var(--green,#16a34a)"
      : d.outcome === "loss"
        ? "var(--red,#dc2626)"
        : "var(--muted)";
  const arrow = (t.dir || "long") === "long" ? "↑" : "↓";
  const rTxt =
    d.r != null
      ? `${d.r > 0 ? "+" : ""}${d.r}R`
      : d.pnl != null
        ? `${d.pnl > 0 ? "+" : ""}${d.pnl}`
        : "–";
  return { col, arrow, rTxt, d };
}
function extTjTrades() {
  const d = extTjData();
  const top = `<div style="display:flex;gap:8px;justify-content:center;margin-bottom:12px;flex-wrap:wrap"><button class="mkt-btn-teal" data-onclick="extTjAddTrade"><i class="ti ti-plus" aria-hidden="true"></i> Add trade</button><button class="mkt-btn-ghost" data-onclick="extTjImport"><i class="ti ti-upload" aria-hidden="true"></i> Import CSV</button></div>`;
  if (!d.trades.length)
    return (
      top +
      `<div class="mkt-empty-state"><i class="ti ti-chart-candle" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>No trades yet. Add your first or import a CSV.</div></div>`
    );
  const rows = d.trades
    .slice()
    .reverse()
    .map((t) => {
      const b = _tjRBadge(t);
      return `<div class="mkt-installed-row"><div style="flex:1"><div class="mkt-item-name">${b.arrow} ${mktEsc(t.symbol || "–")} <span style="font-size:9.5px;color:var(--muted);font-weight:500">${mktEsc(t.dir || "long")}</span></div><div class="mkt-item-author">${mktEsc(t.date || "")}${t.emotion ? " · " + mktEsc(t.emotion) : ""}</div></div><span style="font-weight:700;font-size:12px;color:${b.col};margin-right:10px">${b.rTxt}</span><button class="mkt-btn-ghost mkt-btn-sm mkt-btn-danger" data-onclick="extTjDel" data-onclick-arg0="${mktEsc(t.id)}">✕</button></div>`;
    })
    .join("");
  return top + rows;
}
async function extTjAddTrade() {
  const f = await siModal.form(
    "Log a trade",
    [
      {
        id: "symbol",
        label: "Symbol",
        placeholder: "e.g. EURUSD, BTCUSD",
        required: true,
      },
      {
        id: "dir",
        label: "Direction",
        type: "select",
        options: [
          { value: "long", label: "Long" },
          { value: "short", label: "Short" },
        ],
        default: "long",
      },
      {
        id: "entry",
        label: "Entry price",
        type: "number",
        placeholder: "e.g. 1.1000",
      },
      {
        id: "exit",
        label: "Exit price",
        type: "number",
        placeholder: "e.g. 1.1050",
      },
      {
        id: "stop",
        label: "Stop price (for R-multiple)",
        type: "number",
        placeholder: "optional",
      },
      {
        id: "size",
        label: "Size / units / lots",
        type: "number",
        placeholder: "optional (for P&L)",
      },
      {
        id: "emotion",
        label: "Emotion / psychology",
        placeholder: "e.g. confident, FOMO, revenge",
      },
      { id: "date", label: "Date", type: "date" },
      {
        id: "notes",
        label: "Notes / thesis / lesson",
        type: "textarea",
        placeholder: "What was the setup? What did you learn?",
      },
    ],
    { confirmLabel: "Save trade" },
  );
  if (!f || !f.symbol) return;
  const d = extTjData();
  d.trades.push({
    id: "t_" + Date.now(),
    symbol: f.symbol.toUpperCase(),
    dir: f.dir || "long",
    entry: f.entry || "",
    exit: f.exit || "",
    stop: f.stop || "",
    size: f.size || "",
    emotion: f.emotion || "",
    date: f.date || new Date().toISOString().slice(0, 10),
    notes: f.notes || "",
  });
  extTjSave(d);
  extTjRender();
}
function extTjDel(id) {
  const d = extTjData();
  d.trades = d.trades.filter((t) => t.id !== id);
  extTjSave(d);
  extTjRender();
}
async function extTjImport() {
  const csv = await siModal.input(
    "Import trades (CSV)",
    "symbol,dir,entry,exit,stop,size,emotion,date",
    "",
    {
      type: "text",
      confirmLabel: "Import",
      description:
        "Paste one trade per line: symbol,dir,entry,exit,stop,size,emotion,date. Only symbol is required.",
    },
  );
  // input() is single-line; accept comma rows separated by " ; " too. For multi-line use the textarea form.
  if (!csv) return;
  const lines = csv
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return;
  const d = extTjData();
  let n = 0;
  lines.forEach((line) => {
    const c = line.split(",").map((s) => s.trim());
    if (!c[0]) return;
    d.trades.push({
      id: "t_" + Date.now() + "_" + n++,
      symbol: c[0].toUpperCase(),
      dir: (c[1] || "long").toLowerCase() === "short" ? "short" : "long",
      entry: c[2] || "",
      exit: c[3] || "",
      stop: c[4] || "",
      size: c[5] || "",
      emotion: c[6] || "",
      date: c[7] || new Date().toISOString().slice(0, 10),
      notes: "",
    });
  });
  extTjSave(d);
  extTjRender();
  if (typeof toast === "function")
    toast(`${n} trade${n !== 1 ? "s" : ""} imported`);
}
function extTjJournal() {
  const d = extTjData();
  const journaled = d.trades.filter(
    (t) => (t.notes && t.notes.trim()) || (t.emotion && t.emotion.trim()),
  );
  // Emotion frequency summary
  const freq = {};
  d.trades.forEach((t) => {
    const e = (t.emotion || "").trim().toLowerCase();
    if (e) freq[e] = (freq[e] || 0) + 1;
  });
  const chips = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([e, n]) =>
        `<span class="mkt-cat-pill" style="cursor:default">${mktEsc(e)} · ${n}</span>`,
    )
    .join("");
  const head = chips
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:14px">${chips}</div>`
    : "";
  if (!journaled.length)
    return (
      head +
      `<div class="mkt-empty-state"><i class="ti ti-notebook" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>No journal entries yet. Add notes or an emotion when logging a trade.</div></div>`
    );
  return (
    head +
    journaled
      .slice()
      .reverse()
      .map((t) => {
        const b = _tjRBadge(t);
        return `<div class="mkt-installed-row" style="align-items:flex-start"><div style="flex:1"><div class="mkt-item-name">${mktEsc(t.symbol || "–")} <span style="color:${b.col};font-weight:700">${b.rTxt}</span></div>${t.emotion ? `<div class="mkt-item-author">${mktEsc(t.emotion)}</div>` : ""}${t.notes ? `<div class="mkt-brief-desc" style="margin-top:4px">${mktEsc(t.notes)}</div>` : ""}</div><span style="font-size:9.5px;color:var(--muted)">${mktEsc(t.date || "")}</span></div>`;
      })
      .join("")
  );
}
function extTjRisk() {
  const d = extTjData();
  const s = d.settings;
  return `<div class="mkt-card" style="max-width:420px;margin:0 auto;padding:16px">
    <div class="mkt-item-name" style="margin-bottom:4px">Position-size calculator</div>
    <div class="mkt-brief-desc" style="margin-bottom:12px">Risk a fixed % per trade. Position size = (account × risk%) ÷ price distance to stop.</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <label class="si-modal-label">Account balance</label><input id="tj-acct" class="si-modal-input" type="number" value="${mktEsc(String(s.account))}">
      <label class="si-modal-label">Risk per trade (%)</label><input id="tj-risk" class="si-modal-input" type="number" value="${mktEsc(String(s.riskPct))}">
      <label class="si-modal-label">Entry price</label><input id="tj-entry" class="si-modal-input" type="number" placeholder="e.g. 1.1000">
      <label class="si-modal-label">Stop price</label><input id="tj-stop" class="si-modal-input" type="number" placeholder="e.g. 1.0980">
    </div>
    <button class="mkt-btn-teal" style="width:100%;margin-top:12px" data-onclick="extTjCalc">Calculate</button>
    <div id="tj-calc-result" style="margin-top:12px"></div>
  </div>`;
}
function extTjCalc() {
  const acct = _tjNum((document.getElementById("tj-acct") || {}).value);
  const riskPct = _tjNum((document.getElementById("tj-risk") || {}).value);
  const entry = _tjNum((document.getElementById("tj-entry") || {}).value);
  const stop = _tjNum((document.getElementById("tj-stop") || {}).value);
  const out = document.getElementById("tj-calc-result");
  if (acct == null || riskPct == null) {
    if (out)
      out.innerHTML = `<div class="mkt-brief-desc" style="color:var(--red,#dc2626)">Enter account balance and risk %.</div>`;
    return;
  }
  // Persist account/risk defaults
  const d = extTjData();
  d.settings = { account: acct, riskPct };
  extTjSave(d);
  const riskAmt = +((acct * riskPct) / 100).toFixed(2);
  let sizeLine = "";
  if (entry != null && stop != null && Math.abs(entry - stop) > 0) {
    const dist = Math.abs(entry - stop);
    const size = +(riskAmt / dist).toFixed(2);
    sizeLine = `<div class="mkt-installed-row"><div style="flex:1" class="mkt-item-name">Position size</div><span style="font-weight:700">${size} units</span></div><div class="mkt-installed-row"><div style="flex:1" class="mkt-item-name">Stop distance</div><span>${+dist.toFixed(5)}</span></div>`;
  } else {
    sizeLine = `<div class="mkt-brief-desc">Add entry + stop to get a position size.</div>`;
  }
  if (out)
    out.innerHTML = `<div class="mkt-installed-row"><div style="flex:1" class="mkt-item-name">Risk amount</div><span style="font-weight:700">${riskAmt}</span></div>${sizeLine}`;
}
function extTjStats() {
  const d = extTjData();
  const ts = d.trades.map((t) => Object.assign({}, t, _tjDerive(t)));
  const n = ts.length;
  if (!n)
    return `<div class="mkt-empty-state"><i class="ti ti-chart-bar" style="font-size:28px;opacity:.2" aria-hidden="true"></i><div>No stats yet. Log some trades.</div></div>`;
  const wins = ts.filter((t) => t.outcome === "win").length;
  const losses = ts.filter((t) => t.outcome === "loss").length;
  const decided = wins + losses;
  const winRate = decided ? Math.round((wins / decided) * 100) : 0;
  const rVals = ts.filter((t) => t.r != null).map((t) => t.r);
  const totalR = rVals.reduce((a, b) => a + b, 0);
  const avgR = rVals.length ? +(totalR / rVals.length).toFixed(2) : null;
  const pnlVals = ts.filter((t) => t.pnl != null).map((t) => t.pnl);
  const totalPnl = pnlVals.reduce((a, b) => a + b, 0);
  const stat = (label, val) =>
    `<div style="flex:1;min-width:90px;background:rgba(127,127,127,.05);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center"><div style="font-size:18px;font-weight:700;color:var(--text)">${val}</div><div style="font-size:10px;color:var(--muted);margin-top:2px">${label}</div></div>`;
  const grid = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">${stat("Trades", n)}${stat("Win rate", winRate + "%")}${stat("Avg R", avgR != null ? avgR : "–")}${stat("Total R", rVals.length ? (totalR > 0 ? "+" : "") + +totalR.toFixed(2) : "–")}${stat("Net P&L", pnlVals.length ? (totalPnl > 0 ? "+" : "") + +totalPnl.toFixed(2) : "–")}</div>`;
  // Equity curve from cumulative R (chronological)
  let curve = "";
  if (rVals.length > 1) {
    let cum = 0;
    const pts = ts.filter((t) => t.r != null).map((t) => (cum += t.r));
    const min = Math.min(0, ...pts),
      max = Math.max(0, ...pts),
      range = max - min || 1;
    const W = 320,
      H = 90,
      step = W / (pts.length - 1);
    const coords = pts
      .map(
        (p, i) =>
          `${(i * step).toFixed(1)},${(H - ((p - min) / range) * H).toFixed(1)}`,
      )
      .join(" ");
    const zeroY = (H - ((0 - min) / range) * H).toFixed(1);
    curve = `<div class="mkt-item-name" style="margin-bottom:6px">Equity curve (cumulative R)</div><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:90px;overflow:visible"><line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--border)" stroke-dasharray="3 3"/><polyline points="${coords}" fill="none" stroke="var(--teal,#0ea5a4)" stroke-width="2"/></svg>`;
  }
  return grid + curve;
}

// ── Live tab: pull the connected MetaTrader account and visualize it ──
function _tjMoney(v, cur) {
  const n = parseFloat(v);
  if (!isFinite(n)) return "–";
  const s =
    (n > 0 ? "+" : "") +
    n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  return cur ? `${s} ${cur}` : s;
}
function extTjLive() {
  // Not configured / not connected → connect prompt.
  if (!_MT_CONNECTED) {
    return `<div class="mkt-card" style="max-width:440px;margin:0 auto;padding:20px;text-align:center">
      <div style="font-size:30px">📈</div>
      <div class="mkt-item-name" style="margin:6px 0 4px">Connect MetaTrader</div>
      <div class="mkt-brief-desc" style="margin-bottom:14px">Link your MT4/MT5 account to see your live balance, equity, open positions and trade history, and import closed trades straight into this journal.</div>
      <button class="mkt-btn-teal" data-onclick="mtConnect"><i class="ti ti-plug-connected" aria-hidden="true"></i> Connect MetaTrader</button>
    </div>`;
  }
  const a = _MT_ACCOUNT;
  // Connected but still deploying/syncing on MetaApi's side.
  if (!a || a.state === "pending") {
    return `<div class="mkt-empty-state"><i class="ti ti-loader-2 ps-spin" style="font-size:26px;opacity:.35" aria-hidden="true"></i>
      <div>Syncing ${mktEsc(_MT_STATUS.login || "your account")} (${(_MT_STATUS.platform || "mt5").toUpperCase()})…</div>
      <div class="mkt-brief-desc" style="margin-top:4px">MetaApi is connecting to your broker. This can take a minute on first link.</div>
      <button class="mkt-btn-ghost mkt-btn-sm" style="margin-top:10px" data-onclick="mtLoadAccount">Refresh</button></div>`;
  }
  const info = a.info || {};
  const cur = info.currency || "";
  const positions = a.positions || [];
  const deals = (a.deals || []).filter((d) => d.entry === "out"); // closed legs carry the realized P&L

  // ── Account summary tiles ──
  const stat = (label, val, color) =>
    `<div style="flex:1;min-width:96px;background:rgba(127,127,127,.05);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center"><div style="font-size:16px;font-weight:700;color:${color || "var(--text)"}">${val}</div><div style="font-size:10px;color:var(--muted);margin-top:2px">${label}</div></div>`;
  const equityCol =
    parseFloat(info.equity) >= parseFloat(info.balance)
      ? "var(--green,#16a34a)"
      : "var(--red,#dc2626)";
  const tiles = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
    ${stat("Balance", `${(+info.balance || 0).toLocaleString()} ${cur}`)}
    ${stat("Equity", `${(+info.equity || 0).toLocaleString()} ${cur}`, equityCol)}
    ${stat("Free margin", `${(+info.freeMargin || 0).toLocaleString()}`)}
    ${stat("Leverage", info.leverage ? `1:${info.leverage}` : "–")}
  </div>`;

  // ── Header row: who / refresh / import ──
  const head = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
    <div><span class="mkt-item-name">${mktEsc(info.name || _MT_STATUS.login || "Account")}</span>
      <span class="mkt-item-author">${mktEsc(_MT_STATUS.server || "")} · ${(_MT_STATUS.platform || "mt5").toUpperCase()}</span></div>
    <div style="display:flex;gap:6px">
      <button class="mkt-btn-ghost mkt-btn-sm" data-onclick="mtLoadAccount"><i class="ti ti-refresh" aria-hidden="true"></i></button>
      <button class="mkt-btn-teal mkt-btn-sm" data-onclick="extTjImportLive"${deals.length ? "" : " disabled"}><i class="ti ti-download" aria-hidden="true"></i> Import ${deals.length} closed</button>
    </div></div>`;

  // ── Open positions ──
  let posHtml = `<div class="mkt-item-name" style="margin:14px 0 6px">Open positions (${positions.length})</div>`;
  if (!positions.length) {
    posHtml += `<div class="mkt-brief-desc">No open positions right now.</div>`;
  } else {
    posHtml += positions
      .map((p) => {
        const col =
          +p.profit >= 0 ? "var(--green,#16a34a)" : "var(--red,#dc2626)";
        const arrow = p.type === "buy" ? "↑" : "↓";
        return `<div class="mkt-installed-row"><div style="flex:1"><div class="mkt-item-name">${arrow} ${mktEsc(p.symbol)} <span style="font-size:9.5px;color:var(--muted);font-weight:500">${mktEsc(p.type)} ${mktEsc(String(p.volume))}</span></div><div class="mkt-item-author">@ ${mktEsc(String(p.openPrice))} → ${mktEsc(String(p.current))}</div></div><span style="font-weight:700;font-size:12px;color:${col}">${_tjMoney(p.profit, cur)}</span></div>`;
      })
      .join("");
  }

  // ── Realized P&L curve from closed deals (chronological) ──
  let curve = "";
  if (deals.length > 1) {
    const sorted = deals
      .slice()
      .sort((x, y) => new Date(x.time) - new Date(y.time));
    let cum = 0;
    const pts = sorted.map(
      (d) => (cum += (+d.profit || 0) + (+d.swap || 0) + (+d.commission || 0)),
    );
    const min = Math.min(0, ...pts),
      max = Math.max(0, ...pts),
      range = max - min || 1;
    const W = 320,
      H = 90,
      step = W / (pts.length - 1);
    const coords = pts
      .map(
        (p, i) =>
          `${(i * step).toFixed(1)},${(H - ((p - min) / range) * H).toFixed(1)}`,
      )
      .join(" ");
    const zeroY = (H - ((0 - min) / range) * H).toFixed(1);
    const endCol = cum >= 0 ? "var(--green,#16a34a)" : "var(--red,#dc2626)";
    curve = `<div class="mkt-item-name" style="margin:14px 0 6px">Realized P&L (${deals.length} closed · ${_tjMoney(cum, cur)})</div><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:90px;overflow:visible"><line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--border)" stroke-dasharray="3 3"/><polyline points="${coords}" fill="none" stroke="${endCol}" stroke-width="2"/></svg>`;
  }

  return head + tiles + curve + posHtml;
}

// Import the connected account's closed deals into the local journal (dedupe by deal id).
function extTjImportLive() {
  const a = _MT_ACCOUNT;
  if (!a || !a.deals) {
    toast("No live trades to import yet.");
    return;
  }
  const closed = a.deals.filter((d) => d.entry === "out");
  if (!closed.length) {
    toast("No closed trades in range.");
    return;
  }
  const d = extTjData();
  const have = new Set(d.trades.map((t) => t.mtId).filter(Boolean));
  let n = 0;
  closed.forEach((deal) => {
    const key = "mt_" + (deal.id || `${deal.symbol}_${deal.time}`);
    if (have.has(key)) return;
    const pnl =
      (+deal.profit || 0) + (+deal.swap || 0) + (+deal.commission || 0);
    d.trades.push({
      id: "t_" + Date.now() + "_" + n++,
      mtId: key,
      symbol: (deal.symbol || "").toUpperCase(),
      // A closing deal of a SELL position closes a long entry, and vice-versa.
      dir: deal.type === "sell" ? "long" : "short",
      entry: "",
      exit: String(deal.price || ""),
      stop: "",
      size: String(deal.volume || ""),
      pnlOverride: +pnl.toFixed(2),
      emotion: "",
      date:
        (deal.time || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
      notes: "Imported from MetaTrader",
    });
  });
  extTjSave(d);
  toast(
    n
      ? `${n} trade${n !== 1 ? "s" : ""} imported from MetaTrader`
      : "Already up to date, no new trades.",
  );
  if (n) {
    _extTjSeg = "trades";
    extTjRender();
  }
}

/* ── Stage 4: Org "Add Extension" entry + post-install onboarding checklist ── */

function extShowOnboarding(item) {
  const m = document.getElementById("mktDetailModal");
  const c = document.getElementById("mktDetailContent");
  if (!m || !c) {
    mktToast(
      `${item.name} installed. Enable it in any space via ⋮ → Settings & extensions`,
    );
    return;
  }
  if (typeof mktCurrentItem !== "undefined") mktCurrentItem = item;
  document.getElementById("mktDetailIcon").textContent = item.icon || "🧩";
  document.getElementById("mktDetailName").textContent =
    `${item.name} installed`;
  document.getElementById("mktDetailAuthor").textContent = "Get started";
  document.getElementById("mktDetailMeta").innerHTML = "";
  document.getElementById("mktDetailActions").innerHTML =
    `<button class="mkt-install-btn mkt-btn-lg" data-onclick="mktCloseDetail">Done</button>`;
  c.innerHTML = `<div class="mkt-reviews-section"><div class="mkt-section-label" style="margin-bottom:8px">Set up ${mktEsc(item.name)}</div>
    <div class="mkt-onboard-step">✅ Installed</div>
    <div class="mkt-onboard-step">▢ <strong>Enable it in a space</strong>: open any space → ⋮ → <em>Settings &amp; extensions</em> → toggle ${mktEsc(item.name)} on.</div>
    <div class="mkt-onboard-step">▢ <strong>Open the space</strong>: a new <em>${mktEsc(item.name)}</em> tab appears in that space.</div>
    <div style="margin-top:12px"><button class="mkt-btn-teal" data-onclick="_mktCloseDetailThenAddOrgExt">Enable in my Org</button></div></div>`;
  m.style.display = "flex";
}
