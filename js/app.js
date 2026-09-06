// ═══════════════════════ SESSION TOKEN (in-memory) ═══════════
// The session token is held in memory ONLY — never persisted to localStorage.
// This removes the long-lived, JS-readable credential that an XSS could exfiltrate.
// Across reloads the token is gone from JS, but the httpOnly `sivarr_session`
// cookie (sent automatically same-origin) re-authenticates every request; the
// backend _BearerTokenMiddleware falls back to that cookie when no token is sent.
// getToken() intentionally returns '' (never null) so `?token=` stays empty and
// the server cleanly falls back to the cookie.
let _MEM_TOKEN = "";
function getToken() {
  return _MEM_TOKEN || "";
}
function setToken(t) {
  _MEM_TOKEN = t || "";
}
// One-time cleanup for returning users: purge any token persisted by a
// pre-cookie-auth build so it stops sitting in localStorage as an XSS-readable
// credential. The app no longer reads it (auth rides the httpOnly cookie).
try {
  localStorage.removeItem("sivarr_token");
} catch (e) {}

// ═══════════════════════ AUTH TRANSPORT ══════════════════════
// Send the session token in the Authorization header, never in the URL. This
// rewrites every same-origin /api/ fetch: any `?token=` is stripped from the URL
// and moved to `Authorization: Bearer <token>` (backend accepts it transparently).
// Stops token leakage into server/proxy logs, browser history, and Referer headers.
// NOTE: EventSource (SSE) can't set headers, so those streams now authenticate
// via the httpOnly session cookie (P3b) — no token in the URL either.
(function () {
  const _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string" && input.includes("/api/")) {
        const u = new URL(input, location.origin);
        const tok = getToken() || u.searchParams.get("token") || "";
        if (u.searchParams.has("token")) u.searchParams.delete("token");
        init = init || {};
        const headers = new Headers(init.headers || {});
        if (tok && !headers.has("Authorization"))
          headers.set("Authorization", "Bearer " + tok);
        // CSRF double-submit: echo the sivarr_csrf cookie as X-CSRF-Token on state-mutating
        // requests so the backend middleware can validate it (belt-and-suspenders with SameSite=Lax).
        const method = (init.method || "GET").toUpperCase();
        if (
          ["POST", "PUT", "DELETE", "PATCH"].includes(method) &&
          !headers.has("X-CSRF-Token")
        ) {
          const m = document.cookie.match(/(?:^|;\s*)sivarr_csrf=([^;]+)/);
          if (m) headers.set("X-CSRF-Token", decodeURIComponent(m[1]));
        }
        init.headers = headers;
        return _origFetch(u.pathname + u.search + u.hash, init);
      }
    } catch (_) {
      /* fall through to a normal fetch */
    }
    return _origFetch(input, init);
  };
})();

// ═══════════════════════════ STATE ═══════════════════════════
const S = {
  sid: null,
  name: "",
  email: "",
  diff: "medium",
  topics: [],
  weak: [],
  quizActive: false,
  quizQ: 0,
  quizScore: 0,
  curQ: null,
  wrongAnswers: [],
  stats: { questions: 0, quizzes: 0, sessions: 1, wrong: 0 },
};

const API = async (url, body) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const j = await r.json();
      detail = j.detail || detail;
    } catch {
      try {
        detail = (await r.text()) || detail;
      } catch {}
    }
    const err = new Error(detail);
    err.status = r.status;
    if (r.status === 429) {
      const retryAfter = r.headers.get("Retry-After");
      err.retryAfter = retryAfter ? parseInt(retryAfter) : 60;
    }
    throw err;
  }
  return r.json();
};

function track(event, props = {}) {
  if (window.plausible) window.plausible(event, { props });
}

// esc / escHtml / $ / toast now live in js/core/dom.js, which loads before this
// file and before js/features/*.js. See that file's header for why.

// ═══════════════════════ SKELETON LOADING ════════════════════
// HTML templates for shimmer placeholders shown while async data loads.
// Each render function (glRender, annRender, etc.) overwrites the container
// with real content, so no explicit "hide" step is needed.
const _SK = {
  goal: () => `<div class="sk-goal">
    <div class="sk sk-title"></div>
    <div class="sk sk-sub"></div>
    <div class="sk sk-bar"></div>
    <div class="sk sk-meta"></div>
  </div>`,

  post: () => `<div class="sk-post">
    <div class="sk-row" style="margin-bottom:10px">
      <div class="sk sk-avatar"></div>
      <div class="sk-col" style="flex:1">
        <div class="sk sk-name"></div>
        <div class="sk sk-time"></div>
      </div>
    </div>
    <div class="sk sk-body1"></div>
    <div class="sk sk-body2"></div>
    <div class="sk sk-body3"></div>
  </div>`,

  ann: () => `<div class="sk-ann">
    <div class="sk sk-atitle"></div>
    <div class="sk sk-abody1"></div>
    <div class="sk sk-abody2"></div>
  </div>`,

  task: () => `<div class="sk-task">
    <div class="sk sk-check"></div>
    <div class="sk sk-label"></div>
    <div class="sk sk-tag"></div>
  </div>`,

  habit: () => `<div class="sk-habit">
    <div class="sk sk-icon"></div>
    <div class="sk sk-hname"></div>
    <div class="sk-dots">
      ${'<div class="sk sk-dot"></div>'.repeat(7)}
    </div>
  </div>`,

  calHour: (hasEvent) => `<div class="sk-cal-hour${hasEvent ? "" : " empty"}">
    <div class="sk sk-time"></div>
    <div class="sk sk-event"></div>
  </div>`,

  orgPanel: () => `<div class="sk-org-wrap">
    <div class="sk-org-hero">
      <div class="sk sk-logo"></div>
      <div class="sk-hero-info" style="flex:1;display:flex;flex-direction:column;gap:7px">
        <div class="sk sk-hero-name" style="height:18px;width:48%"></div>
        <div class="sk sk-hero-meta" style="height:11px;width:30%;opacity:.55"></div>
      </div>
      <div class="sk-hero-btns" style="display:flex;gap:8px">
        <div class="sk sk-btn" style="height:32px;width:90px;border-radius:8px"></div>
        <div class="sk sk-btn" style="height:32px;width:90px;border-radius:8px;opacity:.6"></div>
      </div>
    </div>
    <div class="sk-org-tabs">
      ${["Overview", "Tasks", "Goals", "Members", "Projects"]
        .map(
          (t) =>
            `<div class="sk sk-org-tab" style="width:${52 + t.length * 4}px"></div>`,
        )
        .join("")}
    </div>
    <div class="sk-stat-row">
      ${Array(5)
        .fill(0)
        .map(
          () => `
        <div class="sk-stat">
          <div class="sk sk-val"></div>
          <div class="sk sk-lbl"></div>
        </div>`,
        )
        .join("")}
    </div>
    <div class="sk-os-grid2">
      ${Array(2)
        .fill(0)
        .map(
          () => `
        <div class="sk-os-card">
          <div class="sk sk-os-row" style="height:12px;width:45%;margin-bottom:6px"></div>
          <div class="sk sk-os-row"></div>
          <div class="sk sk-os-row mid"></div>
          <div class="sk sk-os-row short"></div>
        </div>`,
        )
        .join("")}
    </div>
    <div class="sk-os-grid2" style="margin-top:0">
      ${Array(2)
        .fill(0)
        .map(
          () => `
        <div class="sk-os-card">
          <div class="sk sk-os-row" style="height:12px;width:45%;margin-bottom:6px"></div>
          ${Array(3)
            .fill(0)
            .map(
              (_, i) => `
            <div class="sk-mem" style="padding:6px 0;border-bottom:1px solid var(--border)">
              <div class="sk sk-av" style="width:26px;height:26px;border-radius:50%;flex-shrink:0"></div>
              <div class="sk sk-mn" style="height:10px;flex:1"></div>
            </div>`,
            )
            .join("")}
        </div>`,
        )
        .join("")}
    </div>
  </div>`,
};

function skShow(containerId, tplFn, count = 3) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = Array.from({ length: count }, tplFn).join("");
}
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// UNIVERSAL DIALOG MODAL  (siModal)
// Async promise-based replacement for all browser prompt/confirm/alert calls.
// Usage:
//   const name = await siModal.input('Add Habit', 'Habit name…');
//   if (!await siModal.confirm('Delete?', {danger:true})) return;
//   await siModal.alert('Something went wrong.');
//   const data = await siModal.form('New Event', [{id:'title',label:'Title',…}]);
// ═══════════════════════════════════════════════════════════════
const siModal = (() => {
  let _res = null;

  function _show(html) {
    return new Promise((resolve) => {
      _res = resolve;
      const overlay = $("si-modal-overlay");
      const box = $("si-modal-box");
      if (!overlay || !box) {
        resolve(null);
        return;
      }
      box.innerHTML = html;
      overlay.classList.add("open");
      const first = box.querySelector("input,textarea,select");
      if (first) setTimeout(() => first.focus(), 60);
    });
  }

  function _done(val) {
    const o = $("si-modal-overlay");
    if (o) o.classList.remove("open");
    if (_res) {
      _res(val);
      _res = null;
    }
  }

  function _bgClose(e) {
    if (e.target === $("si-modal-overlay")) _done(null);
  }

  document.addEventListener("keydown", (e) => {
    const o = $("si-modal-overlay");
    if (!o || !o.classList.contains("open")) return;
    if (e.key === "Escape") {
      _done(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && e.target.tagName !== "TEXTAREA") {
      const btn = o.querySelector(".si-modal-btn-primary");
      if (btn) {
        e.preventDefault();
        btn.click();
      }
    }
  });

  // ── input ──────────────────────────────────────────────────
  function input(title, placeholder = "", defaultVal = "", opts = {}) {
    const { description = "", confirmLabel = "Confirm", type = "text" } = opts;
    return _show(`
      <div class="si-modal-hd">
        <span class="si-modal-title">${title}</span>
        <button class="si-modal-x" data-onclick="siModalDone" data-onclick-args="[null]"><i class="ti ti-x"></i></button>
      </div>
      ${description ? `<div class="si-modal-desc">${description}</div>` : ""}
      <div class="si-modal-body">
        <input id="si-m-inp" class="si-modal-input" type="${type}"
          placeholder="${placeholder}" value="${esc(defaultVal)}" autocomplete="off">
      </div>
      <div class="si-modal-ft">
        <button class="si-modal-btn si-modal-btn-cancel" data-onclick="siModalDone" data-onclick-args="[null]">Cancel</button>
        <button class="si-modal-btn si-modal-btn-primary" data-onclick="siModalSubInput">${confirmLabel}</button>
      </div>`);
  }
  function _subInput() {
    const v = ($("si-m-inp") || {}).value?.trim() || "";
    _done(v || null);
  }

  // ── confirm ────────────────────────────────────────────────
  function confirm(message, opts = {}) {
    const {
      title = "Confirm",
      confirmLabel = "Confirm",
      danger = false,
    } = opts;
    return _show(`
      <div class="si-modal-hd">
        <span class="si-modal-title">${title}</span>
        <button class="si-modal-x" data-onclick="siModalDone" data-onclick-args="[false]"><i class="ti ti-x"></i></button>
      </div>
      <div class="si-modal-confirm-body">
        <p class="si-modal-confirm-msg">${message}</p>
      </div>
      <div class="si-modal-ft">
        <button class="si-modal-btn si-modal-btn-cancel" data-onclick="siModalDone" data-onclick-args="[false]">Cancel</button>
        <button class="si-modal-btn si-modal-btn-primary${danger ? " danger" : ""}"
          data-onclick="siModalDone" data-onclick-args="[true]">${confirmLabel}</button>
      </div>`);
  }

  // ── confirmTyped (GitHub-style "type the name to confirm") ──
  // expectedText is never embedded into any inline JS attribute (only
  // esc()'d into HTML text/attribute content) -- it's kept in a
  // closure-scoped variable and compared inside _checkTyped(), so a name
  // containing a quote can't break out of an inline handler string.
  let _typedExpected = "";
  function confirmTyped(message, expectedText, opts = {}) {
    const {
      title = "Confirm",
      confirmLabel = "Delete",
      danger = true,
    } = opts;
    _typedExpected = expectedText;
    return _show(`
      <div class="si-modal-hd">
        <span class="si-modal-title">${title}</span>
        <button class="si-modal-x" data-onclick="siModalDone" data-onclick-args="[false]"><i class="ti ti-x"></i></button>
      </div>
      <div class="si-modal-confirm-body">
        <p class="si-modal-confirm-msg">${message}</p>
        <p class="si-modal-confirm-msg" style="margin-top:10px;font-size:.82rem">
          Type <strong>${esc(expectedText)}</strong> to confirm.
        </p>
        <input id="si-m-typed" class="si-modal-input" type="text" autocomplete="off"
          placeholder="${esc(expectedText)}" data-oninput="siModalCheckTyped">
      </div>
      <div class="si-modal-ft">
        <button class="si-modal-btn si-modal-btn-cancel" data-onclick="siModalDone" data-onclick-args="[false]">Cancel</button>
        <button class="si-modal-btn si-modal-btn-primary${danger ? " danger" : ""}"
          id="si-m-typed-btn" disabled data-onclick="siModalDone" data-onclick-args="[true]">${confirmLabel}</button>
      </div>`);
  }
  function _checkTyped() {
    const inp = $("si-m-typed");
    const btn = $("si-m-typed-btn");
    if (!inp || !btn) return;
    btn.disabled = inp.value !== _typedExpected;
  }

  // ── alert ──────────────────────────────────────────────────
  function alert(message, opts = {}) {
    const { title = "Notice" } = opts;
    return _show(`
      <div class="si-modal-hd">
        <span class="si-modal-title">${title}</span>
      </div>
      <div class="si-modal-confirm-body">
        <p class="si-modal-confirm-msg">${message}</p>
      </div>
      <div class="si-modal-ft">
        <button class="si-modal-btn si-modal-btn-primary" data-onclick="siModalDone" data-onclick-args="[true]">OK</button>
      </div>`);
  }

  // ── form ───────────────────────────────────────────────────
  // fields: [{id, label, type ('text'|'textarea'|'select'|'emoji'|'date'|'number'),
  //           placeholder, default, options (for select/emoji), required}]
  function form(title, fields, opts = {}) {
    const { confirmLabel = "Save", description = "" } = opts;
    const fHTML = fields
      .map((f) => {
        if (f.type === "emoji")
          return `
        <div class="si-modal-field">
          <label class="si-modal-label">${f.label}</label>
          <div class="si-modal-emoji-grid" id="smg-${f.id}">
            ${(f.options || [])
              .map(
                (e) => `
              <button type="button" class="si-modal-emoji-btn${(f.default || "") === e ? " sel" : ""}"
                data-onclick="siModalPickEmoji" data-onclick-arg0="smg-${f.id}" data-onclick-arg1="si-mf-${f.id}" data-onclick-this>${e}</button>`,
              )
              .join("")}
          </div>
          <input type="hidden" id="si-mf-${f.id}" value="${esc(f.default || "")}">
        </div>`;
        if (f.type === "select")
          return `
        <div class="si-modal-field">
          <label class="si-modal-label">${f.label}</label>
          <select id="si-mf-${f.id}" class="si-modal-input">
            ${(f.options || [])
              .map(
                (o) =>
                  `<option value="${o.value}"${o.value === (f.default || "") ? " selected" : ""}>${o.label}</option>`,
              )
              .join("")}
          </select>
        </div>`;
        if (f.type === "textarea")
          return `
        <div class="si-modal-field">
          <label class="si-modal-label">${f.label}</label>
          <textarea id="si-mf-${f.id}" class="si-modal-input si-modal-textarea"
            placeholder="${f.placeholder || ""}" rows="3">${esc(f.default || "")}</textarea>
        </div>`;
        return `
        <div class="si-modal-field">
          <label class="si-modal-label">${f.label}${f.required ? '<span style="color:var(--red3)"> *</span>' : ""}</label>
          <input id="si-mf-${f.id}" class="si-modal-input" type="${f.type || "text"}"
            placeholder="${f.placeholder || ""}" value="${esc(f.default || "")}"
            autocomplete="${f.type === "password" ? "new-password" : "off"}">
        </div>`;
      })
      .join("");
    // -args spreads a JSON array as SEPARATE positional arguments (delegate.js's
    // collectArgs does args.concat(parsed)); siModalSubForm takes ONE array
    // argument, so the ids array must be wrapped an extra level deep here
    // ([[..ids..]]) to survive that spread as a single argument again.
    const idsArgs = JSON.stringify([fields.map((f) => f.id)]);
    return _show(`
      <div class="si-modal-hd">
        <span class="si-modal-title">${title}</span>
        <button class="si-modal-x" data-onclick="siModalDone" data-onclick-args="[null]"><i class="ti ti-x"></i></button>
      </div>
      ${description ? `<div class="si-modal-desc">${description}</div>` : ""}
      <div class="si-modal-form-body">${fHTML}</div>
      <div class="si-modal-ft">
        <button class="si-modal-btn si-modal-btn-cancel" data-onclick="siModalDone" data-onclick-args="[null]">Cancel</button>
        <button class="si-modal-btn si-modal-btn-primary"
          data-onclick="siModalSubForm" data-onclick-args="${esc(idsArgs)}">
          ${confirmLabel}
        </button>
      </div>`);
  }
  function _subForm(ids) {
    const result = {};
    for (const id of ids) {
      const el = $(`si-mf-${id}`);
      result[id] = el ? el.value.trim() : "";
    }
    _done(result);
  }
  function _pickEmoji(gridId, hidId, btn) {
    const grid = $(gridId);
    if (grid)
      grid
        .querySelectorAll(".si-modal-emoji-btn")
        .forEach((b) => b.classList.remove("sel"));
    btn.classList.add("sel");
    const hid = $(hidId);
    if (hid) hid.value = btn.textContent;
  }

  return {
    input,
    confirm,
    confirmTyped,
    alert,
    form,
    _done,
    _bgClose,
    _subInput,
    _subForm,
    _checkTyped,
    _pickEmoji,
    _show_raw: _show,
  };
})();

// CSP migration: siModal.* are dotted names delegate.js's window[fnName]
// lookup can't resolve (siModal is a `const`, never on window at all, and
// even if it were, "siModal._done" is a nested property, not one literal
// window key) -- flat wrapper globals for every siModal method an inline
// handler used to call directly.
window.siModalDone = (v) => siModal._done(v);
window.siModalSubInput = () => siModal._subInput();
window.siModalCheckTyped = () => siModal._checkTyped();
window.siModalSubForm = (ids) => siModal._subForm(ids);
window.siModalPickEmoji = (gridId, hidId, el) => siModal._pickEmoji(gridId, hidId, el);
window.siModalBgClose = (e) => siModal._bgClose(e);

// ═══════════════════════════ PROFILE PICTURE ════════════════════

const PFP_KEY = () => `sivarr_pfp_${S.sid || "guest"}`;

function uploadProfilePic(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    toast("Image too large. Max 2MB.");
    input.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    // Resize to 200x200 via canvas before saving
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 200;
      const ctx = canvas.getContext("2d");
      // Crop to square from center
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 200, 200);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      localStorage.setItem(PFP_KEY(), dataUrl);
      applyProfilePic(dataUrl);
      toast("Profile photo updated ✓");
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = "";
}

function applyProfilePic(dataUrl) {
  // All avatar elements to update
  const avatarIds = ["tb-av", "tb-av-big", "snav-av"];
  avatarIds.forEach((id) => {
    const el = $(id);
    if (!el) return;
    if (dataUrl) {
      el.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      el.style.background = "none";
      el.style.padding = "0";
    } else {
      el.innerHTML = S.name?.[0]?.toUpperCase() || "?";
      el.style.background =
        "linear-gradient(135deg,var(--accent),var(--accent2))";
    }
  });
}

function loadProfilePic() {
  const saved = localStorage.getItem(PFP_KEY());
  if (saved) applyProfilePic(saved);
}

let AUTH_TAB = "login";

// CSP migration: shared Enter-key wrappers for the login form's field
// chaining (delegate.js has no conditional-expression grammar).
// _onEnterCallNamed dispatches to a named global the same way
// data-onclick="fn" itself does -- not arbitrary-expression eval, just the
// zero-arg-call idiom `if (event.key === 'Enter') fn();` factored out since
// it recurs across unrelated fields/functions.
window._onEnterCallNamed = function (e, fnName) {
  if (e.key === "Enter") {
    const fn = window[fnName];
    if (typeof fn === "function") fn();
  }
};
window._onEnterFocus = function (e, targetId) {
  if (e.key === "Enter") $(targetId)?.focus();
};
window._loginPwEnterNext = function (e) {
  if (e.key === "Enter") {
    AUTH_TAB === "register" ? $("l-cpw").focus() : doLogin();
  }
};


// ── Password policy (register only) ───────────────────────────
// Mirrors core.py's password_policy_error(). The SERVER is the authority --
// this exists so people see the rules while typing instead of being rejected
// after submitting. Keep the two in sync if either changes.
function _pwRules(pw) {
  pw = pw || "";
  return {
    len:   pw.length >= 8,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    digit: /[0-9]/.test(pw),
  };
}

function _pwRulesOk(pw) {
  return Object.values(_pwRules(pw)).every(Boolean);
}

function _pwRulesRender() {
  const box = $("pw-rules");
  if (!box || box.style.display === "none") return;
  const rules = _pwRules($("l-pw")?.value || "");
  box.querySelectorAll("li[data-rule]").forEach((li) => {
    const ok = !!rules[li.dataset.rule];
    li.classList.toggle("ok", ok);
    const ic = li.querySelector("i");
    if (ic) ic.className = ok ? "ti ti-circle-check" : "ti ti-circle";
  });
}

// Bound once, not inline -- inline handlers are what Session 19 is removing.
document.addEventListener("DOMContentLoaded", () => {
  const pw = $("l-pw");
  if (pw) pw.addEventListener("input", _pwRulesRender);
});

function setAuthTab(tab) {
  AUTH_TAB = tab;
  const isReg = tab === "register";
  const loginTab = $("auth-tab-login");
  const regTab = $("auth-tab-register");
  if (loginTab) loginTab.classList.toggle("active", !isReg);
  if (regTab) regTab.classList.toggle("active", isReg);

  // Show name + register-only fields only when registering
  const nf = $("name-field");
  if (nf) nf.style.display = isReg ? "block" : "none";
  const rf = $("register-fields");
  if (rf) rf.style.display = isReg ? "block" : "none";
  const fl = $("forgot-pw-link");
  if (fl) fl.style.display = isReg ? "none" : "block";

  // Requirements only apply to new accounts -- never gate an existing user out.
  const pr = $("pw-rules");
  if (pr) {
    pr.style.display = isReg ? "block" : "none";
    if (isReg) _pwRulesRender();
  }

  // 2FA field only ever appears mid-flow after a totp_required response —
  // never pre-shown, and cleared when switching tabs.
  const tf = $("l-totp-field");
  if (tf) tf.style.display = "none";
  const tv = $("l-totp");
  if (tv) tv.value = "";

  // Update password placeholder
  const pw = $("l-pw");
  if (pw) pw.placeholder = isReg ? "Min. 8 characters" : "Your password";

  const h = $("login-heading");
  if (h) h.textContent = isReg ? "Create account" : "Welcome back";
  const s = $("login-sub");
  if (s)
    s.textContent = isReg
      ? "Join the Sivarr workspace."
      : "Sign in to your workspace.";
  const b = $("login-btn");
  if (b) b.textContent = isReg ? "Create account" : "Sign in";
  const e = $("login-err");
  if (e) e.textContent = "";
  const g = $("google-btn-text");
  if (g) g.textContent = isReg ? "Sign up with Google" : "Continue with Google";

  // Focus the first visible field
  if (isReg) {
    setTimeout(() => $("ln")?.focus(), 50);
  } else {
    setTimeout(() => $("lm")?.focus(), 50);
  }
}

function togglePwVis(inputId, btnId) {
  const inp = $(inputId);
  const btn = $(btnId);
  if (!inp) return;
  inp.type = inp.type === "password" ? "text" : "password";
  const icon = btn?.querySelector("i");
  if (icon)
    icon.className = inp.type === "password" ? "ti ti-eye" : "ti ti-eye-off";
}

async function doLogin(prefillEmail) {
  const err = $("login-err");
  const btn = $("login-btn");
  if (err) err.textContent = "";

  // ── Student path ──────────────────────────────────────────
  const isReg = AUTH_TAB === "register";
  const email = (prefillEmail || $("lm")?.value || "").trim();
  const pw = $("l-pw")?.value || "";

  // Client-side validation
  if (!email) {
    if (err) err.textContent = "Email address is required.";
    $("lm")?.focus();
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    if (err) err.textContent = "Enter a valid email address.";
    $("lm")?.focus();
    return;
  }
  if (!pw) {
    if (err) err.textContent = "Password is required.";
    $("l-pw")?.focus();
    return;
  }
  if (isReg && !_pwRulesOk(pw)) {
    if (err) err.textContent = "Please meet all four password requirements below.";
    _pwRulesRender();
    $("l-pw")?.focus();
    return;
  }
  if (isReg) {
    const cpw = $("l-cpw")?.value || "";
    if (cpw && cpw !== pw) {
      if (err) err.textContent = "Passwords do not match.";
      $("l-cpw")?.focus();
      return;
    }
  }

  let body = { email, password: pw, action: AUTH_TAB };
  const totpVal = ($("l-totp")?.value || "").trim();
  if (totpVal) body.totp = totpVal;

  if (isReg) {
    const name = ($("ln")?.value || "").trim();
    const cpw = $("l-cpw")?.value || "";
    const phone = ($("l-phone")?.value || "").trim();

    if (!name || name.length < 2) {
      if (err) err.textContent = "Full name is required (min 2 characters).";
      $("ln")?.focus();
      return;
    }
    if (pw.length < 8) {
      if (err) err.textContent = "Password must be at least 8 characters.";
      $("l-pw")?.focus();
      return;
    }
    if (cpw && cpw !== pw) {
      if (err) err.textContent = "Passwords do not match.";
      $("l-cpw")?.focus();
      return;
    }
    if (!cpw) {
      if (err) err.textContent = "Please confirm your password.";
      $("l-cpw")?.focus();
      return;
    }

    body = { ...body, name, confirm_password: cpw, phone };
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Please wait…";
  }

  try {
    const r = await API("/api/login", body);
    saveSession(r.name, r.email, r.token);
    track(isReg ? "Register" : "Login");
    _applyLoginData(r);
  } catch (e) {
    const status = e.status || 0;
    const detail = e.message || "";
    if (status === 401 && detail === "google_only_account") {
      _authOfferSetPassword(
        err,
        email,
        `This account uses Google sign-in. Use 'Continue with Google' below, or set a password:`,
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
      return;
    }
    if (status === 403 && detail === "email_not_verified") {
      if (err) {
        err.textContent = `Your email isn't verified yet. Check your inbox for the verification link.`;
        const resendBtn = document.createElement("button");
        resendBtn.type = "button";
        resendBtn.textContent = "Resend verification email";
        resendBtn.style.cssText =
          "display:block;margin-top:6px;background:none;border:none;cursor:pointer;color:var(--teal);text-decoration:underline;padding:0;font-size:.82rem";
        resendBtn.onclick = () => requestVerificationEmail(email);
        err.appendChild(resendBtn);
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
      clearSession();
      return;
    }
    if (status === 401 && detail === "totp_required") {
      const field = $("l-totp-field");
      if (field) field.style.display = "";
      if (err)
        err.textContent = "Enter the 6-digit code from your authenticator app.";
      $("l-totp")?.focus();
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
      return;
    }
    if (status === 401 && detail === "Invalid 2FA code.") {
      if (err) err.textContent = "Invalid 2FA code. Try again.";
      const t = $("l-totp");
      if (t) {
        t.value = "";
        t.focus();
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
      return;
    }
    if (status === 409 && detail === "account_is_passwordless") {
      _authOfferSetPassword(
        err,
        email,
        `This email is registered with Google. Sign in with Google, or set a password:`,
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = isReg ? "Create account" : "Sign in";
      }
      return;
    }
    const text =
      status === 409
        ? detail
        : status === 401
          ? detail
          : status === 400
            ? detail
            : status === 422
              ? "Check your details and try again."
              : status === 429
                ? "Too many attempts. Please wait a moment."
                : detail ||
                  "Something went wrong. Check your connection and try again.";
    if (err) err.textContent = text;
    if (btn) {
      btn.disabled = false;
      btn.textContent = isReg ? "Create account" : "Sign in";
    }
    clearSession();
    return;
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = isReg ? "Create account" : "Sign in";
  }
}

// ═══════════════════════════ ANNOUNCEMENTS ══════════════════════
async function loadAnnouncements() {
  try {
    const r = await fetch("/api/announcements/active");
    const d = await r.json();
    const anns = d.announcements || [];
    if (!anns.length) return;

    // Don't show announcements the student has already dismissed
    const dismissed = JSON.parse(
      localStorage.getItem("sivarr_dismissed_anns") || "[]",
    );
    const unseen = anns.filter(
      (a) => !dismissed.includes(a.date + a.text.slice(0, 20)),
    );
    if (!unseen.length) return;

    const TYPE_COLORS = {
      info: {
        bg: "#4f6ef715",
        border: "#4f6ef740",
        color: "#4f6ef7",
        icon: "📘",
      },
      warning: {
        bg: "#f59e0b15",
        border: "#f59e0b40",
        color: "#f59e0b",
        icon: "⚠️",
      },
      deadline: {
        bg: "#ef444415",
        border: "#ef444440",
        color: "#ef4444",
        icon: "⏰",
      },
      exam: {
        bg: "#7c3aed15",
        border: "#7c3aed40",
        color: "#7c3aed",
        icon: "📝",
      },
    };

    // Remove existing popup if any
    const existing = document.getElementById("ann-popup");
    if (existing) existing.remove();

    const latest = unseen[unseen.length - 1];
    const style = TYPE_COLORS[latest.type] || TYPE_COLORS.info;
    const key = latest.date + latest.text.slice(0, 20);

    // Create popup
    const popup = document.createElement("div");
    popup.id = "ann-popup";
    popup.innerHTML = `
      <div id="ann-popup-inner">
        <div style="display:flex;align-items:flex-start;gap:10px">
          <span style="font-size:1.3rem;flex-shrink:0">${style.icon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:.72rem;font-weight:700;color:${style.color};text-transform:uppercase;
              letter-spacing:.05em;margin-bottom:3px">
              New announcement
              ${
                unseen.length > 1
                  ? `<span style="background:${style.color};color:#fff;border-radius:20px;
                padding:1px 7px;font-size:.65rem;margin-left:6px">${unseen.length} new</span>`
                  : ""
              }
            </div>
            <div style="font-size:.88rem;line-height:1.5;color:var(--text)">${esc(latest.text)}</div>
            <div style="font-size:.72rem;color:var(--muted);margin-top:4px">${latest.date}</div>
          </div>
          <button class="announcement-dismiss-btn" data-onclick="dismissAnnouncement" data-onclick-arg0="${key}">✕</button>
        </div>
        ${
          unseen.length > 1
            ? `
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid ${style.border}">
          <button data-onclick="showAllAnnouncements" style="background:none;border:none;
            color:${style.color};font-size:.78rem;font-weight:600;cursor:pointer;font-family:var(--font)">
            View all ${unseen.length} announcements →
          </button>
        </div>`
            : ""
        }
      </div>`;

    // Styles for the popup
    popup.style.cssText = `
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%) translateY(-100%);
      width: min(460px, calc(100vw - 2rem));
      background: var(--card);
      border: 1px solid ${style.border};
      border-top: none;
      border-radius: 0 0 16px 16px;
      padding: 1rem 1.1rem;
      z-index: 300;
      box-shadow: 0 8px 32px rgba(0,0,0,.4);
      transition: transform .4s cubic-bezier(0.34, 1.56, 0.64, 1);
    `;

    document.body.appendChild(popup);

    // Animate drop down
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        popup.style.transform = "translateX(-50%) translateY(0)";
      });
    });

    // Auto dismiss after 8 seconds
    setTimeout(() => dismissAnnouncement(key), 8000);
  } catch {}
}

function dismissAnnouncement(key) {
  const popup = document.getElementById("ann-popup");
  if (!popup) return;
  popup.style.transform = "translateX(-50%) translateY(-110%)";
  setTimeout(() => popup.remove(), 400);
  // Remember dismissed
  const dismissed = JSON.parse(
    localStorage.getItem("sivarr_dismissed_anns") || "[]",
  );
  if (!dismissed.includes(key)) dismissed.push(key);
  // Keep only last 50
  localStorage.setItem(
    "sivarr_dismissed_anns",
    JSON.stringify(dismissed.slice(-50)),
  );
}

function showAllAnnouncements() {
  dismissAnnouncement("");
  fetch("/api/announcements/active")
    .then((r) => r.json())
    .then((d) => {
      const anns = d.announcements || [];
      const TYPE_ICONS = {
        info: "📘",
        warning: "⚠️",
        deadline: "⏰",
        exam: "📝",
      };
      addMsg(
        "sivarr",
        "📢 Announcements:\n\n" +
          anns
            .map(
              (a, i) => `${TYPE_ICONS[a.type] || "📘"} ${a.text}\n(${a.date})`,
            )
            .join("\n\n"),
      );
    })
    .catch(() => {});
}

// ═══════════════════════════ SESSION PERSISTENCE ══════════════
// Save login to localStorage so user stays logged in on return

function saveSession(name, email, token) {
  localStorage.setItem("sivarr_name", name);
  localStorage.setItem("sivarr_email", email);
  localStorage.setItem("sivarr_ts", Date.now());
  if (token) setToken(token); // in-memory only — never localStorage
}

function clearSession() {
  localStorage.removeItem("sivarr_name");
  localStorage.removeItem("sivarr_email");
  localStorage.removeItem("sivarr_matric"); // clear legacy key
  localStorage.removeItem("sivarr_ts");
  const token = getToken();
  setToken("");
  // Always tell the backend to invalidate the session AND clear the httpOnly
  // cookie. After a reload `token` is '' (in-memory only) but the cookie is sent
  // automatically, so the server resolves and revokes the session from it.
  fetch("/api/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => {});
}

function getSavedSession() {
  const name = localStorage.getItem("sivarr_name");
  const email = localStorage.getItem("sivarr_email");
  const ts = localStorage.getItem("sivarr_ts");
  const token = getToken();
  if (!name || !email || !ts) return null;
  if (Date.now() - parseInt(ts) > 30 * 24 * 60 * 60 * 1000) {
    clearSession();
    return null;
  }
  return { name, email, token };
}

// ═══════════════════════════ LOGIN ════════════════════════════
// Single source of truth for whether #login-screen (all of _login.html) is
// visible/interactive. Toggles the `auth-screen` body class that layout.css
// keys off (display + pointer-events), AND the `inert` attribute directly
// on #login-screen so focus/keyboard/screen-reader access is cut too — not
// just pointer events. Every place that shows/hides the login page should
// call this instead of touching classes or #login-screen's inline style
// directly, so there's exactly one on/off switch to reason about.
function _setAuthScreen(showLogin) {
  const ls = $("login-screen");
  document.body.classList.toggle("auth-screen", showLogin);
  if (ls) ls.inert = !showLogin;
}

function logout() {
  if (window.Sentry) Sentry.setUser(null);
  clearSession();
  document.body.classList.remove("dashboard-active");
  _setAuthScreen(true);
  location.reload();
}

// ── Cross-device hydration ──────────────────────────────────────────────────
//   Pull this account's server-stored data into localStorage so a second device
//   shows what was changed elsewhere. Server = source of truth, BUT an empty
//   server response never wipes local data (guards a fresh device from blanking
//   a populated one). Runs on every login / session restore.
// One-time fixup, per account: before chatSaveTask/_aiAddTask/useTemplate
// mirrored into the SH store too, they wrote only to the flat
// sivarr_tasks_ store — never synced to the server — so those tasks were
// at risk of being silently dropped the moment _hydrateFromServer() below
// overwrote local state with the server's copy (which never had them).
// Fold any such orphaned tasks into SH once, so they get picked up by the
// normal server sync from here on. Best-effort — never blocks login.
function _migrateStrandedFlatTasks() {
  const flagKey = `sivarr_tasks_migrated_${S.sid}`;
  if (!S.sid || localStorage.getItem(flagKey)) return;
  try {
    const flat = JSON.parse(
      localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
    );
    // getSHData/saveSHData never existed under those names -- this whole
    // migration has been silently no-op'ing (caught by this try/catch,
    // exactly as its own "best-effort" comment intended, just for the
    // wrong reason) since before this function was written. Real
    // getTasksData()/addTask() now (js/features/tasks.js, window-exposed).
    // addTask() spreads its fields object over its own default id, so
    // passing id explicitly here preserves each stranded task's real id
    // instead of minting a new one.
    if (typeof window.getTasksData === "function" && typeof window.addTask === "function") {
      const known = new Set(
        (window.getTasksData().tasks || []).map((t) => String(t.id)),
      );
      flat.forEach((t) => {
        if (!t || known.has(String(t.id))) return;
        window.addTask({
          id: t.id,
          title: t.title || "",
          status: t.done
            ? "done"
            : t.status === "inprogress"
              ? "inprogress"
              : "todo",
          date: t.due || "",
          priority: t.priority || "normal",
          created:
            typeof t.created === "number"
              ? new Date(t.created).toISOString()
              : t.created || new Date().toISOString(),
        });
        known.add(String(t.id));
      });
    }
  } catch (_) {
    // best-effort — a migration failure must never block login
  } finally {
    try {
      localStorage.setItem(flagKey, "1");
    } catch (_) {}
  }
}

async function _hydrateFromServer() {
  const token = getToken();
  if (!token || !S.sid) return;
  const enc = encodeURIComponent(token);
  const pull = (url) =>
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

  const [tk, hb, jn, sk, fn, dc] = await Promise.all([
    pull(`/api/tasks/restore?token=${enc}`),
    pull(`/api/habits/restore?token=${enc}`),
    pull(`/api/journal/restore?token=${enc}`),
    pull(`/api/skills/restore?token=${enc}`),
    pull(`/api/finance/restore?token=${enc}`),
    pull(`/api/docs/restore?token=${enc}`),
  ]);
  let changed = false;

  if (tk && Array.isArray(tk.tasks) && tk.tasks.length) {
    // getSHData/saveSHData/SH_KEY/_shServerTaskToLocal never existed under
    // those names in this file -- leftover references from before
    // js/features/tasks.js was rewritten onto a different storage key
    // (sivarr_sh_${sid}, TASKS_KEY there) under different function names.
    // Uncaught, this threw and aborted the rest of hydration below (habits/
    // journal/skills/finance/docs) for any account with server-side tasks
    // -- caught by actually calling it in a browser, not by reading it.
    // Writes the real key directly (not via tasks.js's saveTasksData,
    // which would also push these just-pulled-from-the-server rows back
    // up as if they were new local edits) — same direct-write shape this
    // function already uses for habits/journal/skills/finance below.
    const shKey = `sivarr_sh_${S.sid}`;
    let sh;
    try {
      sh = JSON.parse(localStorage.getItem(shKey) || '{"tasks":[]}');
    } catch (_) {
      sh = { tasks: [] };
    }
    // Server rows use DB column names (description/goal_id/attach_name);
    // the render/edit code reads desc/goalId/attachName — translate here or
    // this overwrite silently blanks those fields on every hydrate.
    const localTasks = tk.tasks.map((t) =>
      typeof serverTaskToLocal === "function" ? serverTaskToLocal(t) : t,
    );
    sh.tasks = localTasks;
    localStorage.setItem(shKey, JSON.stringify(sh));
    changed = true;
  }
  if (hb && Array.isArray(hb.habits) && hb.habits.length) {
    // Server rows use "frequency"; the render/edit code reads "freq" — same
    // translation need as tasks' desc/goalId, see _habServerHabitToLocal.
    const localHabits = hb.habits.map((h) =>
      typeof _habServerHabitToLocal === "function"
        ? _habServerHabitToLocal(h)
        : h,
    );
    localStorage.setItem(HAB_KEY(), JSON.stringify(localHabits));
    changed = true;
  }
  if (jn && Array.isArray(jn.entries) && jn.entries.length) {
    localStorage.setItem(JNL_KEY(), JSON.stringify(jn.entries));
    changed = true;
  }
  if (sk && Array.isArray(sk.skills) && sk.skills.length) {
    localStorage.setItem(SK_KEY(), JSON.stringify(sk.skills));
    changed = true;
  }
  if (
    fn &&
    fn.data &&
    ((fn.data.transactions || []).length ||
      Object.keys(fn.data.budgets || {}).length)
  ) {
    localStorage.setItem(FIN_KEY(), JSON.stringify(fn.data));
    changed = true;
  }
  // Docs are stored text-only server-side, so only hydrate when THIS device has
  // none (a fresh device) — never clobber richer local content.
  if (dc && Array.isArray(dc.docs) && dc.docs.length) {
    let local;
    try {
      local = JSON.parse(localStorage.getItem(`sivarr_docs_${S.sid}`) || "[]");
    } catch (_) {
      local = [];
    }
    if (!local.length) {
      localStorage.setItem(`sivarr_docs_${S.sid}`, JSON.stringify(dc.docs));
      changed = true;
    }
  }

  if (changed) {
    try {
      if (typeof loadHome === "function") loadHome();
    } catch (_) {}
    try {
      if (typeof sbRenderStats === "function") sbRenderStats();
    } catch (_) {}
    try {
      if (typeof updateSBStats === "function") updateSBStats();
    } catch (_) {}
    try {
      _rehydrateActivePanel();
    } catch (_) {}
  }
}

// Re-init whichever data panel is currently open so it reflects fresh data.
function _rehydrateActivePanel() {
  const active = document.querySelector(".panel.active");
  const id = active && active.id;
  if (!id) return;
  if (id === "panel-habits" && typeof habitInit === "function") habitInit();
  else if (id === "panel-journal" && typeof journalInit === "function")
    journalInit();
  else if (id === "panel-skills" && typeof skillsInit === "function")
    skillsInit();
  else if (id === "panel-finance" && typeof finInit === "function") finInit();
}

function _applyLoginData(r) {
  // ── Essential: set core session state and REVEAL THE DASHBOARD first.
  //    This block must never be blocked by a cosmetic/enhancement failure
  //    below — otherwise a server-authenticated login (email, session
  //    restore, or Google) throws here and is reported to the user as a
  //    failed login even though the token is already saved.
  S.sid = r.sid;
  S.name = r.name;
  S.email = r.email;
  S.diff = r.difficulty;
  S.topics = r.topics;
  S.weak = r.weak;
  S.stats = {
    questions: r.questions,
    quizzes: r.quizzes,
    sessions: r.sessions,
    wrong: r.wrong_count,
  };
  S.uploadedFiles = r.uploaded_files || [];
  S.plan = r.plan || "free";

  _setAuthScreen(false);
  const _db = $("dashboard");
  if (_db) _db.style.display = "block";
  document.body.classList.add("dashboard-active");

  // ── Enhancement: profile chrome, panels, integrations, briefs. Wrapped
  //    so any single failure here can't undo the successful login above.
  try {
    const initial = (
      (r.name || r.email || "?").trim().charAt(0) || "?"
    ).toUpperCase();

    const tbAv = $("tb-av");
    if (tbAv) tbAv.textContent = initial;
    const tbNm = $("tb-name");
    if (tbNm) tbNm.textContent = r.name;
    const snavAv = $("snav-av");
    if (snavAv) snavAv.textContent = initial;
    const snavName = $("snav-name");
    if (snavName) snavName.textContent = r.name;
    const pdName = $("pd-name");
    if (pdName) pdName.textContent = r.name;
    const pdMatric = $("pd-matric");
    if (pdMatric) pdMatric.textContent = r.email;
    const tbAvBig = $("tb-av-big");
    if (tbAvBig) tbAvBig.textContent = initial;
    const mobAv = $("mob-snav-av");
    if (mobAv) mobAv.textContent = initial;
    const mobName = $("mob-snav-name");
    if (mobName) mobName.textContent = r.name;
    loadProfilePic();
    snavToggle("ai", $("snav-sec-ai"));
    updateDiff(r.difficulty);
    updateSBStats();
    renderTopics(r.topics, r.weak);
    renderFileList();
    loadWrong();

    if (localStorage.getItem("sb_retracted") === "1") {
      $("sidebar")?.classList.add("retracted");
      document.body.classList.add("sb-retracted");
    }
    if (localStorage.getItem("sb_collapsed") === "1") {
      $("sidebar")?.classList.add("collapsed");
      const _ri = $("sb-rail-icon");
      if (_ri) _ri.className = "ti ti-layout-sidebar-left-expand";
    }
    const _postCreate = sessionStorage.getItem("sivarr_post_create");
    const _landingPanel = _postCreate || _panelFromUrl() || "home";
    if (_postCreate) sessionStorage.removeItem("sivarr_post_create");
    nav(_landingPanel, null);

    // Land directly on the panel's content on mobile too (not the launcher) —
    // same as any other nav destination. We first REPLACE the current entry
    // with a clean root state (sivStack: []) — this is the floor: whatever
    // page we arrived from (a post-login reload, a Google OAuth callback
    // redirect, etc.) is discarded from the app's perspective. We then PUSH
    // the landing-panel state on top of it. This guarantees history.back()
    // from the landing panel always has an app-owned "root" entry to land
    // on first, so it can never fall through past the app's own history and
    // resurface prior third-party pages (e.g. accounts.google.com) that
    // happen to still sit in the tab's real session history.
    _mobReady = true;
    if (window.innerWidth <= 720) {
      $("sidebar")?.classList.remove("retracted", "collapsed");
      document.body.classList.remove("mobile-sidebar-open");
      try {
        localStorage.setItem("sb_last_panel", _landingPanel);
      } catch (_) {}
      _mobStack = [];
      document.body.classList.remove("mob-drilled");
      try {
        history.replaceState({ sivStack: [] }, "");
      } catch (_) {}
      _mobStack = [_landingPanel];
      document.body.classList.add("mob-drilled");
      try {
        history.pushState({ sivStack: [_landingPanel] }, "");
      } catch (_) {}
    }

    // Fold any pre-fix orphaned flat-store-only tasks into SH BEFORE the
    // server hydration below can overwrite local state without them.
    _migrateStrandedFlatTasks();
    // Cross-device sync: pull this account's latest data from the server and
    // refresh the UI once it lands (non-blocking — local renders instantly).
    _hydrateFromServer();

    const greet = $("welcome-greeting");
    if (greet) {
      const hr = new Date().getHours();
      const tod =
        hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
      greet.textContent = `${tod}, ${(r.name || "").split(" ")[0]}`;
    }
    // Show/hide email verification banner
    const vb = $("verify-banner");
    if (vb) vb.style.display = r.email_verified === false ? "flex" : "none";

    // Tag Sentry errors with the logged-in user (no PII beyond id/email)
    if (window.Sentry) {
      Sentry.setUser({ id: r.sid, email: r.email });
    }

    chatCounterInit();
    _contextSent = false; // fresh context for each login session
    _chatMsgCount = 0;
    setTimeout(_buildNotifs, 1200);
    loadAnnouncements();
    setTimeout(() => briefCheck(), 800);

    // Seed localStorage from server spaces (server wins on login/restore)
    if (r.spaces && r.spaces.length) {
      seedSpacesFromServer(r.spaces);
    }
    setTimeout(() => spaceRenderSidebar(), 100);
    setTimeout(() => {
      navRenderSidebar();
      sbRenderStats();
    }, 120);
    setTimeout(() => {
      if (typeof mktSyncSpacePrefs === "function") mktSyncSpacePrefs();
    }, 200);
    // Handle Stripe payment return
    setTimeout(() => agCheckPaymentReturn(), 500);
    // Show onboarding for new users
    if (!r.returning) setTimeout(() => siObMaybeStart(), 600);
    // Accept any pending org invite from URL, then surface email-pending invites
    setTimeout(_acceptPendingOrgInvite, 800);
    setTimeout(_loadPendingInvites, 1400);
    // Load integration statuses
    setTimeout(gcalCheckStatus, 1000);
    setTimeout(githubCheckStatus, 1100);
    setTimeout(billingLoadStatus, 1200);
    setTimeout(monoCheckStatus, 1400);
    setTimeout(mtCheckStatus, 1600);
    setTimeout(_sendTaskReminderIfNeeded, 3000);
  } catch (e) {
    console.error(
      "Sivarr: post-login UI setup failed (login still succeeded):",
      e,
    );
    if (window.Sentry) Sentry.captureException(e);
  }
}

async function restoreSession(token) {
  try {
    const r = await API("/api/session/restore", { token });
    saveSession(r.name, r.email, r.token || token);
    _applyLoginData(r);
    return true;
  } catch (e) {
    setToken("");
    return false;
  }
}

// ── Auth sub-flow helpers ──────────────────────────────────────────

let _resetToken = null; // token from ?reset= URL param

function showLoginView() {
  const panels = ["forgot-pw-form", "forgot-sent-view", "reset-pw-form"];
  panels.forEach((id) => {
    const el = $(id);
    if (el) el.style.display = "none";
  });
  const mainEls = [
    "student-fields",
    "login-err",
    "login-btn",
    "login-note",
    "auth-tabs",
    "forgot-pw-link",
  ];
  mainEls.forEach((id) => {
    const el = $(id);
    if (el) el.style.display = "";
  });
  // Restore correct heading/sub
  const h = $("login-heading");
  if (h) h.textContent = "Welcome back";
  const s = $("login-sub");
  if (s) s.textContent = "Sign in to your workspace.";
}

function showForgotPassword() {
  const mainEls = [
    "student-fields",
    "login-err",
    "login-btn",
    "login-note",
    "auth-tabs",
    "forgot-pw-link",
  ];
  mainEls.forEach((id) => {
    const el = $(id);
    if (el) el.style.display = "none";
  });
  const fp = $("forgot-pw-form");
  if (fp) fp.style.display = "block";
  const h = $("login-heading");
  if (h) h.style.display = "none";
  const sub = $("login-sub");
  if (sub) sub.style.display = "none";
  setTimeout(() => $("fp-email")?.focus(), 50);
}

async function submitForgotPassword() {
  const email = ($("fp-email")?.value || "").trim();
  const err = $("forgot-err");
  const btn = $("fp-btn");
  if (err) err.textContent = "";
  if (!email) {
    if (err) err.textContent = "Please enter your email.";
    return;
  }
  if (btn) {
    btn.textContent = "Sending...";
    btn.disabled = true;
  }
  try {
    await API("/api/auth/forgot-password", { email });
  } catch (e) {
    /* always proceed to sent view */
  }
  if (btn) {
    btn.textContent = "Send reset link";
    btn.disabled = false;
  }
  const fp = $("forgot-pw-form");
  if (fp) fp.style.display = "none";
  const sv = $("forgot-sent-view");
  if (sv) sv.style.display = "block";
}

function showResetPasswordForm(token) {
  _resetToken = token;
  const mainEls = [
    "student-fields",
    "login-err",
    "login-btn",
    "login-note",
    "auth-tabs",
    "forgot-pw-link",
  ];
  mainEls.forEach((id) => {
    const el = $(id);
    if (el) el.style.display = "none";
  });
  const h = $("login-heading");
  if (h) h.style.display = "none";
  const sub = $("login-sub");
  if (sub) sub.style.display = "none";
  const rp = $("reset-pw-form");
  if (rp) rp.style.display = "block";
  setTimeout(() => $("rp-pw")?.focus(), 50);
}

async function submitResetPassword() {
  const pw = $("rp-pw")?.value || "";
  const cpw = $("rp-cpw")?.value || "";
  const err = $("reset-err");
  const btn = $("rp-btn");
  if (err) err.textContent = "";
  if (!pw) {
    if (err) err.textContent = "Enter a new password.";
    return;
  }
  if (pw.length < 8) {
    if (err) err.textContent = "Password must be at least 8 characters.";
    return;
  }
  if (pw !== cpw) {
    if (err) err.textContent = "Passwords do not match.";
    return;
  }
  if (btn) {
    btn.textContent = "Updating...";
    btn.disabled = true;
  }
  try {
    await API("/api/auth/reset-password", { token: _resetToken, password: pw });
    // Clear URL params then show success
    history.replaceState(null, "", "/");
    showLoginView();
    const h = $("login-heading");
    if (h) {
      h.style.display = "";
      h.textContent = "Welcome back";
    }
    const sub = $("login-sub");
    if (sub) {
      sub.style.display = "";
    }
    toast("Password updated! Please sign in with your new password.");
  } catch (e) {
    if (err) err.textContent = e.message || "Reset link is invalid or expired.";
  } finally {
    if (btn) {
      btn.textContent = "Update password";
      btn.disabled = false;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PAYWALL / PLAN ACCESS SYSTEM
// ─────────────────────────────────────────────────────────────

const _PLAN_LEVELS = {
  free: 0,
  Free: 0,
  // Paid tier 1 — Pro and the academic-space paid tiers
  pro: 1,
  Pro: 1,
  "Student Pro": 1,
  "Educator Pro": 1,
  // Paid tier 2 — top personal/org tiers
  creator: 2,
  Creator: 2,
  team: 2,
  Team: 2,
};

function _planLevel(name) {
  return _PLAN_LEVELS[name || "free"] ?? 0;
}

function _hasPlan(required) {
  // Dev bypass: localStorage.setItem('sivarr_dev','1') in console to unlock everything
  if (localStorage.getItem("sivarr_dev") === "1") return true;
  const current = _planLevel(_BILLING_STATUS?.name || "free");
  return current >= _planLevel(required);
}

const _PAYWALL_CFG = {
  org: {
    plan: "Pro",
    icon: "ti-building",
    title: "Organization Space",
    desc: "Collaborate with your team, manage projects, and chat in real-time.",
    perks: [
      "Real-time org chat",
      "Project kanban",
      "Team goals & docs",
      "Member management",
    ],
  },
  orgchat: {
    plan: "Pro",
    icon: "ti-messages",
    title: "Org Chat",
    desc: "Real-time team messaging with channels and direct messages.",
    perks: [
      "Slack-style channels",
      "Direct messages",
      "Presence indicators",
      "Emoji reactions",
    ],
  },
  team: {
    plan: "Pro",
    icon: "ti-users",
    title: "Team Space",
    desc: "Manage your team, roles, and workload in one place.",
    perks: [
      "Team members",
      "Role management",
      "Workload view",
      "Activity feed",
    ],
  },
  projects: {
    plan: "Pro",
    icon: "ti-layout-kanban",
    title: "Projects",
    desc: "Build and track projects with kanban boards and milestones.",
    perks: [
      "Kanban boards",
      "Milestones",
      "GitHub linking",
      "Progress tracking",
    ],
  },
  founder: {
    plan: "Team",
    icon: "ti-rocket",
    title: "Founder Mode",
    desc: "Strategic tools for building your company: metrics, pipeline, and vision.",
    perks: [
      "Company metrics",
      "Fundraising pipeline",
      "Team builder",
      "Vision board",
    ],
  },
};

function _showPaywall(panelName) {
  const cfg = _PAYWALL_CFG[panelName];
  if (!cfg) return;
  const panel = document.getElementById(`panel-${panelName}`);
  if (!panel) return;
  panel.querySelector(".paywall-overlay")?.remove();
  const el = document.createElement("div");
  el.className = "paywall-overlay";
  el.innerHTML = `
    <div class="paywall-card">
      <div class="paywall-icon"><i class="ti ${cfg.icon}"></i></div>
      <h3>${esc(cfg.title)}</h3>
      <p>${esc(cfg.desc)}</p>
      <ul class="paywall-perks">${cfg.perks.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
      <button class="paywall-btn" data-onclick="showPricing">Upgrade to ${esc(cfg.plan)} →</button>
    </div>`;
  panel.style.position = "relative";
  panel.appendChild(el);
}

function _removePaywall(panelName) {
  document
    .getElementById(`panel-${panelName}`)
    ?.querySelector(".paywall-overlay")
    ?.remove();
}

// Wire upgrade button in sidebar after billing loads
function _billingRenderSidebar() {
  const planName = _BILLING_STATUS?.name || "Free";
  const isPaid = _planLevel(planName) > 0;
  const btn = $("sb-upgrade-btn");
  const planLabel = $("sb-plan-label");
  const upLabel = $("sb-upgrade-label");
  if (planLabel)
    planLabel.textContent = isPaid ? `${planName} Plan` : "Free Plan";
  if (upLabel)
    upLabel.textContent = isPaid ? "Manage subscription" : "Upgrade Sivarr";
  if (btn) btn.style.borderColor = isPaid ? "var(--teal)" : "var(--border)";
}

// ─────────────────────────────────────────────────────────────
//  GITHUB INTEGRATION
// ─────────────────────────────────────────────────────────────

let _GITHUB_CONNECTED = false;
let _GITHUB_USERNAME = "";

async function githubCheckStatus() {
  const token = getToken() || "";
  if (!token) return;
  try {
    const r = await fetch(
      `/api/integrations/github/status?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _GITHUB_CONNECTED = d.connected;
    _GITHUB_USERNAME = d.username || "";
    integrationsRender();
  } catch (_) {}
}

function githubConnect() {
  const token = getToken() || "";
  if (!token) {
    toast("Sign in first.");
    return;
  }
  window.location.href = `/auth/github?token=${encodeURIComponent(token)}`;
}

async function githubLoadRepos() {
  const token = getToken() || "";
  if (!token || !_GITHUB_CONNECTED) return [];
  try {
    const r = await fetch(
      `/api/integrations/github/repos?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    return d.repos || [];
  } catch (_) {
    return [];
  }
}

async function githubLoadActivity(repoFullName) {
  const token = getToken() || "";
  if (!token || !_GITHUB_CONNECTED) return null;
  try {
    const r = await fetch(
      `/api/integrations/github/activity?token=${encodeURIComponent(token)}&repo=${encodeURIComponent(repoFullName)}`,
    );
    return await r.json();
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  INTEGRATIONS PAGE (Library panel)
// ─────────────────────────────────────────────────────────────

// CSP migration: each integration card's button used to serialize its
// action closure to source text and eval it inline (`onclick="(${fn.toString()})()"`)
// -- the one genuinely inexpressible pattern in this whole migration, since
// delegate.js deliberately only ever dispatches to real named globals, never
// arbitrary serialized code (see js/core/delegate.js's own header). Real fix:
// dispatch on the integration's stable `id` instead. _intActions is
// rebuilt on every integrationsRender() call, so intAction() always calls
// whatever the most recently rendered card's action closure actually is.
let _intActions = {};
window.intAction = function (id) {
  const fn = _intActions[id];
  if (fn) fn();
};

function integrationsRender() {
  const grid = $("integrations-grid");
  if (!grid) return;
  const token = getToken() || "";
  const integrations = [
    {
      id: "google",
      name: "Google OAuth",
      logo: `<svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.2l6.8-6.8C35.8 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.3 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.5-4.1 7-10.2 7-17.1z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6L2.6 13.3A24 24 0 0 0 0 24c0 3.8.9 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.6-5.9c-2 1.4-4.7 2.2-7.6 2.2-6.3 0-11.6-3.8-13.5-9.2l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`,
      bg: "#fff",
      connected: true,
      statusText: "Sign-in active",
      action: null,
      actionLabel: "Connected",
    },
    {
      id: "gcal",
      name: "Google Calendar",
      logo: `<svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.2l6.8-6.8C35.8 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.3 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.5-4.1 7-10.2 7-17.1z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6L2.6 13.3A24 24 0 0 0 0 24c0 3.8.9 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.6-5.9c-2 1.4-4.7 2.2-7.6 2.2-6.3 0-11.6-3.8-13.5-9.2l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`,
      bg: "#fff",
      connected: _GCAL_CONNECTED,
      statusText: _GCAL_CONNECTED ? "Syncing events" : "Not connected",
      action: () => gcalConnect(),
      actionLabel: _GCAL_CONNECTED ? "Connected" : "Connect",
    },
    {
      id: "github",
      name: "GitHub",
      logo: `<svg width="20" height="20" viewBox="0 0 98 96" fill="currentColor"><path d="M48.9 0C21.8 0 0 22 0 49.2c0 21.8 14 40.3 33.5 46.8 2.5.5 3.4-1 3.4-2.3v-8c-13.7 3-16.6-6.7-16.6-6.7-2.2-5.7-5.5-7.2-5.5-7.2-4.5-3 .3-3 .3-3 5 .4 7.6 5.1 7.6 5.1 4.4 7.6 11.6 5.4 14.4 4.1.4-3.2 1.7-5.4 3.1-6.6-11-1.2-22.5-5.5-22.5-24.5 0-5.4 1.9-9.8 5.1-13.3-.5-1.3-2.2-6.3.5-13.1 0 0 4.1-1.3 13.4 5 3.9-1.1 8-1.6 12.2-1.6 4.1 0 8.3.5 12.2 1.6 9.3-6.3 13.4-5 13.4-5 2.7 6.8 1 11.8.5 13.1 3.1 3.5 5 7.9 5 13.3 0 19-11.6 23.3-22.6 24.5 1.8 1.5 3.4 4.5 3.4 9.2v13.6c0 1.3.8 2.8 3.4 2.3C84 89.4 98 70.9 98 49.2 97.9 22 76 0 48.9 0z"/></svg>`,
      bg: "#24292e",
      connected: _GITHUB_CONNECTED,
      statusText: _GITHUB_CONNECTED ? `@${_GITHUB_USERNAME}` : "Not connected",
      action: () => githubConnect(),
      actionLabel: _GITHUB_CONNECTED ? "Connected" : "Connect",
    },
    {
      id: "paystack",
      name: "Paystack",
      logo: "💳",
      bg: "#00C3F7",
      connected: (_BILLING_STATUS?.plan || "free") !== "free",
      statusText:
        _BILLING_STATUS?.plan === "free" || !_BILLING_STATUS
          ? "Free plan"
          : `${_BILLING_STATUS.name} (expires ${_BILLING_STATUS.expires || ""})`,
      action: () => showPricing(),
      actionLabel:
        (_BILLING_STATUS?.plan || "free") !== "free" ? "Manage" : "Upgrade",
    },
    {
      id: "flutterwave",
      name: "Flutterwave",
      logo: "🦋",
      bg: "#F5A623",
      connected: _BILLING_STATUS?.gateway === "flutterwave",
      statusText:
        _BILLING_STATUS?.gateway === "flutterwave"
          ? `${_BILLING_STATUS.name} via Flutterwave`
          : "Pay with card/bank/USSD",
      action: () => showPricing(),
      actionLabel: "Upgrade",
    },
    {
      id: "mono",
      name: "Mono",
      logo: "🏦",
      bg: "#000",
      connected: _MONO_CONNECTED,
      statusText: _MONO_CONNECTED
        ? "Bank account linked"
        : "African open banking",
      action: () => monoConnect(),
      actionLabel: _MONO_CONNECTED ? "Connected" : "Connect",
    },
    {
      id: "metatrader",
      name: "MetaTrader",
      logo: "📈",
      bg: "#1c64f2",
      connected: _MT_CONNECTED,
      statusText: _MT_CONNECTED
        ? `MT account ${_MT_STATUS.login || ""} · ${(_MT_STATUS.platform || "mt5").toUpperCase()}`
        : "Link MT4/MT5 → live balance, positions & trades",
      action: () => mtConnect(),
      actionLabel: _MT_CONNECTED ? "Connected" : "Connect",
    },
    {
      id: "whatsapp",
      name: "WhatsApp Business",
      logo: "💬",
      bg: "#25D366",
      connected: false,
      comingSoon: true,
      statusText: "Reports, alerts & SIVA briefings (coming soon)",
      action: () =>
        toast(
          "WhatsApp Business is coming soon. It will power SIVA reports, alerts & trading summaries.",
        ),
      actionLabel: "Coming soon",
    },
  ];

  // Stage 8: standardized per-category layout. Each integration declares a category;
  // cards render under a full-width category header in a fixed order. The card markup
  // itself is the single unified pattern shared across every integration.
  const INT_CAT = {
    google: "Identity",
    gcal: "Calendar",
    github: "Developer",
    paystack: "Payments & Finance",
    flutterwave: "Payments & Finance",
    mono: "Payments & Finance",
    metatrader: "Trading",
    whatsapp: "Communication",
  };
  const CAT_ORDER = [
    "Identity",
    "Calendar",
    "Developer",
    "Payments & Finance",
    "Trading",
    "Communication",
  ];
  const card = (i) => `
    <div class="int-card ${i.connected ? "connected" : ""}">
      <div class="int-header">
        <div class="int-logo" style="background:${i.bg};color:${i.bg === "#fff" ? "#000" : "#fff"}">${i.logo}</div>
        <div>
          <div class="int-name">${esc(i.name)}</div>
          <div class="int-status ${i.connected ? "ok" : ""}">${esc(i.statusText)}</div>
        </div>
      </div>
      ${
        i.comingSoon
          ? `<button class="int-btn int-soon" data-onclick="intAction" data-onclick-arg0="${i.id}">${esc(i.actionLabel)}</button>`
          : i.action
            ? `<button class="int-btn ${i.connected ? "connected-btn" : ""}" data-onclick="intAction" data-onclick-arg0="${i.id}">${i.connected ? "✓ " : ""}${esc(i.actionLabel)}</button>`
            : `<button class="int-btn connected-btn" disabled>✓ ${esc(i.actionLabel)}</button>`
      }
    </div>`;
  const byCat = {};
  _intActions = {};
  integrations.forEach((i) => {
    if (i.action) _intActions[i.id] = i.action;
    const c = INT_CAT[i.id] || "Other";
    (byCat[c] = byCat[c] || []).push(i);
  });
  const cats = CAT_ORDER.filter((c) => byCat[c]).concat(
    Object.keys(byCat).filter((c) => !CAT_ORDER.includes(c)),
  );
  grid.innerHTML = cats
    .map(
      (c) =>
        `<div class="int-cat-head">${esc(c)}</div>` +
        byCat[c].map(card).join(""),
    )
    .join("");
}

// ─────────────────────────────────────────────────────────────
//  GOOGLE CALENDAR INTEGRATION
// ─────────────────────────────────────────────────────────────

let _GCAL_CONNECTED = false;
let _GCAL_EVENTS = [];

async function gcalCheckStatus() {
  const token = getToken() || "";
  if (!token) return;
  try {
    const r = await fetch(
      `/api/integrations/gcal/status?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _GCAL_CONNECTED = d.connected;
    const btn = $("gcal-connect-btn");
    const label = $("gcal-btn-label");
    const disc = $("gcal-disconnect-btn");
    if (btn && label) {
      if (_GCAL_CONNECTED) {
        label.textContent = "Google Connected";
        btn.style.borderColor = "var(--teal)";
        btn.style.color = "var(--teal)";
        btn.onclick = gcalLoadEvents;
        btn.title = "Refresh Google Calendar events";
      } else {
        label.textContent = "Connect Google";
        btn.style.borderColor = "";
        btn.style.color = "";
        btn.onclick = gcalConnect;
        btn.title = "";
      }
    }
    if (disc) disc.style.display = _GCAL_CONNECTED ? "" : "none";
    if (_GCAL_CONNECTED) gcalLoadEvents();
  } catch (_) {}
}

function gcalConnect() {
  if (!getToken()) {
    toast("Sign in first.");
    return;
  }
  // The server resolves the session from the httpOnly cookie — never put the
  // session token in the URL (it would leak to history, logs and the Referer).
  window.location.href = "/auth/google/calendar";
}

async function gcalLoadEvents() {
  const token = getToken() || "";
  if (!token || !_GCAL_CONNECTED) return;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();
  try {
    const r = await fetch(
      `/api/integrations/gcal/events?token=${encodeURIComponent(token)}&time_min=${encodeURIComponent(start)}&time_max=${encodeURIComponent(end)}`,
    );
    const d = await r.json();
    _GCAL_EVENTS = d.events || [];
    if (typeof calRender === "function") calRender(); // surface Google events in the calendar
  } catch (_) {}
}

async function gcalDisconnect() {
  const token = getToken() || "";
  if (!token) return;
  if (
    !confirm(
      "Disconnect Google Calendar? Your Google events will stop showing in Sivarr and Sivarr’s access will be revoked.",
    )
  )
    return;
  try {
    await API("/api/integrations/gcal/disconnect", { token });
    _GCAL_CONNECTED = false;
    _GCAL_EVENTS = [];
    toast("Google Calendar disconnected.");
    gcalCheckStatus();
    if (typeof calRender === "function") calRender();
  } catch (e) {
    toast(e.message || "Disconnect failed.");
  }
}

async function gcalPushEvent(ev) {
  const token = getToken() || "";
  if (!token || !_GCAL_CONNECTED) {
    toast("Connect Google Calendar first.");
    return;
  }
  try {
    let tz = "UTC";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch (_) {}
    await API("/api/integrations/gcal/push", {
      token,
      title: ev.title,
      start: ev.start,
      end: ev.end || ev.start,
      allDay: !!ev.allDay,
      description: ev.description || "",
      tz,
    });
    toast("Event pushed to Google Calendar!");
  } catch (e) {
    toast(e.message || "Push to Google Calendar failed.");
  }
}

// ─────────────────────────────────────────────────────────────
//  PAYSTACK SUBSCRIPTION BILLING
// ─────────────────────────────────────────────────────────────

let _BILLING_STATUS = null;
let _ENTITLEMENTS = null; // { plan, caps:{spaces,templates,integrations,analytics_days}, usage }

async function billingLoadStatus() {
  const token = getToken() || "";
  if (!token) return;
  try {
    const r = await fetch(
      `/api/billing/status?token=${encodeURIComponent(token)}`,
    );
    _BILLING_STATUS = await r.json();
    _billingRenderBadge();
    _billingRenderSidebar();
    integrationsRender();
  } catch (_) {}
  // Plan feature caps (quota gating) — used for upgrade prompts client-side.
  try {
    const e = await fetch(
      `/api/billing/entitlements?token=${encodeURIComponent(token)}`,
    );
    if (e.ok) _ENTITLEMENTS = await e.json();
  } catch (_) {}
}

function _billingRenderBadge() {
  const el = $("billing-plan-badge");
  if (!el || !_BILLING_STATUS) return;
  const plan = _BILLING_STATUS.name || "Free";
  el.textContent = plan;
  el.style.background = plan === "Free" ? "var(--bg3)" : "var(--teal2)";
  el.style.color = plan === "Free" ? "var(--muted)" : "var(--teal)";
}

// CSP migration: the paywall overlay's own "Upgrade Now" button just reveals
// the real pricing modal by id -- a DOM expression, not a named global.
window._showPricingModal = function () {
  const m = document.getElementById("pricing-modal");
  if (m) m.style.display = "flex";
};

async function showPricing() {
  const modal = $("pricing-modal");
  if (!modal) return;
  modal.style.display = "flex";
  const token = getToken() || "";
  let planData = { plans: {}, paystack_available: false };
  try {
    const r = await fetch("/api/billing/plans");
    planData = await r.json();
  } catch (_) {}

  const cards = $("pricing-cards");
  if (cards) {
    const currentPlan = _BILLING_STATUS?.name?.toLowerCase() || "free";
    // Server is the source of truth for price + live NGN conversion (USD anchor).
    const disp = {};
    (planData.display || []).forEach((d) => {
      disp[d.id] = d;
    });
    const usdOf = (id, fb) => disp[id]?.display_usd || fb;
    const localOf = (id) => disp[id]?.fx?.display_local || "";

    // Personal-space ladder (Academic & Org spaces have their own plans).
    const plans = [
      {
        id: "free",
        name: "Free",
        usd: "$0",
        per: "/forever",
        perks: [
          "AI chat (15/day)",
          "Tasks & Goals",
          "Calendar",
          "Personal journal",
        ],
        free: true,
      },
      {
        id: "pro_monthly",
        name: "Pro",
        usd: usdOf("pro_monthly", "$12"),
        local: localOf("pro_monthly"),
        per: "/month",
        perks: [
          "Everything in Free",
          "Unlimited core AI",
          "All premium templates",
          "5 integrations",
          "Priority AI speed",
        ],
        featured: true,
      },
      {
        id: "creator_monthly",
        name: "Creator",
        usd: usdOf("creator_monthly", "$22"),
        local: localOf("creator_monthly"),
        per: "/month",
        perks: [
          "Best AI model (Claude Opus, coming soon)",
          "Unlimited personal spaces",
          "Sell on the marketplace",
          "Creator analytics",
          "Early access to new features",
        ],
      },
    ];
    cards.innerHTML = plans
      .map((p) => {
        const isCurrent =
          currentPlan === p.name.toLowerCase() ||
          (p.free && currentPlan === "free");
        return `
      <div class="pricing-card${p.featured ? " featured" : ""}${isCurrent ? " current-plan" : ""}">
        <div class="pricing-name">${esc(p.name)}</div>
        <div class="pricing-price">${esc(p.usd)}<span>${p.per}</span></div>
        ${p.local ? `<div style="font-size:.72rem;color:var(--muted);margin:-4px 0 8px">${esc(p.local)} · billed via Paystack</div>` : ""}
        <ul class="pricing-perks">${p.perks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        ${
          isCurrent
            ? `<button class="pricing-btn free-btn" disabled>Current plan</button>`
            : p.free
              ? `<button class="pricing-btn free-btn" disabled>Free</button>`
              : `<div style="display:flex;flex-direction:column;gap:6px">
                <button class="pricing-btn" data-onclick="billingSubscribe" data-onclick-arg0="${p.id}">Paystack →</button>
                <button class="pricing-btn" style="background:var(--amber,#F5A623);border-color:var(--amber,#F5A623)" data-onclick="flutterwaveSubscribe" data-onclick-arg0="${p.id}">Flutterwave →</button>
               </div>`
        }
      </div>`;
      })
      .join("");

    // Comparison table (Personal: Free / Pro / Creator)
    const tableWrap =
      cards.parentElement?.querySelector("#pricing-compare") ||
      (() => {
        const t = document.createElement("div");
        t.id = "pricing-compare";
        t.style.cssText =
          "margin-top:24px;border-top:1px solid var(--border);padding-top:20px";
        cards.parentElement?.appendChild(t);
        return t;
      })();
    const CHECK = '<span style="color:var(--teal)">✓</span>';
    const CROSS = '<span style="color:var(--muted)">✗</span>';
    const rows = [
      ["AI messages / day", "15", "Unlimited", "Unlimited"],
      ["Active templates", "3", "All", "All"],
      ["Analytics history", "7 days", "Full", "Full"],
      ["Integrations", "1", "5", "Unlimited"],
      ["Priority AI speed", CROSS, CHECK, CHECK],
      ["Best model (Claude Opus, soon)", CROSS, CROSS, CHECK],
      ["Personal spaces", "1", "3", "Unlimited"],
      ["Sell on marketplace", CROSS, CROSS, CHECK],
      [
        "Price",
        usdOf("free", "$0") + "/mo",
        usdOf("pro_monthly", "$12") + "/mo",
        usdOf("creator_monthly", "$22") + "/mo",
      ],
    ];
    tableWrap.innerHTML = `
      <div style="font-weight:700;margin-bottom:12px;font-size:.9rem">Feature comparison</div>
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:600">Feature</th>
            ${["Free", "Pro", "Creator"].map((n) => `<th style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border);color:${n.toLowerCase() === currentPlan ? "var(--teal)" : "var(--muted)"};font-weight:700">${n}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:7px 8px;color:var(--text2)">${r[0]}</td>
            ${r
              .slice(1)
              .map(
                (v) =>
                  `<td style="padding:7px 8px;text-align:center">${v}</td>`,
              )
              .join("")}
          </tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <div style="margin-top:12px;font-size:.74rem;color:var(--muted)">Prices in USD · local amount converted at checkout. Academic & Organisation spaces have their own plans.</div>`;
  }
}

function closePricing() {
  const modal = $("pricing-modal");
  if (modal) modal.style.display = "none";
}

async function billingSubscribe(planId) {
  const token = getToken() || "";
  if (!token) {
    toast("Sign in to subscribe.");
    return;
  }
  try {
    const r = await API("/api/billing/subscribe", { token, plan: planId });
    if (r.authorization_url) {
      toast("Redirecting to Paystack…");
      window.location.href = r.authorization_url;
    }
  } catch (e) {
    toast(e.message || "Could not start payment. Please try again.");
  }
}

async function billingVerify(reference, planId) {
  const token = getToken() || "";
  if (!token || !reference) return;
  try {
    const r = await fetch(
      `/api/billing/verify/${encodeURIComponent(reference)}?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    if (d.ok) {
      await billingLoadStatus(); // refreshes _ENTITLEMENTS (incl. org_sub_active)
      if (d.org_id) {
        toast("Organisation plan activated ✓");
        ["org", "orgchat", "team", "projects"].forEach(_removePaywall);
        if (typeof orgInit === "function") orgInit();
        return;
      }
      _unlockAfterPayment(d.name || planId || "Pro");
    }
  } catch (_) {
    toast(
      "Payment verification failed. Contact support if funds were deducted.",
    );
  }
}

function _unlockAfterPayment(planName) {
  const level = _planLevel(planName);
  const GUARDED = {
    org: "Pro",
    orgchat: "Pro",
    team: "Pro",
    projects: "Pro",
    founder: "Team",
  };
  for (const [panel, required] of Object.entries(GUARDED)) {
    if (level >= _planLevel(required)) _removePaywall(panel);
  }
  if (level >= _planLevel("Pro")) {
    toast(`🎉 You're on the ${planName} plan! Org Space is now unlocked.`);
    setTimeout(() => nav("org"), 800);
  }
}

function checkAuthParams() {
  const params = new URLSearchParams(window.location.search);
  const reset = params.get("reset");
  const verify = params.get("verify");
  const verified = params.get("verified");
  const orgInvite = params.get("org_invite");
  const googleTok = params.get("google_token");
  const authErr = params.get("auth_error");
  const gcalConn = params.get("gcal_connected");
  const gcalErr = params.get("gcal_error");
  const githubConn = params.get("github_connected");
  const githubErr = params.get("github_error");
  const billing = params.get("billing");
  const billingRef = params.get("ref");
  const billingPlan = params.get("plan");

  if (reset) {
    history.replaceState(null, "", "/");
    showResetPasswordForm(reset);
    return;
  }
  if (verified === "1") {
    history.replaceState(null, "", "/");
    toast("Email verified! You can now sign in.");
  } else if (verified === "error") {
    history.replaceState(null, "", "/");
    toast("Verification link is invalid or expired. Please request a new one.");
  }
  if (orgInvite) {
    history.replaceState(null, "", "/");
    sessionStorage.setItem("pending_org_invite", orgInvite);
  }

  // Google OAuth callback — exchange one-time code for real session token
  const googleCode = params.get("google_code");
  if (googleCode) {
    history.replaceState(null, "", "/");
    sessionStorage.setItem("google_login_pending_code", googleCode);
    return;
  }
  // Legacy fallback: direct token (old flow, keep for safety)
  if (googleTok) {
    history.replaceState(null, "", "/");
    setToken(googleTok);
    sessionStorage.setItem("google_login_pending", googleTok);
    return;
  }
  if (authErr) {
    history.replaceState(null, "", "/");
    const msgs = {
      google_not_configured: "Google sign-in is not configured yet.",
      google_denied: "Google sign-in was cancelled.",
      google_token_failed: "Google token exchange failed. Please try again.",
      google_failed: "Google sign-in failed. Please try again.",
      google_no_email:
        "Could not retrieve email from Google. Please use email/password.",
    };
    toast(msgs[authErr] || "Authentication error. Please try again.");
  }

  // Google Calendar callback
  if (gcalConn === "1") {
    history.replaceState(null, "", "/");
    sessionStorage.setItem("gcal_just_connected", "1");
  }
  if (gcalErr) {
    history.replaceState(null, "", "/");
    const msgs = {
      not_configured: "Google Calendar integration not configured.",
      denied: "Google Calendar access was denied.",
      session_expired: "Session expired. Please sign in again.",
      token_failed: "Google Calendar token exchange failed.",
      plan_limit:
        "Your plan’s integration limit is reached. Upgrade to connect more.",
    };
    toast(msgs[gcalErr] || "Google Calendar connection failed.");
    if (gcalErr === "plan_limit" && typeof showPricing === "function")
      showPricing();
  }

  // GitHub callback
  if (githubConn === "1") {
    history.replaceState(null, "", "/");
    sessionStorage.setItem("github_just_connected", "1");
  }
  if (githubErr) {
    history.replaceState(null, "", "/");
    const msgs = {
      not_configured: "GitHub integration not configured.",
      denied: "GitHub access was denied.",
      session_expired: "Session expired. Sign in again.",
      token_failed: "GitHub token exchange failed.",
      plan_limit:
        "Your plan’s integration limit is reached. Upgrade to connect more.",
    };
    toast(msgs[githubErr] || "GitHub connection failed.");
    if (githubErr === "plan_limit" && typeof showPricing === "function")
      showPricing();
  }

  // Paystack billing callback
  if (billing === "success" && billingRef) {
    history.replaceState(null, "", "/");
    sessionStorage.setItem("billing_verify_ref", billingRef);
    sessionStorage.setItem("billing_verify_plan", billingPlan || "");
  }

  // Flutterwave billing callback
  const flwBilling = params.get("flw_billing");
  const flwRef = params.get("ref") || params.get("tx_ref") || "";
  if (flwBilling === "success" && flwRef) {
    history.replaceState(null, "", "/");
    sessionStorage.setItem("flw_verify_ref", flwRef);
    sessionStorage.setItem(
      "flw_verify_plan",
      sessionStorage.getItem("flw_billing_plan") || "",
    );
  }

  // Landing page "Get Started Free" — pre-select the Sign Up tab so it
  // actually differs from "Sign In" (both used to just land on the default
  // Sign In tab).
  if (params.get("auth") === "register") {
    history.replaceState(null, "", "/");
    if (typeof setAuthTab === "function") setAuthTab("register");
  }
}

async function _acceptPendingOrgInvite() {
  const inviteToken = sessionStorage.getItem("pending_org_invite");
  if (!inviteToken) return;
  sessionStorage.removeItem("pending_org_invite");
  const token = getToken() || "";
  if (!token) return;
  try {
    const r = await API("/api/org/join", { token, invite_token: inviteToken });
    if (r.ok) {
      // In-app bell notification (the server also sends a web push).
      try {
        const notifs = JSON.parse(localStorage.getItem(NOTIF_KEY()) || "[]");
        notifs.unshift({
          id: `orgjoin_${Date.now()}`,
          type: "org",
          icon: "🎉",
          msg: `You joined ${r.org_name || "the organization"}`,
          read: false,
          ts: Date.now(),
        });
        localStorage.setItem(NOTIF_KEY(), JSON.stringify(notifs));
      } catch (e) {}
      toast(`You joined ${r.org_name || "the organization"}!`);
      // Reload into the org space (matches orgCreateSpace; refreshes membership).
      sessionStorage.setItem("sivarr_post_create", "org");
      setTimeout(() => location.reload(), 900);
    }
  } catch (e) {
    toast(e.message || "Invite link is invalid or expired.");
  }
}

// Shared invite-accept (used by the email-link path, the bell, and the prompt).


// Pull any pending org invites for this account's email on sign-in (so an invite
// isn't lost if the email was missed), surface them in the bell, and prompt.




// CSP migration: dismiss the email-verify banner (this.closest(...).style
// mutation -- a DOM expression, not a plain this reference).
window._hideVerifyBanner = function (el) {
  const banner = el.closest("#verify-banner");
  if (banner) banner.style.display = "none";
};

async function resendVerificationEmail() {
  const token = getSavedSession()?.token;
  if (!token) return;
  try {
    await API("/api/auth/resend-verification", { token });
    toast("Verification email resent. Check your inbox.");
  } catch (e) {
    toast("Could not resend. Please try again shortly.");
  }
}

async function requestVerificationEmail(email) {
  try {
    await API("/api/auth/request-verification", { email });
    toast("Verification email sent. Check your inbox (and spam folder).");
  } catch (e) {
    toast("Could not resend. Try again in a moment.");
  }
}

// Let a passwordless (Google) account set an email/password via the reset flow.
// Safe against takeover: the link is delivered to the account's real inbox, so
// only the email owner can complete it.
async function sendSetPasswordLink(email) {
  try {
    await API("/api/auth/forgot-password", { email });
    toast("Check your inbox. We sent a link to set your password.");
  } catch (e) {
    toast("Could not send the link. Try again shortly.");
  }
}

// Render an inline "set a password" action under the auth error line.
function _authOfferSetPassword(err, email, leadText) {
  if (!err) return;
  err.textContent = leadText + " ";
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "Email me a link to set a password";
  b.style.cssText =
    "display:block;margin-top:6px;background:none;border:none;cursor:pointer;color:var(--teal);text-decoration:underline;padding:0;font-size:.82rem";
  b.onclick = () => sendSetPasswordLink(email);
  err.appendChild(b);
}

// ── Google Sign-In helpers ────────────────────────────────────────────────────

function googleSignInStart(e) {
  const btn = $("btn-google");
  const txt = $("google-btn-text");
  if (btn) {
    btn.style.opacity = "0.7";
    btn.style.pointerEvents = "none";
  }
  if (txt) txt.textContent = "Redirecting to Google…";
  // Let the href navigate — no e.preventDefault()
}

async function _googleCheckAvailable() {
  try {
    const r = await fetch("/api/config");
    const d = await r.json();
    if (d.google_oauth === false) {
      const or = $("google-or");
      const btn = $("btn-google");
      if (or) or.style.display = "none";
      if (btn) btn.style.display = "none";
    }
  } catch (_) {
    /* silently ignore — show button by default */
  }
}

// Auto-restore on page load — try token first, fall back to re-login
window.addEventListener("DOMContentLoaded", async () => {
  localStorage.removeItem("sivarr_lecturer_token");
  localStorage.removeItem("sivarr_lecturer_name");

  // Restore accent colour immediately — before anything renders
  const _sa = localStorage.getItem("sivarr_accent");
  if (_sa) _applyAccentColor(_sa, localStorage.getItem("sivarr_accent2") || "");

  // Check if Google OAuth is available (hide button if not configured)
  _googleCheckAvailable();

  // Handle ?reset= / ?verify= / ?verified= URL params before anything else
  checkAuthParams();

  // Google OAuth — exchange one-time code for full session data (with retries)
  // The exchange endpoint returns the same shape as /api/login so we can call
  // _applyLoginData directly — no second cross-worker restoreSession needed.
  const googleCode = sessionStorage.getItem("google_login_pending_code");
  if (googleCode) {
    sessionStorage.removeItem("google_login_pending_code");
    const btn = $("login-btn");
    if (btn) {
      btn.textContent = "Signing in with Google…";
      btn.disabled = true;
    }
    const MAX_ATTEMPTS = 5;
    const RETRY_DELAY = 700;
    let lastErr = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 0)
          await new Promise((res) => setTimeout(res, RETRY_DELAY * attempt));
        const r = await fetch(
          `/api/auth/google/exchange?code=${encodeURIComponent(googleCode)}`,
        );
        const d = await r.json();
        if (!r.ok || !d.token) {
          lastErr = d.detail || "Exchange failed";
          continue;
        }
        setToken(d.token);
        saveSession(d.name, d.email, d.token);
        _applyLoginData(d);
        toast("Signed in with Google!");
        _postLoginIntegrations();
        return;
      } catch (e) {
        lastErr = e.message || "Network error";
      }
    }
    toast("Google sign-in failed. Please try again.");
    if (btn) {
      btn.textContent = "Sign In";
      btn.disabled = false;
    }
    return;
  }

  // Legacy fallback — direct google_token (kept for safety)
  const googlePending = sessionStorage.getItem("google_login_pending");
  if (googlePending) {
    sessionStorage.removeItem("google_login_pending");
    const btn = $("login-btn");
    if (btn) {
      btn.textContent = "Signing in with Google…";
      btn.disabled = true;
    }
    const ok = await restoreSession(googlePending);
    if (ok) {
      toast("Signed in with Google!");
      _postLoginIntegrations();
      return;
    }
    toast("Google sign-in failed. Please try again.");
    if (btn) {
      btn.textContent = "Sign In";
      btn.disabled = false;
    }
    return;
  }

  const saved = getSavedSession();
  if (!saved) return;

  const btn = $("login-btn");
  if (btn) {
    btn.textContent = "Resuming session...";
    btn.disabled = true;
  }

  // Token restore — no password required. With cookie-auth the in-memory token is
  // empty after a reload, so ALWAYS attempt restore: /api/session/restore
  // authenticates from the httpOnly cookie when no token is sent. restoreSession
  // returns false (→ login form) if there's no valid session cookie.
  {
    const ok = await restoreSession(saved.token || "");
    if (ok) {
      _postLoginIntegrations();
      return;
    }
    toast("Your session expired. Please sign in again.");
  }

  // Fallback: pre-fill email and show login form for expired/invalid tokens
  if (saved.email && $("lm")) $("lm").value = saved.email;
  if (btn) {
    btn.textContent = "Sign In";
    btn.disabled = false;
  }
});

function _postLoginIntegrations() {
  // Google Calendar just connected
  if (sessionStorage.getItem("gcal_just_connected")) {
    sessionStorage.removeItem("gcal_just_connected");
    toast("Google Calendar connected!");
    gcalCheckStatus();
  }
  // GitHub just connected
  if (sessionStorage.getItem("github_just_connected")) {
    sessionStorage.removeItem("github_just_connected");
    toast("GitHub connected!");
    githubCheckStatus();
  }
  // Paystack billing just returned
  const bilRef = sessionStorage.getItem("billing_verify_ref");
  const bilPlan = sessionStorage.getItem("billing_verify_plan");
  if (bilRef) {
    sessionStorage.removeItem("billing_verify_ref");
    sessionStorage.removeItem("billing_verify_plan");
    billingVerify(bilRef, bilPlan);
  }

  // Flutterwave billing just returned
  const flwRef = sessionStorage.getItem("flw_verify_ref");
  const flwPlan = sessionStorage.getItem("flw_verify_plan");
  if (flwRef) {
    sessionStorage.removeItem("flw_verify_ref");
    sessionStorage.removeItem("flw_verify_plan");
    sessionStorage.removeItem("flw_billing_plan");
    flutterwaveVerify(flwRef, flwPlan);
  }

  // Set up browser push notifications (silent — user won't see this unless they approve)
  setTimeout(_pushSetup, 2000);
}

// ═══════════════════════ BROWSER PUSH NOTIFICATIONS ═════════════════════

function _urlBase64ToUint8Array(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function _pushSetup() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch("/api/push/vapid-public");
    const data = await res.json();
    if (!data.available || !data.public_key) return;

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(data.public_key),
      });
    }
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, subscription: sub.toJSON() }),
    });
  } catch (_) {
    // Push is optional — fail silently
  }
}

["ln", "lm"].forEach((id, i) => {
  const el = $(id);
  if (el)
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") i === 0 ? $("lm").focus() : doLogin();
    });
});

// Register service worker for PWA install + offline support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        // Listen for FLUSH_QUEUE messages from service worker background sync
        navigator.serviceWorker.addEventListener("message", (e) => {
          if (e.data?.type === "FLUSH_QUEUE") _flushOfflineQueue();
        });
      })
      .catch((err) => console.warn("SW registration failed:", err));
  });
}

// ═══════════════════════ OFFLINE SUPPORT ════════════════════════

const _OFFLINE_QUEUE_KEY = "sivarr_offline_queue";
let _offlineQueue = JSON.parse(
  localStorage.getItem(_OFFLINE_QUEUE_KEY) || "[]",
);

function _showOfflineBanner() {
  const b = $("offline-banner");
  if (b) b.style.display = "flex";
  document.body.classList.add("offline");
  _updateOfflineCount();
}

function _hideOfflineBanner() {
  const b = $("offline-banner");
  if (b) b.style.display = "none";
  document.body.classList.remove("offline");
}

function _updateOfflineCount() {
  const el = $("offline-queue-count");
  if (el && _offlineQueue.length) {
    el.textContent = `${_offlineQueue.length} change${_offlineQueue.length > 1 ? "s" : ""} pending`;
  } else if (el) {
    el.textContent = "";
  }
}

// Queue a POST API call for when we're back online
function _queueMutation(url, body) {
  const token = getToken() || "";
  _offlineQueue.push({
    url,
    body: JSON.stringify({ ...body, token }),
    ts: Date.now(),
  });
  localStorage.setItem(_OFFLINE_QUEUE_KEY, JSON.stringify(_offlineQueue));
  _updateOfflineCount();
}

// Flush queued mutations after reconnecting
async function _flushOfflineQueue() {
  if (!_offlineQueue.length || !navigator.onLine) return;
  const queue = [..._offlineQueue];
  _offlineQueue = [];
  localStorage.removeItem(_OFFLINE_QUEUE_KEY);
  let flushed = 0;
  for (const item of queue) {
    try {
      const body = JSON.parse(item.body);
      // Always use the current session token (original may have expired)
      const token = getToken();
      if (token && body.token !== undefined) body.token = token;
      const r = await fetch(item.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) flushed++;
      else _offlineQueue.push(item);
    } catch (_) {
      _offlineQueue.push(item);
    }
  }
  if (_offlineQueue.length) {
    localStorage.setItem(_OFFLINE_QUEUE_KEY, JSON.stringify(_offlineQueue));
  }
  _updateOfflineCount();
  if (flushed > 0)
    toast(`${flushed} offline change${flushed > 1 ? "s" : ""} synced ✓`);
}

// Online / offline event handlers
window.addEventListener("offline", () => {
  _showOfflineBanner();
});

window.addEventListener("online", async () => {
  _hideOfflineBanner();
  await _flushOfflineQueue();
  // Try Background Sync if supported
  if ("serviceWorker" in navigator && "SyncManager" in window) {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (reg) reg.sync.register("sivarr-sync").catch(() => {});
  }
});

// Show banner immediately if already offline on load
if (!navigator.onLine) _showOfflineBanner();

// ═══════════════════════ AUTOSAVE SYSTEM ════════════════════════

let _unsavedChanges = false;
let _saveStatusTimer = null;
let _jnlDraftTimer = null;

function _saveStatus(state) {
  const el = $("global-save-status");
  clearTimeout(_saveStatusTimer);
  const cfg = {
    unsaved: { text: "● Unsaved", color: "var(--coral)" },
    saving: { text: "● Saving…", color: "var(--text3)" },
    saved: { text: "✓ Saved", color: "var(--teal)" },
  };
  const c = cfg[state];
  _unsavedChanges = state === "unsaved" || state === "saving";
  if (el) {
    el.textContent = c ? c.text : "";
    el.style.color = c ? c.color : "";
  }
  if (state === "saved") {
    _saveStatusTimer = setTimeout(() => {
      if (el) el.textContent = "";
      _unsavedChanges = false;
    }, 2500);
  }
}

// Warn before tab close / navigation when there are unsaved edits
window.addEventListener("beforeunload", (e) => {
  if (_unsavedChanges) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// Journal input → debounced draft autosave
function _jnlInput() {
  _saveStatus("unsaved");
  clearTimeout(_jnlDraftTimer);
  _jnlDraftTimer = setTimeout(() => {
    const ta = $("journal-text");
    if (!ta?.value?.trim()) return;
    const today = new Date().toISOString().split("T")[0];
    localStorage.setItem(`${JNL_KEY()}_jnl_draft_${today}`, ta.value.trim());
    _saveStatus("saved");
  }, 1500);
}

// Note textarea → track unsaved, persist draft
function _noteInput() {
  const ta = $("new-note-text");
  if (!ta) return;
  if (ta.value.trim()) {
    localStorage.setItem(`sivarr_note_draft_${S.sid}`, ta.value);
    _saveStatus("unsaved");
  } else {
    localStorage.removeItem(`sivarr_note_draft_${S.sid}`);
    _saveStatus("saved");
  }
}

// Wire journal textarea after DOM is ready
window.addEventListener("DOMContentLoaded", () => {
  const jnl = $("journal-text");
  if (jnl) jnl.addEventListener("input", _jnlInput);
  const noteTA = $("new-note-text");
  if (noteTA) noteTA.addEventListener("input", _noteInput);
});

// ═══════════════════════════ ATTACHMENTS ════════════════════════

let ATTACHMENTS = []; // { name, type, content (base64 or text) }

function toggleAttachMenu() {
  const menu = $("attach-menu");
  const btn = $("attach-btn");
  if (!menu) return;
  const open = menu.style.display === "block";
  menu.style.display = open ? "none" : "block";
  btn.style.borderColor = open ? "var(--border)" : "var(--accent)";
  btn.style.color = open ? "var(--muted)" : "var(--accent)";
}

// CSP migration: multi-statement (trigger the attach flow, then close the
// "+" menu it was opened from).
window._triggerAttachThenCloseMenu = function (type) {
  triggerAttach(type);
  closeChatMenu();
};

function triggerAttach(type) {
  $("attach-menu").style.display = "none";
  $("attach-btn").style.borderColor = "var(--border)";
  $("attach-btn").style.color = "var(--muted)";
  const inputMap = {
    image: "attach-image-input",
    pdf: "attach-pdf-input",
    file: "attach-file-input",
    doc: "attach-doc-input",
  };
  $(inputMap[type])?.click();
}

// CSP migration: param order flipped to (type, input) -- delegate.js's
// data-onchange-this always appends the element LAST. All 4 call sites are
// the hidden file inputs just above in templates/_panels_core.html.
function handleAttach(type, input) {
  const file = input.files[0];
  if (!file) return;

  const MAX = 5 * 1024 * 1024;
  if (file.size > MAX) {
    toast("File too large. Max 5MB.");
    input.value = "";
    return;
  }

  const reader = new FileReader();

  if (type === "image") {
    reader.onload = (e) => {
      ATTACHMENTS.push({
        name: file.name,
        type: "image",
        content: e.target.result,
      });
      renderAttachPreview();
      toast(`Image attached: ${file.name}`);
    };
    reader.readAsDataURL(file);
  } else {
    reader.onload = (e) => {
      ATTACHMENTS.push({ name: file.name, type, content: e.target.result });
      renderAttachPreview();
      toast(`Attached: ${file.name}`);
    };
    reader.readAsText(file);
  }
  input.value = "";
}

function renderAttachPreview() {
  const strip = $("attach-preview");
  if (!strip) return;
  if (!ATTACHMENTS.length) {
    strip.style.display = "none";
    return;
  }
  strip.style.display = "flex";
  strip.innerHTML = ATTACHMENTS.map(
    (a, i) => `
    <div class="attach-chip">
      <span>${a.type === "image" ? "🖼️" : a.type === "pdf" ? "📄" : "📎"}</span>
      ${esc(a.name)}
      <button data-onclick="removeAttach" data-onclick-args="[${i}]">✕</button>
    </div>`,
  ).join("");
}

function removeAttach(idx) {
  ATTACHMENTS.splice(idx, 1);
  renderAttachPreview();
}

// Close attach menu when clicking outside
document.addEventListener("click", (e) => {
  const menu = $("attach-menu");
  const btn = $("attach-btn");
  if (menu && btn && !menu.contains(e.target) && e.target !== btn) {
    menu.style.display = "none";
    btn.style.borderColor = "var(--border)";
    btn.style.color = "var(--muted)";
  }
});

/* ══════════════════════════════════════════════════════════════
   Sivarr CONTEXT ENGINE
   Reads all local data stores and builds a rich snapshot that
   gets injected into the first message of each chat session,
   giving Sivarr genuine awareness of the user's world.
   ══════════════════════════════════════════════════════════════ */

let _contextSent = false; // reset to false on each login
let _chatMsgCount = 0; // messages sent this session

// ── Activity streak (fires across all features) ───────────────
function _recordActivity() {
  if (!S.sid) return;
  const key = `sivarr_streak_${S.sid}`;
  const today = new Date().toDateString();
  try {
    const d = JSON.parse(localStorage.getItem(key) || "{}");
    if (d.last === today) return;
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    const streak = d.last === yesterday ? (d.streak || 0) + 1 : 1;
    localStorage.setItem(key, JSON.stringify({ last: today, streak }));
    // Fire daily_open automation on first visit of the day
    _autoFire("daily_open", {
      journalPrompt: "What's on my mind today? ",
      followUpTask: "Today's top priority",
    });
  } catch (_) {}
}

function _getActivityStreak() {
  if (!S.sid) return 0;
  try {
    const d = JSON.parse(
      localStorage.getItem(`sivarr_streak_${S.sid}`) || "{}",
    );
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (d.last === today || d.last === yesterday) return d.streak || 0;
    return 0;
  } catch (_) {
    return 0;
  }
}

// ── Lightweight micro-context for messages 2+ ─────────────────
function buildMicroContext() {
  if (!S.sid) return "";
  try {
    const tasks = JSON.parse(
      localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
    ).filter((t) => !t.done);
    const goals = JSON.parse(
      localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
    ).filter((g) => !g.completed);
    const streak = _getActivityStreak();
    const parts = [];
    if (tasks.length) parts.push(`${tasks.length} open tasks`);
    if (goals.length)
      parts.push(
        `top goal: ${goals[0].title}${goals[0].progress ? ` ${goals[0].progress}%` : ""}`,
      );
    if (streak > 1) parts.push(`${streak}-day streak`);
    return parts.length ? `[Context: ${parts.join(" · ")}] ` : "";
  } catch (_) {
    return "";
  }
}

// ── Proactive greeting in chat (once per day) ─────────────────
function chatProactiveGreet() {
  if (!S.sid) return;
  const today = new Date().toDateString();
  const key = `sivarr_greeted_${S.sid}`;
  if (localStorage.getItem(key) === today) return;

  const welcome = $("chat-welcome");
  if (!welcome || welcome.style.display === "none") return;

  const firstName = S.name.split(" ")[0];
  const hr = new Date().getHours();
  const tod = hr < 12 ? "Morning" : hr < 17 ? "Afternoon" : "Evening";

  const tasks = JSON.parse(
    localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
  ).filter((t) => !t.done);
  const goals = JSON.parse(
    localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
  ).filter((g) => !g.completed);
  const jnl = JSON.parse(
    localStorage.getItem(`sivarr_journal_${S.sid}`) || "[]",
  );
  const habits = JSON.parse(
    localStorage.getItem(`sivarr_habits_${S.sid}`) || "[]",
  );
  const bestStreak = habits.reduce((m, h) => Math.max(m, h.streak || 0), 0);
  const today8601 = new Date().toISOString().split("T")[0];
  const journaledToday = jnl.some((e) => e.date === today8601);

  const lines = [`${tod}, ${firstName}.`];
  if (tasks.length)
    lines.push(
      `You have **${tasks.length} task${tasks.length > 1 ? "s" : ""}** open.`,
    );
  if (goals.length)
    lines.push(
      `Your **${goals[0].title}** goal is at ${goals[0].progress || 0}%.`,
    );
  if (bestStreak >= 3)
    lines.push(`🔥 ${bestStreak}-day habit streak, don't break it.`);
  if (!journaledToday && jnl.length)
    lines.push(`Haven't journalled today yet.`);
  if (!tasks.length && !goals.length)
    lines.push(
      `Your slate is clean. Good time to set a goal or plan your week.`,
    );
  lines.push(`What are we working on?`);

  welcome.style.display = "none";
  addMsg("sivarr", lines.join(" "), false, false);
  localStorage.setItem(key, today);
}

async function buildSivarrContext() {
  if (!S.sid) return "";
  const sid = S.sid;
  const today = new Date().toDateString();
  const lines = [`Sivarr CONTEXT SNAPSHOT for ${S.name} — ${today}`];

  // ── Tasks ─────────────────────────────────────────────────
  try {
    const tasks = JSON.parse(
      localStorage.getItem(`sivarr_tasks_${sid}`) || "[]",
    );
    const open = tasks.filter((t) => !t.done);
    const done = tasks.filter((t) => t.done);
    if (open.length) {
      lines.push(
        `Open tasks (${open.length}): ${open
          .slice(0, 6)
          .map((t) => t.title || t.text || "")
          .filter(Boolean)
          .join(" | ")}`,
      );
    }
    if (done.length) lines.push(`Tasks completed so far: ${done.length}`);
  } catch (_) {}

  // ── Goals ─────────────────────────────────────────────────
  try {
    const goals = JSON.parse(
      localStorage.getItem(`sivarr_goals_${sid}`) || "[]",
    );
    const active = goals.filter((g) => !g.done);
    if (active.length) {
      lines.push(
        `Active goals (${active.length}): ${active
          .slice(0, 4)
          .map((g) => {
            const pct = g.progress !== undefined ? ` — ${g.progress}%` : "";
            const due = g.deadline ? ` (due ${g.deadline})` : "";
            return (g.title || "") + pct + due;
          })
          .filter(Boolean)
          .join(" | ")}`,
      );
    }
    const completedGoals = goals.filter((g) => g.done);
    if (completedGoals.length)
      lines.push(`Goals achieved: ${completedGoals.length}`);
  } catch (_) {}

  // ── Habits ────────────────────────────────────────────────
  try {
    const habits = JSON.parse(
      localStorage.getItem(`sivarr_habits_${sid}`) || "[]",
    );
    if (habits.length) {
      lines.push(
        `Tracked habits: ${habits
          .slice(0, 5)
          .map((h) => {
            const streak = h.streak ? ` (${h.streak}-day streak)` : "";
            return (h.name || h.title || "") + streak;
          })
          .filter(Boolean)
          .join(" | ")}`,
      );
    }
  } catch (_) {}

  // ── Journal ───────────────────────────────────────────────
  try {
    const journal = JSON.parse(
      localStorage.getItem(`sivarr_journal_${sid}`) || "[]",
    );
    if (journal.length) {
      const recent = journal[journal.length - 1];
      const text = (recent.text || recent.content || recent.entry || "")
        .trim()
        .slice(0, 200);
      const date = recent.date || recent.created || "";
      if (text)
        lines.push(
          `Latest journal entry${date ? ` (${date})` : ""}: "${text}${text.length === 200 ? "…" : ""}"`,
        );
      lines.push(`Total journal entries: ${journal.length}`);
    }
  } catch (_) {}

  // ── Focus sessions ────────────────────────────────────────
  try {
    const focusLog = JSON.parse(
      localStorage.getItem(`sivarr_focus_log_${sid}`) || "[]",
    );
    if (focusLog.length) {
      const totalMins = focusLog.reduce((s, f) => s + (f.duration || 0), 0);
      const lastTask = focusLog[focusLog.length - 1]?.task || "";
      lines.push(
        `Focus sessions: ${focusLog.length} sessions, ${totalMins} total minutes`,
      );
      if (lastTask) lines.push(`Last focus task: "${lastTask}"`);
    }
  } catch (_) {}

  // ── Calendar events ───────────────────────────────────────
  try {
    const events = JSON.parse(
      localStorage.getItem(`sivarr_events_${sid}`) || "[]",
    );
    const nowMs = Date.now();
    const upcoming = events
      .filter((e) => e.date && new Date(e.date).getTime() >= nowMs)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 3);
    if (upcoming.length) {
      lines.push(
        `Upcoming events: ${upcoming.map((e) => `${e.title || ""} on ${e.date}`).join(" | ")}`,
      );
    }
  } catch (_) {}

  // ── Profile ───────────────────────────────────────────────
  try {
    const prof = JSON.parse(
      localStorage.getItem(`sivarr_profile_${sid}`) || "{}",
    );
    if (prof.bio) lines.push(`User bio: "${prof.bio}"`);
    if (prof.skills?.length) lines.push(`Skills: ${prof.skills.join(", ")}`);
  } catch (_) {}

  // ── Courses / Topics ──────────────────────────────────────
  try {
    if (S.topics?.length)
      lines.push(`Study topics: ${S.topics.slice(0, 6).join(", ")}`);
  } catch (_) {}

  // ── Organization (fetched from server) ───────────────────
  try {
    const _tok = getToken() || "";
    const snapRes = _tok
      ? await fetch(`/api/context/snapshot?token=${encodeURIComponent(_tok)}`)
      : null;
    const snap = snapRes?.ok ? await snapRes.json() : null;
    if (snap?.org) {
      const o = snap.org;
      lines.push(
        `Organization: ${o.name} (role: ${o.role}, members: ${o.members})`,
      );
      if (o.open_tasks?.length)
        lines.push(`Org open tasks: ${o.open_tasks.join(" | ")}`);
      if (o.overdue_tasks?.length)
        lines.push(`Org OVERDUE tasks: ${o.overdue_tasks.join(" | ")}`);
      if (o.active_goals?.length)
        lines.push(
          `Org active goals: ${o.active_goals.map((g) => `${g.title} (${g.progress}%)`).join(" | ")}`,
        );
    }
  } catch (_) {}

  if (lines.length <= 1) return ""; // only the header, no data yet
  return lines.join("\n");
}

let _lastFailedMsg = null;
let _lastUserMsg = null;

async function send(retryText = null) {
  const ci = $("ci");
  const msg = retryText || ci?.value.trim() || "";
  if (!msg && !ATTACHMENTS.length) return;
  if (!S.sid) return;

  // Build full message with attachment context
  let fullMsg = msg;
  if (ATTACHMENTS.length) {
    const attachContext = ATTACHMENTS.map((a) =>
      a.type === "image"
        ? `[Image attached: ${a.name}]`
        : `[File attached: ${a.name}]\n\nContent:\n${a.content.slice(0, 3000)}`,
    ).join("\n\n");
    fullMsg = msg ? `${msg}\n\n${attachContext}` : attachContext;
  }

  // Show user bubble only on original send, not retry
  if (!retryText) {
    const displayMsg = msg || `📎 ${ATTACHMENTS.map((a) => a.name).join(", ")}`;
    addMsg("user", displayMsg);
    if (ATTACHMENTS.length) {
      ATTACHMENTS = [];
      renderAttachPreview();
    }
    if (ci) {
      ci.value = "";
      ci.style.height = "auto";
    }
  }

  const btn = $("sb");
  if (btn) btn.disabled = true;

  // Always inject context: full snapshot on message 1 and every 8 messages, micro-context otherwise
  let context = "";
  if (!retryText) {
    _chatMsgCount++;
    const needFullContext = !_contextSent || _chatMsgCount % 8 === 0;
    if (needFullContext) {
      context = await buildSivarrContext();
      _contextSent = true;
    } else {
      context = buildMicroContext();
    }
  }

  _lastUserMsg = fullMsg;
  const r = await _chatStream(fullMsg, context);
  if (r && !r.error) {
    _lastFailedMsg = null;
    S.stats.questions++;
    updateSBStats();
    refreshTopics();
    chatCounterDecrement();
    track("Chat_Sent");
    _recordActivity();
  }
}

function retryChat() {
  if (!_lastFailedMsg) return;
  const msgs = $("msgs");
  if (msgs) {
    const errBubs = msgs.querySelectorAll(".msg-error");
    if (errBubs.length) errBubs[errBubs.length - 1].closest(".msg")?.remove();
  }
  const txt = _lastFailedMsg;
  _lastFailedMsg = null;
  send(txt);
}

function chatRegenerate() {
  if (!_lastUserMsg) return;
  const msgs = $("msgs");
  if (msgs) {
    const aiBubbles = msgs.querySelectorAll(".msg.sivarr");
    if (aiBubbles.length) aiBubbles[aiBubbles.length - 1].remove();
  }
  _chatStream(_lastUserMsg, "");
}

async function _chatStream(fullMsg, context) {
  const btn = $("sb");
  if (btn) btn.disabled = true;
  _chatSetStatus(true);

  let res;
  try {
    const token = getToken() || "";
    res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: S.sid, message: fullMsg, context, token }),
    });
  } catch {
    _chatSetStatus(false);
    if (btn) btn.disabled = false;
    addMsg(
      "sivarr",
      'Could not reach Sivarr. Check your connection and tap "Try again".',
      false,
      true,
    );
    _lastFailedMsg = fullMsg;
    return null;
  }

  if (!res.ok) {
    _chatSetStatus(false);
    if (btn) btn.disabled = false;
    if (res.status === 401) {
      addMsg(
        "sivarr",
        "Your session expired. Please sign in again to keep chatting.",
        false,
        true,
      );
    } else if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      // Daily free-tier cap returns a descriptive `detail`; per-minute rate limit returns retryAfter.
      const limitMsg =
        data.detail ||
        `You've sent a lot of messages. Please wait ${data.retryAfter || 60} seconds before trying again.`;
      addMsg("sivarr", limitMsg, false, true);
    } else {
      addMsg(
        "sivarr",
        'Could not reach Sivarr. Check your connection and tap "Try again".',
        false,
        true,
      );
      _lastFailedMsg = fullMsg;
    }
    return null;
  }

  // Create streaming bubble
  const welcome = $("chat-welcome");
  if (welcome) welcome.style.display = "none";
  const w = $("msgs");
  const d = document.createElement("div");
  d.className = "msg sivarr";
  d.innerHTML = `<div class="msg-av">AI</div><div class="msg-inner"><div class="msg-bub md-body" style="min-height:1.4em"></div></div>`;
  w.appendChild(d);
  scrollMsgs();

  const msgId = Date.now();
  d.dataset.msgId = msgId;
  const bub = d.querySelector(".msg-bub");
  const slowTimer = setTimeout(() => {
    if (!bub.textContent.trim()) bub.textContent = "Thinking…";
  }, 8000);
  let fullText = "",
    isError = false,
    suggestions = [];

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") break outer;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.done) {
            suggestions = parsed.suggestions || [];
            break outer;
          }
          if (parsed.token) {
            fullText += parsed.token;
            isError = parsed.error || false;
            bub.textContent = fullText + "▌";
            scrollMsgs();
          }
        } catch {}
      }
    }
  } catch {
    clearTimeout(slowTimer);
    _chatSetStatus(false);
    if (btn) btn.disabled = false;
    bub.classList.add("msg-error");
    bub.innerHTML =
      'Stream interrupted. <button class="chat-retry-btn" data-onclick="retryChat">↻ Try again</button>';
    _lastFailedMsg = fullMsg;
    return null;
  }

  clearTimeout(slowTimer);

  // Finalise: render markdown, reactions, action buttons, suggestion pills
  bub.innerHTML = isError
    ? `<span class="msg-error">${esc(fullText)}</span>`
    : renderMarkdown(fullText);
  const inner = d.querySelector(".msg-inner");
  if (!isError) {
    inner.insertAdjacentHTML(
      "beforeend",
      `
      <div class="msg-actions">
        <button class="msg-action-btn" data-onclick="chatSaveTask" data-onclick-this>+ Task</button>
        <button class="msg-action-btn" data-onclick="chatSaveNote" data-onclick-this>+ Note</button>
        <button class="msg-action-btn" data-onclick="chatCopyMsg" data-onclick-this>Copy</button>
        <button class="msg-action-btn" data-onclick="chatRegenerate" title="Regenerate response">↻</button>
        <button class="msg-action-btn" data-onclick="_chatDownloadFromBtn" data-onclick-this>⬇ Save</button>
        <button class="msg-action-btn chat-react-btn" data-val="up"   data-onclick="chatReact" data-onclick-arg0="up"   data-onclick-this title="Good response">👍</button>
        <button class="msg-action-btn chat-react-btn" data-val="down" data-onclick="chatReact" data-onclick-arg0="down" data-onclick-this title="Bad response">👎</button>
      </div>`,
    );
    if (suggestions.length) {
      inner.insertAdjacentHTML(
        "beforeend",
        `
        <div class="chat-suggestions">
          ${suggestions.map((s) => `<button class="chat-sug-pill" data-onclick="quickPrompt" data-onclick-arg0="${esc(s)}">${esc(s)}</button>`).join("")}
        </div>`,
      );
    }
  } else {
    _lastFailedMsg = fullMsg;
    inner.insertAdjacentHTML(
      "beforeend",
      `<button class="chat-retry-btn" data-onclick="retryChat">↻ Try again</button>`,
    );
  }

  _chatSetStatus(false);
  if (btn) btn.disabled = false;
  scrollMsgs();
  return { reply: fullText, uncertain: false, error: isError };
}

// CSP migration: param order flipped to (val, btn) -- delegate.js's
// data-onclick-this always appends the element LAST, never first. Both
// call sites are the two reaction buttons just above.
function chatReact(val, btn) {
  const msgId = btn.closest(".msg")?.dataset.msgId;
  if (!msgId || !S.sid) return;
  const key = `sivarr_chat_reactions_${S.sid}`;
  const store = JSON.parse(localStorage.getItem(key) || "{}");
  const cur = store[msgId];
  store[msgId] = cur === val ? null : val; // toggle off if same
  localStorage.setItem(key, JSON.stringify(store));
  // Update visuals in the message
  btn
    .closest(".msg-actions")
    .querySelectorAll(".chat-react-btn")
    .forEach((b) => {
      const active = store[msgId] === b.dataset.val;
      b.style.background = active ? "var(--teal2,rgba(13,122,95,.1))" : "";
      b.style.borderColor = active ? "var(--accent)" : "";
      b.style.fontWeight = active ? "700" : "";
    });
}

/* Daily message counter — resets at midnight */
const CHAT_LIMIT = 20;
function chatCounterKey() {
  return `sivarr_chat_count_${new Date().toDateString()}_${S.sid}`;
}
function chatCounterGet() {
  return parseInt(localStorage.getItem(chatCounterKey()) || "0", 10);
}
function chatCounterDecrement() {
  const used = chatCounterGet() + 1;
  localStorage.setItem(chatCounterKey(), used);
  chatCounterRender(used);
}
function chatCounterRender(used) {
  const el = $("chat-msg-counter");
  if (!el) return;
  const left = Math.max(0, CHAT_LIMIT - used);
  el.textContent = `${left} msg${left !== 1 ? "s" : ""} left today`;
  el.style.color = left <= 5 ? "var(--coral)" : "var(--text4)";
}
function chatCounterInit() {
  chatCounterRender(chatCounterGet());
}

function quickPrompt(text) {
  // Hide welcome screen, set input, and send
  const welcome = $("chat-welcome");
  if (welcome) welcome.style.display = "none";
  const ci = $("ci");
  if (ci) {
    ci.value = text;
    ci.style.height = "auto";
  }
  send();
}

function addMsg(role, text, uncertain = false, isError = false) {
  const welcome = $("chat-welcome");
  if (welcome) welcome.style.display = "none";

  const w = $("msgs");
  const d = document.createElement("div");
  d.className = `msg ${role}`;

  const isAI = role === "sivarr";
  const av = isAI ? "AI" : S.name?.[0]?.toUpperCase() || "U";
  const rendered = isAI ? renderMarkdown(text) : esc(text);
  const errClass = isError ? " msg-error" : "";

  d.innerHTML = `
    <div class="msg-av">${av}</div>
    <div class="msg-inner">
      <div class="msg-bub md-body${errClass}">${rendered}</div>
      ${uncertain ? `<div class="uncertain"><i class="ti ti-alert-triangle"></i> Verify with your lecturer</div>` : ""}
      ${isError ? `<button class="chat-retry-btn" data-onclick="retryChat">↻ Try again</button>` : ""}
      ${
        isAI && !isError
          ? `
        <div class="msg-actions">
          <button class="msg-action-btn" data-onclick="chatSaveTask" data-onclick-this>+ Task</button>
          <button class="msg-action-btn" data-onclick="chatSaveNote" data-onclick-this>+ Note</button>
          <button class="msg-action-btn" data-onclick="chatCopyMsg" data-onclick-this>Copy</button>
          <button class="msg-action-btn" data-onclick="chatRegenerate" title="Regenerate response">↻</button>
          <button class="msg-action-btn" data-onclick="_chatDownloadFromBtn" data-onclick-this>⬇ Save</button>
        </div>`
          : ""
      }
    </div>`;
  w.appendChild(d);
  scrollMsgs();
  return d;
}

function chatCopyMsg(btn) {
  const text = btn.closest(".msg").querySelector(".msg-bub")?.innerText || "";
  navigator.clipboard?.writeText(text).then(() => toast("Copied ✓"));
}

// ── Agent selector ─────────────────────────────────────────
let _activeAgent = "siva";

function agentSelect(id, btn) {
  if (_activeAgent === id) return;
  _activeAgent = id;
  document
    .querySelectorAll(".agent-chip")
    .forEach((c) => c.classList.remove("active"));
  if (btn) btn.classList.add("active");
}

function agentSelectLocked(id) {
  const labels = {
    claude: "Claude (Anthropic)",
    gpt4: "GPT-4 (OpenAI)",
    perplexity: "Perplexity",
  };
  toast(`${labels[id] || id} integration coming soon ✦`);
}

// ── Chat add-menu ("+" popover) ─────────────────────────────
function toggleChatMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById("chat-add-menu");
  const btn = document.getElementById("chat-add-btn");
  if (!menu) return;
  const open = menu.classList.toggle("open");
  if (btn) btn.classList.toggle("open", open);
  if (open) {
    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== btn) {
        menu.classList.remove("open");
        if (btn) btn.classList.remove("open");
        document.removeEventListener("click", close);
      }
    };
    setTimeout(() => document.addEventListener("click", close), 10);
  }
}
function closeChatMenu() {
  const menu = document.getElementById("chat-add-menu");
  const btn = document.getElementById("chat-add-btn");
  if (menu) menu.classList.remove("open");
  if (btn) btn.classList.remove("open");
}
function agentSelectCam(id, btn) {
  _activeAgent = id;
  document
    .querySelectorAll(".cam-model")
    .forEach((c) => c.classList.remove("cam-active"));
  if (btn) btn.classList.add("cam-active");
  closeChatMenu();
}

async function chatClearConfirm() {
  const ok = await siModal.confirm("Clear this conversation?", {
    title: "Clear chat",
    confirmLabel: "Clear",
    danger: true,
  });
  if (!ok) return;
  const w = $("msgs");
  if (!w) return;
  w.innerHTML = "";
  const welcome = document.createElement("div");
  welcome.id = "chat-welcome";
  welcome.innerHTML = document.getElementById("chat-welcome")?.outerHTML
    ? $("panel-chat").querySelector("#chat-welcome")?.outerHTML || ""
    : "";
  // Simpler: reload the welcome screen
  w.innerHTML = `<div id="chat-welcome" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100%;padding:2.5rem 1.5rem;text-align:center;animation:fadeUp .5s cubic-bezier(.4,0,.2,1)">
    <div class="chat-welcome-orb"><img src="/static/sivarrai.png" alt="Sivarr"></div>
    <h1 class="chat-welcome-heading" id="welcome-greeting">Chat cleared</h1>
    <p class="chat-welcome-sub">Start a new conversation below.</p>
  </div>`;
  toast("Chat cleared");
}

function chatExport() {
  const msgs = document.querySelectorAll("#msgs .msg");
  if (!msgs.length) {
    toast("Nothing to export yet.");
    return;
  }
  let out = `Sivarr AI Chat Export (${new Date().toLocaleString()})\n${"─".repeat(50)}\n\n`;
  msgs.forEach((m) => {
    const role = m.classList.contains("sivarr") ? "Sivarr AI" : S.name || "You";
    const text = m.querySelector(".msg-bub")?.innerText || "";
    out += `${role}:\n${text}\n\n`;
  });
  downloadText(out);
}

function _chatSetStatus(thinking = false) {
  const dot = $("chat-status-dot");
  const text = $("chat-status-text");
  if (dot) dot.classList.toggle("thinking", thinking);
  if (text) text.textContent = thinking ? "Thinking…" : "Online · Ready";
}

async function chatSaveTask(btn) {
  if (!S.sid) return;
  const msgText = btn
    .closest(".msg")
    .querySelector(".msg-bub")
    .innerText.trim()
    .slice(0, 200);
  const title = await siModal.input(
    "Save as Task",
    "Task title:",
    msgText.split("\n")[0].slice(0, 100),
    { confirmLabel: "Add Task" },
  );
  if (!title) return;
  // Used to write the legacy sivarr_tasks_ key, then "mirror" into the
  // real Tasks/Flux store via getSHData/saveSHData -- neither of which
  // exist anymore, so the mirror silently never happened and this button
  // never actually added anything the Tasks panel could show. One real
  // call does both correctly.
  if (typeof window.addTask === "function") {
    window.addTask({ title, priority: "medium" });
    if (typeof window.renderAll === "function") window.renderAll();
  }
  toast("Task added");
}

async function chatSaveNote(btn) {
  if (!S.sid) return;
  const msgText = btn
    .closest(".msg")
    .querySelector(".msg-bub")
    .innerText.trim()
    .slice(0, 2000);
  const title = await siModal.input("Save as Note", "Note title:", "", {
    confirmLabel: "Save Note",
  });
  if (!title) return;
  const notes = JSON.parse(
    localStorage.getItem(`sivarr_notes_${S.sid}`) || "[]",
  );
  notes.unshift({
    id: Date.now(),
    title,
    content: msgText,
    created: new Date().toISOString(),
    source: "ai",
  });
  localStorage.setItem(
    `sivarr_notes_${S.sid}`,
    JSON.stringify(notes.slice(0, 100)),
  );
  toast("Note saved");
}

function addTyping() {
  _chatSetStatus(true);
  const w = $("msgs"),
    d = document.createElement("div");
  d.className = "msg sivarr";
  d.innerHTML = `<div class="msg-av">AI</div>
    <div class="msg-inner"><div class="typing"><span></span><span></span><span></span></div></div>`;
  w.appendChild(d);
  scrollMsgs();
  return d;
}

function scrollMsgs() {
  const m = $("msgs");
  m.scrollTop = m.scrollHeight;
}

function ckd(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

// ═══════════════════════════ QUIZ ═════════════════════════════
// CSP migration: Enter-to-start on the quiz topic input.
window._startQuizOnEnter = function (e) {
  if (e.key === "Enter") startQuiz();
};

function startQuiz() {
  const typed = $("quiz-topic-input") ? $("quiz-topic-input").value.trim() : "";

  // If no studied topics AND no typed topic, show helpful message
  if (!S.topics.length && !typed) {
    toast("Type a topic above or ask me questions in Chat first!");
    return;
  }

  // Store custom topic for this quiz session
  S.quizCustomTopic = typed || "";
  S.quizActive = true;
  S.quizQ = 0;
  S.quizScore = 0;
  loadQ();
}

async function loadQ() {
  const qw = $("qw");
  if (!qw) return;

  let topic = S.quizCustomTopic || "";
  if (!topic && S.topics.length)
    topic = S.topics[Math.floor(Math.random() * S.topics.length)];
  if (!topic) topic = "general knowledge";

  qw.innerHTML = `
    <div style="padding:3rem 1rem;text-align:center">
      <div style="font-size:1.8rem;margin-bottom:.75rem">⏳</div>
      <div style="color:var(--muted);font-size:.9rem">Generating question ${S.quizQ + 1} of 5...</div>
      <div style="font-size:.78rem;color:var(--muted2);margin-top:.3rem">${esc(topic)}</div>
    </div>`;

  try {
    const r = await fetch(
      `/api/quiz/question?token=${encodeURIComponent(getToken())}&topic=${encodeURIComponent(topic)}&difficulty=${encodeURIComponent(S.diff)}`,
    );
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    const q = await r.json();
    if (q.error) {
      toast(q.error);
      resetQuiz();
      return;
    }
    S.curQ = q;
    renderQ(q);
  } catch (e) {
    qw.innerHTML = `
      <div style="padding:2rem;text-align:center">
        <div style="font-size:1.5rem;margin-bottom:.5rem">⚠️</div>
        <div style="color:var(--muted);font-size:.88rem;margin-bottom:1rem">Couldn't generate question. AI may be busy.</div>
        <button class="btn-start" style="padding:8px 20px;font-size:.82rem" data-onclick="loadQ">Try Again</button>
        <button style="margin-left:8px;background:none;border:1px solid var(--border);border-radius:8px;padding:8px 16px;color:var(--muted);font-size:.82rem;cursor:pointer" data-onclick="resetQuiz">Cancel</button>
      </div>`;
  }
}

function renderQ(q) {
  const pct = (S.quizQ / 5) * 100;
  $("qw").innerHTML = `
    <div class="q-header">
      <h3>Question ${S.quizQ + 1} <span style="color:var(--muted);font-weight:400">of 5</span></h3>
      <span style="font-size:.75rem;color:var(--muted)">[${S.diff.toUpperCase()}]</span>
    </div>
    <div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>
    <div class="q-card">
      <h4>${esc(q.question)}</h4>
      <div class="opts">
        ${["A", "B", "C", "D"]
          .map(
            (l) => `
          <button class="opt-btn" data-onclick="answer" data-onclick-arg0="${l}" data-l="${l}">
            <span class="opt-letter">${l}</span>${esc(q.options[l])}
          </button>`,
          )
          .join("")}
      </div>
      <div class="expl" id="expl"></div>
    </div>`;
}

async function answer(letter) {
  const q = S.curQ,
    correct = letter === q.answer;
  document.querySelectorAll(".opt-btn").forEach((b) => {
    b.disabled = true;
    if (b.dataset.l === q.answer) b.classList.add("correct");
    if (b.dataset.l === letter && !correct) b.classList.add("wrong");
  });
  const ex = $("expl");
  ex.textContent = (correct ? "✅ " : "❌ ") + q.explanation;
  ex.style.display = "block";
  if (correct) S.quizScore++;
  await API("/api/quiz/submit", {
    token: getToken(),
    topic: q.topic || S.topics[0],
    difficulty: S.diff,
    answer: letter,
    question: q.question,
    correct: q.answer,
    explanation: q.explanation,
  });
  S.quizQ++;
  setTimeout(() => (S.quizQ >= 5 ? showResult() : loadQ()), 1800);
}

async function showResult() {
  const pct = Math.round((S.quizScore / 5) * 100);
  const emoji = pct === 100 ? "🏆" : pct >= 80 ? "🌟" : pct >= 60 ? "👍" : "💪";
  const msg =
    pct === 100
      ? "Perfect score! Outstanding!"
      : pct >= 80
        ? "Great job!"
        : pct >= 60
          ? "Good effort, keep going!"
          : "Keep practising!";
  await API("/api/quiz/complete", {
    token: getToken(),
    score: S.quizScore,
    topic: S.topics[0] || "general",
    difficulty: S.diff,
  });
  $("qw").innerHTML = `
    <div class="score-card">
      <div style="font-size:2.5rem;margin-bottom:.5rem">${emoji}</div>
      <div class="score-num">${S.quizScore}/5</div>
      <div style="color:var(--muted);margin:.4rem 0">${pct}% · ${S.diff.toUpperCase()}</div>
      <div style="font-weight:500;margin-bottom:1.5rem">${msg}</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:1rem">
        <button class="action-btn" data-onclick="shareResult" data-onclick-args="${esc(JSON.stringify([S.quizScore, S.topics[0] || "general"]))}">🔗 Share Result</button>
      </div>
      <button class="btn-start" data-onclick="startQuiz">Take Another Quiz</button>
    </div>`;
  S.stats.quizzes++;
  updateSBStats();
  loadWrong();
  S.quizActive = false;
  _recordActivity();
}

function resetQuiz() {
  S.quizActive = false;
  S.quizCustomTopic = "";
  $("qw").innerHTML = `
    <div class="quiz-start-card">
      <div style="font-size:2.5rem">📝</div>
      <h2>Test your knowledge</h2>
      <p style="margin-bottom:1rem">Difficulty: <strong style="color:var(--accent)">${S.diff.charAt(0).toUpperCase() + S.diff.slice(1)}</strong></p>
      <div style="margin-bottom:1rem;text-align:left">
        <label style="font-size:.75rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">Topic (optional)</label>
        <input id="quiz-topic-input" type="text"
          placeholder="e.g. Photosynthesis, Newton's laws..."
          style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 13px;color:var(--text);font-family:var(--font-body);font-size:.88rem;outline:none"
          data-onkeydown="_startQuizOnEnter" data-onkeydown-event>
        <p style="font-size:.72rem;color:var(--muted);margin-top:5px">Leave blank to quiz from your studied topics</p>
      </div>
      <button class="btn-start" data-onclick="startQuiz">Start Quiz</button>
    </div>`;
}

// ═══════════════════════════ SUGGESTIONS ═══════════════════════
async function getSuggestions() {
  const _st = $("sug-txt");
  if (_st) _st.textContent = "Thinking...";
  try {
    const r = await fetch(
      `/api/suggest?token=${encodeURIComponent(getToken() || "")}`,
    );
    const d = await r.json();
    if (_st) _st.textContent = d.suggestion;
  } catch {
    const _stc = $("sug-txt");
    if (_stc) _stc.textContent = "Couldn't load suggestions. Try again.";
  }
}

// ═══════════════════════════ WRONG ANSWERS ══════════════════════
async function loadWrong() {
  try {
    const _wt = getToken() || "";
    const r = await fetch(
      `/api/wrong?sid=${S.sid}&token=${encodeURIComponent(_wt)}`,
    );
    const d = await r.json();
    S.wrongAnswers = d.wrong;
    const wc = $("wc");
    if (wc) wc.textContent = d.wrong.length;
    const wcm = $("wc-m");
    if (wcm) wcm.textContent = d.wrong.length;
    const sqw = $("sq-w");
    if (sqw) sqw.textContent = d.wrong.length;
    const list = $("wrong-list");
    const listm = $("wrong-list-m");
    const html = !d.wrong.length
      ? `<span style="color:var(--muted);font-size:.78rem">No wrong answers yet, keep quizzing!</span>`
      : d.wrong
          .map(
            (w, i) => `
          <div class="wrong-item">
            <div class="wrong-q">${esc(w.question)}</div>
            <div class="wrong-ans">You: ${w.your_answer} · Correct: <span>${w.correct}</span></div>
            <div style="color:var(--muted);font-size:.7rem;margin-top:2px">${esc(w.explanation)}</div>
            <button class="btn-clear" data-onclick="clearWrong" data-onclick-args="[${i}]">✓ Got it</button>
          </div>`,
          )
          .join("");
    if (list) list.innerHTML = html;
    if (listm) listm.innerHTML = html;
  } catch (e) {
    console.error("loadWrong error:", e);
  }
}

async function clearWrong(idx) {
  await API("/api/wrong/clear", { token: getToken(), index: idx });
  loadWrong();
  toast("Removed from revision ✓");
}

// ═══════════════════════════ STATS ══════════════════════════════
async function loadStats() {
  const _st = getToken() || "";
  const r = await fetch(
    `/api/progress?sid=${S.sid}&token=${encodeURIComponent(_st)}`,
  );
  const d = await r.json();

  // Build sparkline SVG
  const hist = d.quiz_history || [];
  let sparkSVG = "";
  if (hist.length > 1) {
    const W = 300,
      H = 48,
      pad = 6;
    const max = Math.max(...hist.map((q) => q.pct), 1);
    const pts = hist.map((q, i) => {
      const x = pad + (i / (hist.length - 1)) * (W - pad * 2);
      const y = H - pad - (q.pct / max) * (H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const area = `${W - pad},${H} ${pad},${H}`;
    sparkSVG = `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:48px;margin-top:8px">
        <defs>
          <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4f6ef7" stop-opacity=".3"/>
            <stop offset="100%" stop-color="#4f6ef7" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <polygon points="${pts.join(" ")} ${area}" fill="url(#sg)"/>
        <polyline points="${pts.join(" ")}" fill="none" stroke="#4f6ef7"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${pts[pts.length - 1].split(",")[0]}"
                cy="${pts[pts.length - 1].split(",")[1]}"
                r="3.5" fill="#7c3aed"/>
      </svg>`;
  }

  // Topic mastery bars
  const mastery = d.topic_mastery || {};
  const masteryHTML = Object.entries(mastery).length
    ? Object.entries(mastery)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 7)
        .map(
          ([t, pct]) => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:.75rem;color:var(--muted);width:90px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t)}</span>
          <div style="flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;transition:width .6s ease"></div>
          </div>
          <span style="font-size:.7rem;color:var(--muted);width:28px;text-align:right">${pct}%</span>
        </div>`,
        )
        .join("")
    : '<span style="font-size:.78rem;color:var(--muted)">Ask questions to build topic mastery.</span>';

  // Badges
  const badges = d.badges || [];
  const badgesHTML = badges.length
    ? badges
        .map(
          (b) =>
            `<span style="background:#4f6ef718;border:1px solid #4f6ef730;border-radius:20px;padding:3px 10px;font-size:.7rem;font-weight:700;color:var(--accent);font-family:var(--font);margin:2px;display:inline-block">🏅 ${esc(b)}</span>`,
        )
        .join("")
    : '<span style="font-size:.78rem;color:var(--muted)">Complete quizzes to earn badges.</span>';

  // Streak colour
  const sc =
    (d.streak || 0) >= 7
      ? "#f59e0b"
      : (d.streak || 0) >= 3
        ? "#fb923c"
        : "var(--muted)";
  const xp = d.xp || 0;
  const lvl = d.level || 1;

  $("sw").innerHTML = `

    <!-- Hero -->
    <div style="background:linear-gradient(135deg,#4f6ef718,#7c3aed12);border:1px solid #4f6ef730;border-radius:16px;padding:1.1rem;margin-bottom:.875rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
        <div>
          <div style="font-family:var(--font);font-size:.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Level ${lvl}</div>
          <div style="font-family:var(--font);font-size:1.2rem;font-weight:800;letter-spacing:-.02em">${esc(d.name?.split(" ")[0] || "Student")}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:1.3rem">🔥</div>
          <div style="font-family:var(--font);font-size:.82rem;font-weight:800;color:${sc}">${d.streak || 0} day streak</div>
        </div>
      </div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${xp % 100}%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;transition:width .8s ease"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--muted);margin-top:3px">
        <span>${xp} XP</span><span>${100 - (xp % 100)} XP to Level ${lvl + 1}</span>
      </div>
    </div>

    <!-- Stats grid -->
    <div class="stats-grid" style="margin-bottom:.875rem">
      <div class="stat-card" style="--sc:#4f6ef7"><div class="sc-label">Questions</div><div class="sc-val" style="color:#4f6ef7">${d.questions}</div></div>
      <div class="stat-card" style="--sc:#7c3aed"><div class="sc-label">Quizzes</div><div class="sc-val" style="color:#7c3aed">${d.quizzes_taken}</div></div>
      <div class="stat-card" style="--sc:#22c55e"><div class="sc-label">Avg Score</div><div class="sc-val" style="color:#22c55e">${d.avg_score}%</div></div>
      <div class="stat-card" style="--sc:#f59e0b"><div class="sc-label">This Week</div><div class="sc-val" style="color:#f59e0b">${d.sessions_week || 0}</div></div>
    </div>

    <!-- Quiz trend -->
    ${
      hist.length > 1
        ? `
    <div class="r-card" style="margin-bottom:.875rem">
      <div class="r-title">📈 Quiz Score Trend <span style="color:var(--muted);font-weight:400;font-size:.72rem">(last ${hist.length})</span></div>
      ${sparkSVG}
      <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--muted);margin-top:4px">
        <span>Earliest</span><span>Latest: ${hist[hist.length - 1]?.pct || 0}%</span>
      </div>
    </div>`
        : ""
    }

    <!-- Topic mastery -->
    <div class="r-card" style="margin-bottom:.875rem">
      <div class="r-title">📚 Topic Mastery</div>
      <div style="margin-top:.5rem">${masteryHTML}</div>
    </div>

    <!-- Weak areas -->
    ${
      d.weak?.length
        ? `
    <div style="background:linear-gradient(135deg,#ef444410,transparent);border:1px solid #ef444430;border-radius:12px;padding:.875rem;margin-bottom:.875rem" id="weak-section">
      <div style="font-size:.72rem;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.5rem">⚠️ Needs Work</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:.625rem">
        ${d.weak.map((t) => `<span style="background:#ef444415;border:1px solid #ef444430;border-radius:20px;padding:3px 10px;font-size:.72rem;color:var(--red);font-weight:600">${esc(t)}</span>`).join("")}
      </div>
      <button data-onclick="_navChatWithPrefill" data-onclick-arg0="${esc(`Help me improve my understanding of ${d.weak[0] || ""}`)}"
        style="width:100%;background:none;border:1px solid #ef444440;border-radius:8px;padding:7px;color:var(--red);font-family:var(--font);font-size:.75rem;font-weight:700;cursor:pointer">
        Study weak topics with AI →
      </button>
    </div>`
        : ""
    }

    <!-- Badges -->
    <div class="r-card" style="margin-bottom:.875rem">
      <div class="r-title">🏅 Badges</div>
      <div style="margin-top:.5rem;display:flex;flex-wrap:wrap;gap:3px">${badgesHTML}</div>
    </div>

    <!-- Best topic -->
    ${
      d.best_topic
        ? `
    <div style="background:linear-gradient(135deg,#22c55e10,transparent);border:1px solid #22c55e30;border-radius:12px;padding:.875rem;display:flex;align-items:center;gap:10px">
      <div style="font-size:1.4rem">⭐</div>
      <div>
        <div style="font-family:var(--font);font-size:.8rem;font-weight:700;color:var(--green)">Strongest Topic</div>
        <div style="font-size:.78rem;color:var(--text);margin-top:1px">${esc(d.best_topic)}</div>
      </div>
    </div>`
        : ""
    }
  `;
}

async function loadProgress() {
  const _pt = getToken() || "";
  const r = await fetch(
    `/api/progress?sid=${S.sid}&token=${encodeURIComponent(_pt)}`,
  );
  const d = await r.json();
  const pw = $("pw");
  if (!pw) return;

  // Sparkline
  const hist = d.quiz_history || [];
  const W = 280,
    H = 44,
    pad = 4;
  let sparkSVG = "";
  if (hist.length > 1) {
    const max = Math.max(...hist.map((q) => q.pct), 1);
    const pts = hist.map((q, i) => {
      const x = pad + (i / (hist.length - 1)) * (W - pad * 2);
      const y = H - pad - (q.pct / max) * (H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const areaClose = `${W - pad},${H} ${pad},${H}`;
    sparkSVG = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:44px;margin-top:6px">
      <defs><linearGradient id="pr-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4f6ef7" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#4f6ef7" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${pts.join(" ")} ${areaClose}" fill="url(#pr-grad)"/>
      <polyline points="${pts.join(" ")}" fill="none" stroke="#4f6ef7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${pts.map((p, i) => (i === pts.length - 1 ? `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="3.5" fill="#7c3aed"/>` : "")).join("")}
    </svg>`;
  }

  // XP level
  const xp = d.xp || 0;
  const level = d.level || 1;
  const xpPct = xp % 100;

  // Topic mastery rows
  const mastery = d.topic_mastery || {};
  const masteryHTML = Object.entries(mastery).length
    ? Object.entries(mastery)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(
          ([t, pct]) => `
        <div class="pr-topic-row">
          <span style="font-size:.78rem;color:var(--muted);width:100px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t)}</span>
          <div class="pr-topic-bar-wrap"><div class="pr-topic-bar-fill" style="width:${pct}%"></div></div>
          <span style="font-size:.72rem;color:var(--muted);width:30px;text-align:right">${pct}%</span>
        </div>`,
        )
        .join("")
    : '<span style="font-size:.78rem;color:var(--muted)">Chat and quiz to build topic mastery.</span>';

  // Badges
  const badges = d.badges || [];
  const badgesHTML = badges.length
    ? badges.map((b) => `<span class="pr-badge">🏅 ${esc(b)}</span>`).join("")
    : '<span style="font-size:.78rem;color:var(--muted)">Complete quizzes to earn badges.</span>';

  // Streak fire
  const streakColor =
    d.streak >= 7 ? "#f59e0b" : d.streak >= 3 ? "#fb923c" : "var(--muted)";

  pw.innerHTML = `
    <!-- Hero: Level + Streak -->
    <div class="pr-hero">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
        <div>
          <div style="font-family:var(--font);font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Level ${level}</div>
          <div style="font-family:var(--font);font-size:1.3rem;font-weight:800;letter-spacing:-.02em">${d.name?.split(" ")[0] || "Student"}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:1.4rem">🔥</div>
          <div style="font-family:var(--font);font-size:.85rem;font-weight:800;color:${streakColor}">${d.streak || 0} day streak</div>
        </div>
      </div>
      <div class="pr-level-bar"><div class="pr-level-fill" style="width:${xpPct}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--muted)">
        <span>${xp} XP</span>
        <span>${100 - xpPct} XP to Level ${level + 1}</span>
      </div>
    </div>

    <!-- Stats grid -->
    <div class="pr-stat-row">
      <div class="pr-stat" style="--pr-color:#4f6ef7">
        <div class="pr-stat-val">${d.questions}</div>
        <div class="pr-stat-lbl">Questions asked</div>
      </div>
      <div class="pr-stat" style="--pr-color:#7c3aed">
        <div class="pr-stat-val">${d.quizzes_taken}</div>
        <div class="pr-stat-lbl">Quizzes taken</div>
      </div>
      <div class="pr-stat" style="--pr-color:#22c55e">
        <div class="pr-stat-val">${d.avg_score}%</div>
        <div class="pr-stat-lbl">Average score</div>
      </div>
      <div class="pr-stat" style="--pr-color:#f59e0b">
        <div class="pr-stat-val">${d.sessions_week || 0}</div>
        <div class="pr-stat-lbl">Sessions this week</div>
      </div>
    </div>

    <!-- Quiz trend sparkline -->
    ${
      hist.length > 1
        ? `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:.875rem">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:.75rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">📈 Quiz Score Trend</div>
        <div style="font-size:.72rem;color:var(--accent)">${hist.length} quizzes</div>
      </div>
      ${sparkSVG}
    </div>`
        : ""
    }

    <!-- Topic mastery -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:.875rem">
      <div style="font-size:.75rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.75rem">📚 Topic Mastery</div>
      ${masteryHTML}
    </div>

    <!-- Weak areas -->
    ${
      d.weak?.length
        ? `
    <div style="background:linear-gradient(135deg,#ef444410,transparent);border:1px solid #ef444430;border-radius:12px;padding:1rem;margin-bottom:.875rem" id="weak-section">
      <div style="font-size:.75rem;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.625rem">⚠️ Needs Work</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${d.weak.map((t) => `<span style="background:#ef444415;border:1px solid #ef444430;border-radius:20px;padding:3px 10px;font-size:.72rem;color:var(--red);font-weight:600">${esc(t)}</span>`).join("")}
      </div>
      <button data-onclick="_navChatWithPrefill" data-onclick-arg0="${esc(`Help me improve at ${d.weak[0]}`)}" style="width:100%;margin-top:.75rem;background:none;border:1px solid #ef444440;border-radius:8px;padding:7px;color:var(--red);font-family:var(--font);font-size:.75rem;font-weight:700;cursor:pointer;transition:all .15s">
        Study weak topics with AI →
      </button>
    </div>`
        : ""
    }

    <!-- Badges -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:.875rem">
      <div style="font-size:.75rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.625rem">🏅 Badges</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${badgesHTML}</div>
    </div>

    <!-- Best topic -->
    ${
      d.best_topic
        ? `
    <div style="background:linear-gradient(135deg,#22c55e10,transparent);border:1px solid #22c55e30;border-radius:12px;padding:.875rem;margin-bottom:.875rem;display:flex;align-items:center;gap:12px">
      <div style="font-size:1.5rem">⭐</div>
      <div>
        <div style="font-family:var(--font);font-size:.82rem;font-weight:700;color:var(--green)">Strongest Topic</div>
        <div style="font-size:.78rem;color:var(--text);margin-top:1px">${esc(d.best_topic)}</div>
      </div>
    </div>`
        : ""
    }

    <!-- AI coaching CTA -->
    <div style="background:linear-gradient(135deg,var(--accent)15,var(--accent2)10);border:1px solid var(--accent)30;border-radius:12px;padding:1rem;margin-bottom:.875rem;text-align:center">
      <div style="font-size:.75rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.5rem">✨ AI Coaching</div>
      <div style="font-size:.8rem;color:var(--text2);margin-bottom:.75rem">Get a personalised coaching session based on your progress data.</div>
      <button data-onclick="getProgressCoaching" style="background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none;border-radius:9px;padding:9px 22px;font-family:var(--font);font-size:.8rem;font-weight:700;cursor:pointer">Get coaching from Sivarr →</button>
    </div>
  `;
}

function getProgressCoaching() {
  if (!S.sid) return;
  const tasks = JSON.parse(
    localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
  );
  const goals = JSON.parse(
    localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
  );
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const jnl = JSON.parse(localStorage.getItem(JNL_KEY()) || "[]");
  const streak = _getActivityStreak();
  const today8601 = new Date().toISOString().split("T")[0];

  const doneTasks = tasks.filter((t) => t.done).length;
  const openTasks = tasks.filter((t) => !t.done).length;
  const activeGoals = goals.filter((g) => !g.completed);
  const habitsToday = habits.filter((h) =>
    (h.completions || []).includes(today8601),
  ).length;
  const jnlThisWeek = jnl.filter((e) => {
    const diff =
      (Date.now() - new Date(e.date + "T12:00:00").getTime()) / 86400000;
    return diff <= 7;
  }).length;

  const lines = [
    `Here's my Sivarr data for coaching:`,
    `- Tasks: ${doneTasks} done, ${openTasks} still open`,
    activeGoals.length
      ? `- Active goals: ${activeGoals.map((g) => `${g.title} (${g.progress || 0}%)`).join(", ")}`
      : "- No active goals",
    `- Habit check-ins today: ${habitsToday}/${habits.length}`,
    `- Journal entries this week: ${jnlThisWeek}`,
    `- Activity streak: ${streak} day${streak !== 1 ? "s" : ""}`,
    S.stats?.questions ? `- AI questions asked: ${S.stats.questions}` : "",
    S.stats?.quizzes ? `- Quizzes completed: ${S.stats.quizzes}` : "",
    ``,
    `Based on this, give me a honest coaching session. What patterns do you see? What should I stop, start, or do more of? Be direct and specific.`,
  ].filter(Boolean);

  nav("chat", null);
  setTimeout(() => {
    const ci = $("ci");
    if (ci) {
      ci.value = lines.join("\n");
      ci.focus();
    }
  }, 350);
}

// ═══════════════════════ GOALS ═════════════════════════════

let GL_GOALS = [];
let _glFilter = "all"; // 'all' | 'active' | 'completed'

function _glHealth(g) {
  if (g.completed) return { label: "Done", color: "#22c55e", icon: "✅" };
  if (!g.deadline) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(g.deadline + "T00:00:00");
  if (today > deadline)
    return { label: "Off Track", color: "#ef4444", icon: "🔴" };
  const created = g.created
    ? new Date(g.created.split("T")[0] + "T00:00:00")
    : deadline;
  const total = Math.max(1, (deadline - created) / 86400000);
  const elapsed = Math.max(0, (today - created) / 86400000);
  const ePct = (elapsed / total) * 100;
  const pct = g.progress || 0;
  if (ePct < 5) return { label: "On Track", color: "#22c55e", icon: "🟢" };
  if (pct >= ePct * 0.85)
    return { label: "On Track", color: "#22c55e", icon: "🟢" };
  if (pct >= ePct * 0.5)
    return { label: "At Risk", color: "#f59e0b", icon: "🟡" };
  return { label: "Off Track", color: "#ef4444", icon: "🔴" };
}

function glStartCheckin() {
  if (!S.sid) return;
  localStorage.setItem(
    `sivarr_gl_checkin_${S.sid}`,
    new Date().toISOString().split("T")[0],
  );
  glRender(); // re-render to dismiss banner
  const first = GL_GOALS.find((g) => !g.completed);
  if (first) glUpdateProgress(first.id, first.progress || 0);
}

function _glCheckinDue() {
  if (!S.sid) return false;
  const key = `sivarr_gl_checkin_${S.sid}`;
  const last = localStorage.getItem(key);
  if (!last) return GL_GOALS.some((g) => !g.completed);
  const daysSince =
    (Date.now() - new Date(last + "T00:00:00").getTime()) / 86400000;
  return daysSince >= 7 && GL_GOALS.some((g) => !g.completed);
}

async function glLoad() {
  const cacheKey = `goals_${S.sid}`;
  // Render the last-known list immediately (IndexedDB — see js/core/idb.js)
  // while the network fetch runs in the background, instead of making the
  // user stare at a skeleton on every load just to see the same goals they
  // already had. Falls back to the skeleton only when there's truly no
  // cache yet (first-ever load on this device).
  const cached = await idbGet(cacheKey);
  if (cached) {
    GL_GOALS = cached;
    glRender();
  } else {
    skShow("gl-list", _SK.goal, 3);
  }
  try {
    const r = await fetch(
      `/api/goals?token=${encodeURIComponent(getToken() || "")}`,
    );
    const d = await r.json();
    GL_GOALS = d.goals || [];
    idbSet(cacheKey, GL_GOALS);
    GL_GOALS.forEach((g) => _calSyncGoal(g)); // keep calendar in sync
    glRender();
  } catch (e) {
    // Offline and no cache at all (cache case already rendered above) —
    // nothing to show but empty.
    if (!cached) {
      GL_GOALS = [];
      glRender();
    }
  }
}

function glRender() {
  const list = $("gl-list");
  if (!list) return;
  const today = new Date();

  const total = GL_GOALS.length;
  const active = GL_GOALS.filter((g) => !g.completed).length;
  const completed = GL_GOALS.filter((g) => g.completed).length;
  const overdue = GL_GOALS.filter(
    (g) =>
      !g.completed && g.deadline && new Date(g.deadline + "T00:00:00") < today,
  ).length;

  if (!total) {
    list.innerHTML = `<div class="empty-state">
      <div class="es-orb" style="font-size:2rem;margin-bottom:10px">🎯</div>
      <div class="es-title">No goals yet</div>
      <p class="es-sub" style="max-width:300px">Goals keep you accountable. Set a target, track progress, and let Sivarr AI tell you if you're on track.</p>
      <button class="es-cta" data-onclick="glToggleForm">+ Set your first goal</button>
    </div>`;
    return;
  }

  let goals = GL_GOALS;
  if (_glFilter === "active") goals = GL_GOALS.filter((g) => !g.completed);
  if (_glFilter === "completed") goals = GL_GOALS.filter((g) => g.completed);

  const checkinBanner = _glCheckinDue()
    ? `
    <div style="background:linear-gradient(135deg,var(--accent)08,var(--accent2)06);border:1px solid var(--accent)30;border-radius:12px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div>
        <div style="font-weight:700;font-size:.86rem;color:var(--text)">📋 Weekly check-in</div>
        <div style="font-size:.77rem;color:var(--muted);margin-top:2px">How are your goals tracking? Update your progress numbers.</div>
      </div>
      <button data-onclick="glStartCheckin" style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:6px 14px;font-family:var(--font-body);font-size:.78rem;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0">Update now</button>
    </div>`
    : "";

  const statsHTML = `
    <div class="gl-stats">
      <div class="gl-stat"><div class="gl-stat-val">${total}</div><div class="gl-stat-lbl">Total</div></div>
      <div class="gl-stat"><div class="gl-stat-val">${active}</div><div class="gl-stat-lbl">Active</div></div>
      <div class="gl-stat completed"><div class="gl-stat-val">${completed}</div><div class="gl-stat-lbl">Done</div></div>
      <div class="gl-stat${overdue ? " overdue" : ""}"><div class="gl-stat-val">${overdue}</div><div class="gl-stat-lbl">Overdue</div></div>
    </div>`;

  const filtersHTML = `
    <div class="gl-filters">
      <button class="gl-filter-btn${_glFilter === "all" ? " active" : ""}" data-onclick="glSetFilter" data-onclick-arg0="all">All (${total})</button>
      <button class="gl-filter-btn${_glFilter === "active" ? " active" : ""}" data-onclick="glSetFilter" data-onclick-arg0="active">Active (${active})</button>
      <button class="gl-filter-btn${_glFilter === "completed" ? " active" : ""}" data-onclick="glSetFilter" data-onclick-arg0="completed">Completed (${completed})</button>
    </div>`;

  const emptyFilter = !goals.length
    ? `<div style="text-align:center;padding:2rem 1rem;color:var(--muted);font-size:.84rem">No ${_glFilter} goals.</div>`
    : "";

  list.innerHTML =
    statsHTML +
    checkinBanner +
    filtersHTML +
    emptyFilter +
    goals
      .map((g) => {
        const daysLeft = g.deadline
          ? Math.ceil((new Date(g.deadline + "T00:00:00") - today) / 86400000)
          : null;
        const pct = g.progress || 0;
        const health = _glHealth(g);
        const healthBadge = health
          ? `<span style="display:inline-flex;align-items:center;gap:3px;background:${health.color}18;color:${health.color};border-radius:5px;padding:1px 7px;font-size:.68rem;font-weight:700;letter-spacing:.02em">${health.icon} ${health.label}</span>`
          : "";
        const daysLabel =
          daysLeft !== null
            ? daysLeft > 0
              ? `${daysLeft}d left`
              : daysLeft === 0
                ? "Today!"
                : "Overdue"
            : "";
        const krs = g.key_results || [];
        const isScore = g.goal_type === "score";
        const hasKRs = !isScore && krs.length > 0;
        const krsHTML = krs
          .map((kr) => {
            const krPct = Math.min(
              100,
              (kr.current / Math.max(0.01, kr.target)) * 100,
            );
            return `
        <div style="margin-bottom:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;gap:8px">
            <span style="font-size:.78rem;color:var(--text2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(kr.title)}</span>
            <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
              <input type="number" value="${kr.current}" min="0"
                style="width:52px;text-align:right;background:var(--bg3);border:1px solid var(--border);
                       border-radius:5px;padding:2px 6px;font-size:.76rem;color:var(--text);outline:none"
                data-onblur="_glUpdateKRFromEl" data-onblur-arg0="${g.id}" data-onblur-arg1="${kr.id}" data-onblur-this
                data-onkeydown="_blurElOnEnter" data-onkeydown-event>
              <span style="font-size:.7rem;color:var(--muted);white-space:nowrap">/ ${kr.target}${kr.unit ? " " + esc(kr.unit) : ""}</span>
              <span style="font-size:.7rem;font-weight:700;color:var(--accent);min-width:30px;text-align:right">${Math.round(krPct)}%</span>
              <button data-onclick="glDeleteKR" data-onclick-arg0="${g.id}" data-onclick-arg1="${kr.id}"
                style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.72rem;padding:1px 3px;flex-shrink:0">✕</button>
            </div>
          </div>
          <div style="height:3px;background:var(--border);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${krPct}%;background:var(--accent);border-radius:2px;transition:width .3s"></div>
          </div>
        </div>`;
          })
          .join("");

        return `
      <div class="gl-card ${g.completed ? "done" : ""}" data-id="${g.id}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <div class="gl-title" style="margin-bottom:4px">${g.completed ? "✅ " : ""}${esc(g.title)}</div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              ${healthBadge}
              ${g.subject ? `<span style="font-size:.72rem;color:var(--muted)">📚 ${esc(g.subject)}</span>` : ""}
              ${daysLeft !== null ? `<span style="font-size:.72rem;color:${daysLeft <= 0 ? "#ef4444" : daysLeft <= 3 ? "#f59e0b" : "var(--muted)"}">${daysLabel}</span>` : ""}
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-family:var(--font);font-size:.9rem;font-weight:800;color:var(--accent)">${pct}%</div>
            <div style="font-size:.67rem;color:var(--muted)">${hasKRs ? `${krs.length} KR${krs.length !== 1 ? "s" : ""}` : `of ${g.target_score || 100}%`}</div>
          </div>
        </div>
        <div class="gl-prog-wrap">
          <div class="gl-prog-fill ${g.completed ? "done" : ""}" style="width:${pct}%"></div>
        </div>
        ${hasKRs ? `<div style="margin-top:10px">${krsHTML}</div>` : ""}
        ${
          !isScore
            ? `<button class="gl-add-kr-btn" data-onclick="glAddKR" data-onclick-arg0="${g.id}"
          style="margin-top:${hasKRs ? "0" : "8px"}">
          + Key Result</button>`
            : ""
        }
        <div class="gl-actions">
          ${isScore || !hasKRs ? `<button class="gl-action-btn" data-onclick="glUpdateProgress" data-onclick-args="${esc(JSON.stringify([g.id, pct]))}">📈 Update</button>` : ""}
          <button class="gl-action-btn done-btn" data-onclick="glMarkDone" data-onclick-arg0="${g.id}">${g.completed ? "↩ Reopen" : "✓ Done"}</button>
          <button class="gl-action-btn" data-onclick="glEditGoal" data-onclick-arg0="${g.id}">✏️ Edit</button>
          <button class="gl-action-btn siva-btn" data-onclick="glAskSivaGoal" data-onclick-arg0="${g.id}">🤖 Ask SIVA</button>
          <button class="gl-action-btn del-btn" data-onclick="glDelete" data-onclick-arg0="${g.id}">🗑</button>
        </div>
      </div>`;
      })
      .join("");
}

function glToggleForm() {
  $("gl-add-form").classList.toggle("open");
  if ($("gl-add-form").classList.contains("open")) {
    $("gl-title")?.focus();
    $("gl-deadline").min = new Date().toISOString().split("T")[0];
  }
}

function glToggleScoreField(type) {
  const sf = $("gl-score-field");
  if (sf) sf.style.display = type === "score" ? "block" : "none";
}

async function glSaveGoal() {
  const title = $("gl-title")?.value.trim();
  const subject = $("gl-subject")?.value.trim();
  const target = parseInt($("gl-target")?.value) || 70;
  const deadline = $("gl-deadline")?.value;
  const goal_type = $("gl-type")?.value || "okr";
  if (!title) {
    toast("Enter a goal title.");
    return;
  }
  try {
    const r = await API("/api/goals/add", {
      token: getToken(),
      title,
      subject,
      target_score: target,
      deadline,
      goal_type,
    });
    GL_GOALS.push(r.goal);
    if (deadline) _calSyncGoal(r.goal);
    glRender();
    $("gl-add-form").classList.remove("open");
    $("gl-title").value = "";
    $("gl-subject").value = "";
    $("gl-target").value = "70";
    $("gl-deadline").value = "";
    if ($("gl-type")) $("gl-type").value = "okr";
    glToggleScoreField("okr");
    toast("Goal added! 🎯");
  } catch (e) {
    toast("Could not save goal.");
  }
}

async function glUpdateProgress(id, current) {
  const val = await siModal.input(
    "Update Progress",
    "0 – 100",
    String(current),
    {
      type: "number",
      confirmLabel: "Update",
      description: `Currently at ${current}%`,
    },
  );
  if (val === null) return;
  const pct = Math.min(Math.max(parseInt(val) || 0, 0), 100);
  try {
    await API("/api/goals/update", {
      token: getToken(),
      id,
      progress: pct,
      completed: pct >= 100,
    });
    const g = GL_GOALS.find((x) => x.id === id);
    if (g) {
      g.progress = pct;
      g.completed = pct >= 100;
    }
    glRender();
    if (pct >= 100) toast("Goal completed! 🎉");
    else toast(`Progress updated to ${pct}% ✓`);
  } catch (e) {
    toast("Update failed.");
  }
}

async function glMarkDone(id) {
  const g = GL_GOALS.find((x) => x.id === id);
  if (!g) return;
  const completed = !g.completed;
  try {
    await API("/api/goals/update", {
      token: getToken(),
      id,
      progress: completed ? 100 : g.progress,
      completed,
    });
    g.completed = completed;
    if (completed) {
      g.progress = 100;
      _calRemoveEvent(`goal_${id}`);
      _autoFire("goal_progress", {
        goalTitle: g.title,
        journalPrompt: `I just completed my goal: "${g.title}". What did I learn? `,
        followUpTask: `Celebrate: ${g.title}`,
      });
    } else _calSyncGoal(g);
    glRender();
    toast(completed ? "Goal completed! 🎉" : "Goal reopened");
  } catch (e) {
    toast("Update failed.");
  }
}

async function glDelete(id) {
  if (
    !(await siModal.confirm("Delete this goal? You can restore it from Trash within 30 days.", {
      title: "Delete Goal",
      confirmLabel: "Delete",
      danger: true,
    }))
  )
    return;
  try {
    await API("/api/goals/delete", { token: getToken(), id });
    _calRemoveEvent(`goal_${id}`);
    GL_GOALS = GL_GOALS.filter((x) => x.id !== id);
    glRender();
    toast("Goal moved to Trash");
  } catch (e) {
    toast("Delete failed.");
  }
}

async function glRestore(id) {
  try {
    await API("/api/goals/restore", { token: getToken(), id });
    await glLoad();
  } catch (e) {
    toast("Restore failed.");
  }
}

// ══════════════════════ TRASH ══════════════════════
//
// One combined view over four different storage shapes: Tasks/Habits/Docs
// are client-array-sync domains (see js/features/*.js — no server-side
// delete endpoint exists for them, deleted_at rides along in the normal
// /sync payload), so their trashed items are already sitting in localStorage
// and need no network call. Goals is server-authoritative, so its trash is a
// real fetch. Habits deserve a special note: they're addressed by array
// INDEX, not id (see js/features/habits.js's _habVisible) — the index this
// panel hands back to habitRestore() must be the habit's position in the
// FULL localStorage array, exactly what habits.deleted_at-carrying entries
// already have from JSON.parse, so no extra bookkeeping is needed here.

let _TRASH_GOALS = [];

async function trashLoadGoals() {
  const token = getToken();
  if (!token) {
    _TRASH_GOALS = [];
    return;
  }
  try {
    const r = await fetch(`/api/goals/trash?token=${encodeURIComponent(token)}`);
    const d = await r.json();
    _TRASH_GOALS = d.goals || [];
  } catch (e) {
    _TRASH_GOALS = [];
  }
}

function _trashLocalItems() {
  const items = [];

  (getTasksData().tasks || []).forEach((t) => {
    if (t.deleted_at) {
      items.push({
        type: "task",
        icon: "ti-checkbox",
        id: t.id,
        title: t.title || "Untitled task",
        deleted_at: t.deleted_at,
      });
    }
  });

  JSON.parse(localStorage.getItem(HAB_KEY()) || "[]").forEach((h, i) => {
    if (h.deleted_at) {
      items.push({
        type: "habit",
        icon: "ti-flame",
        id: i,
        title: h.title || "Untitled habit",
        deleted_at: h.deleted_at,
      });
    }
  });

  docGetAll().forEach((d) => {
    if (d.deleted_at) {
      items.push({
        type: "doc",
        icon: "ti-notebook",
        id: d.id,
        title: d.title || "Untitled note",
        deleted_at: d.deleted_at,
      });
    }
  });

  return items;
}

function _trashRelTime(iso) {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

const _TRASH_TYPE_LABEL = { task: "Task", habit: "Habit", doc: "Note", goal: "Goal" };

function trashRender() {
  const list = $("trash-list");
  if (!list) return;

  const items = _trashLocalItems().concat(
    _TRASH_GOALS.map((g) => ({
      type: "goal",
      icon: "ti-target",
      id: g.id,
      title: g.title || "Untitled goal",
      deleted_at: g.deleted_at,
    })),
  );
  items.sort((a, b) => (b.deleted_at || "").localeCompare(a.deleted_at || ""));

  const empty = $("trash-empty");
  if (!items.length) {
    list.innerHTML = "";
    if (empty) empty.style.display = "flex";
    return;
  }
  if (empty) empty.style.display = "none";

  list.innerHTML = items
    .map(
      (it) => `
    <div class="trash-item">
      <i class="ti ${it.icon} trash-item-icon"></i>
      <div class="trash-item-info">
        <div class="trash-item-title">${esc(it.title)}</div>
        <div class="trash-item-meta">${_TRASH_TYPE_LABEL[it.type]} · deleted ${_trashRelTime(it.deleted_at)}</div>
      </div>
      <button class="btn" data-onclick="trashRestore" data-onclick-arg0="${it.type}" data-onclick-arg1="${esc(String(it.id))}">Restore</button>
    </div>`,
    )
    .join("");
}

async function trashRestore(type, id) {
  if (type === "task") restoreSHTask(id);
  else if (type === "habit") habitRestore(Number(id));
  else if (type === "doc") docRestore(id);
  else if (type === "goal") await glRestore(id);
  toast("Restored");
  await trashInit();
}

async function trashInit() {
  await trashLoadGoals();
  trashRender();
}

// ── Goal Key Results ──────────────────────────────────────────────────────────

function glAddKR(goalId) {
  // Inject inline form into the goal card
  const card = document.querySelector(`.gl-card[data-id="${goalId}"]`);
  if (!card) return;
  card.querySelectorAll(".gl-kr-form").forEach((f) => f.remove());
  const form = document.createElement("div");
  form.className = "gl-kr-form";
  form.style.cssText =
    "display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap";
  form.innerHTML = `
    <input placeholder="What will you measure?" id="kr-title-${goalId}"
      style="flex:2;min-width:130px;background:var(--surface);border:1px solid var(--accent);border-radius:7px;
             padding:5px 9px;color:var(--text);font-family:var(--font-body);font-size:.8rem;outline:none">
    <input type="number" placeholder="Target" id="kr-target-${goalId}" value="100" min="1"
      style="width:68px;background:var(--surface);border:1px solid var(--border);border-radius:7px;
             padding:5px 8px;color:var(--text);font-family:var(--font-body);font-size:.8rem;outline:none;text-align:center">
    <input placeholder="Unit" id="kr-unit-${goalId}" value="%"
      style="width:60px;background:var(--surface);border:1px solid var(--border);border-radius:7px;
             padding:5px 8px;color:var(--text);font-family:var(--font-body);font-size:.8rem;outline:none">
    <button data-onclick="glSaveKR" data-onclick-arg0="${goalId}"
      style="background:var(--accent);color:#fff;border:none;border-radius:7px;
             padding:5px 13px;font-family:var(--font-body);font-size:.78rem;font-weight:600;cursor:pointer">Add</button>
    <button data-onclick="_removeClosest" data-onclick-arg0=".gl-kr-form" data-onclick-this
      style="background:none;border:1px solid var(--border);border-radius:7px;
             padding:5px 9px;font-family:var(--font-body);font-size:.78rem;color:var(--muted);cursor:pointer">✕</button>`;
  card.appendChild(form);
  document.getElementById(`kr-title-${goalId}`)?.focus();
}

async function glSaveKR(goalId) {
  const title = ($(`kr-title-${goalId}`)?.value || "").trim();
  const target = parseFloat($(`kr-target-${goalId}`)?.value) || 100;
  const unit = ($(`kr-unit-${goalId}`)?.value || "").trim();
  if (!title) {
    toast("Enter a Key Result name");
    return;
  }
  try {
    await API("/api/goals/kr/add", {
      token: getToken(),
      goal_id: goalId,
      title,
      target,
      current: 0,
      unit,
    });
    await glLoad();
    toast("Key Result added ✓");
  } catch {
    toast("Could not add Key Result");
  }
}

// CSP migration: delegate.js has no this.value-read grammar (needs the
// numeric coercion too); read it here instead.
window._glUpdateKRFromEl = function (goalId, krId, el) {
  glUpdateKR(goalId, krId, +el.value);
};

// CSP migration: generic blur-on-Enter for single-line numeric/text inputs.
window._blurElOnEnter = function (e) {
  if (e.key === "Enter") e.target.blur();
};

// CSP migration: generic "close this inline form" button (this.closest(sel).remove()).
window._removeClosest = function (selector, el) {
  el.closest(selector)?.remove();
};

// CSP migration: generic "remove this element by id" (document.getElementById(id).remove()).
window._removeElById = function (id) {
  document.getElementById(id)?.remove();
};

async function glUpdateKR(goalId, krId, current) {
  try {
    await API("/api/goals/kr/update", {
      token: getToken(),
      goal_id: goalId,
      kr_id: krId,
      current,
    });
    // Update local cache silently, then re-render
    const g = GL_GOALS.find((x) => x.id === goalId);
    if (g) {
      const kr = (g.key_results || []).find((k) => k.id === krId);
      if (kr) kr.current = current;
      g.progress = Math.round(
        (g.key_results || []).reduce(
          (s, k) =>
            s + Math.min(100, (k.current / Math.max(0.01, k.target)) * 100),
          0,
        ) / Math.max(1, (g.key_results || []).length),
      );
      if (g.progress >= 100) g.completed = true;
    }
    glRender();
  } catch {
    toast("Update failed");
  }
}

async function glDeleteKR(goalId, krId) {
  if (
    !(await siModal.confirm("Delete this Key Result?", {
      title: "Delete Key Result",
      confirmLabel: "Delete",
      danger: true,
    }))
  )
    return;
  try {
    await API("/api/goals/kr/delete", {
      token: getToken(),
      goal_id: goalId,
      kr_id: krId,
    });
    await glLoad();
  } catch {
    toast("Delete failed");
  }
}

function glSetFilter(f) {
  _glFilter = f;
  glRender();
}

function glEditGoal(id) {
  const g = GL_GOALS.find((x) => x.id === id);
  if (!g) return;
  const card = document.querySelector(`.gl-card[data-id="${id}"]`);
  if (!card) return;
  card.querySelectorAll(".gl-edit-form").forEach((f) => f.remove());
  const form = document.createElement("div");
  form.className = "gl-edit-form";
  form.innerHTML = `
    <div class="gl-edit-title">Edit Goal</div>
    <input class="gl-edit-input" id="gl-edit-t-${id}" placeholder="Goal title" value="${esc(g.title)}">
    <input class="gl-edit-input" id="gl-edit-s-${id}" placeholder="Category (optional)" value="${esc(g.subject || "")}">
    <input class="gl-edit-input" id="gl-edit-d-${id}" type="date" value="${g.deadline || ""}" style="color-scheme:dark">
    <div style="display:flex;gap:7px">
      <button class="gl-edit-save" data-onclick="glSaveEdit" data-onclick-arg0="${id}">Save</button>
      <button class="gl-edit-cancel" data-onclick="_removeClosest" data-onclick-arg0=".gl-edit-form" data-onclick-this>Cancel</button>
    </div>`;
  const actions = card.querySelector(".gl-actions");
  if (actions) card.insertBefore(form, actions);
  else card.appendChild(form);
  document.getElementById(`gl-edit-t-${id}`)?.focus();
}

async function glSaveEdit(id) {
  const title = ($(`gl-edit-t-${id}`)?.value || "").trim();
  const subject = ($(`gl-edit-s-${id}`)?.value || "").trim();
  const deadline = $(`gl-edit-d-${id}`)?.value || "";
  if (!title) {
    toast("Goal title required");
    return;
  }
  try {
    await API("/api/goals/edit", {
      token: getToken(),
      id,
      title,
      subject,
      deadline: deadline || null,
    });
    const g = GL_GOALS.find((x) => x.id === id);
    if (g) {
      g.title = title;
      g.subject = subject;
      g.deadline = deadline || null;
      _calSyncGoal(g);
    }
    glRender();
    toast("Goal updated ✓");
  } catch {
    toast("Update failed.");
  }
}

function glAskSivaGoal(id) {
  const g = GL_GOALS.find((x) => x.id === id);
  if (!g) return;
  const health = _glHealth(g);
  const krs = g.key_results || [];
  const krSummary = krs.length
    ? " Key results: " +
      krs
        .map(
          (k) =>
            `${k.title} (${k.current}/${k.target}${k.unit ? " " + k.unit : ""})`,
        )
        .join(", ") +
      "."
    : "";
  const prompt = `My goal: "${g.title}"${g.subject ? " (" + g.subject + ")" : ""}. Progress: ${g.progress || 0}%${health ? ", status: " + health.label : ""}.${krSummary}${g.deadline ? ` Deadline: ${g.deadline}.` : ""} Help me stay on track. What should I focus on next?`;
  nav("chat");
  setTimeout(() => {
    const ci = $("ci");
    if (ci) {
      ci.value = prompt;
      ci.focus();
    }
  }, 350);
}

// ═══════════════════════ STUDY PLAN ═════════════════════════

function spLoadSaved() {
  const saved = localStorage.getItem(`sivarr_sp_${S.sid}`);
  if (!saved) return;
  try {
    const data = JSON.parse(saved);
    if (!data?.plan?.length) return;
    // Restore subject + date fields
    const subj = $("sp-subject");
    if (subj) subj.value = data.subject || "";
    const dt = $("sp-date");
    if (dt) dt.value = data.exam_date || "";
    // Show countdown
    const countdown = $("sp-countdown");
    if (countdown && data.exam_date) {
      const daysLeft = Math.ceil(
        (new Date(data.exam_date) - new Date()) / 86400000,
      );
      if (daysLeft > 0) {
        countdown.style.display = "flex";
        const dt2 = $("sp-days-text");
        if (dt2)
          dt2.textContent = `${daysLeft} day${daysLeft !== 1 ? "s" : ""} until your exam`;
        const el = $("sp-exam-label");
        if (el)
          el.textContent = `${data.subject} · ${new Date(data.exam_date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
      }
    }
    renderStudyPlan(data);
    const btn = $("sp-btn");
    if (btn) btn.textContent = "✨ Regenerate Plan";
  } catch (e) {}
}

let SP_HOURS = 1;

function setSPHours(h, btn) {
  SP_HOURS = h;
  document
    .querySelectorAll(".sp-hrs-btn")
    .forEach((b) => b.classList.remove("sp-hrs-active"));
  if (btn) btn.classList.add("sp-hrs-active");
}

async function generateStudyPlan() {
  const subject = $("sp-subject")?.value.trim();
  const date = $("sp-date")?.value;
  const err = $("sp-err");
  const btn = $("sp-btn");
  const result = $("sp-result");
  const countdown = $("sp-countdown");

  err.textContent = "";

  if (!subject) {
    err.textContent = "Please enter a subject or course.";
    return;
  }
  if (!date) {
    err.textContent = "Please pick your exam date.";
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const examDay = new Date(date);
  const daysLeft = Math.round((examDay - today) / 86400000);

  if (daysLeft < 1) {
    err.textContent = "Exam date must be in the future.";
    return;
  }

  // Show countdown
  countdown.style.display = "flex";
  $("sp-days-text").textContent =
    `${daysLeft} day${daysLeft !== 1 ? "s" : ""} until your exam`;
  $("sp-exam-label").textContent =
    `${subject} · ${examDay.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;

  btn.disabled = true;
  btn.textContent = "⏳ Generating your plan...";
  result.style.display = "none";

  try {
    const res = await fetch("/api/study-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: getToken(),
        subject,
        exam_date: date,
        hours_per_day: SP_HOURS,
      }),
    });

    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || "Failed to generate plan.");
    }

    const data = await res.json();
    localStorage.setItem(`sivarr_sp_${S.sid}`, JSON.stringify(data));
    renderStudyPlan(data);
  } catch (e) {
    err.textContent = e.message || "Something went wrong. Try again.";
    countdown.style.display = "none";
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Regenerate Plan";
  }
}

function renderStudyPlan(data) {
  const result = $("sp-result");
  const plan = data.plan || [];

  if (!plan.length) {
    result.innerHTML =
      '<p style="color:var(--muted);font-size:.85rem">Could not generate plan. Try again.</p>';
    result.style.display = "block";
    return;
  }

  const saved = JSON.parse(localStorage.getItem(`sp_checks_${S.sid}`) || "{}");

  result.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <div style="font-family:var(--font);font-size:.85rem;font-weight:700;color:var(--text)">
        📅 ${plan.length}-Day Plan · ${data.subject}
      </div>
      <button class="sp-export-btn" data-onclick="downloadStudyPlan">
        ⬇ Export
      </button>
    </div>

    ${plan
      .map(
        (day, di) => `
      <div class="sp-day-card" id="sp-day-${di}">
        <div class="sp-day-header">
          <span class="sp-day-num">Day ${day.day} · ${esc(day.date || "")}</span>
          <span class="sp-hours-badge">⏱ ${day.hours || SP_HOURS}h</span>
        </div>
        <div class="sp-day-focus">📖 ${esc(day.focus || "")}</div>
        <div>
          ${(day.tasks || [])
            .map((task, ti) => {
              const key = `${di}_${ti}`;
              const done = saved[key] ? "done" : "";
              return `
              <div class="sp-task">
                <div class="sp-task-check ${done}" data-onclick="toggleSPTask" data-onclick-arg0="${di}" data-onclick-arg1="${ti}" data-onclick-this>
                  ${done ? "✓" : ""}
                </div>
                <span style="${done ? "text-decoration:line-through;opacity:.5" : ""}" id="sp-task-text-${di}-${ti}">${esc(task)}</span>
              </div>`;
            })
            .join("")}
        </div>
      </div>
    `,
      )
      .join("")}

    <div style="background:linear-gradient(135deg,#22c55e10,transparent);border:1px solid #22c55e30;border-radius:12px;padding:.875rem;margin-top:.5rem;text-align:center">
      <div style="font-size:1.2rem;margin-bottom:4px">💪</div>
      <div style="font-family:var(--font);font-size:.82rem;font-weight:700;color:#22c55e">You've got this, ${S.name.split(" ")[0]}!</div>
      <div style="font-size:.72rem;color:var(--muted);margin-top:2px">Tick off tasks as you go. Sivarr's got your back 24/7.</div>
    </div>
  `;

  result.style.display = "block";
  result.scrollIntoView({ behavior: "smooth", block: "start" });
}

function toggleSPTask(di, ti, el) {
  const key = `${di}_${ti}`;
  const saved = JSON.parse(localStorage.getItem(`sp_checks_${S.sid}`) || "{}");
  const done = !saved[key];
  saved[key] = done;
  localStorage.setItem(`sp_checks_${S.sid}`, JSON.stringify(saved));
  el.classList.toggle("done", done);
  el.textContent = done ? "✓" : "";
  const txt = $(`sp-task-text-${di}-${ti}`);
  if (txt)
    txt.style.cssText = done ? "text-decoration:line-through;opacity:.5" : "";
}

function downloadStudyPlan() {
  const subject = $("sp-subject")?.value.trim() || "Study Plan";
  const cards = document.querySelectorAll(".sp-day-card");
  let text = `Sivarr STUDY PLAN: ${subject.toUpperCase()}\n`;
  text += `Generated: ${new Date().toLocaleDateString()}\n`;
  text += "=".repeat(40) + "\n\n";
  cards.forEach((card) => {
    const num = card.querySelector(".sp-day-num")?.textContent || "";
    const focus = card.querySelector(".sp-day-focus")?.textContent || "";
    const tasks = [...card.querySelectorAll(".sp-task span")]
      .map((t) => `  • ${t.textContent.trim()}`)
      .join("\n");
    text += `${num}\n${focus}\n${tasks}\n\n`;
  });
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sivarr-studyplan-${subject.replace(/\s+/g, "-").toLowerCase()}.txt`;
  a.click();
}

// ═══════════════════════ CONTENT HUB ════════════════════════

const CH_KEY = () => `sivarr_ch_${S.sid || "guest"}`;
let CH_ACTIVE_PLATFORM = null;
let CH_PERIOD = 7;

const CH_PLATFORMS = {
  instagram: { name: "Instagram", icon: "📸", color: "#e1306c" },
  tiktok: { name: "TikTok", icon: "🎵", color: "#69c9d0" },
  youtube: { name: "YouTube", icon: "▶️", color: "#ff0000" },
  twitter: { name: "X/Twitter", icon: "𝕏", color: "#1da1f2" },
  linkedin: { name: "LinkedIn", icon: "💼", color: "#0077b5" },
};

const CH_METRICS_DEF = [
  { key: "followers", label: "Followers", color: "#4f6ef7", icon: "👥" },
  {
    key: "followers_new",
    label: "New Followers",
    color: "#22c55e",
    icon: "📈",
  },
  {
    key: "followers_lost",
    label: "Lost Followers",
    color: "#ef4444",
    icon: "📉",
  },
  { key: "views", label: "Views", color: "#a78bfa", icon: "👁" },
  { key: "reach", label: "Reach", color: "#f59e0b", icon: "📡" },
  { key: "likes", label: "Likes", color: "#f472b6", icon: "❤️" },
  { key: "comments", label: "Comments", color: "#34d399", icon: "💬" },
  { key: "shares", label: "Shares", color: "#60a5fa", icon: "🔁" },
  { key: "saves", label: "Saves", color: "#fb923c", icon: "🔖" },
];

function chLoadData() {
  try {
    return JSON.parse(localStorage.getItem(CH_KEY()) || "{}");
  } catch {
    return {};
  }
}
function chSaveData(d) {
  localStorage.setItem(CH_KEY(), JSON.stringify(d));
}

function chInit() {
  const data = chLoadData();
  const connected = Object.keys(data.platforms || {});
  if (connected.length === 0) {
    $("ch-connect-screen").style.display = "block";
    $("ch-dashboard").style.display = "none";
  } else {
    $("ch-connect-screen").style.display = "none";
    $("ch-dashboard").style.display = "block";
    CH_ACTIVE_PLATFORM = CH_ACTIVE_PLATFORM || connected[0];
    chRenderTabs(connected);
    chRenderDashboard();
  }
  // Sync badge states
  connected.forEach((p) => {
    const badge = $(`ch-badge-${p}`);
    if (badge) {
      badge.textContent = "Connected ✓";
      badge.closest("button")?.classList.add("connected");
    }
  });
}

function chShowConnect() {
  $("ch-connect-screen").style.display = "block";
  $("ch-dashboard").style.display = "none";
}

function chConnect(platform) {
  const data = chLoadData();
  data.platforms = data.platforms || {};

  // Generate realistic mock data for demo
  const base = {
    instagram: 12400,
    tiktok: 8200,
    youtube: 3100,
    twitter: 5600,
    linkedin: 2800,
  };
  const b = base[platform] || 5000;
  const days = 30;
  const mkSeries = (base, variance) =>
    Array.from({ length: days }, (_, i) =>
      Math.max(
        0,
        Math.round(
          base +
            (Math.random() - 0.48) * variance +
            i * (Math.random() * 2 - 0.5),
        ),
      ),
    );

  data.platforms[platform] = {
    connected_at: new Date().toISOString(),
    metrics: {
      followers: mkSeries(b, b * 0.02),
      followers_new: mkSeries(Math.round(b * 0.003), 20),
      followers_lost: mkSeries(Math.round(b * 0.001), 8),
      views: mkSeries(b * 4, b * 0.8),
      reach: mkSeries(b * 2.5, b * 0.5),
      likes: mkSeries(b * 0.08, b * 0.02),
      comments: mkSeries(Math.round(b * 0.012), 15),
      shares: mkSeries(Math.round(b * 0.008), 10),
      saves: mkSeries(Math.round(b * 0.015), 12),
    },
  };
  chSaveData(data);

  const badge = $(`ch-badge-${platform}`);
  if (badge) {
    badge.textContent = "Connected ✓";
    badge.closest("button")?.classList.add("connected");
  }
  toast(`${CH_PLATFORMS[platform]?.name} connected! 🎉`);

  CH_ACTIVE_PLATFORM = platform;
  setTimeout(() => chInit(), 400);
}

function chDisconnect() {
  if (!CH_ACTIVE_PLATFORM) return;
  const data = chLoadData();
  delete (data.platforms || {})[CH_ACTIVE_PLATFORM];
  chSaveData(data);
  const badge = $(`ch-badge-${CH_ACTIVE_PLATFORM}`);
  if (badge) {
    badge.textContent = "Connect";
    badge.closest("button")?.classList.remove("connected");
  }
  toast(`Disconnected.`);
  CH_ACTIVE_PLATFORM = null;
  chInit();
}

function chSetPeriod(days, btn) {
  CH_PERIOD = days;
  document
    .querySelectorAll("#ch-period-tabs .ch-tab")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  chRenderDashboard();
}

function chRenderTabs(connected) {
  const tabs = $("ch-platform-tabs");
  if (!tabs) return;
  tabs.innerHTML = connected
    .map((p) => {
      const pl = CH_PLATFORMS[p] || { name: p, icon: "📊" };
      return `<button class="ch-tab ${p === CH_ACTIVE_PLATFORM ? "active" : ""}"
      data-onclick="chSwitchPlatform" data-onclick-arg0="${p}" data-onclick-this>${pl.icon} ${pl.name}</button>`;
    })
    .join("");
}

function chSwitchPlatform(p, btn) {
  CH_ACTIVE_PLATFORM = p;
  document
    .querySelectorAll("#ch-platform-tabs .ch-tab")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  chRenderDashboard();
}

function chRenderDashboard() {
  const data = chLoadData();
  const pdata = data.platforms?.[CH_ACTIVE_PLATFORM];
  if (!pdata) return;

  const metrics = pdata.metrics;
  const period = CH_PERIOD;
  const grid = $("ch-metrics-grid");
  if (!grid) return;

  // Slice to period
  const slice = (obj) =>
    Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, v.slice(-period)]),
    );
  const m = slice(metrics);

  // Compute stats: current = last value, prev = value period ago
  const stat = (arr) => {
    const cur = arr[arr.length - 1] || 0;
    const prev = arr[0] || 0;
    const delta = cur - prev;
    const pct = prev ? ((delta / prev) * 100).toFixed(1) : "0.0";
    return { cur, delta, pct };
  };

  const fmt = (n) =>
    n >= 1000000
      ? (n / 1000000).toFixed(1) + "M"
      : n >= 1000
        ? (n / 1000).toFixed(1) + "K"
        : n;

  // Render metric cards
  grid.innerHTML = CH_METRICS_DEF.map((def) => {
    const s = stat(m[def.key] || [0]);
    const up = s.delta >= 0;
    const arrow = up ? "▲" : "▼";
    const cls = s.delta === 0 ? "flat" : up ? "up" : "down";
    return `
      <div class="ch-metric-card" style="--ch-color:${def.color}">
        <div class="ch-metric-label">${def.icon} ${def.label}</div>
        <div class="ch-metric-val">${fmt(s.cur)}</div>
        <div class="ch-metric-delta ${cls}">${arrow} ${fmt(Math.abs(s.delta))} (${s.pct}%)</div>
      </div>`;
  }).join("");

  // Engagement rate
  const totalFollowers = (m.followers || [0]).at(-1) || 1;
  const totalInteractions =
    ((m.likes || [0]).at(-1) || 0) +
    ((m.comments || [0]).at(-1) || 0) +
    ((m.shares || [0]).at(-1) || 0);
  const engRate = ((totalInteractions / totalFollowers) * 100).toFixed(2);
  const engEl = $("ch-eng-val");
  if (engEl) engEl.textContent = engRate + "%";
  const engFill = $("ch-eng-fill");
  if (engFill)
    engFill.style.width = Math.min(parseFloat(engRate) * 10, 100) + "%";

  // Sparkline for views
  chDrawSparkline(m.views || [], "#4f6ef7");
  const lbl = $("ch-chart-label");
  if (lbl) lbl.textContent = "👁 Views (last " + period + " days)";

  // AI Insight
  chGenerateInsight(m, engRate, CH_ACTIVE_PLATFORM);
}

function chDrawSparkline(data, color) {
  const svg = $("ch-chart-svg");
  if (!svg || !data.length) return;
  const W = 300,
    H = 60,
    pad = 4;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (W - pad * 2);
    const y = H - pad - ((v - min) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const areaClose = `${W - pad},${H} ${pad},${H}`;
  svg.innerHTML = `
    <defs>
      <linearGradient id="ch-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${pts.join(" ")} ${areaClose}" fill="url(#ch-grad)"/>
    <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round"/>
    ${pts
      .map((p, i) =>
        i === pts.length - 1
          ? `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="3" fill="${color}"/>`
          : "",
      )
      .join("")}`;
}

function chGenerateInsight(m, engRate, platform) {
  const insight = $("ch-insight");
  const txt = $("ch-insight-text");
  if (!insight || !txt) return;

  const pName = CH_PLATFORMS[platform]?.name || platform;
  const eng = parseFloat(engRate);
  const views = (m.views || [0]).at(-1) || 0;
  const newFolls = (m.followers_new || [0]).reduce((a, b) => a + b, 0);
  const comments = (m.comments || [0]).reduce((a, b) => a + b, 0);

  let msg = "";
  if (eng > 5)
    msg = `🔥 Your ${pName} engagement rate of ${engRate}% is above average. Your audience is highly active. Keep posting consistently to maintain momentum.`;
  else if (eng > 3)
    msg = `✅ Solid engagement at ${engRate}% on ${pName}. Focus on replies and saves to push past 5%. That's when the algorithm rewards you most.`;
  else if (eng < 1)
    msg = `📉 Your engagement on ${pName} is below 1%. Try shorter content, stronger CTAs, and posting at peak hours (6–9pm local time).`;
  else
    msg = `📊 Your ${pName} stats look steady. You gained ${newFolls.toLocaleString()} new followers this period. ${comments > 50 ? "Great comment engagement!" : "Try ending posts with a question to boost comments."}`;

  txt.textContent = msg;
  insight.style.display = "block";
}

// ═══════════════════════ MOBILE FAB DISPATCH ═════════════════════
// #mob-fab is one global element (templates/_modals.html). It used to open
// quick-capture (cnOpen()) everywhere and only became the Sivarr AI
// quick-chat trigger on the Academic Space panel; it's now the chat trigger
// everywhere, on every panel, and never opens quick-capture at all.
// acadChatToggle() (js/features/academic.js) itself is unaffected by which
// panel is active -- _acadChatContext() there is what adapts per panel.
function mobFabTrigger() {
  if (typeof acadChatToggle === "function") acadChatToggle();
}

// ═══════════════════════ CREATE NEW ═════════════════════════

// CSP migration: multi-statement (close the create-space modal, then open pricing).
window._closeCnModalThenShowPricing = function () {
  document.getElementById("cn-modal-bg")?.classList.remove("open");
  showPricing();
};

function cnOpen() {
  cnTab("create");
  $("cn-modal-bg").classList.add("open");
}
function cnClose(e) {
  if (e.target === $("cn-modal-bg")) $("cn-modal-bg").classList.remove("open");
}

// CSP migration: this call site forces a close regardless of click target by
// constructing a synthetic event object, which isn't expressible as an HTML
// attribute value (a real DOM element reference, not serializable data).
window._forceCloseCnModal = function () {
  cnClose({ target: $("cn-modal-bg") });
};

// CSP migration: multi-statement (close the quick-capture modal, then open
// the separate create-space modal).
window._closeCnModalThenOpenSpace = function () {
  $("cn-modal-bg")?.classList.remove("open");
  openCreateSpaceModal();
};
function cnAction(type) {
  $("cn-modal-bg").classList.remove("open");
  setTimeout(() => {
    if (type === "note") {
      nav("notes", null);
      setTimeout(() => {
        const ta = $("new-note-text");
        if (ta) {
          ta.focus();
          ta.scrollIntoView({ behavior: "smooth" });
        }
      }, 300);
    } else if (type === "task") {
      nav("flux", null);
      setTimeout(() => {
        const btn = document.querySelector(
          '.sh-add-btn, [onclick*="showAddTask"], [onclick*="openTaskModal"]',
        );
        if (btn) btn.click();
      }, 300);
    } else if (type === "studyplan") {
      snavSelect("studyplan", "planner", null);
      setTimeout(() => {
        const el = $("sp-subject");
        if (el) el.focus();
      }, 350);
    } else if (type === "quiz") {
      nav("quiz", null);
      setTimeout(() => {
        const ti = $("quiz-topic-input");
        if (ti) ti.focus();
      }, 300);
    } else if (type === "studydeck") {
      nav("lab", null);
      setTimeout(() => {
        const el = $("lab-file-input-p");
        if (el) el.click();
      }, 350);
    } else if (type === "ask") {
      nav("chat", null);
      setTimeout(() => {
        const ci = $("ci");
        if (ci) ci.focus();
      }, 300);
    }
  }, 250);
}

// ── Framework Templates ────────────────────────────────────────
const _FRAMEWORKS = {
  "study-routine": {
    label: "Study Routine",
    fields: [
      {
        id: "subject",
        label: "Subject / Course",
        placeholder: "e.g. Mathematics",
        required: true,
      },
      {
        id: "duration",
        label: "Daily study time (mins)",
        type: "text",
        placeholder: "e.g. 60",
        default: "60",
      },
    ],
    build(f) {
      const mins = parseInt(f.duration) || 60;
      const subj = f.subject;
      return [
        {
          title: `📖 Read ${subj} notes`,
          type: "reading",
          priority: "high",
          desc: `${mins} min daily reading session`,
        },
        {
          title: `✍️ Practice ${subj} problems`,
          type: "assignment",
          priority: "medium",
          desc: "Work through exercises",
        },
        {
          title: `🔁 Review flashcards: ${subj}`,
          type: "revision",
          priority: "medium",
          desc: "Active recall session",
        },
        {
          title: `📝 Summarise today's ${subj}`,
          type: "other",
          priority: "low",
          desc: "Write key takeaways",
        },
      ];
    },
  },
  "project-pipeline": {
    label: "Project Pipeline",
    fields: [
      {
        id: "project",
        label: "Project name",
        placeholder: "e.g. Website Redesign",
        required: true,
      },
    ],
    build(f) {
      const p = f.project;
      return [
        {
          title: `🗺 Plan: ${p}`,
          type: "other",
          priority: "high",
          desc: "Define scope, goals, and timeline",
        },
        {
          title: `🎨 Design: ${p}`,
          type: "other",
          priority: "high",
          desc: "Wireframes, mockups, architecture",
        },
        {
          title: `🔨 Build: ${p}`,
          type: "project",
          priority: "high",
          desc: "Core implementation sprint",
        },
        {
          title: `🧪 Test: ${p}`,
          type: "other",
          priority: "medium",
          desc: "QA, bug fixes, review",
        },
        {
          title: `🚀 Launch: ${p}`,
          type: "other",
          priority: "medium",
          desc: "Deploy and announce",
        },
        {
          title: `📊 Retrospective: ${p}`,
          type: "other",
          priority: "low",
          desc: "What worked, what to improve",
        },
      ];
    },
  },
  "exam-prep": {
    label: "Exam Prep",
    fields: [
      {
        id: "subject",
        label: "Subject",
        placeholder: "e.g. Physics",
        required: true,
      },
      {
        id: "exam_date",
        label: "Exam date",
        type: "text",
        placeholder: "e.g. 2026-07-15",
      },
    ],
    build(f) {
      const s = f.subject;
      return [
        {
          title: `📋 Make ${s} topic list`,
          type: "revision",
          priority: "high",
          desc: "List all topics and mark weak areas",
        },
        {
          title: `📖 Revise ${s}: Week 1`,
          type: "revision",
          priority: "high",
          desc: "Cover first third of syllabus",
        },
        {
          title: `📖 Revise ${s}: Week 2`,
          type: "revision",
          priority: "high",
          desc: "Cover second third of syllabus",
        },
        {
          title: `📖 Revise ${s}: Week 3`,
          type: "revision",
          priority: "high",
          desc: "Cover final third of syllabus",
        },
        {
          title: `❓ Past papers: ${s}`,
          type: "exam",
          priority: "high",
          desc: "Timed practice with past questions",
        },
        {
          title: `🔁 Weak spots review: ${s}`,
          type: "revision",
          priority: "medium",
          desc: "Focus on topics that need more work",
        },
        {
          title: `✅ Final revision: ${s}`,
          type: "revision",
          priority: "high",
          desc: "Quick-fire review of all key points",
        },
      ];
    },
  },
  "team-sprint": {
    label: "Team Sprint",
    fields: [
      {
        id: "goal",
        label: "Sprint goal",
        placeholder: "e.g. Launch v2 beta",
        required: true,
      },
      {
        id: "duration",
        label: "Sprint length (days)",
        type: "text",
        placeholder: "e.g. 7",
        default: "7",
      },
    ],
    build(f) {
      const g = f.goal;
      return [
        {
          title: `⚡ Sprint planning: ${g}`,
          type: "project",
          priority: "high",
          desc: "Define tasks, assign owners, set deadline",
        },
        {
          title: `🎯 Set milestones: ${g}`,
          type: "project",
          priority: "high",
          desc: "Break goal into measurable checkpoints",
        },
        {
          title: `🔨 Build sprint tasks: ${g}`,
          type: "project",
          priority: "high",
          desc: "Execute the sprint backlog",
        },
        {
          title: `📊 Mid-sprint check-in: ${g}`,
          type: "other",
          priority: "medium",
          desc: "Review progress, unblock team",
        },
        {
          title: `🧪 Sprint review: ${g}`,
          type: "other",
          priority: "medium",
          desc: "Demo output, gather feedback",
        },
        {
          title: `🔁 Sprint retrospective: ${g}`,
          type: "other",
          priority: "low",
          desc: "What went well, what to change",
        },
      ];
    },
  },
};

async function cnFramework(type) {
  cnClose({ target: $("cn-modal-bg") });
  const fw = _FRAMEWORKS[type];
  if (!fw) return;
  const vals = await siModal.form(`⚡ ${fw.label}`, fw.fields, {
    confirmLabel: "Create Tasks",
  });
  if (!vals) return;
  // getSHData/saveSHData/renderSHOverview/renderSHBoard never existed
  // under those names -- this used to build real-looking task objects and
  // then silently fail to store or render any of them.
  const built = fw.build(vals);
  built.forEach((t) => {
    if (typeof window.addTask === "function") {
      window.addTask({
        title: t.title,
        priority: t.priority || "medium",
        desc: t.desc || "",
      });
    }
  });
  nav("flux", null);
  if (typeof window.renderAll === "function") window.renderAll();
  toast(`${built.length} tasks created for "${fw.label}" ✓`);
}

// ═══════════════════════ SETTINGS ═════════════════════════

const ST_KEY = () => `sivarr_st_${S.sid || "guest"}`;

function stLoad() {
  return JSON.parse(localStorage.getItem(ST_KEY()) || "{}");
}
function stSave(data) {
  localStorage.setItem(ST_KEY(), JSON.stringify(data));
}

const ST_SECTIONS = [
  "profile",
  "appearance",
  "notifications",
  "security",
  "plan",
  "data",
];

function stToggleSection(id) {
  const target = $(`st-sec-${id}`);
  if (!target) return;
  const isOpen = target.classList.contains("open");
  // Close all
  ST_SECTIONS.forEach((s) => {
    const el = $(`st-sec-${s}`);
    if (el) el.classList.remove("open");
  });
  // Toggle clicked — open if it was closed
  if (!isOpen) target.classList.add("open");
}

function stInit() {
  // Populate profile fields
  const st = stLoad();
  const nameEl = $("st-name-input");
  const emailEl = $("st-email-input");
  const phoneEl = $("st-phone-input");
  const avatarL = $("st-avatar-letter");
  const nameDisp = $("st-name-display");
  const matDisp = $("st-matric-display");

  if (nameEl) nameEl.value = S.name || "";
  if (emailEl) emailEl.value = st.email || "";
  if (phoneEl) phoneEl.value = st.phone || "";
  if (avatarL) avatarL.textContent = S.name ? S.name[0].toUpperCase() : "?";
  if (nameDisp) nameDisp.textContent = S.name || "";
  if (matDisp) matDisp.textContent = S.email || "";

  // Load profile pic into settings avatar
  const saved = localStorage.getItem(`sivarr_pfp_${S.sid}`);
  if (saved) {
    const av = $("st-avatar");
    if (av) {
      av.style.backgroundImage = `url(${saved})`;
      av.style.backgroundSize = "cover";
      $("st-avatar-letter").style.display = "none";
    }
  }

  // ── Appearance controls (theme mode / density / font size) ──
  const _mode =
    localStorage.getItem("sivarr_theme_mode") ||
    (localStorage.getItem("sivarr_theme") === "dark" ? "dark" : "light");
  _stSyncSeg("st-theme-seg", "mode", _mode);
  const _dens = localStorage.getItem("sivarr_density") || "cozy";
  _stSyncSeg("st-density-seg", "density", _dens);
  stApplyReduceMotion(localStorage.getItem("sivarr_reduce_motion") === "on");
  const _fs = parseInt(localStorage.getItem("sivarr_font_scale")) || 100;
  const _fsr = $("st-fontscale");
  if (_fsr) _fsr.value = _fs;
  const _fsl = $("st-fontscale-label");
  if (_fsl) _fsl.textContent = _fs + "%";
  const _diVal =
    typeof briefDecorIntensity === "function" ? briefDecorIntensity() : 50;
  const _dir = $("st-decor-opacity");
  if (_dir) _dir.value = _diVal;
  const _dil = $("st-decor-label");
  if (_dil) _dil.textContent = _decorLabel(_diVal);

  // Notification toggles
  ["ann", "streak", "quiz"].forEach((key) => {
    const el = $(`st-notif-${key}`);
    if (el) {
      const val = localStorage.getItem(`sivarr_notif_${key}`);
      if (val === "off") el.classList.remove("on");
      else el.classList.add("on");
    }
  });

  // ── Colour wheel — restore from saved accent ──
  stWheelInit();
  const _acc = localStorage.getItem("sivarr_accent") || "#41076B";
  const _acc2 = localStorage.getItem("sivarr_accent2") || "#7B2CAD";
  const _hsl = _hexToHsl(_acc);
  _stWheelH = _hsl.h;
  _stWheelS = _hsl.s;
  _stWheelL = _hsl.l;
  _stWheelCommit(false);
  const _hi = $("st-hex-input");
  if (_hi) _hi.value = _acc.replace("#", "").toUpperCase();
  const _nc = $("st-native-color");
  if (_nc) _nc.value = _acc;
  const _h2 = $("st-hex2-input");
  if (_h2) _h2.value = _acc2.replace("#", "").toUpperCase();
  const _n2 = $("st-native-color2");
  if (_n2) _n2.value = _acc2;
  document.querySelectorAll(".st-accent-dot").forEach((d) => {
    const bg = (d.style.background || "").replace(/\s/g, "").toLowerCase();
    d.classList.toggle("sel", bg === _acc.toLowerCase());
  });

  // Usage bars + plan details
  stUpdateUsage();
  stLoadBillingHistory();
  st2faInit();
  stLoadSessions();

  // Org settings (Blueprint Stage 3) — shown only when the user is in an org
  if (typeof orgSettingsInit === "function") orgSettingsInit();
  if (typeof stExtrasRestore === "function") stExtrasRestore();

  // Sub-nav: mirror Organisation visibility, then enable scroll-spy
  const _orgSec = $("st-sec-org"),
    _orgNav = $("st-subnav-org");
  if (_orgNav && _orgSec)
    _orgNav.style.display = _orgSec.style.display === "none" ? "none" : "";
  _stScrollSpyInit();
}

function stUpdateUsage() {
  const today = new Date().toISOString().split("T")[0];
  const hist = JSON.parse(
    localStorage.getItem(`sivarr_usage_${today}`) || '{"chat":0,"quiz":0}',
  );
  const chatUsed = hist.chat || 0;
  const quizUsed = hist.quiz || 0;
  const isPaid = _planLevel(_BILLING_STATUS?.name || "free") > 0;
  const chatMax = isPaid ? 999 : 20;
  const quizMax = isPaid ? 999 : 5;

  const cu = $("st-usage-chat");
  if (cu)
    cu.textContent = isPaid ? `${chatUsed} / ∞` : `${chatUsed} / ${chatMax}`;
  const cb = $("st-usage-chat-bar");
  if (cb)
    cb.style.width = isPaid
      ? "100%"
      : Math.min((chatUsed / chatMax) * 100, 100) + "%";
  if (cb && isPaid) cb.style.background = "var(--accent)";
  const qu = $("st-usage-quiz");
  if (qu)
    qu.textContent = isPaid ? `${quizUsed} / ∞` : `${quizUsed} / ${quizMax}`;
  const qb = $("st-usage-quiz-bar");
  if (qb)
    qb.style.width = isPaid
      ? "100%"
      : Math.min((quizUsed / quizMax) * 100, 100) + "%";
  if (qb && isPaid) qb.style.background = "var(--accent)";

  const sub = _BILLING_STATUS || {};
  const plan = sub.name || "Free";
  const status = sub.status || "active";

  const badge = $("st-plan-badge");
  if (badge) {
    badge.textContent = isPaid ? `⚡ ${plan}` : "✦ Free";
    badge.className = `st-plan-badge ${isPaid ? "st-plan-pro" : "st-plan-free"}`;
  }

  const meta = $("st-plan-meta");
  if (meta) {
    if (isPaid) {
      meta.style.display = "";
      const expEl = $("st-plan-expires");
      if (expEl) expEl.textContent = sub.expires || "–";
      const gwEl = $("st-plan-gateway");
      if (gwEl)
        gwEl.textContent = sub.gateway
          ? sub.gateway.charAt(0).toUpperCase() + sub.gateway.slice(1)
          : "Paystack";
      const stEl = $("st-plan-status");
      if (stEl) {
        stEl.textContent =
          status === "cancelled" ? "Cancelled (access until expiry)" : "Active";
        stEl.style.color =
          status === "cancelled"
            ? "var(--amber,#f59e0b)"
            : "var(--green,#22c55e)";
      }
    } else {
      meta.style.display = "none";
    }
  }

  const cta = $("st-plan-cta");
  const cancel = $("st-plan-cancel");
  if (cta) cta.style.display = isPaid ? "none" : "";
  if (cancel)
    cancel.style.display = isPaid && status !== "cancelled" ? "" : "none";
}

let _stBillingHistory = [];
async function stLoadBillingHistory() {
  const token = getToken() || "";
  if (!token) return;
  try {
    const r = await fetch(
      `/api/billing/history?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    const list = $("st-billing-history-list");
    const wrap = $("st-billing-history");
    if (!list || !wrap) return;
    if (!d.history || d.history.length === 0) {
      wrap.style.display = "none";
      return;
    }
    _stBillingHistory = d.history;
    wrap.style.display = "";
    list.innerHTML = d.history
      .map(
        (h, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:.78rem">
        <div>
          <div style="font-weight:600">${esc(h.plan)}</div>
          <div style="color:var(--muted);margin-top:2px">${esc(h.date)} · ${esc(h.gateway || "Paystack")}</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <div style="text-align:right">
            <div style="font-weight:700;color:var(--accent)">${esc(h.amount)}</div>
            <div style="color:var(--muted);font-size:.7rem">${esc(h.reference || "")}</div>
          </div>
          <button class="int-btn" style="padding:5px 9px;font-size:.72rem" data-onclick="stDownloadInvoice" data-onclick-args="[${i}]" title="Download invoice"><i class="ti ti-download" aria-hidden="true"></i> Invoice</button>
        </div>
      </div>`,
      )
      .join("");
  } catch (_) {}
}
// Stage 10: generate a self-contained, printable HTML invoice from a billing record.
function stDownloadInvoice(i) {
  const h = _stBillingHistory[i];
  if (!h) return;
  const who = (typeof S !== "undefined" && S.name) || "";
  const email = (typeof S !== "undefined" && S.email) || "";
  const ref = h.reference || "SVR-" + Date.now();
  // NOT part of the CSP migration: this is a self-contained, standalone
  // HTML document served as its own downloadable blob (a.href below), never
  // inserted into this app's own DOM and never loaded with delegate.js --
  // its inline onclick="window.print()" runs in a fresh, unrelated document
  // context that our unsafe-inline removal doesn't reach or need to.
  const inv = `<!doctype html><html><head><meta charset="utf-8"><title>Sivarr invoice ${esc(ref)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:640px;margin:40px auto;padding:0 24px}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0ea5a4;padding-bottom:16px;margin-bottom:24px}
.brand{font-size:1.5rem;font-weight:800;color:#0ea5a4}.muted{color:#666;font-size:.85rem}
table{width:100%;border-collapse:collapse;margin:20px 0}td,th{text-align:left;padding:10px 0;border-bottom:1px solid #eee;font-size:.9rem}
.tot{font-size:1.2rem;font-weight:800;text-align:right;margin-top:8px}.r{text-align:right}
@media print{body{margin:0}.noprint{display:none}}</style></head>
<body>
<div class="hd"><div><div class="brand">Sivarr</div><div class="muted">sivarr.com</div></div>
<div class="r"><div style="font-weight:700">INVOICE</div><div class="muted">${esc(ref)}</div><div class="muted">${esc(h.date || "")}</div></div></div>
<div class="muted">Billed to</div><div style="font-weight:600;margin-bottom:4px">${esc(who || "Sivarr customer")}</div>${email ? `<div class="muted">${esc(email)}</div>` : ""}
<table><thead><tr><th>Description</th><th class="r">Amount</th></tr></thead>
<tbody><tr><td>${esc(h.plan || "Subscription")} (Sivarr plan)</td><td class="r">${esc(h.amount || "")}</td></tr></tbody></table>
<div class="tot">Total: ${esc(h.amount || "")}</div>
<div class="muted" style="margin-top:24px">Paid via ${esc(h.gateway || "Paystack")}. Thank you for using Sivarr.</div>
<button class="noprint" onclick="window.print()" style="margin-top:24px;padding:10px 20px;background:#0ea5a4;color:#fff;border:0;border-radius:8px;font-weight:700;cursor:pointer">Print / Save as PDF</button>
</body></html>`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([inv], { type: "text/html" }));
  a.download = `sivarr-invoice-${ref}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function billingCancelConfirm() {
  const ok = await siModal.confirm(
    "You'll keep access until your expiry date, but won't be renewed. Continue?",
    {
      title: "Cancel subscription?",
      confirmLabel: "Yes, cancel",
      danger: true,
    },
  );
  if (!ok) return;
  const token = getToken() || "";
  try {
    const r = await fetch("/api/billing/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const d = await r.json();
    if (d.ok) {
      toast(d.message || "Subscription cancelled.");
      await billingLoadStatus();
      stUpdateUsage();
    } else {
      toast(d.detail || "Could not cancel. Contact support.");
    }
  } catch (_) {
    toast("Could not cancel. Please try again.");
  }
}

async function stSaveProfile() {
  const name = $("st-name-input")?.value.trim();
  const phone = $("st-phone-input")?.value.trim() || "";
  if (!name || name.length < 2) {
    toast("Name must be at least 2 characters.");
    return;
  }
  const token = getToken();
  const btn = document.querySelector('[data-onclick="stSaveProfile"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  try {
    if (token) {
      await fetch("/api/user/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, phone }),
      });
    }
    S.name = name;
    const st = stLoad();
    st.phone = phone;
    stSave(st);
    const nameDisp = $("st-name-display");
    if (nameDisp) nameDisp.textContent = name;
    const avatarL = $("st-avatar-letter");
    if (avatarL) avatarL.textContent = name[0].toUpperCase();
    const tbAv = $("tb-av");
    if (tbAv) tbAv.textContent = name[0].toUpperCase();
    const tbName = $("tb-name");
    if (tbName) tbName.textContent = name;
    _saveStatus("saved");
    toast("Profile saved ✓");
  } catch {
    toast("Could not save. Try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save Profile";
    }
  }
}

function stToggleTheme(btn) {
  btn.classList.toggle("on");
  toggleThemeFromMenu();
}

// CSP migration: param order flipped to (key, btn) -- delegate.js's
// data-onclick-this always appends the element LAST.
function stToggleNotif(key, btn) {
  const turningOn = !btn.classList.contains("on");
  btn.classList.toggle("on");
  const isOn = btn.classList.contains("on");
  localStorage.setItem(`sivarr_notif_${key}`, isOn ? "on" : "off");

  if (
    isOn &&
    (key === "streak" || key === "tasks") &&
    "Notification" in window
  ) {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") {
        toast(`${key === "streak" ? "Streak" : "Task"} reminders enabled`);
        _pushSubscribeForKey(key);
      } else {
        btn.classList.remove("on");
        localStorage.setItem(`sivarr_notif_${key}`, "off");
        const errEl = document.createElement("div");
        errEl.style.cssText =
          "font-size:.78rem;color:var(--red,#ef4444);margin-top:4px";
        errEl.textContent =
          "Enable notifications in your browser settings first.";
        btn.parentElement?.appendChild(errEl);
        setTimeout(() => errEl.remove(), 4000);
      }
    });
  } else {
    toast(`${isOn ? "Enabled" : "Disabled"} notifications`);
  }
}

async function _pushSubscribeForKey(type) {
  try {
    const token = getToken() || "";
    if (!token || !navigator.serviceWorker) return;
    const cfgR = await fetch("/api/config");
    const cfg = await cfgR.json();
    if (!cfg.vapid_public_key) return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(cfg.vapid_public_key),
      });
    }
    await fetch("/api/notifications/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, subscription: sub.toJSON(), type }),
    });
    localStorage.setItem("sivarr_notif_subscribed", "true");
  } catch (_) {}
}

// Full accent colour map — each swatch defines every derived CSS variable
const _ACCENT_MAP = {
  "#4f6ef7": {
    teal: "#4f6ef7",
    teal2: "rgba(79,110,247,.12)",
    teal3: "rgba(79,110,247,.22)",
    teal4: "#3a55d4",
    purple: "#7c3aed",
    purple2: "rgba(124,58,237,.12)",
    glow: "0 0 20px rgba(79,110,247,.3)",
  },
  // "Sivarr" default swatch (see the Settings preset button) — was the old
  // pre-rebrand teal (#0D7A5F/#534AB7); matches base.css's actual current
  // default (--accent/--accent2) now.
  "#41076b": {
    teal: "#41076b",
    teal2: "rgba(65,7,107,.12)",
    teal3: "rgba(65,7,107,.22)",
    teal4: "#2d0454",
    purple: "#7b2cad",
    purple2: "rgba(123,44,173,.12)",
    glow: "0 0 20px rgba(65,7,107,.3)",
  },
  "#06b6d4": {
    teal: "#06b6d4",
    teal2: "rgba(6,182,212,.12)",
    teal3: "rgba(6,182,212,.22)",
    teal4: "#0891b2",
    purple: "#0284c7",
    purple2: "rgba(2,132,199,.12)",
    glow: "0 0 20px rgba(6,182,212,.3)",
  },
  "#10b981": {
    teal: "#10b981",
    teal2: "rgba(16,185,129,.12)",
    teal3: "rgba(16,185,129,.22)",
    teal4: "#059669",
    purple: "#7c3aed",
    purple2: "rgba(124,58,237,.12)",
    glow: "0 0 20px rgba(16,185,129,.3)",
  },
  "#f59e0b": {
    teal: "#f59e0b",
    teal2: "rgba(245,158,11,.12)",
    teal3: "rgba(245,158,11,.22)",
    teal4: "#d97706",
    purple: "#ef4444",
    purple2: "rgba(239,68,68,.1)",
    glow: "0 0 20px rgba(245,158,11,.3)",
  },
  "#ef4444": {
    teal: "#ef4444",
    teal2: "rgba(239,68,68,.1)",
    teal3: "rgba(239,68,68,.2)",
    teal4: "#dc2626",
    purple: "#f97316",
    purple2: "rgba(249,115,22,.1)",
    glow: "0 0 20px rgba(239,68,68,.3)",
  },
  "#ec4899": {
    teal: "#ec4899",
    teal2: "rgba(236,72,153,.1)",
    teal3: "rgba(236,72,153,.2)",
    teal4: "#db2777",
    purple: "#8b5cf6",
    purple2: "rgba(139,92,246,.1)",
    glow: "0 0 20px rgba(236,72,153,.3)",
  },
  "#8b5cf6": {
    teal: "#8b5cf6",
    teal2: "rgba(139,92,246,.12)",
    teal3: "rgba(139,92,246,.22)",
    teal4: "#7c3aed",
    purple: "#ec4899",
    purple2: "rgba(236,72,153,.1)",
    glow: "0 0 20px rgba(139,92,246,.3)",
  },
};

// ─── Colour maths (shared by accent presets + colour wheel) ───
function _hexToRgb(hex) {
  hex = (hex || "").replace("#", "");
  if (hex.length === 3)
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  const n = parseInt(hex || "0", 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function _rgba(hex, a) {
  const { r, g, b } = _hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function _hexToHsl(hex) {
  let { r, g, b } = _hexToRgb(hex);
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b);
  let h,
    s,
    l = (mx + mn) / 2;
  if (mx === mn) {
    h = s = 0;
  } else {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    switch (mx) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s, l };
}
function _hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }
  const to = (v) => ("0" + Math.round((v + m) * 255).toString(16)).slice(-2);
  return "#" + to(r) + to(g) + to(b);
}
// Auto-derive a pleasing secondary/gradient colour from a primary
function _deriveSecondary(hex) {
  const { h, s, l } = _hexToHsl(hex);
  return _hslToHex(
    h + 150,
    Math.max(0.45, s * 0.9),
    Math.min(0.62, Math.max(0.42, l)),
  );
}

function _applyAccentColor(color, color2) {
  const r = document.documentElement.style;
  const m = _ACCENT_MAP[color] || null;
  const c1 = (m && m.teal) || color;
  const c2 = (m && m.purple) || color2 || _deriveSecondary(c1);
  r.setProperty("--accent", c1);
  r.setProperty("--accent2", c2);
  r.setProperty("--teal", c1);
  r.setProperty("--teal2", (m && m.teal2) || _rgba(c1, 0.12));
  r.setProperty("--teal3", (m && m.teal3) || _rgba(c1, 0.22));
  r.setProperty("--teal4", (m && m.teal4) || c1);
  r.setProperty("--purple", c2);
  r.setProperty("--purple2", (m && m.purple2) || _rgba(c2, 0.12));
  r.setProperty("--glow-teal", (m && m.glow) || `0 0 20px ${_rgba(c1, 0.3)}`);
  r.setProperty("--glow-purple", `0 0 20px ${_rgba(c2, 0.3)}`);
  r.setProperty("--ai-grad", `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`);
}

function stSetAccent(color, color2, el) {
  document
    .querySelectorAll(".st-accent-dot")
    .forEach((d) => d.classList.remove("sel"));
  if (el) el.classList.add("sel");
  _applyAccentColor(color, color2);
  localStorage.setItem("sivarr_accent", color);
  localStorage.setItem("sivarr_accent2", color2 || "");
  toast("Accent colour updated ✓");
}

// ═══════════ APPEARANCE: colour wheel + theme modes + density ═══════════

function _normHex(v) {
  if (!v) return null;
  v = String(v).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(v))
    v = v
      .split("")
      .map((c) => c + c)
      .join("");
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
  return "#" + v.toLowerCase();
}

// Central colour application — persists + syncs every control
function stApplyColor(hex, secondary, syncWheel) {
  hex = _normHex(hex);
  if (!hex) return;
  const sec = secondary
    ? _normHex(secondary)
    : localStorage.getItem("sivarr_accent2") || _deriveSecondary(hex);
  _applyAccentColor(hex, sec);
  localStorage.setItem("sivarr_accent", hex);
  localStorage.setItem("sivarr_accent2", sec);
  // sync swatches
  document.querySelectorAll(".st-accent-dot").forEach((d) => {
    const bg = (d.style.background || "").replace(/\s/g, "").toLowerCase();
    d.classList.toggle("sel", bg === hex.toLowerCase());
  });
  // sync hex + native inputs
  const hi = $("st-hex-input");
  if (hi) hi.value = hex.replace("#", "").toUpperCase();
  const nc = $("st-native-color");
  if (nc) nc.value = hex;
  const h2 = $("st-hex2-input");
  if (h2) h2.value = sec.replace("#", "").toUpperCase();
  const n2 = $("st-native-color2");
  if (n2) n2.value = sec;
  if (syncWheel) {
    const { h, s, l } = _hexToHsl(hex);
    _stWheelH = h;
    _stWheelS = s;
    _stWheelL = l;
    _stWheelCommit(false);
  }
}

// CSP migration: takes the input element (delegate.js has no `this.value`
// grammar) instead of the raw value string.
function stHexInput(el) {
  const hex = _normHex(el.value);
  if (!hex) {
    toast("Enter a valid hex colour");
    return;
  }
  stApplyColor(hex, null, true);
}
// CSP migration: takes the input element instead of the raw value string.
function stSetSecondary(el) {
  const hex = _normHex(el.value);
  if (!hex) {
    toast("Invalid colour");
    return;
  }
  const primary = localStorage.getItem("sivarr_accent") || "#41076b";
  stApplyColor(primary, hex, false);
}
// CSP migration: Enter-to-submit wrappers for the hex-colour text inputs.
window._stHexInputOnEnter = function (e) {
  if (e.key === "Enter") stHexInput(e.target);
};
window._stSetSecondaryOnEnter = function (e) {
  if (e.key === "Enter") stSetSecondary(e.target);
};
function stPickPreset(c1, c2, el) {
  stApplyColor(c1, c2, true);
  toast("Theme colour updated ✓");
}
function stResetAppearance() {
  // Was flat (#41076b, #41076b) — same bug as the CSS --accent/--accent2
  // duplicate-value bug: any two-tone gradient using both stops rendered
  // as a solid colour. Matches base.css's actual default now.
  stApplyColor("#41076b", "#7b2cad", true);
  toast("Reset to Sivarr default");
}

// ── Colour wheel (hue/sat ring + lightness slider) ──
let _stWheelH = 160,
  _stWheelS = 1,
  _stWheelL = 0.5;
function stWheelInit() {
  const w = $("st-wheel");
  if (!w || w.dataset.bound) return;
  w.dataset.bound = "1";
  const onMove = (e) => {
    const rect = w.getBoundingClientRect();
    const cx = rect.left + rect.width / 2,
      cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx,
      dy = e.clientY - cy;
    const R = rect.width / 2;
    const r = Math.min(Math.hypot(dx, dy), R);
    _stWheelS = R ? r / R : 0;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    _stWheelH = (((ang + 90) % 360) + 360) % 360;
    _stWheelCommit(true);
  };
  w.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      w.setPointerCapture(e.pointerId);
    } catch (_) {}
    onMove(e);
    const mv = (ev) => onMove(ev);
    const up = () => {
      w.removeEventListener("pointermove", mv);
      w.removeEventListener("pointerup", up);
      w.removeEventListener("pointercancel", up);
    };
    w.addEventListener("pointermove", mv);
    w.addEventListener("pointerup", up);
    w.addEventListener("pointercancel", up);
  });
}
function _stWheelThumb() {
  const w = $("st-wheel"),
    t = $("st-wheel-thumb");
  if (!w || !t) return;
  const R = w.clientWidth / 2;
  const ang = ((_stWheelH - 90) * Math.PI) / 180;
  t.style.left = R + Math.cos(ang) * _stWheelS * R + "px";
  t.style.top = R + Math.sin(ang) * _stWheelS * R + "px";
  t.style.background = _hslToHex(_stWheelH, _stWheelS, _stWheelL);
}
function _stUpdateLightSlider() {
  const sl = $("st-light-slider");
  if (!sl) return;
  const hue = _hslToHex(_stWheelH, _stWheelS, 0.5);
  sl.style.background = `linear-gradient(90deg, #000, ${hue}, #fff)`;
  sl.value = Math.round(_stWheelL * 100);
}
// broadcast=true → also persist/apply the colour app-wide
function _stWheelCommit(broadcast) {
  _stWheelThumb();
  _stUpdateLightSlider();
  const hex = _hslToHex(_stWheelH, _stWheelS, _stWheelL);
  const hi = $("st-hex-input");
  if (hi) hi.value = hex.replace("#", "").toUpperCase();
  const nc = $("st-native-color");
  if (nc) nc.value = hex;
  if (broadcast) stApplyColor(hex, null, false);
}
// CSP migration: takes the range-input element instead of the raw value string.
function stWheelLight(el) {
  _stWheelL = Math.max(0, Math.min(1, (parseInt(el.value) || 50) / 100));
  _stWheelCommit(true);
}

// ── Theme modes (light / dark / system) ──
function _resolveTheme(mode) {
  if (mode === "system")
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  return mode === "dark" ? "dark" : "light";
}
function _syncThemeIcons(eff) {
  const nowDark = eff === "dark";
  const sw = $("pd-toggle-sw");
  if (sw) sw.classList.toggle("on", nowDark);
  const icon = $("pd-theme-icon");
  if (icon)
    icon.className = nowDark ? "ti ti-moon pd-icon" : "ti ti-sun pd-icon";
  const label = $("pd-theme-label");
  if (label) label.textContent = nowDark ? "Dark Mode" : "Light Mode";
  const themeIcon = $("theme-icon");
  if (themeIcon) themeIcon.className = nowDark ? "ti ti-moon" : "ti ti-sun";
}
function _stSyncSeg(segId, attr, val) {
  const seg = $(segId);
  if (!seg) return;
  seg
    .querySelectorAll(".st-seg-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset[attr] === val));
}
function stApplyThemeMode(mode) {
  mode = ["light", "dark", "system"].includes(mode) ? mode : "light";
  localStorage.setItem("sivarr_theme_mode", mode);
  const eff = _resolveTheme(mode);
  const html = document.documentElement;
  document.body.classList.add("theme-transitioning");
  setTimeout(() => document.body.classList.remove("theme-transitioning"), 300);
  if (eff === "dark") html.setAttribute("data-theme", "dark");
  else html.removeAttribute("data-theme");
  localStorage.setItem("sivarr_theme", eff); // legacy key kept in sync
  const sa = localStorage.getItem("sivarr_accent");
  if (sa) _applyAccentColor(sa, localStorage.getItem("sivarr_accent2") || "");
  _syncThemeIcons(eff);
  _stSyncSeg("st-theme-seg", "mode", mode);
}
function stSetThemeMode(mode) {
  stApplyThemeMode(mode);
  toast("Theme: " + mode.charAt(0).toUpperCase() + mode.slice(1));
}

// ── UI density + font size ──
function stSetDensity(d) {
  d = d === "compact" ? "compact" : "cozy";
  if (d === "cozy") document.documentElement.removeAttribute("data-density");
  else document.documentElement.setAttribute("data-density", d);
  localStorage.setItem("sivarr_density", d);
  _stSyncSeg("st-density-seg", "density", d);
}

function stApplyReduceMotion(on) {
  if (on) document.documentElement.setAttribute("data-reduce-motion", "on");
  else document.documentElement.removeAttribute("data-reduce-motion");
  const btn = $("st-reduce-motion");
  if (btn) btn.classList.toggle("on", !!on);
}
function stSetReduceMotion(btn) {
  const on = !btn.classList.contains("on");
  localStorage.setItem("sivarr_reduce_motion", on ? "on" : "off");
  stApplyReduceMotion(on);
}
// CSP migration: takes the range-input element instead of the raw value string.
function stSetFontScale(el) {
  let v = Math.max(85, Math.min(120, parseInt(el.value) || 100));
  document.documentElement.style.setProperty("--font-scale", v / 100);
  localStorage.setItem("sivarr_font_scale", v);
  const l = $("st-fontscale-label");
  if (l) l.textContent = v + "%";
  const r = $("st-fontscale");
  if (r && +r.value !== v) r.value = v;
}

function _decorLabel(v) {
  v = +v;
  return v === 0 ? "Off" : v <= 30 ? "Subtle" : v <= 60 ? "Medium" : "Bold";
}
// CSP migration: takes the range-input element instead of the raw value string.
function stSetDecorOpacity(el) {
  let v = Math.max(0, Math.min(100, parseInt(el.value) || 0));
  localStorage.setItem("sivarr_decor_intensity", v);
  const l = $("st-decor-label");
  if (l) l.textContent = _decorLabel(v);
  const r = $("st-decor-opacity");
  if (r && +r.value !== v) r.value = v;
  if (typeof renderBriefDecor === "function") renderBriefDecor();
}

// ── Settings sub-nav: scroll-spy + jump ──
let _stSpyObs = null;
function _stScrollSpyInit() {
  const root = $("st-content");
  if (!root) return;
  if (_stSpyObs) _stSpyObs.disconnect();
  const items = [...document.querySelectorAll(".st-subnav-item")];
  _stSpyObs = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          const id = en.target.id.replace("st-sec-", "");
          items.forEach((it) =>
            it.classList.toggle("active", it.dataset.sec === id),
          );
        }
      });
    },
    { root, rootMargin: "-8% 0px -72% 0px", threshold: 0 },
  );
  document
    .querySelectorAll("#st-content .st-section")
    .forEach((s) => _stSpyObs.observe(s));
}
function stGoSection(id, el) {
  const t = $("st-sec-" + id),
    root = $("st-content");
  if (t && root)
    root.scrollTo({ top: Math.max(0, t.offsetTop - 12), behavior: "smooth" });
  document
    .querySelectorAll(".st-subnav-item")
    .forEach((it) =>
      it.classList.toggle("active", it === el || it.dataset.sec === id),
    );
}
function stFilterSubnav(el) {
  const q = (el.value || "").trim().toLowerCase();
  document.querySelectorAll("#st-subnav .st-subnav-item[data-sec]").forEach((it) => {
    const label = it.textContent.trim().toLowerCase();
    it.classList.toggle("st-nav-hidden", q.length > 0 && !label.includes(q));
  });
}

async function stChangePassword() {
  const current = $("st-pw-current")?.value?.trim();
  const pw = $("st-pw-input")?.value;
  const pw2 = $("st-pw2-input")?.value;
  if (!current) {
    toast("Enter your current password.");
    return;
  }
  if (!pw || pw.length < 8) {
    toast("New password must be at least 8 characters.");
    return;
  }
  if (pw !== pw2) {
    toast("New passwords do not match.");
    return;
  }
  const token = getToken();
  if (!token) {
    toast("Session expired. Please sign in again.");
    return;
  }
  const btn = $("st-pw-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Updating…";
  }
  try {
    const r = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        current_password: current,
        new_password: pw,
      }),
    });
    const d = await r.json();
    if (!r.ok) {
      toast(d.detail || "Failed to update password.");
      return;
    }
    toast("Password updated ✓");
    if ($("st-pw-current")) $("st-pw-current").value = "";
    if ($("st-pw-input")) $("st-pw-input").value = "";
    if ($("st-pw2-input")) $("st-pw2-input").value = "";
  } catch {
    toast("Network error. Try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🔑 Update Password";
    }
  }
}

async function stLogoutAll() {
  if (
    !(await siModal.confirm("You will be signed out on all devices.", {
      title: "Sign Out Everywhere",
      confirmLabel: "Sign Out",
      danger: true,
    }))
  )
    return;
  const token = getToken();
  if (token) {
    try {
      await fetch("/api/auth/sessions/revoke-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {}
  }
  clearSession();
  location.reload();
}

// ── Sessions & Devices ──────────────────────────────────────────────
function _stEsc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
function _stTimeAgo(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "Active now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
async function stLoadSessions() {
  const list = $("st-sessions-list");
  if (!list) return;
  const token = getToken();
  if (!token) return;
  try {
    const r = await fetch("/api/auth/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const d = await r.json();
    if (!r.ok || !d.sessions) {
      list.innerHTML = `<div style="font-size:0.78rem;color:var(--muted)">Couldn't load sessions.</div>`;
      return;
    }
    if (!d.sessions.length) {
      list.innerHTML = `<div style="font-size:0.78rem;color:var(--muted)">No active sessions.</div>`;
      return;
    }
    list.innerHTML = d.sessions
      .map((s) => {
        const icon =
          s.device.includes("iPhone") || s.device.includes("Android")
            ? "ti-device-mobile"
            : s.device.includes("iPad")
              ? "ti-device-tablet"
              : "ti-device-laptop";
        const right = s.is_current
          ? `<span class="st-session-now">Active now</span>`
          : `<button class="st-session-revoke" data-onclick="stRevokeSession" data-onclick-arg0="${_stEsc(s.ref)}" data-onclick-this>Sign out</button>`;
        return `<div class="st-session-row">
          <div class="st-session-icon"><i class="ti ${icon}"></i></div>
          <div style="flex:1;min-width:0">
            <div class="st-session-name">${_stEsc(s.device)}${s.is_current ? " · This device" : ""}</div>
            <div class="st-session-meta">${_stEsc(s.ip)} · ${_stTimeAgo(s.last_seen)}</div>
          </div>
          ${right}
        </div>`;
      })
      .join("");
  } catch {
    list.innerHTML = `<div style="font-size:0.78rem;color:var(--muted)">Couldn't load sessions.</div>`;
  }
}
async function stRevokeSession(ref, btn) {
  const token = getToken();
  if (!token) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "…";
  }
  try {
    const r = await fetch("/api/auth/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ref }),
    });
    if (r.ok) {
      toast("Session signed out");
      stLoadSessions();
    } else {
      toast("Couldn't sign out that session.");
    }
  } catch {
    toast("Network error. Try again.");
  }
}

// ── 2FA (Session 20) ──────────────────────────────────────────────
// Four states, one visible at a time: st-2fa-off / st-2fa-setup /
// st-2fa-recovery / st-2fa-on. st-2fa-disable-confirm layers on top of
// st-2fa-on. _2faShow() is the only thing that toggles visibility so the
// states can't end up double-shown.
function _2faShow(id) {
  [
    "st-2fa-off",
    "st-2fa-setup",
    "st-2fa-recovery",
    "st-2fa-on",
    "st-2fa-disable-confirm",
  ].forEach((sid) => {
    const el = $(sid);
    if (el) el.style.display = sid === id ? "" : "none";
  });
}

async function st2faInit() {
  const statusEl = $("st-2fa-status");
  const token = getToken();
  if (!token) return;
  try {
    const r = await fetch("/api/auth/2fa/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const d = await r.json();
    if (!r.ok) {
      if (statusEl) statusEl.textContent = "";
      return;
    }
    if (d.enabled) {
      if (statusEl) statusEl.textContent = "Enabled ✓";
      _2faShow("st-2fa-on");
    } else {
      if (statusEl) statusEl.textContent = "Off";
      _2faShow("st-2fa-off");
    }
  } catch {
    if (statusEl) statusEl.textContent = "";
  }
}

let _2faPending = null; // { secret, otpauth_url, qr_svg }

async function st2faStart() {
  const token = getToken();
  if (!token) {
    toast("Session expired. Please sign in again.");
    return;
  }
  const btn = $("st-2fa-start-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Generating…";
  }
  try {
    const r = await fetch("/api/auth/2fa/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const d = await r.json();
    if (!r.ok) {
      toast(d.detail || "Could not start 2FA setup.");
      return;
    }
    _2faPending = d;
    const qr = $("st-2fa-qr");
    if (qr) qr.innerHTML = d.qr_svg || "";
    const secretEl = $("st-2fa-secret");
    if (secretEl) secretEl.textContent = d.secret || "";
    const codeInput = $("st-2fa-confirm-code");
    if (codeInput) codeInput.value = "";
    _2faShow("st-2fa-setup");
  } catch {
    toast("Network error. Try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🔐 Enable 2FA";
    }
  }
}

function st2faCancelSetup() {
  _2faPending = null;
  _2faShow("st-2fa-off");
}

async function st2faConfirm() {
  const code = ($("st-2fa-confirm-code")?.value || "").trim();
  if (!code) {
    toast("Enter the 6-digit code from your authenticator app.");
    return;
  }
  const token = getToken();
  if (!token) {
    toast("Session expired. Please sign in again.");
    return;
  }
  const btn = $("st-2fa-confirm-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Verifying…";
  }
  try {
    const r = await fetch("/api/auth/2fa/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, code }),
    });
    const d = await r.json();
    if (!r.ok) {
      toast(d.detail || "Invalid code. Try again.");
      return;
    }
    _2faPending = null;
    const codesEl = $("st-2fa-codes");
    if (codesEl) codesEl.textContent = (d.recovery_codes || []).join("\n");
    _2faShow("st-2fa-recovery");
  } catch {
    toast("Network error. Try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Confirm & Enable";
    }
  }
}

function st2faAckRecovery() {
  const statusEl = $("st-2fa-status");
  if (statusEl) statusEl.textContent = "Enabled ✓";
  toast("Two-factor authentication enabled ✓");
  _2faShow("st-2fa-on");
}

function st2faDisableStart() {
  const pwInput = $("st-2fa-disable-pw");
  if (pwInput) pwInput.value = "";
  _2faShow("st-2fa-disable-confirm");
}

function st2faDisableCancel() {
  _2faShow("st-2fa-on");
}

async function st2faDisableConfirm() {
  const password = $("st-2fa-disable-pw")?.value || "";
  if (!password) {
    toast("Enter your password to confirm.");
    return;
  }
  const token = getToken();
  if (!token) {
    toast("Session expired. Please sign in again.");
    return;
  }
  try {
    const r = await fetch("/api/auth/2fa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const d = await r.json();
    if (!r.ok) {
      toast(d.detail || "Incorrect password.");
      return;
    }
    toast("Two-factor authentication disabled");
    const statusEl = $("st-2fa-status");
    if (statusEl) statusEl.textContent = "Off";
    _2faShow("st-2fa-off");
  } catch {
    toast("Network error. Try again.");
  }
}

// ═══════════════════════════════════════════════════════════════
//  IMPORT / EXPORT
// ═══════════════════════════════════════════════════════════════

async function stExportAll() {
  const token = getToken();
  if (!token) {
    toast("Sign in first.");
    return;
  }

  const btn = $("export-btn");
  if (btn) {
    btn.textContent = "Preparing ZIP…";
    btn.disabled = true;
  }

  // Gather localStorage-only data to send alongside the token
  const habits = JSON.parse(
    localStorage.getItem(`sivarr_habits_${S.sid}`) || "[]",
  );
  const journal = JSON.parse(localStorage.getItem(JNL_KEY()) || "[]");
  const finance = _finData();
  const skills = _skData().skills || [];

  try {
    const r = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, habits, journal, finance, skills }),
    });
    if (!r.ok) throw new Error("Export failed");
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dispHdr = r.headers.get("Content-Disposition") || "";
    const match = dispHdr.match(/filename="([^"]+)"/);
    a.download = match ? match[1] : "sivarr-export.zip";
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
    toast("Export downloaded ✓");
  } catch (e) {
    toast("Export failed. Try again.");
  } finally {
    if (btn) {
      btn.textContent = "↓ Export my data (ZIP)";
      btn.disabled = false;
    }
  }
}

// ── CSV parser (no external library) ──────────────────────────

function _parseCSV(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = _splitCSVLine(lines[0]).map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  return lines
    .slice(1)
    .map((line) => {
      const vals = _splitCSVLine(line);
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = (vals[i] || "").trim().replace(/^"|"$/g, "");
      });
      return obj;
    })
    .filter((r) => Object.values(r).some((v) => v));
}

function _splitCSVLine(line) {
  const result = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') {
      inQ = !inQ;
    } else if (ch === "," && !inQ) {
      result.push(cur);
      cur = "";
    } else cur += ch;
  }
  result.push(cur);
  return result;
}

// ── Import handlers ───────────────────────────────────────────

async function stImportTasks(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const token = getToken();
  if (!token) {
    toast("Sign in first.");
    return;
  }
  const text = await file.text();
  const rows = _parseCSV(text);
  if (!rows.length) {
    toast("No valid rows found in CSV.");
    return;
  }
  _setImportStatus(`Importing ${rows.length} tasks…`);
  try {
    const r = await fetch("/api/import/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, tasks: rows }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Import failed");
    _setImportStatus(`✓ ${d.imported} tasks imported`);
    toast(`${d.imported} tasks imported ✓`);
    // Sync localStorage from server
    const taskR = await fetch(`/api/tasks/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        tasks: JSON.parse(
          localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
        ),
      }),
    });
  } catch (e) {
    _setImportStatus("Import failed. Check CSV format.");
    toast("Task import failed.");
  }
}

async function stImportGoals(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const token = getToken();
  if (!token) {
    toast("Sign in first.");
    return;
  }
  const text = await file.text();
  const rows = _parseCSV(text);
  if (!rows.length) {
    toast("No valid rows found in CSV.");
    return;
  }
  _setImportStatus(`Importing ${rows.length} goals…`);
  try {
    const r = await fetch("/api/import/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, goals: rows }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Import failed");
    _setImportStatus(`✓ ${d.imported} goals imported`);
    toast(`${d.imported} goals imported ✓`);
  } catch (e) {
    _setImportStatus("Import failed. Check CSV format.");
    toast("Goal import failed.");
  }
}

async function stImportNotes(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const token = getToken();
  if (!token) {
    toast("Sign in first.");
    return;
  }
  const markdown = await file.text();
  if (!markdown.trim()) {
    toast("File is empty.");
    return;
  }
  _setImportStatus(`Importing ${file.name}…`);
  try {
    const r = await fetch("/api/import/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, markdown, filename: file.name }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Import failed");
    _setImportStatus(
      `✓ Note imported as "${file.name.replace(".md", "").replace(".txt", "")}" in Docs`,
    );
    toast("Note imported ✓. Check Docs & Notes");
  } catch (e) {
    _setImportStatus("Import failed.");
    toast("Note import failed.");
  }
}

function _setImportStatus(msg) {
  const el = $("import-status");
  if (el) el.textContent = msg;
}

// ── Multi-file importers (Notion / Trello / Asana) ─────────────
// Both /api/import/notion and /api/import/trello take the same shape --
// {token, files:[{filename, content}]} -- and cap at 50 files per request
// server-side (routes/import_notion.py, routes/import_trello.py); a file
// containing a task list is further capped at 500 rows inside
// routes/tasks.py's import_tasks. Read every selected file's text up front
// (capped to 50 client-side too, so a user who picks more isn't left
// guessing which ones made it) rather than silently dropping the rest.
async function _readFilesForImport(input) {
  const all = Array.from(input.files || []);
  input.value = "";
  if (all.length > 50) {
    toast(`Only the first 50 of ${all.length} selected files will be imported (50-file limit per import).`);
  }
  const files = all.slice(0, 50);
  return Promise.all(
    files.map(async (f) => ({ filename: f.name, content: await f.text() })),
  );
}

async function stImportNotion(input) {
  const files = await _readFilesForImport(input);
  if (!files.length) return;
  const token = getToken();
  if (!token) {
    toast("Sign in first.");
    return;
  }
  _setImportStatus(`Importing ${files.length} file${files.length === 1 ? "" : "s"} from Notion…`);
  try {
    const r = await fetch("/api/import/notion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, files }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Import failed");
    _setImportStatus(
      `✓ ${d.docs_imported} doc${d.docs_imported === 1 ? "" : "s"}, ${d.tasks_imported} task${d.tasks_imported === 1 ? "" : "s"} imported from Notion (500-row cap per task file)`,
    );
    toast(`Notion import: ${d.docs_imported} docs, ${d.tasks_imported} tasks ✓`);
  } catch (e) {
    _setImportStatus("Notion import failed. Check the exported files.");
    toast("Notion import failed.");
  }
}

async function stImportTrello(input) {
  const files = await _readFilesForImport(input);
  if (!files.length) return;
  const token = getToken();
  if (!token) {
    toast("Sign in first.");
    return;
  }
  _setImportStatus(`Importing ${files.length} file${files.length === 1 ? "" : "s"} from Trello/Asana…`);
  try {
    const r = await fetch("/api/import/trello", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, files }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Import failed");
    _setImportStatus(
      `✓ ${d.tasks_imported} task${d.tasks_imported === 1 ? "" : "s"} imported from Trello/Asana (500-row cap per file)`,
    );
    toast(`${d.tasks_imported} tasks imported ✓`);
  } catch (e) {
    _setImportStatus("Trello/Asana import failed. Check the exported files.");
    toast("Trello/Asana import failed.");
  }
}

// ── Journal sync wiring ───────────────────────────────────────
// _syncHabitsToServer moved to js/features/habits.js (per-entity diff sync,
// same treatment as tasks — see that file's _syncTasksToServer). Still
// callable from here since all scripts are loaded by the time any of these
// functions actually run, regardless of file load order.

function _syncJournalToServer(entries) {
  const token = getToken();
  if (!token || !S.sid) return;
  if (!navigator.onLine) {
    _queueMutation("/api/journal/sync", { token, entries });
    return;
  }
  fetch("/api/journal/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, entries }),
  }).catch(() => _queueMutation("/api/journal/sync", { token, entries }));
}

async function stClearChat() {
  if (
    !(await siModal.confirm("This clears the conversation on this device.", {
      title: "Clear Chat",
      confirmLabel: "Clear",
      danger: true,
    }))
  )
    return;
  // Chat is held in the DOM for the current session only (nothing persisted
  // client- or server-side), so clearing the thread is the whole job.
  const msgs = $("msgs");
  if (msgs) msgs.innerHTML = "";
  const welcome = $("chat-welcome");
  if (welcome) welcome.style.display = "";
  _contextSent = false; // re-inject context on next message after a clear
  _chatMsgCount = 0;
  toast("Chat cleared ✓");
}

async function stClearWrong() {
  if (
    !(await siModal.confirm("Your revision list will be cleared.", {
      title: "Clear Revision List",
      confirmLabel: "Clear",
      danger: true,
    }))
  )
    return;
  try {
    await API("/api/wrong/clear", { token: getToken(), index: "all" });
  } catch (e) {}
  toast("Revision list cleared ✓");
}

async function stResetProgress() {
  // Wipes server-side learning stats (quizzes, topics, XP, streak, revision
  // list) via the token-authed /api/reset-progress endpoint. Account,
  // subscription and saved documents are kept. You stay signed in; we reload
  // so the dashboard reflects the freshly-zeroed stats.
  if (
    !(await siModal.confirm(
      "This permanently erases your stats, quiz history, XP and streak from your account. This cannot be undone. Your account, subscription and saved documents are kept.",
      {
        title: "Reset Progress",
        confirmLabel: "Reset Everything",
        danger: true,
      },
    ))
  )
    return;
  try {
    await API("/api/reset-progress", { token: getToken() });
  } catch (e) {
    toast("Could not reset progress. Please try again.");
    return;
  }
  toast("Progress reset ✓ Reloading...");
  setTimeout(() => location.reload(), 1000);
}

// Restore accent on load
(function () {
  const a = localStorage.getItem("sivarr_accent");
  const a2 = localStorage.getItem("sivarr_accent2");
  if (a) document.documentElement.style.setProperty("--accent", a);
  if (a2) document.documentElement.style.setProperty("--accent2", a2);
})();

// ═══════════════════════ VOICE INPUT ════════════════════════

let VOICE_ACTIVE = false;
let VOICE_REC = null;

function voiceInit() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast("Voice input not supported on this browser.");
    return null;
  }
  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = "en-NG";
  return rec;
}

// inputId/btnId default to the main chat's own elements so both existing
// zero-arg call sites (the main chat's mic button, and the
// setTimeout(toggleVoice, 300) shortcut below) keep working unchanged.
// Passing them lets any other input+button pair (e.g. the mobile FAB's
// quick-chat popup, js/features/academic.js's acadChatSend) reuse the same
// real speech-recognition wiring instead of a second implementation.
// onFinishName is a global function NAME (string), resolved via window[...]
// here rather than accepted as a function reference -- data-onclick-args
// (js/core/delegate.js) only ever carries JSON data, never a live function,
// by design (the same reason delegate.js dispatches by name, not eval).
function toggleVoice(inputId = "ci", btnId = "voice-btn", onFinishName = "send") {
  if (VOICE_ACTIVE) {
    VOICE_REC?.stop();
    VOICE_ACTIVE = false;
    updateVoiceBtn(false, btnId);
    return;
  }
  VOICE_REC = voiceInit();
  if (!VOICE_REC) return;
  VOICE_ACTIVE = true;
  updateVoiceBtn(true, btnId);
  toast("Listening... 🎤");

  VOICE_REC.onresult = (e) => {
    const transcript = Array.from(e.results)
      .map((r) => r[0].transcript)
      .join("");
    const inp = $(inputId);
    if (inp) inp.value = transcript;
  };
  VOICE_REC.onend = () => {
    VOICE_ACTIVE = false;
    updateVoiceBtn(false, btnId);
    const inp = $(inputId);
    if (inp && inp.value.trim()) {
      toast("Got it, sending... ✓");
      const fn = window[onFinishName];
      if (typeof fn === "function") setTimeout(fn, 500);
    }
  };
  VOICE_REC.onerror = (e) => {
    VOICE_ACTIVE = false;
    updateVoiceBtn(false, btnId);
    toast(
      e.error === "not-allowed"
        ? "Microphone permission denied."
        : "Voice error. Try again.",
    );
  };
  VOICE_REC.start();
}

function updateVoiceBtn(active, btnId = "voice-btn") {
  const btn = $(btnId);
  if (!btn) return;
  // Buttons with a real <i> icon (both #voice-btn and the quick-chat
  // popup's mic button ship one) get their icon swapped in place; a
  // textContent fallback covers any caller whose button has no icon.
  const icon = btn.querySelector("i");
  if (icon) icon.className = active ? "ti ti-player-stop-filled" : "ti ti-microphone";
  else btn.textContent = active ? "🔴" : "🎤";
  btn.style.color = active ? "var(--red)" : "var(--muted)";
  btn.style.borderColor = active ? "var(--red)" : "var(--border)";
  if (active) btn.style.animation = "pulse 1s infinite";
  else btn.style.animation = "";
}

// ═══════════════════════════ DIFFICULTY ═════════════════════════

// ═══════════════ CREATE NEW TAB SWITCHER ════════════════════

function cnTab(name) {
  ["create", "space", "framework"].forEach((t) => {
    const pane = $("cnpane-" + t);
    const btn = $("cntab-" + t);
    if (pane) pane.style.display = t === name ? "block" : "none";
    if (btn) {
      btn.style.background =
        t === name
          ? "linear-gradient(135deg,var(--accent),var(--accent2))"
          : "none";
      btn.style.color = t === name ? "#fff" : "var(--muted)";
    }
  });
  if (name === "space") spReset();
}

// ═══════════════ SPACES SYSTEM ══════════════════════════════

const SPACES_KEY = () => `sivarr_spaces_${S.sid || "guest"}`;
let _spType = null;

const SP_PERSONAL_TABS = [
  { key: "task-tracker", icon: "✅", label: "Task Tracker", route: "flux" },
  { key: "content-hub", icon: "🧠", label: "Content Hub", route: "contenthub" },
];
const SP_ORG_TABS = [
  { key: "goals", icon: "🎯", label: "Goals", route: "goals" },
  { key: "knowledge", icon: "📚", label: "Knowledge", route: "notes" },
];

function spGetAll() {
  try {
    return JSON.parse(localStorage.getItem(SPACES_KEY()) || "[]");
  } catch {
    return [];
  }
}
function spSaveAll(spaces) {
  localStorage.setItem(SPACES_KEY(), JSON.stringify(spaces));
}

function spPickType(type) {
  _spType = type;
  $("sp-type-personal")?.classList.toggle("sel", type === "personal");
  $("sp-type-org")?.classList.toggle("sel", type === "org");
}

function spNext() {
  if (!_spType) {
    toast("Please choose a space type.");
    return;
  }
  $("sp-s1").style.display = "none";
  $("sp-s2").style.display = "block";
  const label = $("sp-s2-label");
  if (label)
    label.textContent =
      _spType === "personal"
        ? "Personal space name:"
        : "Organization space name:";
  const mw = $("sp-members-wrap");
  if (mw) mw.style.display = _spType === "org" ? "block" : "none";
  const ni = $("sp-name");
  if (ni) {
    ni.value = "";
    ni.focus();
  }
  const ei = $("sp-err");
  if (ei) ei.textContent = "";
}

function spBack() {
  $("sp-s2").style.display = "none";
  $("sp-s1").style.display = "block";
}

function spReset() {
  _spType = null;
  $("sp-type-personal")?.classList.remove("sel");
  $("sp-type-org")?.classList.remove("sel");
  const s1 = $("sp-s1");
  if (s1) s1.style.display = "block";
  const s2 = $("sp-s2");
  if (s2) s2.style.display = "none";
  const ni = $("sp-name");
  if (ni) ni.value = "";
  const mi = $("sp-members");
  if (mi) mi.value = "";
  const ei = $("sp-err");
  if (ei) ei.textContent = "";
}

// CSP migration: Enter-to-create on the space-name input.
window._spCreateOnEnter = function (e) {
  if (e.key === "Enter") spCreate();
};

function spCreate() {
  const name = $("sp-name")?.value.trim();
  if (!name) {
    const e = $("sp-err");
    if (e) e.textContent = "Please enter a space name.";
    return;
  }
  // Quota gating: block a new space beyond the plan cap (server enforces too).
  const cap = _ENTITLEMENTS?.caps?.spaces;
  if (cap != null && spGetAll().length >= cap) {
    const e = $("sp-err");
    if (e)
      e.innerHTML =
        `Your plan includes ${cap} space${cap !== 1 ? "s" : ""}. ` +
        `<a data-onclick="_closeCnModalThenShowPricing" ` +
        `style="color:var(--teal);cursor:pointer;text-decoration:underline">Upgrade</a> to add more.`;
    return;
  }
  const members =
    _spType === "org"
      ? $("sp-members")
          ?.value.trim()
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean) || []
      : [];

  const spaces = spGetAll();
  spaces.push({
    id: Date.now().toString(36),
    type: _spType,
    name,
    members,
    created: new Date().toISOString(),
  });
  spSaveAll(spaces);

  $("cn-modal-bg").classList.remove("open");
  spReset();
  spRender();
  toast(`"${name}" created! 🎉`);
}

function spRender() {
  const c = $("dyn-spaces-container");
  if (!c) return;
  const spaces = spGetAll();

  if (!spaces.length) {
    c.innerHTML =
      '<div style="font-size:.72rem;color:var(--muted);padding:4px 8px;opacity:.6">No spaces yet</div>';
    return;
  }

  c.innerHTML = spaces
    .map((sp) => {
      const tabs = sp.type === "personal" ? SP_PERSONAL_TABS : SP_ORG_TABS;
      const icon = sp.type === "personal" ? "👤" : "🏢";
      return `<div class="dsp-section" data-spid="${sp.id}">
      <div class="dsp-header" data-onclick="spToggle" data-onclick-arg0="${sp.id}">
        <span class="dsp-icon">${icon}</span>
        <span class="dsp-name">${esc(sp.name)}</span>
        <button class="dsp-ellipsis" data-onclick="spMenu" data-onclick-arg0="${sp.id}" title="Options">···</button>
        <div class="dsp-menu" id="dspm-${sp.id}">
          <button class="dsp-menu-item" data-onclick="spRename" data-onclick-arg0="${sp.id}">✏️ Rename</button>
          ${sp.type === "org" ? `<button class="dsp-menu-item" data-onclick="spAddMember" data-onclick-arg0="${sp.id}">👥 Add Member</button>` : ""}
          <button class="dsp-menu-item danger" data-onclick="spDelete" data-onclick-arg0="${sp.id}">🗑 Delete</button>
        </div>
      </div>
      <div class="dsp-items open" id="dspi-${sp.id}">
        ${tabs
          .map(
            (
              t,
            ) => `<button class="snav-item" data-onclick="snavSelect" data-onclick-arg0="${t.key}" data-onclick-arg1="spaces" data-onclick-this>
          <span class="snav-item-icon">${t.icon}</span> ${t.label}
        </button>`,
          )
          .join("")}
      </div>
    </div>`;
    })
    .join("");
}

function spToggle(id) {
  const items = $("dspi-" + id);
  if (!items) return;
  items.classList.toggle("open");
}

function spMenu(id) {
  document.querySelectorAll(".dsp-menu").forEach((m) => {
    if (m.id !== "dspm-" + id) m.classList.remove("open");
  });
  $("dspm-" + id)?.classList.toggle("open");
}

async function spRename(id) {
  const spaces = spGetAll();
  const sp = spaces.find((s) => s.id === id);
  if (!sp) return;
  const n = await siModal.input("Rename Space", sp.name, sp.name, {
    confirmLabel: "Rename",
  });
  if (!n?.trim()) return;
  sp.name = n.trim();
  spSaveAll(spaces);
  spRender();
  document
    .querySelectorAll(".dsp-menu")
    .forEach((m) => m.classList.remove("open"));
}

async function spAddMember(id) {
  const spaces = spGetAll();
  const sp = spaces.find((s) => s.id === id);
  if (!sp) return;
  const m = await siModal.input("Add Member", "Name or matric number", "", {
    confirmLabel: "Add",
  });
  if (!m?.trim()) return;
  sp.members = sp.members || [];
  sp.members.push(m.trim());
  spSaveAll(spaces);
  toast(`Added ${m.trim()} to "${sp.name}"`);
  document
    .querySelectorAll(".dsp-menu")
    .forEach((m) => m.classList.remove("open"));
}

async function spDelete(id) {
  if (
    !(await siModal.confirm(
      "This space and all its data will be permanently deleted.",
      { title: "Delete Space", confirmLabel: "Delete", danger: true },
    ))
  )
    return;
  spSaveAll(spGetAll().filter((s) => s.id !== id));
  spRender();
  toast("Space deleted.");
}

// Close space menus on outside click
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dsp-ellipsis") && !e.target.closest(".dsp-menu"))
    document
      .querySelectorAll(".dsp-menu")
      .forEach((m) => m.classList.remove("open"));
});

// ═══════════════════════ COMMAND PALETTE ════════════════════

const CMD_ITEMS = [
  // ── Pinned (mirrors the sidebar) ──
  {
    icon: "✨",
    label: "Sivarr AI",
    tag: "Pinned",
    panel: "chat",
    keywords: "chat assistant ai",
    action: () => nav("chat", null),
  },
  {
    icon: "🏠",
    label: "Home",
    tag: "Pinned",
    panel: "home",
    keywords: "dashboard",
    action: () => nav("home", null),
  },
  {
    icon: "📥",
    label: "Inbox",
    tag: "Pinned",
    panel: "announcements",
    keywords: "announcements messages notifications",
    action: () => nav("announcements", null),
  },
  // ── Work ──
  {
    icon: "✅",
    label: "Tasks",
    tag: "Work",
    panel: "flux",
    keywords: "flux todo to-do",
    action: () => nav("flux", null),
  },
  {
    icon: "🎯",
    label: "Goals",
    tag: "Work",
    panel: "goals",
    keywords: "objectives",
    action: () => nav("goals", null),
  },
  {
    icon: "📅",
    label: "Calendar",
    tag: "Work",
    panel: "calendar",
    keywords: "events schedule",
    action: () => nav("calendar", null),
  },
  {
    icon: "📓",
    label: "Docs & Notes",
    tag: "Work",
    panel: "notes",
    keywords: "notes documents",
    action: () => nav("notes", null),
  },
  {
    icon: "🧩",
    label: "Templates",
    tag: "Work",
    panel: "templates",
    keywords: "",
    action: () => nav("templates", null),
  },
  // ── Life ──
  {
    icon: "🧠",
    label: "Skills",
    tag: "Life",
    panel: "skills",
    keywords: "",
    action: () => nav("skills", null),
  },
  {
    icon: "💰",
    label: "Finance",
    tag: "Life",
    panel: "finance",
    keywords: "money budget",
    action: () => nav("finance", null),
  },
  {
    icon: "🔥",
    label: "Habits",
    tag: "Life",
    panel: "habits",
    keywords: "streak",
    action: () => nav("habits", null),
  },
  {
    icon: "✍️",
    label: "Journal",
    tag: "Life",
    panel: "journal",
    keywords: "diary mood",
    action: () => nav("journal", null),
  },
  {
    icon: "📊",
    label: "Analytics",
    tag: "Life",
    panel: "stats",
    keywords: "stats insights",
    action: () => nav("stats", null),
  },
  {
    icon: "📋",
    label: "Weekly Review",
    tag: "Life",
    panel: "review",
    keywords: "",
    action: () => nav("review", null),
  },
  // ── Connect ──
  {
    icon: "👥",
    label: "Community",
    tag: "Connect",
    panel: "community",
    keywords: "social feed",
    action: () => nav("community", null),
  },
  {
    icon: "💼",
    label: "Opportunities",
    tag: "Connect",
    panel: "opportunities",
    keywords: "jobs",
    action: () => nav("opportunities", null),
  },
  {
    icon: "🛍️",
    label: "Marketplace",
    tag: "Connect",
    panel: "marketplace",
    keywords: "store extensions",
    action: () => nav("marketplace", null),
  },
  {
    icon: "🔌",
    label: "Integrations",
    tag: "Connect",
    panel: "library",
    keywords: "library plug apps connect",
    action: () => nav("library", null),
  },
  {
    icon: "🤖",
    label: "Agents",
    tag: "Connect",
    panel: "agents",
    keywords: "ai bots",
    action: () => nav("agents", null),
  },
  // ── More tools ──
  {
    icon: "📝",
    label: "Quiz",
    tag: "Tools",
    panel: "quiz",
    keywords: "quizzes test",
    action: () => nav("quiz", null),
  },
  {
    icon: "🧪",
    label: "Study Deck",
    tag: "Tools",
    panel: "lab",
    keywords: "lab flashcards",
    action: () => nav("lab", null),
  },
  {
    icon: "🗺️",
    label: "Study Plan",
    tag: "Tools",
    panel: "studyplan",
    keywords: "",
    action: () => nav("studyplan", null),
  },
  {
    icon: "🧠",
    label: "Content Hub",
    tag: "Tools",
    panel: "contenthub",
    keywords: "",
    action: () => nav("contenthub", null),
  },
  {
    icon: "🧑",
    label: "My Profile",
    tag: "",
    panel: "profile",
    keywords: "account",
    action: () => nav("profile", null),
  },
  {
    icon: "🗑️",
    label: "Trash",
    tag: "",
    panel: "trash",
    keywords: "deleted restore recover",
    action: () => nav("trash", null),
  },
  {
    icon: "⚙️",
    label: "Settings",
    tag: "",
    panel: "settings",
    keywords: "preferences",
    action: () => nav("settings", null),
  },
  {
    icon: "➕",
    label: "Create New",
    tag: "",
    keywords: "add new space",
    action: () => cnOpen(),
  },
  // ── Actions ──
  {
    icon: "🎤",
    label: "Voice Input",
    tag: "Action",
    keywords: "",
    action: () => {
      nav("chat", null);
      setTimeout(toggleVoice, 300);
    },
  },
  {
    icon: "🌙",
    label: "Toggle Theme",
    tag: "Action",
    keywords: "dark light",
    action: () => toggleThemeFromMenu(),
  },
  {
    icon: "🚪",
    label: "Sign Out",
    tag: "Action",
    keywords: "logout",
    action: () => logout(),
  },
];

// ════════════════ SIDEBAR TABS — user-customizable per section (toggled from ⌘K) ════════════════
// Registry: panel → {label, tabler icon, section}. section:'core' = permanent (always shown, top group);
// work/life/connect = customizable (default-shown or addable); tools = palette-only (no sidebar home).
const NAV_TABS = {
  chat: { label: "Sivarr AI", icon: "ti-sparkles", section: "core" },
  home: { label: "Home", icon: "ti-home", section: "core" },
  announcements: { label: "Inbox", icon: "ti-inbox", section: "core" },
  flux: { label: "Tasks", icon: "ti-checkbox", section: "work" },
  goals: { label: "Goals", icon: "ti-target", section: "work" },
  calendar: { label: "Calendar", icon: "ti-calendar", section: "work" },
  notes: { label: "Docs & Notes", icon: "ti-notebook", section: "work" },
  templates: { label: "Templates", icon: "ti-layout-grid", section: "work" },
  skills: { label: "Skills", icon: "ti-atom", section: "life" },
  finance: { label: "Finance", icon: "ti-wallet", section: "life" },
  habits: { label: "Habits", icon: "ti-flame", section: "life" },
  journal: { label: "Journal", icon: "ti-writing", section: "life" },
  stats: { label: "Analytics", icon: "ti-chart-bar", section: "life" },
  review: {
    label: "Weekly Review",
    icon: "ti-calendar-stats",
    section: "life",
  },
  community: { label: "Community", icon: "ti-users", section: "connect" },
  marketplace: {
    label: "Marketplace",
    icon: "ti-building-store",
    section: "connect",
  },
  agents: { label: "Agents", icon: "ti-robot", section: "connect" },
  quiz: { label: "Quiz", icon: "ti-help", section: "tools" },
  lab: { label: "Study Deck", icon: "ti-flask", section: "tools" },
  studyplan: { label: "Study Plan", icon: "ti-map", section: "tools" },
  contenthub: { label: "Content Hub", icon: "ti-news", section: "tools" },
  profile: { label: "My Profile", icon: "ti-user", section: "tools" },
  trash: { label: "Trash", icon: "ti-trash", section: "tools" },
  settings: { label: "Settings", icon: "ti-settings", section: "tools" },
};
// Canonical render order within each customizable section.
const NAV_ORDER = {
  work: ["flux", "goals", "calendar", "notes", "templates"],
  life: ["skills", "finance", "habits", "journal", "stats", "review"],
  connect: ["community", "marketplace", "agents"],
};
const NAV_CORE = ["home", "chat", "announcements"]; // permanent, top group, not removable
// Default tabs shown in the sidebar — rebalanced toward daily-use (Phase 2):
// Work: Tasks/Goals/Calendar/Docs&Notes · Life: Finance/Habits/Journal.
// Anything not here lives only in ⌘K search until the user stars it in.
// (Connect tabs aren't part of this list — that section always renders in
// full via NAV_ORDER.connect, unaffected by starring.)
const NAV_DEFAULT = [
  "flux",
  "goals",
  "calendar",
  "notes",
  "finance",
  "habits",
  "journal",
];
// Extra trailing markup per tab (inline stat placeholders, New badges, inbox dot) — preserved across re-render.
const NAV_EXTRA = {
  flux: '<span class="si-stat si-stat-info" id="sbstat-tasks"></span>',
  goals: '<span class="si-stat" id="sbstat-goals"></span>',
  habits: '<span class="si-stat" id="sbstat-habits"></span>',
  stats: '<span class="si-stat" id="sbstat-stats"></span>',
  marketplace: '<span class="si-new-badge">New</span>',
  agents: '<span class="si-new-badge">New</span>',
  announcements:
    '<span class="si-dot" id="sb-inbox-dot" style="display:none"></span>',
};

function NAV_KEY() {
  return `sivarr_navtabs_${(typeof S !== "undefined" && S.sid) || ""}`;
}
function getNavTabs() {
  try {
    const v = JSON.parse(localStorage.getItem(NAV_KEY()));
    if (Array.isArray(v))
      return v.filter(
        (p) =>
          NAV_TABS[p] &&
          NAV_TABS[p].section !== "core" &&
          NAV_TABS[p].section !== "tools",
      );
  } catch (e) {}
  return NAV_DEFAULT.slice();
}
function setNavTabs(arr) {
  try {
    localStorage.setItem(NAV_KEY(), JSON.stringify(arr));
  } catch (e) {}
}

// ── Sidebar section collapse: Pinned (hides fully) ────────────────────
function _favsCollapsed() {
  try {
    return localStorage.getItem("sivarr_sb_favs_collapsed") === "1";
  } catch (e) {
    return false;
  }
}
function sbTogglePinned() {
  const grp = $("sb-favs"),
    caret = $("sb-favs-caret");
  if (!grp) return;
  const collapsed = !grp.classList.contains("collapsed");
  grp.classList.toggle("collapsed", collapsed);
  if (caret) caret.classList.toggle("collapsed", collapsed);
  try {
    localStorage.setItem("sivarr_sb_favs_collapsed", collapsed ? "1" : "0");
  } catch (e) {}
}

// In the sidebar right now? Core tabs always are; the rest depend on the user's store.
function isNavTab(panel) {
  return NAV_CORE.includes(panel) || getNavTabs().includes(panel);
}
function toggleNavTab(panel) {
  const meta = NAV_TABS[panel];
  if (!meta || meta.section === "core" || meta.section === "tools") return; // core=permanent, tools=no sidebar home
  const t = getNavTabs();
  const i = t.indexOf(panel);
  if (i >= 0) t.splice(i, 1);
  else t.push(panel);
  setNavTabs(t);
  navRenderSidebar();
  if (typeof CMD_OPEN !== "undefined" && CMD_OPEN) cmdSearch(); // refresh the stars in the open palette
}

// The ⌘K star in front of a result: locked for core, toggle for work/life/connect, none for tools/actions.
function _cmdFavStar(panel) {
  const meta = panel && NAV_TABS[panel];
  if (!meta || meta.section === "tools")
    return `<span class="cmd-fav cmd-fav-spacer" aria-hidden="true"></span>`;
  if (meta.section === "core")
    return `<span class="cmd-fav on cmd-fav-locked" title="Always pinned" aria-hidden="true"><i class="ti ti-star-filled"></i></span>`;
  const on = isNavTab(panel);
  return `<span class="cmd-fav ${on ? "on" : ""}" title="${on ? "Remove from sidebar" : "Add to sidebar"}" data-onclick="toggleNavTab" data-onclick-arg0="${panel}"><i class="ti ${on ? "ti-star-filled" : "ti-star"}" aria-hidden="true"></i></span>`;
}

function _navRenderSec(hostId, panels) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.innerHTML = panels
    .map((panel) => {
      const t = NAV_TABS[panel];
      if (!t) return "";
      return `<button class="si" data-panel="${panel}" data-tip="${t.label}" data-tip-pos="right" data-onclick="sidebarNav" data-onclick-this>
      <div class="si-icon"><i class="ti ${t.icon}"></i></div>
      <span class="si-lb">${t.label}</span>${NAV_EXTRA[panel] || ""}
    </button>`;
    })
    .join("");
  // Auto-hide this section's header when the group is empty (Phase 2 nav cleanup).
  const head = host.previousElementSibling;
  if (head && head.classList.contains("sb-sec-head"))
    head.style.display = panels.length ? "" : "none";
  // Re-apply the active highlight if the current panel lives in this section
  const active = document.querySelector(".panel.active");
  if (active && active.id.indexOf("panel-") === 0) {
    const el = host.querySelector(`.si[data-panel="${active.id.slice(6)}"]`);
    if (el) el.classList.add("on");
  }
}
function navRenderSidebar() {
  _navRenderSec("sb-favs", NAV_CORE);
  // Restore collapse state — Pinned hides fully.
  const favsCollapsed = _favsCollapsed();
  $("sb-favs")?.classList.toggle("collapsed", favsCollapsed);
  $("sb-favs-caret")?.classList.toggle("collapsed", favsCollapsed);
  // Tabs starred via the ⌘K palette (toggleNavTab/getNavTabs) — previously
  // saved correctly but never rendered anywhere in the sidebar. Exclude
  // "connect"-section panels: those are always shown below regardless of
  // star state, so including them here would just duplicate the entry.
  _navRenderSec(
    "sgi-starred",
    getNavTabs().filter((p) => NAV_TABS[p] && NAV_TABS[p].section !== "connect"),
  );
  // Connect is a fixed, always-visible list (no pin-filtering) — matches the sidebar's flat layout.
  _navRenderSec("sgi-connect", _getSectionOrder("connect"));
  if (typeof sbRenderStats === "function") sbRenderStats();
}

let CMD_OPEN = false;
let CMD_IDX = -1;
let CMD_VISIBLE = [];
// Search pagination state -- /api/search returns {results, total, has_more}
// scored+sorted server-side across every source; cmdSearchMore() appends
// the next page rather than re-running the whole search.
let _cmdSearchQuery = "";
let _cmdSearchOffset = 0;
let _cmdSearchHasMore = false;
let _cmdSearchLoadingMore = false;
const _CMD_SEARCH_PAGE_SIZE = 15;

function cmdOpen() {
  if (!S.sid) return;
  CMD_OPEN = true;
  $("cmd-bg").classList.add("open");
  const inp = $("cmd-input");
  if (inp) {
    inp.value = "";
    inp.focus();
  }
  cmdSearch();
}

function cmdClose(e) {
  if (e && e.target !== $("cmd-bg")) return;
  cmdDismiss();
}

function cmdDismiss() {
  CMD_OPEN = false;
  $("cmd-bg").classList.remove("open");
}

let _cmdSearchTimer = null;

// ── Typed slash-commands ("/task Buy milk" + Enter) ──────────────────────
// Deterministic dispatch to the same real capture functions the "Capture
// as:" buttons below already use (qcCapture) — no AI interpretation, no new
// write path, just a faster way to reach one that already exists.
const _CMD_SLASH_TYPE_MAP = {
  task: "task", t: "task",
  event: "event", ev: "event",
  journal: "journal", j: "journal",
  goal: "goal", g: "goal",
  note: "note", n: "note",
};
const _CMD_SLASH_INFO = {
  task: { icon: "📋", noun: "a task", verb: "Add task" },
  event: { icon: "📅", noun: "an event", verb: "Add event" },
  journal: { icon: "✍️", noun: "a journal entry", verb: "Save journal entry" },
  goal: { icon: "🎯", noun: "a goal", verb: "Add goal" },
  note: { icon: "💡", noun: "a note", verb: "Save note" },
};
function _cmdParseSlash(raw) {
  const m = /^\/(\w+)(?:\s+(.*))?$/s.exec((raw || "").trim());
  if (!m) return null;
  const type = _CMD_SLASH_TYPE_MAP[m[1].toLowerCase()];
  if (!type) return null;
  return { type, prefix: m[1], text: (m[2] || "").trim() };
}

function cmdSearch() {
  const raw = $("cmd-input")?.value || "";
  const q = raw.toLowerCase().trim();
  const res = $("cmd-results");
  if (!res) return;
  CMD_IDX = -1;

  const capRow = $("cmd-capture-row");

  const slash = _cmdParseSlash(raw);
  if (slash) {
    if (capRow) capRow.style.display = "none";
    const info = _CMD_SLASH_INFO[slash.type];
    if (slash.text) {
      CMD_VISIBLE = [{
        icon: info.icon,
        label: `${info.verb}: "${slash.text.slice(0, 60)}"`,
        tag: "Press Enter",
        type: "slash-action",
        action: () => qcCapture(slash.type, slash.text),
      }];
      cmdRenderResults(q);
    } else {
      CMD_VISIBLE = [];
      res.innerHTML = `<div class="cmd-empty">Type ${info.noun} after <strong>/${esc(slash.prefix)}</strong>, then press Enter.</div>`;
    }
    return;
  }
  if (capRow) capRow.style.display = q.length > 1 ? "flex" : "none";

  // ── Step 1: instant local results (panels + localStorage content) ──
  const notes = JSON.parse(
    localStorage.getItem(`sivarr_notes_${S.sid}`) || "[]",
  );
  const jnl = JSON.parse(
    localStorage.getItem(`sivarr_journal_${S.sid}`) || "[]",
  );

  const panelItems = CMD_ITEMS.filter(
    (item) =>
      !q ||
      item.label.toLowerCase().includes(q) ||
      (item.tag || "").toLowerCase().includes(q) ||
      (item.keywords || "").toLowerCase().includes(q),
  ).map((i) => ({ ...i, type: "panel" }));

  const noteItems = q
    ? notes
        .filter((n) => (n.text || n.title || "").toLowerCase().includes(q))
        .slice(0, 3)
        .map((n) => ({
          icon: "📓",
          label:
            (n.text || n.title || "").split("\n")[0].slice(0, 50) || "Note",
          tag: "Note",
          type: "note",
          action: () => nav("notes", null),
        }))
    : [];

  const jnlItems = q
    ? jnl
        .filter((e) =>
          (e.text || e.content || e.entry || "").toLowerCase().includes(q),
        )
        .slice(0, 3)
        .map((e) => ({
          icon: "✍️",
          label:
            (e.text || e.content || e.entry || "").slice(0, 50) ||
            "Journal entry",
          tag: "Journal",
          type: "journal",
          action: () => nav("journal", null),
        }))
    : [];

  CMD_VISIBLE = [...panelItems, ...noteItems, ...jnlItems];
  cmdRenderResults(q);

  // ── Step 2: server search — debounced 300ms, merges into results ──
  _cmdSearchQuery = q;
  _cmdSearchOffset = 0;
  _cmdSearchHasMore = false;
  clearTimeout(_cmdSearchTimer);
  if (q.length >= 2) {
    const token = getToken();
    if (token) {
      _cmdSearchTimer = setTimeout(() => _cmdRunServerSearch(q, token, false), 300);
    }
  }
}

// Source types the server ranks and returns via /api/search — these
// replace (not append to) the equivalent instant local results above once
// the debounced fetch lands, same as task/goal/doc/post always did; journal
// joins that list since /api/search now covers it too (previously only the
// local localStorage scan did).
const _CMD_SERVER_TYPES = ["task", "goal", "doc", "post", "journal", "org_doc", "org_message"];

function _cmdServerItemLabel(item) {
  const LABELS = {
    task: "Task", goal: "Goal", doc: "Doc", post: "Community",
    journal: "Journal", org_doc: "Org Doc", org_message: "Org Message",
  };
  return LABELS[item.type] || item.type.charAt(0).toUpperCase() + item.type.slice(1);
}

function _cmdServerItemAction(item) {
  const ACTION_MAP = {
    task: () => nav("flux", null),
    goal: () => nav("goals", null),
    doc: () => {
      nav("notes", null);
      setTimeout(() => docOpen(parseInt(item.id) || item.id), 150);
    },
    post: () => nav("community", null),
    journal: () => nav("journal", null),
    org_doc: () => {
      nav("org", null);
      setTimeout(() => {
        if (typeof orgTab === "function") orgTab("docs");
        if (typeof orgOpenDoc === "function") orgOpenDoc(item.id);
      }, 150);
    },
    org_message: () => {
      nav("org", null);
      setTimeout(() => { if (typeof orgTab === "function") orgTab("chat"); }, 150);
    },
  };
  return ACTION_MAP[item.type] || (() => {});
}

async function _cmdRunServerSearch(q, token, appendMore) {
  if (appendMore) _cmdSearchLoadingMore = true;
  try {
    const r = await fetch(
      `/api/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(token)}&limit=${_CMD_SEARCH_PAGE_SIZE}&offset=${_cmdSearchOffset}`,
    );
    if (!r.ok) return;
    const data = await r.json();
    const serverItems = (data.results || []).map((item) => ({
      icon: item.icon,
      label: (item.title || "").slice(0, 60),
      tag: _cmdServerItemLabel(item),
      type: item.type,
      meta: item.meta || "",
      score: item.score || 0,
      action: _cmdServerItemAction(item),
    }));
    _cmdSearchOffset += serverItems.length;
    _cmdSearchHasMore = !!data.has_more;

    const panels = CMD_VISIBLE.filter((i) => i.type === "panel");
    const others = CMD_VISIBLE.filter(
      (i) => i.type !== "panel" && !_CMD_SERVER_TYPES.includes(i.type),
    );
    const existingServer = appendMore
      ? CMD_VISIBLE.filter((i) => _CMD_SERVER_TYPES.includes(i.type))
      : [];
    CMD_VISIBLE = [...panels, ...existingServer, ...serverItems, ...others];
    cmdRenderResults(q);
  } catch (_) {
  } finally {
    _cmdSearchLoadingMore = false;
  }
}

function cmdSearchMore() {
  const token = getToken();
  if (!token || !_cmdSearchQuery || _cmdSearchLoadingMore || !_cmdSearchHasMore) return;
  _cmdRunServerSearch(_cmdSearchQuery, token, true);
}

function cmdRenderResults(q) {
  const res = $("cmd-results");
  if (!res) return;

  if (!CMD_VISIBLE.length) {
    res.innerHTML = q
      ? `<div class="cmd-empty">No results for "<strong>${esc(q)}</strong>". Capture it below ↓</div>`
      : `<div class="cmd-empty">Type to search panels, docs, tasks or actions…</div>`;
    return;
  }

  // Server-ranked hits (real `score` field) render as one flat list in the
  // order /api/search already sorted them, so the ranking is visible
  // instead of getting reshuffled by type into separate sections — each
  // item still shows its type via the tag badge. Everything else (panels,
  // local Notes, and journal's brief instant-render before the debounced
  // server fetch lands) keeps the previous per-type grouping.
  const serverItems = [];
  const localGroups = {};
  CMD_VISIBLE.forEach((item, idx) => {
    if (typeof item.score === "number") {
      serverItems.push({ ...item, _idx: idx });
      return;
    }
    const g = item.type === "note" ? "Notes" : item.tag || "Actions";
    if (!localGroups[g]) localGroups[g] = [];
    localGroups[g].push({ ...item, _idx: idx });
  });

  const itemHTML = (item) => `
      <button class="cmd-item" data-idx="${item._idx}" data-onclick="cmdRun" data-onclick-args="[${item._idx}]">
        ${_cmdFavStar(item.panel)}
        <div class="cmd-item-icon">${item.icon}</div>
        <div style="flex:1;min-width:0">
          <div class="cmd-item-label">${esc(item.label)}</div>
          ${item.meta ? `<div style="font-size:.72rem;color:var(--text3);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.meta)}</div>` : ""}
        </div>
        ${item.tag ? `<span class="cmd-item-tag">${esc(item.tag)}</span>` : ""}
      </button>`;

  const serverHTML = serverItems.length
    ? `<div class="cmd-section-label">Results</div>${serverItems.map(itemHTML).join("")}` +
      (_cmdSearchHasMore
        ? `<button class="cmd-item cmd-item-more" data-onclick="cmdSearchMore">
             <div class="cmd-item-icon">⋯</div>
             <div style="flex:1;min-width:0"><div class="cmd-item-label">Show more results</div></div>
           </button>`
        : "")
    : "";

  const localHTML = Object.entries(localGroups)
    .map(([group, groupItems]) => `
    <div class="cmd-section-label">${group}</div>
    ${groupItems.map(itemHTML).join("")}
  `)
    .join("");

  res.innerHTML = (!q ? cmdRecentHTML() : "") + serverHTML + localHTML;
}

function cmdRun(idx) {
  const item = CMD_VISIBLE[idx];
  if (!item) return;
  cmdDismiss();
  setTimeout(() => item.action(), 50);
}

function cmdKey(e) {
  const items = $("cmd-results")?.querySelectorAll(".cmd-item");
  if (!items?.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    CMD_IDX = Math.min(CMD_IDX + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    CMD_IDX = Math.max(CMD_IDX - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (CMD_IDX >= 0) cmdRun(parseInt(items[CMD_IDX].dataset.idx));
    else if (CMD_VISIBLE.length) cmdRun(0);
    return;
  } else if (e.key === "Escape") {
    cmdDismiss();
    return;
  } else {
    return;
  }

  items.forEach((el, i) => el.classList.toggle("active", i === CMD_IDX));
  items[CMD_IDX]?.scrollIntoView({ block: "nearest" });
}

// Global keyboard shortcut — Cmd+K or Ctrl+K
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    CMD_OPEN ? cmdDismiss() : cmdOpen();
  }
  if (e.key === "Escape" && CMD_OPEN) cmdDismiss();
});

// ═══════════════════════ HOME PANEL ═════════════════════════

// ════════════════════ GETTING STARTED GUIDE ══════════════════════

const _GS_KEY = () => `sivarr_gs_${S.sid}`;
const _GS_JOINED_KEY = () => `sivarr_joined_${S.sid}`;
const _GS_DAYS = 7; // show for this many days after first login
const _GS_TOTAL = 6; // total video cards

function gsInit() {
  if (!S.sid) return;

  // Record first login date if not already stored
  const joinedKey = _GS_JOINED_KEY();
  if (!localStorage.getItem(joinedKey)) {
    localStorage.setItem(joinedKey, new Date().toISOString());
  }

  const section = $("gs-section");
  if (!section) return;

  // Check: dismissed?
  const state = JSON.parse(localStorage.getItem(_GS_KEY()) || "{}");
  if (state.dismissed) {
    section.style.display = "none";
    return;
  }

  // Check: within first N days?
  const joined = new Date(localStorage.getItem(joinedKey));
  const ageMs = Date.now() - joined.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > _GS_DAYS) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  _gsRenderProgress(state.done || []);
}

function _gsRenderProgress(done) {
  const count = done.length;
  const fill = $("gs-progress-fill");
  const label = $("gs-progress-label");
  if (fill) fill.style.width = `${Math.round((count / _GS_TOTAL) * 100)}%`;
  if (label) label.textContent = `${count} / ${_GS_TOTAL} done`;

  // Restore done state on cards
  done.forEach((idx) => {
    const card = $(`gsvid-${idx}`);
    if (card) card.classList.add("done");
  });
}

// No real tutorial videos have been recorded yet — these previously all
// pointed at the same placeholder (a rickroll) shipped to every new user.
// Show an honest "coming soon" card instead of embedding anything.
const _GS_VIDEOS = [
  { title: "Welcome to Sivarr", embed: null },
  { title: "Sivarr AI Chat", embed: null },
  { title: "Tasks & Goals", embed: null },
  { title: "Notes & Docs", embed: null },
  { title: "Org Space", embed: null },
  { title: "Billing & Plans", embed: null },
];

// CSP migration: DOM expression, no named global to dispatch to.
window._removeGsVideoModal = function () {
  document.getElementById("gs-video-modal")?.remove();
};

function gsOpenVideo(idx, card) {
  const v = _GS_VIDEOS[idx];
  if (!v) return;
  // Remove old modal if any
  document.getElementById("gs-video-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "gs-video-modal";
  modal.style.cssText =
    "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center";
  const body = v.embed
    ? `<div style="position:relative;padding-top:56.25%;background:#000;border-radius:8px;overflow:hidden">
        <iframe src="${v.embed}?autoplay=1" style="position:absolute;inset:0;width:100%;height:100%;border:none" allow="autoplay;encrypted-media" allowfullscreen></iframe>
      </div>`
    : `<div style="padding:40px 12px;text-align:center;color:var(--muted)">
        <i class="ti ti-video" style="font-size:2rem;display:block;margin-bottom:10px"></i>
        This walkthrough is still being recorded. Check back soon.
      </div>`;
  modal.innerHTML = `
    <div style="background:var(--bg);border-radius:14px;padding:20px;width:min(720px,95vw);position:relative">
      <button data-onclick="_removeGsVideoModal" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--muted);font-size:1.3rem;cursor:pointer;line-height:1">×</button>
      <div style="font-weight:700;margin-bottom:12px;padding-right:24px">${esc(v.title)}</div>
      ${body}
    </div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
  // Mark done
  gsMarkDone(idx, card);
}

function gsMarkDone(idx, card) {
  const state = JSON.parse(localStorage.getItem(_GS_KEY()) || "{}");
  const done = state.done || [];
  if (!done.includes(idx)) {
    done.push(idx);
    state.done = done;
    localStorage.setItem(_GS_KEY(), JSON.stringify(state));
  }
  if (card) card.classList.add("done");
  _gsRenderProgress(done);

  // Auto-dismiss when all done
  if (done.length >= _GS_TOTAL) {
    setTimeout(() => {
      const s = $("gs-section");
      if (s) {
        s.style.opacity = "0";
        s.style.transition = "opacity .4s";
        setTimeout(() => (s.style.display = "none"), 400);
      }
    }, 800);
  }
}

function gsDismiss() {
  const state = JSON.parse(localStorage.getItem(_GS_KEY()) || "{}");
  state.dismissed = true;
  localStorage.setItem(_GS_KEY(), JSON.stringify(state));
  const s = $("gs-section");
  if (s) {
    s.style.opacity = "0";
    s.style.transition = "opacity .3s";
    setTimeout(() => (s.style.display = "none"), 300);
  }
}

// ═════════════════════════════════════════════════════════════════
//  GREETING HEADER — personalized decoration
//  Users pick a motif; it's scattered faintly behind the greeting card.
// ═════════════════════════════════════════════════════════════════
const BRIEF_ICONS = [
  { key: "sparkles", icon: "ti-sparkles", label: "Sparkles" },
  { key: "star", icon: "ti-star", label: "Stars" },
  { key: "heart", icon: "ti-heart", label: "Hearts" },
  { key: "skull", icon: "ti-skull", label: "Skull" },
  { key: "dot", icon: "ti-point-filled", label: "Dots" },
  { key: "moon", icon: "ti-moon-stars", label: "Moon" },
  { key: "flame", icon: "ti-flame", label: "Flame" },
  { key: "bolt", icon: "ti-bolt", label: "Bolt" },
  { key: "flower", icon: "ti-flower", label: "Flower" },
  { key: "leaf", icon: "ti-leaf", label: "Leaf" },
  { key: "music", icon: "ti-music", label: "Music" },
  { key: "diamond", icon: "ti-diamond", label: "Diamond" },
];
// Scatter presets: [top%, left%, size px, rotate deg, base opacity]
const _BRIEF_DECOR_POS = [
  // upper band
  [8, 6, 16, -12, 0.1],
  [14, 16, 13, 16, 0.08],
  [10, 27, 19, -8, 0.12],
  [20, 37, 14, 20, 0.09],
  [7, 48, 16, -15, 0.1],
  [16, 58, 20, 10, 0.11],
  [9, 68, 14, -20, 0.08],
  [18, 77, 17, 12, 0.1],
  [8, 88, 15, -10, 0.09],
  [15, 95, 13, 18, 0.08],
  // lower band
  [55, 4, 15, -22, 0.09],
  [78, 10, 13, 8, 0.08],
  [62, 19, 18, 14, 0.1],
  [85, 26, 16, -16, 0.09],
  [58, 33, 13, 20, 0.07],
  [82, 42, 19, -8, 0.1],
  [66, 52, 14, 12, 0.08],
  [88, 60, 17, 22, 0.1],
  [60, 70, 13, -18, 0.08],
  [84, 78, 18, 10, 0.1],
  [70, 88, 15, -12, 0.09],
  [86, 95, 13, 16, 0.08],
];
function briefDecorKey() {
  return `sivarr_brief_icon_${S.sid}`;
}
function briefDecorCurrent() {
  return localStorage.getItem(briefDecorKey()) || "sparkles";
}

// Global appearance setting (0–100, default 50). 50 keeps the base opacity,
// 100 doubles it (bolder), 0 hides the decoration entirely.
function briefDecorIntensity() {
  const v = parseInt(localStorage.getItem("sivarr_decor_intensity"));
  return isNaN(v) ? 50 : Math.max(0, Math.min(100, v));
}

function renderBriefDecor() {
  const host = document.getElementById("siva-brief-decor");
  if (!host) return;
  const def =
    BRIEF_ICONS.find((i) => i.key === briefDecorCurrent()) || BRIEF_ICONS[0];
  const mult = briefDecorIntensity() / 50;
  host.innerHTML = _BRIEF_DECOR_POS
    .map(([t, l, s, r, o]) => {
      const op = Math.min(o * mult, 0.4).toFixed(3);
      return `<i class="ti ${def.icon}" style="top:${t}%;left:${l}%;font-size:${s}px;transform:rotate(${r}deg);opacity:${op}"></i>`;
    })
    .join("");
}

function briefDecorToggle(btn) {
  const existing = document.querySelector(".brief-decor-pop");
  if (existing) {
    existing.remove();
    return;
  }
  const cur = briefDecorCurrent();
  const pop = document.createElement("div");
  pop.className = "brief-decor-pop";
  pop.innerHTML = `
    <div class="bdp-title">Decorate your header</div>
    <div class="bdp-grid">
      ${BRIEF_ICONS.map(
        (i) =>
          `<button class="bdp-opt ${i.key === cur ? "sel" : ""}" title="${i.label}"
                 data-onclick="briefDecorPick" data-onclick-arg0="${i.key}"><i class="ti ${i.icon}"></i></button>`,
      ).join("")}
    </div>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.top = r.bottom + 6 + "px";
  let left = r.right - pop.offsetWidth;
  if (left < 8) left = 8;
  pop.style.left = left + "px";
  const close = (e) => {
    if (
      !pop.contains(e.target) &&
      e.target !== btn &&
      !btn.contains(e.target)
    ) {
      pop.remove();
      document.removeEventListener("click", close);
    }
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

function briefDecorPick(key) {
  try {
    localStorage.setItem(briefDecorKey(), key);
  } catch (_) {}
  renderBriefDecor();
  document.querySelector(".brief-decor-pop")?.remove();
}

// Collapse/expand the AI brief's message body — a UI preference (like theme),
// not per-user data, so it's stored globally rather than under S.sid.
function briefMsgToggle() {
  const card = document.querySelector(".siva-brief");
  if (!card) return;
  const collapsed = card.classList.toggle("msg-collapsed");
  try {
    localStorage.setItem("sivarr_brief_collapsed", collapsed ? "1" : "0");
  } catch (_) {}
  const btn = $("brief-collapse-btn");
  if (btn) btn.title = collapsed ? "Expand insight" : "Collapse insight";
}

function _briefMsgRestore() {
  const card = document.querySelector(".siva-brief");
  if (!card) return;
  let collapsed = false;
  try {
    collapsed = localStorage.getItem("sivarr_brief_collapsed") === "1";
  } catch (_) {}
  card.classList.toggle("msg-collapsed", collapsed);
  const btn = $("brief-collapse-btn");
  if (btn) btn.title = collapsed ? "Expand insight" : "Collapse insight";
}

// The header name-line is the single greeting (local time). Strip any leading
// "Good morning/afternoon/evening[, Name]" (or the bare "Morning[, Name]" form
// the AI brief sometimes opens with, skipping "Good") the brief text may carry
// (often from the server's timezone) so we never show two conflicting greetings.
function _stripGreeting(s) {
  if (!s) return s;
  return s
    .replace(
      /^\s*#*\s*(?:good\s+)?(morning|afternoon|evening)\b[\s,!.…—-]*([A-Za-z][\w'’-]*[\s,!.]*)?/i,
      "",
    )
    .replace(/^[\s,.!…—–-]+/, "");
}

async function loadHome() {
  if (!S.sid) return;
  _recordActivity();
  _buildNotifs();
  _renderRecentPills();
  gsInit();

  const hr = new Date().getHours();
  const tod =
    hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  const firstName = S.name.split(" ")[0] || "there";
  const today8601 = new Date().toISOString().split("T")[0];

  const greet = $("home-greeting");
  if (greet) greet.textContent = `${tod}, ${firstName} 👋`;
  const sub = $("home-sub");
  if (sub)
    sub.textContent = new Date().toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  renderBriefDecor();
  _briefMsgRestore();

  // Pull all live data
  const tasks = JSON.parse(
    localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
  );
  const goals = JSON.parse(
    localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
  );
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const jnl = JSON.parse(localStorage.getItem(JNL_KEY()) || "[]");
  const events = JSON.parse(localStorage.getItem(CAL_EVENTS_KEY()) || "[]");
  const notes = JSON.parse(
    localStorage.getItem(`sivarr_notes_${S.sid}`) || "[]",
  );

  const openTasks = tasks.filter((t) => !t.done);
  const activeGoals = goals.filter((g) => !g.completed);
  const streak = _getActivityStreak();

  // ── Sivarr brief — fast data-driven first, AI overlay if cached ──────────────
  const briefMsg = $("home-brief-msg");
  if (briefMsg) {
    const briefKey = `sivarr_brief_${S.sid}_${today8601}`;
    const cached = localStorage.getItem(briefKey);
    if (cached) {
      briefMsg.innerHTML = renderMarkdown(_stripGreeting(cached));
    } else {
      // Show structured data immediately from /api/home/briefing, then fetch AI brief in background
      const token = getToken() || "";
      briefMsg.innerHTML = `<span class="brief-pulse">Loading…</span>`;
      fetch(`/api/home/briefing?token=${encodeURIComponent(token)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          // No greeting here — the header name-line already greets (local time).
          const parts = [];
          if (d.tasks_due_today)
            parts.push(
              `${d.tasks_due_today} task${d.tasks_due_today > 1 ? "s" : ""} due today${d.overdue_tasks ? ` · ${d.overdue_tasks} overdue` : ""}.`,
            );
          if (d.streak_days)
            parts.push(`${d.streak_days}-day streak, keep it going.`);
          if (d.goals_at_risk)
            parts.push(
              `${d.goals_at_risk} goal${d.goals_at_risk > 1 ? "s" : ""} at risk.`,
            );
          if (!parts.length)
            parts.push("You're all set, nothing urgent today. 🎯");
          if (!briefMsg.querySelector(".brief-pulse")) return; // AI beat us, skip
          briefMsg.textContent = parts.join(" ");
          // Still fire the AI brief in background to replace with richer text
          _fetchHomeBrief({
            openTasks,
            activeGoals,
            habits,
            jnl,
            events,
            today8601,
            streak,
            briefKey,
            briefMsg,
          });
        })
        .catch(() => {
          briefMsg.innerHTML = `<span class="brief-pulse">Generating your brief…</span>`;
          _fetchHomeBrief({
            openTasks,
            activeGoals,
            habits,
            jnl,
            events,
            today8601,
            streak,
            briefKey,
            briefMsg,
          });
        });
    }
  }

  // ── Discovery strip — conditional "get more from Sivarr" nudges ─
  try {
    _homeRenderDiscovery(activeGoals, habits, notes);
  } catch (_) {}

  // ── Today: merged tasks + habits, reactive checklist ────────────
  // Reads the real Tasks store (js/features/tasks.js's getTasksData/
  // TASKS_KEY, window-exposed) — subtasks (parent_id) only exist there.
  // The dual-store split this comment used to describe is gone: cmd-k
  // quick-add, NL-date capture and marketplace-content-install all write
  // through the same real addTask()/getTasksData() now, so nothing needs
  // a next-login hydration pass to show up here anymore.
  try {
    _homeRenderToday(today8601, habits);
  } catch (_) {}

  // ── Today's schedule ──────────────────────────────────────────
  try {
    const sl = $("home-schedule-list");
    if (sl) {
      const todayEvts = events
        .filter((e) => (e.date || "").startsWith(today8601))
        .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
      const shTasksToday = activeTasks(getTasksData().tasks)
        .filter((t) => t.date === today8601 && t.status !== "done")
        .sort((a, b) => (a.time || "").localeCompare(b.time || ""));

      const schedItems = [
        ...todayEvts.slice(0, 3).map(
          (e) => `
          <div class="sched-item">
            <div class="sched-time">${e.time || "All day"}</div>
            <div class="sched-dot" style="background:var(--teal)"></div>
            <div class="sched-info">
              <div class="sched-name">${esc(e.title)}</div>
              ${e.desc ? `<div class="sched-sub">${esc(e.desc.slice(0, 40))}</div>` : ""}
            </div>
          </div>`,
        ),
        ...shTasksToday.slice(0, 3).map(
          (t) => `
          <div class="sched-item" data-onclick="nav" data-onclick-args="[&quot;flux&quot;,null]" style="cursor:pointer">
            <div class="sched-time">${t.time || "Task"}</div>
            <div class="sched-dot" style="background:var(--amber3,#f59e0b)"></div>
            <div class="sched-info">
              <div class="sched-name">${esc(t.title)}</div>
              ${t.type ? `<div class="sched-sub">${esc(t.type)}</div>` : ""}
            </div>
          </div>`,
        ),
      ];
      if (schedItems.length) {
        sl.innerHTML = schedItems.slice(0, 5).join("");
      } else {
        sl.innerHTML = `<div class="sched-item"><div class="sched-time">–</div><div class="sched-dot" style="background:var(--text4)"></div><div class="sched-info"><div class="sched-name" style="color:var(--text4)">No events today</div><div class="sched-sub">Add some in Calendar →</div></div></div>`;
      }
    }
  } catch (_) {}

  // ── Finance snapshot ──────────────────────────────────────────
  try {
    const fs = $("home-finance-section");
    const fb = $("home-finance-body");
    if (fs && fb) {
      const fin = _finData();
      const month = today8601.slice(0, 7);
      const mTxs = (fin.transactions || []).filter((t) =>
        t.date.startsWith(month),
      );
      if (mTxs.length) {
        fs.style.display = "block";
        const inc = mTxs
          .filter((t) => t.type === "income")
          .reduce((s, t) => s + t.amount, 0);
        const exp = mTxs
          .filter((t) => t.type === "expense")
          .reduce((s, t) => s + t.amount, 0);
        const bal = inc - exp;
        const balCol = bal >= 0 ? "var(--teal)" : "#f87171";
        // Top spending category
        const catTotals = {};
        mTxs
          .filter((t) => t.type === "expense")
          .forEach((t) => {
            catTotals[t.category] = (catTotals[t.category] || 0) + t.amount;
          });
        const topCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];
        const topCatInfo = topCat ? _finCat("expense", topCat[0]) : null;
        fb.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">
            <div style="text-align:center">
              <div style="font-family:var(--font);font-size:.95rem;font-weight:800;color:var(--teal)">${_finFmt(inc)}</div>
              <div style="font-size:.65rem;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Income</div>
            </div>
            <div style="text-align:center">
              <div style="font-family:var(--font);font-size:.95rem;font-weight:800;color:#f87171">${_finFmt(exp)}</div>
              <div style="font-size:.65rem;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Expenses</div>
            </div>
            <div style="text-align:center">
              <div style="font-family:var(--font);font-size:.95rem;font-weight:800;color:${balCol}">${_finFmt(Math.abs(bal))}</div>
              <div style="font-size:.65rem;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-top:2px">${bal >= 0 ? "Surplus" : "Deficit"}</div>
            </div>
          </div>
          ${topCatInfo ? `<div style="font-size:.75rem;color:var(--text3)">Top spend: <strong style="color:var(--text2)">${topCatInfo.icon} ${topCatInfo.label}</strong>, ${_finFmt(topCat[1])}</div>` : ""}`;
      } else {
        fs.style.display = "none";
      }
    }
  } catch (_) {}

  // ── Skills snapshot ───────────────────────────────────────────
  try {
    const ss = $("home-skills-section");
    const sb = $("home-skills-body");
    if (ss && sb) {
      const skData = _skData();
      const skills = skData.skills || [];
      const topSkills = [...skills]
        .sort((a, b) => (b.level || 0) - (a.level || 0))
        .slice(0, 3);
      if (topSkills.length) {
        ss.style.display = "block";
        sb.innerHTML =
          topSkills
            .map((k) => {
              const lv = _skLevel(k.level || 0);
              const pct = k.level || 0;
              return `<div data-onclick="nav" data-onclick-args="[&quot;skills&quot;,null]" style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;border-bottom:1px solid var(--border)">
            <span style="font-size:1.1rem;flex-shrink:0">${k.emoji || "💡"}</span>
            <div style="flex:1;min-width:0">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                <span style="font-size:.8rem;font-weight:600;color:var(--text)">${esc(k.name)}</span>
                <span style="font-size:.68rem;color:var(--text3)">${lv.label} · ${pct}%</span>
              </div>
              <div style="height:4px;background:var(--border2);border-radius:3px;overflow:hidden">
                <div style="height:4px;width:${pct}%;background:${lv.color};border-radius:3px;transition:width .4s"></div>
              </div>
            </div>
          </div>`;
            })
            .join("") +
          (skills.length > 3
            ? `<div style="font-size:.72rem;color:var(--text3);padding:6px 0">+${skills.length - 3} more skill${skills.length - 3 > 1 ? "s" : ""}</div>`
            : "");
      } else {
        ss.style.display = "none";
      }
    }
  } catch (_) {}

  // ── Across your spaces — dynamic, real-data-only briefing ───────
  try {
    _homeRenderSpaces(activeGoals, jnl, notes, today8601);
  } catch (_) {}

  // ── Trending in Marketplace — real popular-sort API ─────────────
  try {
    _homeRenderTrending();
  } catch (_) {}
}

// ── Today: builds one merged, reactive list from real Tasks-store tasks
// (due today / overdue / pinned, with real parent_id subtasks) and real
// habits — same data homeHabitToggle()/_homeTaskToggle() already operate
// on elsewhere, just newly connected to this UI. ────────────────────
function _homeRenderToday(today8601, habits) {
  const tl = $("home-today-list");
  if (!tl) return;
  const shAll = activeTasks(getTasksData().tasks);
  const topLevel = shAll.filter((t) => !t.parent_id);
  const due = topLevel.filter(
    (t) =>
      t.status !== "done" &&
      (t.date === today8601 || (t.date && t.date < today8601) || t.pinned),
  );
  due.sort((a, b) => {
    const rank = (t) => (t.date && t.date < today8601 ? 0 : t.date === today8601 ? 1 : 2);
    return rank(a) - rank(b);
  });
  const shownTasks = due.slice(0, 4);
  const moreCount = due.length - shownTasks.length;
  const shownHabits = (habits || []).slice(0, 5);

  if (!shownTasks.length && !shownHabits.length) {
    tl.innerHTML = `<div style="text-align:center;padding:22px 0">
      <div style="font-size:1.4rem;margin-bottom:6px">☀️</div>
      <div style="font-size:.86rem;color:var(--text3)">Nothing on your plate yet</div>
      <div style="font-size:.76rem;color:var(--text4);margin-top:2px">Add a task or start a habit to see it here</div>
    </div>`;
    return;
  }

  const taskRows = shownTasks
    .map((t) => {
      const subs = shAll.filter((c) => String(c.parent_id) === String(t.id));
      const doneSubs = subs.filter((c) => c.status === "done").length;
      const overdue = t.date && t.date < today8601;
      const badge = overdue
        ? `<span class="h-today-badge overdue">Overdue</span>`
        : t.date === today8601
          ? `<span class="h-today-badge today">Due today</span>`
          : "";
      const meta = subs.length ? `${doneSubs}/${subs.length} subtasks` : "No subtasks";
      const nextStatus = t.status === "done" ? "todo" : "done";
      const subRows = subs.length
        ? `<div class="h-today-subwrap" id="h-today-sub-${t.id}">
            ${subs
              .map((s) => {
                const sNext = s.status === "done" ? "todo" : "done";
                return `<div class="h-today-subrow">
                <button class="habit-cb h-today-subcheck ${s.status === "done" ? "done" : ""}" data-onclick="_homeTaskToggle" data-onclick-args="${esc(JSON.stringify([s.id, sNext]))}" aria-label="Toggle subtask"></button>
                <span class="h-today-subname ${s.status === "done" ? "done" : ""}">${esc(s.title)}</span>
              </div>`;
              })
              .join("")}
          </div>`
        : "";
      return `<div class="h-today-item">
        <div class="h-today-main" ${subs.length ? `data-onclick="_homeToggleSub" data-onclick-arg0="${esc(t.id)}"` : ""}>
          <button class="habit-cb" data-onclick="_homeTaskToggle" data-onclick-args="${esc(JSON.stringify([t.id, nextStatus]))}" aria-label="Toggle task"></button>
          <div class="h-today-body">
            <div class="h-today-title-row">
              <div class="h-today-title">${esc(t.title)}</div>
              ${badge}
            </div>
            <div class="h-today-meta">${meta}</div>
          </div>
          ${subs.length ? `<i class="ti ti-chevron-right h-today-chev" id="h-today-chev-${t.id}"></i>` : ""}
        </div>
        ${subRows}
      </div>`;
    })
    .join("");

  const habitRows = shownHabits
    .map((h, i) => {
      const done = (h.completions || []).includes(today8601);
      return `<div class="h-today-item">
        <div class="h-today-main" data-onclick="homeHabitToggle" data-onclick-args="[${i}]">
          <button class="habit-cb ${done ? "done" : ""}" data-onclick="homeHabitToggle" data-onclick-args="[${i}]" aria-label="Toggle habit"></button>
          <div class="h-today-body">
            <div class="h-today-title-row"><div class="h-today-title">${esc(h.emoji || "📌")} ${esc(h.title)}</div></div>
          </div>
          ${h.streak > 0 ? `<span class="h-today-streak">🔥 ${h.streak}d</span>` : ""}
        </div>
      </div>`;
    })
    .join("");

  const moreRow = moreCount > 0
    ? `<div class="h-today-more" data-onclick="nav" data-onclick-args="${esc(JSON.stringify(["flux", null]))}">${moreCount} more waiting in Tasks →</div>`
    : "";

  tl.innerHTML = taskRows + habitRows + moreRow;
}

// Toggle a task/subtask's done state via the same moveSHTask() the Tasks
// panel itself uses, then re-render just the Today section (cheap — avoids
// a full loadHome() + AI-brief-cache touch for a single checkbox click).
function _homeTaskToggle(id, newStatus) {
  // moveSHTask() never existed anywhere -- the real equivalent is
  // js/features/tasks.js's updateTaskFields (window-exposed there).
  if (typeof window.updateTaskFields === "function") {
    window.updateTaskFields(id, { status: newStatus });
    if (typeof window.renderAll === "function") window.renderAll();
  }
  const today8601 = new Date().toISOString().split("T")[0];
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  _homeRenderToday(today8601, habits);
}

// Expand/collapse a task's subtask list in place.
function _homeToggleSub(id) {
  const wrap = $(`h-today-sub-${id}`);
  const chev = $(`h-today-chev-${id}`);
  if (wrap) wrap.classList.toggle("open");
  if (chev) chev.classList.toggle("open");
}

// ── Discovery strip — small, conditional "get more from Sivarr" nudges.
// Each card only shows while its own real-data condition is unmet; the
// whole strip hides once every applicable nudge has been satisfied. No
// WhatsApp/Academic cards — neither is backed by real functionality today.
function _homeRenderDiscovery(activeGoals, habits, notes) {
  const sec = $("home-discover-section");
  const strip = $("home-discover-strip");
  if (!sec || !strip) return;
  const cards = [];
  if (!activeGoals.length)
    cards.push({
      icon: "ti-target",
      title: "Set your first goal",
      sub: "Link habits to it and watch progress add up",
      go: "goals",
    });
  if (!habits.length)
    cards.push({
      icon: "ti-flame",
      title: "Start a habit",
      sub: "Small streaks compound, try one this week",
      go: "habits",
    });
  if (!notes.length)
    cards.push({
      icon: "ti-notebook",
      title: "Take your first note",
      sub: "Jot down anything, organize it later",
      go: "notes",
    });
  if (!_GCAL_CONNECTED)
    cards.push({
      icon: "ti-calendar",
      title: "Connect Google Calendar",
      sub: "See events alongside tasks, right on Home",
      go: "settings",
    });
  cards.push({
    icon: "ti-building-store",
    title: "Explore the Marketplace",
    sub: "Templates and AI agents built by other users",
    go: "agents",
  });

  if (!cards.length) {
    sec.style.display = "none";
    return;
  }
  sec.style.display = "block";
  strip.innerHTML = cards
    .map(
      (c) => `<div class="h-discover-card" data-onclick="nav" data-onclick-args="${esc(JSON.stringify([c.go, null]))}">
        <div class="h-discover-icon"><i class="ti ${c.icon}"></i></div>
        <div class="h-discover-title">${esc(c.title)}</div>
        <div class="h-discover-sub">${esc(c.sub)}</div>
      </div>`,
    )
    .join("");
}

// ── Across your spaces — candidate-builder pattern: each function returns
// a card or null depending on real data; render whatever's non-null, hide
// the section entirely when nothing qualifies. No Academic/Org/Trading-
// Journal/WhatsApp cards — none are real, universal per-user data today.
function _homeRenderSpaces(activeGoals, jnl, notes, today8601) {
  const sec = $("home-spaces-section");
  const list = $("home-brief-list");
  if (!sec || !list) return;

  const candidates = [];

  if (activeGoals.length) {
    const g = [...activeGoals].sort((a, b) => (b.progress || 0) - (a.progress || 0))[0];
    candidates.push({
      icon: "ti-target",
      cls: "goal",
      html: `<b>${esc(g.title)}</b> is ${g.progress || 0}% there`,
      tag: "Goals",
      go: "goals",
    });
  }

  const journalledToday = jnl.some((e) => (e.date || "").startsWith(today8601));
  if (!journalledToday) {
    candidates.push({
      icon: "ti-notebook",
      cls: "journal",
      html: `No journal entry today, <b>tap to write one</b>`,
      tag: "Journal",
      go: "journal",
    });
  }

  // Real, reliable signal only — note dates are locale strings, not ISO,
  // so "N notes this week" can't be computed correctly. The single global
  // draft slot is a real boolean we do have.
  try {
    const draft = localStorage.getItem(`sivarr_note_draft_${S.sid}`);
    if (draft && draft.trim()) {
      candidates.push({
        icon: "ti-file-text",
        cls: "notes",
        html: `You have <b>an unsaved draft</b> waiting to be finished`,
        tag: "Notes & Docs",
        go: "notes",
      });
    }
  } catch (_) {}

  if (!candidates.length) {
    sec.style.display = "none";
    return;
  }
  sec.style.display = "block";
  list.innerHTML = candidates
    .slice(0, 4)
    .map(
      (c) => `<div class="h-brief-row" data-onclick="nav" data-onclick-args="${esc(JSON.stringify([c.go, null]))}">
        <div class="h-brief-icon ${c.cls}"><i class="ti ${c.icon}"></i></div>
        <div style="flex:1;min-width:0">
          <div class="h-brief-text">${c.html}</div>
          <span class="h-brief-tag">${esc(c.tag)}</span>
        </div>
        <i class="ti ti-chevron-right h-brief-arrow"></i>
      </div>`,
    )
    .join("");
}

// ── Trending in Marketplace — real popular-sort data, not the old static
// TPL_LIBRARY placeholder array. Independent fetch (doesn't touch the
// agents-panel's own _ag.templates state) so it works even if that panel
// has never been opened this session.
// CSP migration: multi-statement (navigate to the marketplace, then open a
// specific template's detail view).
window._navAgentsThenOpenTemplate = function (id) {
  nav("agents", null);
  agOpenTemplate(id);
};

async function _homeRenderTrending() {
  const strip = $("home-trending-list");
  if (!strip) return;
  strip.innerHTML = `<span class="brief-pulse">Loading…</span>`;
  try {
    const r = await fetch("/api/agents/templates?sort=popular&limit=6");
    const d = await r.json();
    const templates = d.templates || [];
    if (!templates.length) {
      strip.innerHTML = `<div style="font-size:.82rem;color:var(--text4);padding:8px 0">Nothing trending yet, <button data-onclick="nav" data-onclick-args="[&quot;agents&quot;,null]" style="background:none;border:none;color:var(--teal);cursor:pointer;font-family:var(--font);font-size:.82rem;padding:0">browse the marketplace →</button></div>`;
      return;
    }
    strip.innerHTML = templates
      .map((t) => {
        const color = t.thumbnail_color || AG_CAT_COLORS[t.category] || "var(--teal)";
        const icon = AG_CAT_ICONS[t.category] || "ti-template";
        const price = agFormatPrice(t);
        return `<div class="h-trend-card" data-onclick="_navAgentsThenOpenTemplate" data-onclick-arg0="${esc(t.id)}">
          <div class="h-trend-thumb" style="background:${color}1a;color:${color}"><i class="ti ${icon}"></i></div>
          <div class="h-trend-name">${esc(t.name)}</div>
          <div class="h-trend-tag">${esc(AG_CAT_LABELS[t.category] || "Template")} · ${price}</div>
        </div>`;
      })
      .join("");
  } catch (_) {
    strip.innerHTML = `<div style="font-size:.82rem;color:var(--text4);padding:8px 0">Couldn't load trending templates right now.</div>`;
  }
}

async function _fetchHomeBrief({
  openTasks,
  activeGoals,
  habits,
  jnl,
  events,
  today8601,
  streak,
  briefKey,
  briefMsg,
}) {
  if (!S.sid) return;
  const token = getToken() || "";
  if (!token) return;

  const overdueTasks = openTasks.filter(
    (t) => t.due_date && t.due_date < today8601,
  );
  const topGoal = activeGoals[0];
  const highPri = openTasks.find((t) => t.priority === "high");
  const journalled = jnl.some((e) => (e.date || "") === today8601);
  const eventsToday = events.filter((e) =>
    (e.date || "").startsWith(today8601),
  ).length;

  try {
    const r = await API("/api/home/brief", {
      token,
      open_tasks: openTasks.length,
      overdue_tasks: overdueTasks.length,
      top_goal: topGoal?.title || "",
      goal_pct: topGoal?.progress || 0,
      streak,
      events_today: eventsToday,
      journalled,
      high_priority_task: highPri?.title || "",
    });
    if (r?.brief && briefMsg) {
      briefMsg.innerHTML = renderMarkdown(_stripGreeting(r.brief));
      localStorage.setItem(briefKey, r.brief);
    }
  } catch (_) {
    if (briefMsg) {
      const firstName = S.name.split(" ")[0];
      briefMsg.textContent = openTasks.length
        ? `${firstName}, you have ${openTasks.length} task${openTasks.length > 1 ? "s" : ""} open${overdueTasks.length ? ` (${overdueTasks.length} overdue)` : ""}. Make today count.`
        : `Clean slate, ${firstName}. Set a goal or plan your week.`;
    }
  }
}

async function refreshHomeBrief() {
  if (!S.sid) return;
  const today8601 = new Date().toISOString().split("T")[0];
  const briefKey = `sivarr_brief_${S.sid}_${today8601}`;
  localStorage.removeItem(briefKey);

  const briefMsg = $("home-brief-msg");
  if (briefMsg)
    briefMsg.innerHTML = `<span class="brief-pulse">Refreshing…</span>`;

  const tasks = JSON.parse(
    localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
  );
  const goals = JSON.parse(
    localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
  );
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const jnl = JSON.parse(localStorage.getItem(JNL_KEY()) || "[]");
  const events = JSON.parse(localStorage.getItem(CAL_EVENTS_KEY()) || "[]");

  await _fetchHomeBrief({
    openTasks: tasks.filter((t) => !t.done),
    activeGoals: goals.filter((g) => !g.completed),
    habits,
    jnl,
    events,
    today8601,
    streak: _getActivityStreak(),
    briefKey,
    briefMsg,
  });
}

function homeHabitToggle(idx) {
  if (!S.sid) return;
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  if (!habits[idx]) return;
  const today = new Date().toISOString().split("T")[0];
  habits[idx].completions = habits[idx].completions || [];
  if (habits[idx].completions.includes(today)) {
    habits[idx].completions = habits[idx].completions.filter(
      (d) => d !== today,
    );
    habits[idx].streak = Math.max(0, (habits[idx].streak || 0) - 1);
  } else {
    habits[idx].completions.push(today);
    habits[idx].streak = (habits[idx].streak || 0) + 1;
    _recordActivity();
  }
  localStorage.setItem(HAB_KEY(), JSON.stringify(habits));
  _syncHabitsToServer(habits);
  loadHome();
}

// ════════════ CALENDAR ════════════
let CAL_VIEW = "week"; // 'day' | 'week' | 'month'
let CAL_ANCHOR = new Date(); // reference date for the active view
let CAL_MINI_Y = new Date().getFullYear();
let CAL_MINI_M = new Date().getMonth();
let CAL_FILTERS = null; // Set<string> of enabled categories (lazy)
let CAL_EVENTS_KEY = () => `sivarr_cal_${S.sid || "guest"}`;
let CAL_FILTERS_KEY = () => `sivarr_cal_filters_${S.sid || "guest"}`;

// Timeline geometry (week/day views)
const CAL_HOUR_START = 7; // first hour shown (7 AM)
const CAL_HOUR_END = 22; // last hour shown (10 PM)
const CAL_HOUR_PX = 56; // px per hour row

// Event categories — drive colour + the Filters checklist
const CAL_CATS = [
  { id: "meeting", label: "Meetings", color: "#3b82f6" },
  { id: "task", label: "Task Due Dates", color: "#ec4899" },
  { id: "milestone", label: "Milestones", color: "#8b5cf6" },
  { id: "deadline", label: "Deadlines", color: "#f59e0b" },
  { id: "personal", label: "Personal Events", color: "#14b8a6" },
  { id: "birthday", label: "Birthdays", color: "#10b981" },
];
const CAL_CAT_MAP = Object.fromEntries(CAL_CATS.map((c) => [c.id, c]));

// ── Calendar deadline sync helpers ────────────────────────────
function _calUpsertEvent(deterministicId, title, date, color) {
  if (!date || !title) return;
  const evs = JSON.parse(localStorage.getItem(CAL_EVENTS_KEY()) || "[]");
  const idx = evs.findIndex((e) => e.id === deterministicId);
  const ev = { id: deterministicId, title, date, time: "", color };
  if (idx >= 0) evs[idx] = ev;
  else evs.push(ev);
  localStorage.setItem(CAL_EVENTS_KEY(), JSON.stringify(evs));
}

function _calRemoveEvent(deterministicId) {
  const evs = JSON.parse(localStorage.getItem(CAL_EVENTS_KEY()) || "[]").filter(
    (e) => e.id !== deterministicId,
  );
  localStorage.setItem(CAL_EVENTS_KEY(), JSON.stringify(evs));
}

function _calSyncGoal(goal) {
  if (!goal?.deadline || goal.completed) {
    _calRemoveEvent(`goal_${goal.id}`);
    return;
  }
  _calUpsertEvent(
    `goal_${goal.id}`,
    `🎯 ${goal.title}`,
    goal.deadline,
    "var(--teal)",
  );
}

function _calSyncAssignment(classCode, assignment) {
  const due = assignment.due_date || assignment.due || "";
  const id = `assign_${classCode}_${assignment.id}`;
  if (!due) return;
  _calUpsertEvent(id, `📋 ${assignment.title}`, due, "var(--amber3)");
}

function calInit() {
  CAL_ANCHOR = new Date();
  CAL_MINI_Y = CAL_ANCHOR.getFullYear();
  CAL_MINI_M = CAL_ANCHOR.getMonth();
  calRender();
}

function calSetView(v) {
  CAL_VIEW = v;
  calRender();
}

function calNav(dir) {
  const a = new Date(CAL_ANCHOR);
  if (CAL_VIEW === "week") a.setDate(a.getDate() + dir * 7);
  else if (CAL_VIEW === "day") a.setDate(a.getDate() + dir);
  else a.setMonth(a.getMonth() + dir);
  CAL_ANCHOR = a;
  CAL_MINI_Y = a.getFullYear();
  CAL_MINI_M = a.getMonth();
  calRender();
}

// ── Date / time helpers ───────────────────────────────────────
function _calYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function _calFromYMD(s) {
  return new Date(s + "T00:00:00");
}
function _calWeekStart(d) {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day)); // back to Monday
  x.setHours(0, 0, 0, 0);
  return x;
}
function _calWeekDays() {
  const s = _calWeekStart(CAL_ANCHOR);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(s);
    d.setDate(s.getDate() + i);
    return d;
  });
}
function _calToMin(t) {
  if (!t) return null;
  const m = String(t)
    .trim()
    .match(/^(\d{1,2}):?(\d{2})?/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}
function _calFmtMin(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}
// Soft pastel background for any colour (hex or var())
function _calPillBg(color) {
  return `color-mix(in srgb, ${color} 15%, transparent)`;
}

// ── Categories / filters ──────────────────────────────────────
function _calCatOf(ev) {
  if (ev.category && CAL_CAT_MAP[ev.category]) return ev.category;
  if (typeof ev.id === "string") {
    if (ev.id.startsWith("goal_")) return "milestone";
    if (ev.id.startsWith("assign_")) return "deadline";
  }
  return "meeting";
}
function _calGetFilters() {
  if (CAL_FILTERS) return CAL_FILTERS;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(CAL_FILTERS_KEY()) || "null");
  } catch (_) {}
  CAL_FILTERS = new Set(
    Array.isArray(saved) ? saved : CAL_CATS.map((c) => c.id),
  );
  return CAL_FILTERS;
}
function calToggleFilter(cat) {
  const f = _calGetFilters();
  if (f.has(cat)) f.delete(cat);
  else f.add(cat);
  localStorage.setItem(CAL_FILTERS_KEY(), JSON.stringify([...f]));
  calRender();
}

// ── Normalized items (events + tasks), respecting filters ─────
function _calRawEvents() {
  try {
    const v = JSON.parse(localStorage.getItem(CAL_EVENTS_KEY()) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}
function _calNormalize() {
  const f = _calGetFilters();
  const out = [];
  _calRawEvents().forEach((e) => {
    const category = _calCatOf(e);
    if (!f.has(category)) return;
    const startMin = _calToMin(e.time);
    let endMin = _calToMin(e.end);
    if (startMin != null && (endMin == null || endMin <= startMin))
      endMin = Math.min(startMin + 60, 24 * 60);
    out.push({
      id: e.id,
      kind: "event",
      title: e.title,
      date: e.date,
      allDay: startMin == null,
      startMin,
      endMin,
      category,
      color: e.color || CAL_CAT_MAP[category].color,
    });
  });
  if (f.has("task")) {
    activeTasks(getTasksData().tasks)
      .filter((t) => t.date && t.status !== "done")
      .forEach((t) => {
        const startMin = _calToMin(t.time);
        out.push({
          id: "task_" + (t.id || t.title),
          kind: "task",
          title: t.title,
          date: t.date,
          allDay: startMin == null,
          startMin,
          endMin: startMin != null ? Math.min(startMin + 60, 24 * 60) : null,
          category: "task",
          color: CAL_CAT_MAP.task.color,
        });
      });
  }
  // Connected Google Calendar events (read-only, shown under the Meetings filter)
  if (
    f.has("meeting") &&
    typeof _GCAL_EVENTS !== "undefined" &&
    Array.isArray(_GCAL_EVENTS)
  ) {
    _GCAL_EVENTS.forEach((g) => {
      const sd = g.start ? new Date(g.start) : null;
      if (!sd || isNaN(sd)) return;
      const allDay =
        !!g.allDay || (typeof g.start === "string" && g.start.length <= 10);
      let startMin = allDay ? null : sd.getHours() * 60 + sd.getMinutes();
      let endMin = null;
      if (!allDay && g.end) {
        const ed = new Date(g.end);
        if (!isNaN(ed)) endMin = ed.getHours() * 60 + ed.getMinutes();
      }
      if (startMin != null && (endMin == null || endMin <= startMin))
        endMin = Math.min(startMin + 60, 24 * 60);
      out.push({
        id: "g_" + (g.id || g.title),
        kind: "gcal",
        title: g.title || "(No title)",
        date: _calYMD(sd),
        allDay,
        startMin,
        endMin,
        category: "meeting",
        color: g.color || "#4285F4",
        htmlLink: g.htmlLink || "",
      });
    });
  }
  return out;
}
function _calItemsOn(ymd) {
  return _calNormalize()
    .filter((i) => i.date === ymd)
    .sort((a, b) => (a.startMin ?? 1e9) - (b.startMin ?? 1e9));
}
// Lane-pack overlapping timed items within a day (per-cluster width split)
function _calLayoutDay(items) {
  items.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  let cluster = [],
    clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    cluster.forEach((it) => {
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (it.startMin >= lanes[i]) {
          it.lane = i;
          lanes[i] = it.endMin;
          placed = true;
          break;
        }
      }
      if (!placed) {
        it.lane = lanes.length;
        lanes.push(it.endMin);
      }
    });
    cluster.forEach((it) => (it.lanes = lanes.length));
    cluster = [];
  };
  items.forEach((it) => {
    if (cluster.length && it.startMin >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  });
  flush();
  return items;
}

// ── Main render dispatch ──────────────────────────────────────
function calResetData() {
  localStorage.removeItem(CAL_EVENTS_KEY());
  localStorage.removeItem(CAL_FILTERS_KEY());
  CAL_FILTERS = null;
  calRender();
  toast("Calendar data reset");
}
function calRender() {
  const body = $("cal-main-body");
  if (!body) return;
  try {
    _calRenderHeader();
  } catch (err) {
    console.error("Calendar header render failed:", err);
  }
  _calRenderRail();
  try {
    if (CAL_VIEW === "month") body.innerHTML = _calMonthHTML();
    else
      body.innerHTML = _calTimelineHTML(
        CAL_VIEW === "day" ? [new Date(CAL_ANCHOR)] : _calWeekDays(),
      );
  } catch (err) {
    console.error("Calendar body render failed:", err);
    body.innerHTML = `<div class="cal-render-error">
      <i class="ti ti-alert-triangle" aria-hidden="true"></i>
      <div>Couldn't load your calendar events.</div>
      <button class="btn ghost" data-onclick="calResetData">Reset calendar data</button>
    </div>`;
  }
  document
    .querySelectorAll("#cal-view-seg button")
    .forEach((b) => b.classList.toggle("active", b.dataset.v === CAL_VIEW));
  if (CAL_VIEW !== "month") {
    const sc = $("cal-tl-scroll");
    if (sc) sc.scrollTop = Math.max(0, (9 - CAL_HOUR_START) * CAL_HOUR_PX - 8);
  }
}

function _calRenderHeader() {
  const lbl = $("cal-range-label");
  if (!lbl) return;
  if (CAL_VIEW === "day") {
    lbl.textContent = CAL_ANCHOR.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } else if (CAL_VIEW === "week") {
    const s = _calWeekStart(CAL_ANCHOR),
      e = new Date(s);
    e.setDate(s.getDate() + 6);
    const sameM = s.getMonth() === e.getMonth();
    lbl.textContent = `${s.getDate()} ${sameM ? "" : s.toLocaleDateString("en-GB", { month: "short" }) + " "}– ${e.getDate()} ${e.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`;
  } else {
    lbl.textContent = CAL_ANCHOR.toLocaleDateString("en-GB", {
      month: "long",
      year: "numeric",
    });
  }
}

// ── Week / Day timeline ───────────────────────────────────────
function _calChip(i) {
  const click =
    i.kind === "event"
      ? ` data-onclick="calEditEvent" data-onclick-arg0="${esc(i.id)}"`
      : "";
  return `<div class="cal-chip" style="background:${_calPillBg(i.color)};color:${i.color}"${click} title="${esc(i.title)}">${esc(i.title)}</div>`;
}
function _calBlockHTML(i) {
  const top = ((i.startMin - CAL_HOUR_START * 60) / 60) * CAL_HOUR_PX;
  const h = Math.max(22, ((i.endMin - i.startMin) / 60) * CAL_HOUR_PX - 3);
  const lanes = i.lanes || 1,
    lane = i.lane || 0,
    w = 100 / lanes;
  const click = i.kind === "event" ? ` data-onclick="calEditEvent" data-onclick-arg0="${esc(i.id)}"` : "";
  return `<div class="cw-event" style="top:${Math.max(0, top)}px;height:${h}px;left:calc(${lane * w}% + 2px);width:calc(${w}% - 5px);background:${_calPillBg(i.color)};border-left:3px solid ${i.color}"${click} title="${esc(i.title)}">
      <div class="cw-ev-title" style="color:${i.color}">${esc(i.title)}</div>
      <div class="cw-ev-time">${_calFmtMin(i.startMin)} – ${_calFmtMin(i.endMin)}</div>
    </div>`;
}
function _calTimelineHTML(days) {
  const todayYMD = _calYMD(new Date());
  const nHours = CAL_HOUR_END - CAL_HOUR_START + 1;
  const gridH = nHours * CAL_HOUR_PX;

  const heads = days
    .map((d) => {
      const ymd = _calYMD(d),
        isToday = ymd === todayYMD;
      const allDay = _calItemsOn(ymd).filter((i) => i.allDay);
      const chips =
        allDay.slice(0, 2).map(_calChip).join("") +
        (allDay.length > 2
          ? `<div class="cal-allday-more">+${allDay.length - 2} more</div>`
          : "");
      return `<div class="cw-dayhead${isToday ? " today" : ""}">
        <div class="cw-dayname">${d.toLocaleDateString("en-GB", { weekday: "short" })}</div>
        <div class="cw-daynum">${d.getDate()}</div>
        <div class="cw-allday">${chips}</div>
      </div>`;
    })
    .join("");

  let gutter = "";
  for (let h = CAL_HOUR_START; h <= CAL_HOUR_END; h++)
    gutter += `<div class="cw-hour" style="height:${CAL_HOUR_PX}px"><span>${_calFmtMin(h * 60)}</span></div>`;

  const cols = days
    .map((d) => {
      const ymd = _calYMD(d);
      const blocks = _calLayoutDay(_calItemsOn(ymd).filter((i) => !i.allDay))
        .map(_calBlockHTML)
        .join("");
      return `<div class="cw-col${ymd === todayYMD ? " today" : ""}" style="height:${gridH}px;background-size:100% ${CAL_HOUR_PX}px">${blocks || '<div class="cw-col-empty"></div>'}</div>`;
    })
    .join("");

  return `
    <div class="cal-tl" style="--cols:${days.length}">
      <div class="cw-headrow">
        <div class="cw-corner"></div>
        ${heads}
      </div>
      <div class="cw-scroll" id="cal-tl-scroll">
        <div class="cw-grid">
          <div class="cw-gutter">${gutter}</div>
          ${cols}
        </div>
      </div>
    </div>`;
}

// ── Month grid ────────────────────────────────────────────────
function _calMonthHTML() {
  const y = CAL_ANCHOR.getFullYear(),
    m = CAL_ANCHOR.getMonth();
  const first = new Date(y, m, 1).getDay();
  const dim = new Date(y, m + 1, 0).getDate();
  const todayYMD = _calYMD(new Date());
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .map((d) => `<div class="cal-dh">${d}</div>`)
    .join("");
  let cells = "";
  for (let i = 0; i < first; i++) {
    const pd = new Date(y, m, -first + i + 1).getDate();
    cells += `<div class="cal-cell other-month"><div class="cal-num">${pd}</div></div>`;
  }
  for (let d = 1; d <= dim; d++) {
    const ymd = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const items = _calItemsOn(ymd);
    const pills = items
      .slice(0, 3)
      .map((it) => {
        const click =
          it.kind === "event"
            ? ` data-onclick="calEditEvent" data-onclick-arg0="${esc(it.id)}"`
            : "";
        return `<div class="cal-pill" style="background:${_calPillBg(it.color)};color:${it.color}"${click} title="${esc(it.title)}">${esc(it.title)}</div>`;
      })
      .join("");
    const more =
      items.length > 3
        ? `<div class="cal-more">+${items.length - 3} more</div>`
        : "";
    cells += `<div class="cal-cell${ymd === todayYMD ? " today" : ""}" data-onclick="calPickDay" data-onclick-arg0="${ymd}"><div class="cal-num">${d}</div>${pills}${more}</div>`;
  }
  return `<div class="cal-month-view"><div class="cal-dow-row">${dow}</div><div class="cal-grid">${cells}</div></div>`;
}
function calPickDay(ymd) {
  CAL_ANCHOR = _calFromYMD(ymd);
  CAL_VIEW = "day";
  calRender();
}

// ── Left rail: mini calendar, next-up, filters ────────────────
function _calRenderRail() {
  // Each section is isolated: a bad-data throw in one (e.g. the mini
  // calendar/reminder, which both read normalized events+tasks) must not
  // blank sections that don't share that data path (e.g. Filters).
  try {
    _calRenderMini();
  } catch (err) {
    console.error("Calendar mini-month render failed:", err);
  }
  try {
    _calRenderReminder();
  } catch (err) {
    console.error("Calendar reminder render failed:", err);
  }
  try {
    _calRenderFilters();
  } catch (err) {
    console.error("Calendar filters render failed:", err);
  }
}

function _calRenderMini() {
  const grid = $("cal-mini-grid"),
    lbl = $("cal-mini-label");
  if (!grid) return;
  if (lbl)
    lbl.textContent = new Date(CAL_MINI_Y, CAL_MINI_M, 1).toLocaleDateString(
      "en-GB",
      { month: "long", year: "numeric" },
    );
  const first = new Date(CAL_MINI_Y, CAL_MINI_M, 1).getDay();
  const dim = new Date(CAL_MINI_Y, CAL_MINI_M + 1, 0).getDate();
  const todayYMD = _calYMD(new Date()),
    anchorYMD = _calYMD(CAL_ANCHOR);
  const evDates = new Set(_calNormalize().map((i) => i.date));
  let html = ["S", "M", "T", "W", "T", "F", "S"]
    .map((d) => `<div class="cm-dh">${d}</div>`)
    .join("");
  for (let i = 0; i < first; i++) html += `<div></div>`;
  for (let d = 1; d <= dim; d++) {
    const ymd = `${CAL_MINI_Y}-${String(CAL_MINI_M + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cls = ["cm-day"];
    if (ymd === todayYMD) cls.push("today");
    if (ymd === anchorYMD) cls.push("sel");
    if (evDates.has(ymd)) cls.push("has");
    html += `<button class="${cls.join(" ")}" data-onclick="calPickMini" data-onclick-arg0="${ymd}">${d}</button>`;
  }
  grid.innerHTML = html;
}
function calMiniNav(dir) {
  CAL_MINI_M += dir;
  if (CAL_MINI_M > 11) {
    CAL_MINI_M = 0;
    CAL_MINI_Y++;
  }
  if (CAL_MINI_M < 0) {
    CAL_MINI_M = 11;
    CAL_MINI_Y--;
  }
  _calRenderMini();
}
function calPickMini(ymd) {
  CAL_ANCHOR = _calFromYMD(ymd);
  if (CAL_VIEW === "month") CAL_VIEW = "day";
  calRender();
}

function _calRenderReminder() {
  const el = $("cal-reminder");
  if (!el) return;
  const nowYMD = _calYMD(new Date());
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const next = _calNormalize()
    .filter(
      (i) =>
        i.date > nowYMD ||
        (i.date === nowYMD &&
          (i.allDay || (i.endMin ?? i.startMin ?? 0) >= nowMin)),
    )
    .sort((a, b) =>
      a.date < b.date
        ? -1
        : a.date > b.date
          ? 1
          : (a.startMin ?? -1) - (b.startMin ?? -1),
    )[0];
  if (!next) {
    el.innerHTML = `<div class="cal-rem-empty"><i class="ti ti-calendar-event" aria-hidden="true"></i> No upcoming events</div>`;
    return;
  }
  const d = _calFromYMD(next.date);
  const when =
    `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}` +
    (next.allDay ? " · All day" : ` · ${_calFmtMin(next.startMin)}`);
  el.innerHTML = `
    <div class="cal-rem-label"><i class="ti ti-bell" aria-hidden="true"></i> Next up</div>
    <div class="cal-rem-title">${esc(next.title)}</div>
    <div class="cal-rem-when">${when}</div>
    <button class="cal-rem-btn" data-onclick="calPickMini" data-onclick-arg0="${next.date}">View <i class="ti ti-arrow-right" aria-hidden="true"></i></button>`;
}

function _calRenderFilters() {
  const el = $("cal-filter-list");
  if (!el) return;
  const f = _calGetFilters();
  el.innerHTML = CAL_CATS.map(
    (c) => `
    <label class="cal-filter${f.has(c.id) ? " on" : ""}" data-onclick="calToggleFilter" data-onclick-arg0="${c.id}">
      <span class="cal-filter-box" style="--c:${c.color}">${f.has(c.id) ? '<i class="ti ti-check" aria-hidden="true"></i>' : ""}</span>
      <span class="cal-filter-dot" style="background:${c.color}"></span>
      <span class="cal-filter-label">${c.label}</span>
    </label>`,
  ).join("");
}

async function calAddEvent() {
  const today = _calYMD(CAL_ANCHOR || new Date());
  const d = await siModal.form(
    "Add Event",
    [
      {
        id: "title",
        label: "Event title",
        placeholder: "e.g. Team standup",
        required: true,
      },
      {
        id: "date",
        label: "Date",
        type: "date",
        default: today,
        required: true,
      },
      {
        id: "time",
        label: "Start time (leave blank for all-day)",
        type: "time",
      },
      { id: "end", label: "End time", type: "time" },
      {
        id: "category",
        label: "Category",
        type: "select",
        default: "meeting",
        options: CAL_CATS.map((c) => ({ value: c.id, label: c.label })),
      },
    ],
    { confirmLabel: "Add Event" },
  );
  if (!d || !d.title) return;
  const cat = CAL_CAT_MAP[d.category] ? d.category : "meeting";
  const ev = {
    id: Date.now().toString(),
    date: d.date || today,
    title: d.title,
    time: d.time || "",
    end: d.end || "",
    category: cat,
    color: CAL_CAT_MAP[cat].color,
  };
  const evs = _calRawEvents();
  evs.push(ev);
  localStorage.setItem(CAL_EVENTS_KEY(), JSON.stringify(evs));
  CAL_ANCHOR = _calFromYMD(ev.date);
  CAL_MINI_Y = CAL_ANCHOR.getFullYear();
  CAL_MINI_M = CAL_ANCHOR.getMonth();
  calRender();
  toast("Event added ✓");
}

function calDeleteEvent(id) {
  const evs = JSON.parse(localStorage.getItem(CAL_EVENTS_KEY()) || "[]").filter(
    (e) => e.id !== id,
  );
  localStorage.setItem(CAL_EVENTS_KEY(), JSON.stringify(evs));
  calRender();
  toast("Event removed");
}

async function calEditEvent(id) {
  const evs = _calRawEvents();
  const ev = evs.find((e) => e.id === id);
  if (!ev) return;
  const curCat = _calCatOf(ev);
  document.getElementById("cal-edit-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "cal-edit-modal";
  modal.style.cssText =
    "position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center";
  const inS =
    "width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text1);font-family:var(--font);margin-bottom:12px;box-sizing:border-box";
  const lbS =
    "font-size:.8rem;color:var(--muted);display:block;margin-bottom:4px";
  const catOpts = CAL_CATS.map(
    (c) =>
      `<option value="${c.id}"${c.id === curCat ? " selected" : ""}>${c.label}</option>`,
  ).join("");
  modal.innerHTML = `
    <div style="background:var(--bg);border-radius:14px;padding:22px;width:min(380px,95vw);position:relative">
      <button data-onclick="_removeElById" data-onclick-arg0="cal-edit-modal" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--muted);font-size:1.2rem;cursor:pointer">×</button>
      <div style="font-weight:700;margin-bottom:16px">Edit Event</div>
      <label style="${lbS}">Title</label>
      <input id="cal-edit-title" value="${esc(ev.title)}" style="${inS}">
      <label style="${lbS}">Date</label>
      <input id="cal-edit-date" type="date" value="${esc(ev.date)}" style="${inS}">
      <div style="display:flex;gap:10px">
        <div style="flex:1"><label style="${lbS}">Start</label><input id="cal-edit-time" type="time" value="${esc(ev.time || "")}" style="${inS}"></div>
        <div style="flex:1"><label style="${lbS}">End</label><input id="cal-edit-end" type="time" value="${esc(ev.end || "")}" style="${inS}"></div>
      </div>
      <label style="${lbS}">Category</label>
      <select id="cal-edit-cat" style="${inS}">${catOpts}</select>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:4px">
        <button data-onclick="calDeleteEventFromEdit" data-onclick-arg0="${id}" style="background:var(--red,#ef4444);color:#fff;border:none;border-radius:8px;padding:9px 14px;cursor:pointer;font-family:var(--font);font-size:.85rem">Delete</button>
        <button data-onclick="calSaveEditEvent" data-onclick-arg0="${id}" style="background:var(--teal);color:#fff;border:none;border-radius:8px;padding:9px 18px;cursor:pointer;font-family:var(--font);font-size:.85rem;font-weight:600">Save</button>
      </div>
    </div>`;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

function calSaveEditEvent(id) {
  const evs = _calRawEvents();
  const idx = evs.findIndex((e) => e.id === id);
  if (idx < 0) return;
  const title = $("cal-edit-title")?.value.trim();
  const date = $("cal-edit-date")?.value;
  const time = $("cal-edit-time")?.value.trim();
  const end = $("cal-edit-end")?.value.trim();
  const cat = CAL_CAT_MAP[$("cal-edit-cat")?.value]
    ? $("cal-edit-cat").value
    : _calCatOf(evs[idx]);
  if (!title || !date) {
    toast("Title and date are required.");
    return;
  }
  evs[idx] = {
    ...evs[idx],
    title,
    date,
    time,
    end,
    category: cat,
    color: CAL_CAT_MAP[cat].color,
  };
  localStorage.setItem(CAL_EVENTS_KEY(), JSON.stringify(evs));
  document.getElementById("cal-edit-modal")?.remove();
  CAL_ANCHOR = _calFromYMD(date);
  CAL_MINI_Y = CAL_ANCHOR.getFullYear();
  CAL_MINI_M = CAL_ANCHOR.getMonth();
  calRender();
  toast("Event updated ✓");
}

function calDeleteEventFromEdit(id) {
  document.getElementById("cal-edit-modal")?.remove();
  calDeleteEvent(id);
}


// ════════════ SKILLS ════════════
const SK_KEY = () => `sivarr_skills_${S.sid || "guest"}`;

const SK_CATS = [
  "Technical",
  "Language",
  "Creative",
  "Business",
  "Physical",
  "Academic",
  "Other",
];
const SK_EMOJIS = [
  "💻",
  "🎨",
  "🌍",
  "📐",
  "🎸",
  "⚽",
  "📊",
  "🔬",
  "🖊️",
  "🎤",
  "📷",
  "🧠",
  "🏋️",
  "🍳",
  "🎭",
];
const SK_LEVELS = [
  { max: 20, label: "Beginner", color: "#6b7280" },
  { max: 40, label: "Learning", color: "#3b82f6" },
  { max: 60, label: "Developing", color: "#f59e0b" },
  { max: 80, label: "Proficient", color: "#10b981" },
  { max: 100, label: "Expert", color: "#8b5cf6" },
];

function _skData() {
  try {
    return JSON.parse(localStorage.getItem(SK_KEY()) || '{"skills":[]}');
  } catch {
    return { skills: [] };
  }
}
function _skSave(data) {
  localStorage.setItem(SK_KEY(), JSON.stringify(data));
  const token = getToken();
  if (token && navigator.onLine)
    fetch("/api/skills/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, skills: data.skills }),
    }).catch(() => {});
}
function _skLevel(v) {
  return SK_LEVELS.find((l) => v <= l.max) || SK_LEVELS[SK_LEVELS.length - 1];
}

let _skFilter = "all";

function skillsInit() {
  _skFilter = "all";
  skillsRender();
}

function skillsRender() {
  const el = $("sk-list");
  if (!el) return;
  const data = _skData();
  const skills = data.skills || [];

  const totalHrs = skills.reduce(
    (s, k) => s + Math.round((k.total_mins || 0) / 60),
    0,
  );
  const sessions = skills.reduce((s, k) => s + (k.sessions || 0), 0);

  const cats = [
    "all",
    ...new Set(skills.map((s) => s.category).filter(Boolean)),
  ];
  const filterBtns = cats
    .map(
      (c) =>
        `<button class="sk-filter-btn${_skFilter === c ? " active" : ""}" data-onclick="skSetFilter" data-onclick-arg0="${esc(c)}">${c === "all" ? `All (${skills.length})` : c}</button>`,
    )
    .join("");

  const shown =
    _skFilter === "all"
      ? skills
      : skills.filter((s) => s.category === _skFilter);

  const cards = shown.length
    ? shown
        .map((k, i) => {
          const lv = _skLevel(k.level || 0);
          const tLv = _skLevel(k.target || 100);
          const hrs = Math.round((k.total_mins || 0) / 60);
          const lastP = k.last_practiced
            ? new Date(k.last_practiced).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
              })
            : "Never";
          const tgtPct = Math.min(k.target || 100, 100);
          return `
    <div class="sk-card">
      <div class="sk-card-head">
        <div class="sk-emoji">${k.emoji || "💡"}</div>
        <div class="sk-info">
          <div class="sk-name">${esc(k.name)}</div>
          <div class="sk-meta">
            <span class="sk-cat-badge">${esc(k.category || "Other")}</span>
            <span class="sk-level-label">${lv.label}</span>
          </div>
        </div>
        <div class="sk-card-actions">
          <button class="sk-action-btn" data-onclick="skillLog" data-onclick-arg0="${esc(k.id)}"><i class="ti ti-plus"></i> Log</button>
          <button class="sk-action-btn siva" data-onclick="skillAskSiva" data-onclick-arg0="${esc(k.id)}"><i class="ti ti-sparkles"></i> SIVA</button>
          <button class="sk-action-btn" data-onclick="skillEdit" data-onclick-arg0="${esc(k.id)}"><i class="ti ti-pencil"></i></button>
          <button class="sk-action-btn danger" data-onclick="skillDelete" data-onclick-arg0="${esc(k.id)}"><i class="ti ti-trash"></i></button>
        </div>
      </div>
      <div class="sk-progress-wrap">
        <div class="sk-progress-head">
          <span style="font-size:.72rem;color:var(--text3)">Progress</span>
          <span class="sk-progress-nums">${k.level || 0}% → target ${tgtPct}%</span>
        </div>
        <div class="sk-progress-bar">
          <div class="sk-progress-fill" style="width:${k.level || 0}%;background:${lv.color}"></div>
          <div class="sk-progress-target" style="left:${tgtPct}%"></div>
        </div>
      </div>
      <div class="sk-sessions">
        <span class="sk-session-stat"><strong>${k.sessions || 0}</strong> sessions</span>
        <span class="sk-session-stat"><strong>${hrs}h</strong> practiced</span>
        <span class="sk-session-stat">Last: <strong>${lastP}</strong></span>
      </div>
    </div>`;
        })
        .join("")
    : `<div class="sk-empty">
    <div class="sk-empty-icon">🧠</div>
    <div class="sk-empty-title">${_skFilter === "all" ? "No skills yet" : `No ${_skFilter} skills`}</div>
    <div class="sk-empty-sub">${_skFilter === "all" ? "Track what you're learning. Click <strong>+ Add Skill</strong> to start." : "Try another category filter."}</div>
  </div>`;

  el.innerHTML = `
    <div class="sk-summary-grid">
      <div class="sk-stat"><div class="sk-stat-val" style="color:var(--accent)">${skills.length}</div><div class="sk-stat-lbl">Skills</div></div>
      <div class="sk-stat"><div class="sk-stat-val" style="color:var(--teal)">${totalHrs}h</div><div class="sk-stat-lbl">Practiced</div></div>
      <div class="sk-stat"><div class="sk-stat-val" style="color:var(--accent2)">${sessions}</div><div class="sk-stat-lbl">Sessions</div></div>
    </div>
    ${skills.length > 1 ? `<div class="sk-filter-row">${filterBtns}</div>` : ""}
    ${cards}`;
}

function skSetFilter(f) {
  _skFilter = f;
  skillsRender();
}

async function skillAdd() {
  const emojiOpts = SK_EMOJIS.map((e) => ({ value: e, label: e }));
  const catOpts = SK_CATS.map((c) => ({ value: c, label: c }));
  const d = await siModal.form(
    "+ New Skill",
    [
      {
        id: "name",
        label: "Skill name",
        placeholder: "e.g. Python, Spanish, Guitar",
        required: true,
      },
      {
        id: "emoji",
        label: "Icon",
        type: "emoji",
        options: emojiOpts,
        default: "💡",
      },
      {
        id: "category",
        label: "Category",
        type: "select",
        options: catOpts,
        default: "Technical",
      },
      {
        id: "level",
        label: "Current level (0–100)",
        type: "text",
        placeholder: "e.g. 30",
        default: "0",
      },
      {
        id: "target",
        label: "Target level (0–100)",
        type: "text",
        placeholder: "e.g. 80",
        default: "80",
      },
    ],
    { confirmLabel: "Add Skill" },
  );
  if (!d || !d.name) return;
  const data = _skData();
  data.skills.push({
    id: Date.now().toString(36),
    name: d.name.trim(),
    emoji: d.emoji || "💡",
    category: d.category || "Other",
    level: Math.min(100, Math.max(0, parseInt(d.level) || 0)),
    target: Math.min(100, Math.max(0, parseInt(d.target) || 80)),
    sessions: 0,
    total_mins: 0,
    created: new Date().toISOString().slice(0, 10),
    last_practiced: null,
  });
  _skSave(data);
  skillsRender();
  toast("Skill added ✓");
}

async function skillLog(id) {
  const d = await siModal.form(
    "Log Practice Session",
    [
      {
        id: "mins",
        label: "Duration (minutes)",
        type: "text",
        placeholder: "e.g. 30",
        required: true,
        default: "30",
      },
      {
        id: "note",
        label: "What did you work on? (optional)",
        placeholder: "e.g. Completed chapter 3",
      },
      {
        id: "gain",
        label: "Progress gained (+%)",
        type: "text",
        placeholder: "e.g. 5",
        default: "0",
      },
    ],
    { confirmLabel: "Log Session" },
  );
  if (!d) return;
  const mins = Math.max(1, parseInt(d.mins) || 30);
  const gain = Math.min(50, Math.max(0, parseInt(d.gain) || 0));
  const data = _skData();
  const sk = data.skills.find((s) => s.id === id);
  if (!sk) return;
  sk.sessions = (sk.sessions || 0) + 1;
  sk.total_mins = (sk.total_mins || 0) + mins;
  sk.level = Math.min(100, (sk.level || 0) + gain);
  sk.last_practiced = new Date().toISOString().slice(0, 10);
  _skSave(data);
  skillsRender();
  toast(`Session logged: ${mins} min ✓`);
}

async function skillEdit(id) {
  const data = _skData();
  const sk = data.skills.find((s) => s.id === id);
  if (!sk) return;
  const emojiOpts = SK_EMOJIS.map((e) => ({ value: e, label: e }));
  const catOpts = SK_CATS.map((c) => ({ value: c, label: c }));
  const d = await siModal.form(
    "Edit Skill",
    [
      {
        id: "name",
        label: "Skill name",
        placeholder: "e.g. Python",
        required: true,
        default: sk.name,
      },
      {
        id: "emoji",
        label: "Icon",
        type: "emoji",
        options: emojiOpts,
        default: sk.emoji || "💡",
      },
      {
        id: "category",
        label: "Category",
        type: "select",
        options: catOpts,
        default: sk.category,
      },
      {
        id: "level",
        label: "Current level (0–100)",
        type: "text",
        default: String(sk.level || 0),
      },
      {
        id: "target",
        label: "Target level (0–100)",
        type: "text",
        default: String(sk.target || 80),
      },
    ],
    { confirmLabel: "Save" },
  );
  if (!d || !d.name) return;
  sk.name = d.name.trim();
  sk.emoji = d.emoji || sk.emoji;
  sk.category = d.category || sk.category;
  sk.level = Math.min(100, Math.max(0, parseInt(d.level) || 0));
  sk.target = Math.min(100, Math.max(0, parseInt(d.target) || 80));
  _skSave(data);
  skillsRender();
  toast("Skill updated ✓");
}

async function skillDelete(id) {
  const data = _skData();
  const sk = data.skills.find((s) => s.id === id);
  if (!sk) return;
  if (
    !(await siModal.confirm(`Delete "${sk.name}"? All progress will be lost.`, {
      title: "Delete Skill",
      confirmLabel: "Delete",
      danger: true,
    }))
  )
    return;
  data.skills = data.skills.filter((s) => s.id !== id);
  _skSave(data);
  skillsRender();
  toast("Skill deleted");
}

function skillAskSiva(id) {
  const data = _skData();
  const sk = data.skills.find((s) => s.id === id);
  if (!sk) return;
  const lv = _skLevel(sk.level || 0);
  const prompt = `I'm learning ${sk.name} (${sk.category}). I'm currently at ${sk.level || 0}% proficiency (${lv.label} level) and want to reach ${sk.target || 80}%. I've done ${sk.sessions || 0} practice sessions totalling ${Math.round((sk.total_mins || 0) / 60)} hours. Give me a focused study plan and the 3 most important things I should work on next to level up fast.`;
  nav("chat", null);
  setTimeout(() => {
    const ci = $("ci");
    if (!ci) return;
    ci.value = prompt;
    ci.style.height = "auto";
    ci.style.height = Math.min(ci.scrollHeight, 120) + "px";
    ci.focus();
  }, 300);
}

// ════════════ FINANCE ════════════
const FIN_KEY = () => `sivarr_finance_${S.sid || "guest"}`;

const FIN_CATS = {
  expense: [
    { id: "food", label: "Food & Dining", icon: "🍔", color: "#f59e0b" },
    { id: "transport", label: "Transport", icon: "🚗", color: "#3b82f6" },
    { id: "housing", label: "Housing / Rent", icon: "🏠", color: "#8b5cf6" },
    { id: "utilities", label: "Utilities", icon: "⚡", color: "#06b6d4" },
    { id: "health", label: "Health", icon: "💊", color: "#10b981" },
    { id: "education", label: "Education", icon: "📚", color: "#6366f1" },
    {
      id: "entertainment",
      label: "Entertainment",
      icon: "🎬",
      color: "#ec4899",
    },
    { id: "shopping", label: "Shopping", icon: "🛍️", color: "#f97316" },
    { id: "data", label: "Data / Airtime", icon: "📱", color: "#14b8a6" },
    { id: "other", label: "Other", icon: "💸", color: "#6b7280" },
  ],
  income: [
    { id: "salary", label: "Salary", icon: "💼", color: "#10b981" },
    { id: "freelance", label: "Freelance", icon: "💻", color: "#3b82f6" },
    { id: "business", label: "Business", icon: "🏪", color: "#8b5cf6" },
    { id: "investment", label: "Investment", icon: "📈", color: "#f59e0b" },
    { id: "gift", label: "Gift / Transfer", icon: "🎁", color: "#ec4899" },
    { id: "other", label: "Other Income", icon: "➕", color: "#6b7280" },
  ],
};

function _finData() {
  try {
    return JSON.parse(
      localStorage.getItem(FIN_KEY()) || '{"transactions":[],"budgets":{}}',
    );
  } catch {
    return { transactions: [], budgets: {} };
  }
}
function _finSave(data) {
  localStorage.setItem(FIN_KEY(), JSON.stringify(data));
  _finSyncServer(data);
}
function _finSyncServer(data) {
  const token = getToken();
  if (!token || !navigator.onLine) return;
  fetch("/api/finance/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, data }),
  }).catch(() => {});
}
function _finCat(type, id) {
  return (
    FIN_CATS[type]?.find((c) => c.id === id) || {
      label: id,
      icon: "💸",
      color: "#6b7280",
    }
  );
}
function _finFmt(n) {
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `₦${(n / 1_000).toFixed(0)}K`;
  return `₦${Math.round(n).toLocaleString()}`;
}

let _finActiveTab = "overview";

function finInit() {
  _finActiveTab = "overview";
  ["overview", "transactions", "budget"].forEach((t) => {
    const v = $(`fin-view-${t}`);
    if (v) v.style.display = t === "overview" ? "" : "none";
    const b = $(`fin-tab-${t}`);
    if (b) b.classList.toggle("active", t === "overview");
  });
  // Show Mono sync button when bank is connected
  const mb = $("fin-mono-btn");
  if (mb) mb.style.display = _MONO_CONNECTED ? "" : "none";
  finRenderOverview();
}

function _finGuessCategory(narration, type) {
  const n = (narration || "").toLowerCase();
  if (type === "credit") {
    if (/salary|payroll|wage/i.test(n)) return "salary";
    if (/freelance|contract|invoice/i.test(n)) return "freelance";
    if (/business|sales|revenue/i.test(n)) return "business";
    return "other";
  }
  if (/airtime|data|mtn|airtel|glo|9mobile/i.test(n)) return "data";
  if (/fuel|petrol|diesel|gas station/i.test(n)) return "transport";
  if (/uber|bolt|taxi|ride|transport|bus/i.test(n)) return "transport";
  if (/food|eat|chicken|shoprite|spar|kfc|domino/i.test(n)) return "food";
  if (/electricity|nepa|ekedc|ibedc|eedc|phcn/i.test(n)) return "utilities";
  if (/water|waste|sanitation/i.test(n)) return "utilities";
  if (/rent|landlord|housing/i.test(n)) return "housing";
  if (/hospital|pharmacy|clinic|health|medical/i.test(n)) return "health";
  if (/school|tuition|fees|university|college/i.test(n)) return "education";
  if (/netflix|spotify|dstv|cinema|movie|game/i.test(n)) return "entertainment";
  return "other";
}

async function finSyncMono() {
  if (!_MONO_CONNECTED || !_MONO_ACCOUNT) {
    toast("Connect your bank first in Integrations.");
    return;
  }
  const txns = _MONO_ACCOUNT?.transactions || [];
  if (!txns.length) {
    toast("No transactions found from Mono.");
    return;
  }

  const data = _finData();
  const existing = new Set((data.transactions || []).map((t) => t.id));
  let added = 0;

  txns.forEach((t) => {
    const id = `mono_${(t.date || "").slice(0, 10)}_${t.amount}_${(t.narration || "").slice(0, 8).replace(/\s/g, "")}`;
    if (existing.has(id)) return;
    const type = t.type === "credit" ? "income" : "expense";
    const amount = (t.amount || 0) / 100; // kobo → naira
    if (amount <= 0) return;
    data.transactions.push({
      id,
      type,
      amount,
      category: _finGuessCategory(t.narration || t.description, type),
      note: (t.narration || t.description || "").slice(0, 100),
      date: (t.date || new Date().toISOString()).slice(0, 10),
    });
    added++;
  });

  if (!added) {
    toast("All Mono transactions already imported.");
    return;
  }
  _finSave(data);
  if (_finActiveTab === "overview") finRenderOverview();
  if (_finActiveTab === "transactions") finRenderTransactions();
  toast(`${added} transaction${added > 1 ? "s" : ""} imported from Mono ✓`);
}

function finTab(tab, btn) {
  _finActiveTab = tab;
  ["overview", "transactions", "budget"].forEach((t) => {
    const v = $(`fin-view-${t}`);
    if (v) v.style.display = t === tab ? "" : "none";
    const b = $(`fin-tab-${t}`);
    if (b) b.classList.toggle("active", t === tab);
  });
  if (tab === "overview") finRenderOverview();
  if (tab === "transactions") finRenderTransactions();
  if (tab === "budget") finRenderBudget();
}

function finRenderOverview() {
  const el = $("fin-view-overview");
  if (!el) return;
  const data = _finData();
  const txs = data.transactions || [];
  const month = new Date().toISOString().slice(0, 7);
  const mTxs = txs.filter((t) => t.date.startsWith(month));
  const inc = mTxs
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amount, 0);
  const exp = mTxs
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amount, 0);
  const bal = inc - exp;
  const savRate = inc > 0 ? Math.round((bal / inc) * 100) : 0;

  const catTotals = {};
  mTxs
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      catTotals[t.category] = (catTotals[t.category] || 0) + t.amount;
    });
  const maxCat = Math.max(...Object.values(catTotals), 1);
  const catBars = Object.entries(catTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, amt]) => {
      const cat = _finCat("expense", id);
      return `<div class="fin-bar-row">
      <div class="fin-bar-cat">${cat.icon} ${cat.label}</div>
      <div class="fin-bar-track"><div class="fin-bar-fill" style="width:${Math.round((amt / maxCat) * 100)}%;background:${cat.color}"></div></div>
      <div class="fin-bar-pct">${_finFmt(amt)}</div>
    </div>`;
    })
    .join("");

  const recent = [...txs]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);
  const monthName = new Date().toLocaleString("default", { month: "long" });

  el.innerHTML = `
    <div class="fin-bal-card">
      <div class="fin-bal-label">Net Balance · ${monthName}</div>
      <div class="fin-bal-amount">${_finFmt(Math.abs(bal))}</div>
      <div class="fin-bal-sub">${bal >= 0 ? "↑ Surplus" : "↓ Deficit"} · ${savRate}% savings rate</div>
    </div>
    <div class="fin-summary-grid">
      <div class="fin-stat"><div class="fin-stat-val" style="color:var(--teal)">${_finFmt(inc)}</div><div class="fin-stat-lbl">Income</div></div>
      <div class="fin-stat"><div class="fin-stat-val" style="color:#f87171">${_finFmt(exp)}</div><div class="fin-stat-lbl">Expenses</div></div>
      <div class="fin-stat"><div class="fin-stat-val" style="color:var(--accent2)">${txs.length}</div><div class="fin-stat-lbl">All time</div></div>
    </div>
    ${catBars ? `<div class="fin-card"><div class="fin-card-title"><i class="ti ti-chart-bar"></i> Top spending this month</div><div class="fin-bar-chart">${catBars}</div></div>` : ""}
    <div class="fin-card">
      <div class="fin-card-title"><i class="ti ti-list"></i> Recent transactions</div>
      ${
        recent.length
          ? `<div class="fin-tx-list">${recent.map((t) => _finTxHtml(t)).join("")}</div>`
          : `<div class="fin-empty">No transactions yet. Add your first one above.</div>`
      }
    </div>`;
}

function finRenderTransactions() {
  const el = $("fin-view-transactions");
  if (!el) return;
  const data = _finData();
  const allTxs = [...(data.transactions || [])].sort(
    (a, b) => new Date(b.date) - new Date(a.date),
  );
  const filter = el._filter || "all";
  const shown =
    filter === "all" ? allTxs : allTxs.filter((t) => t.type === filter);

  el.innerHTML = `
    <div class="fin-tabs" style="margin-bottom:10px">
      <button class="fin-tab ${filter === "all" ? "active" : ""}"     data-onclick="finTxFilter" data-onclick-arg0="all">All (${allTxs.length})</button>
      <button class="fin-tab ${filter === "income" ? "active" : ""}"  data-onclick="finTxFilter" data-onclick-arg0="income">Income</button>
      <button class="fin-tab ${filter === "expense" ? "active" : ""}" data-onclick="finTxFilter" data-onclick-arg0="expense">Expenses</button>
    </div>
    <div class="fin-card">
      ${
        shown.length
          ? `<div class="fin-tx-list">${shown.map((t) => _finTxHtml(t)).join("")}</div>`
          : `<div class="fin-empty">No transactions here yet.</div>`
      }
    </div>`;
}

function finTxFilter(f) {
  const el = $("fin-view-transactions");
  if (!el) return;
  el._filter = f;
  finRenderTransactions();
}

function _finTxHtml(t) {
  const cat = _finCat(t.type, t.category);
  const d = new Date(t.date).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
  return `<div class="fin-tx">
    <div class="fin-tx-icon ${t.type}" style="background:${cat.color}18">${cat.icon}</div>
    <div class="fin-tx-info">
      <div class="fin-tx-note">${esc(t.note || cat.label)}</div>
      <div class="fin-tx-meta">${cat.label} · ${d}</div>
    </div>
    <div class="fin-tx-amt ${t.type}">${t.type === "income" ? "+" : "-"}${_finFmt(t.amount)}</div>
    <button class="fin-tx-del" data-onclick="finDeleteTx" data-onclick-arg0="${esc(t.id)}" title="Delete"><i class="ti ti-x"></i></button>
  </div>`;
}

function finRenderBudget() {
  const el = $("fin-view-budget");
  if (!el) return;
  const data = _finData();
  const budgets = data.budgets || {};
  const month = new Date().toISOString().slice(0, 7);
  const mExp = (data.transactions || []).filter(
    (t) => t.type === "expense" && t.date.startsWith(month),
  );

  const rows = FIN_CATS.expense
    .map((cat) => {
      const spent = mExp
        .filter((t) => t.category === cat.id)
        .reduce((s, t) => s + t.amount, 0);
      const budget = budgets[cat.id] || 0;
      const pct =
        budget > 0 ? Math.min(Math.round((spent / budget) * 100), 100) : 0;
      const over = budget > 0 && spent > budget;
      return `<div class="fin-budget-item">
      <div class="fin-budget-head">
        <div class="fin-budget-label">${cat.icon} ${cat.label}</div>
        <div class="fin-budget-nums">${_finFmt(spent)}${budget > 0 ? ` / ${_finFmt(budget)}` : " (no limit)"}</div>
      </div>
      ${budget > 0 ? `<div class="fin-budget-bar"><div class="fin-budget-fill" style="width:${pct}%;background:${over ? "#f87171" : cat.color}"></div></div>` : ""}
      <div class="fin-budget-edit">
        <input class="fin-budget-input" type="number" id="fbi-${cat.id}" placeholder="Monthly limit (₦)" value="${budget || ""}" min="0">
        <button class="fin-save-budget" data-onclick="finSaveBudgetCat" data-onclick-arg0="${esc(cat.id)}">Set</button>
      </div>
    </div>`;
    })
    .join("");

  el.innerHTML = `<div class="fin-card">
    <div class="fin-card-title"><i class="ti ti-adjustments"></i> Monthly budget limits</div>
    <div class="fin-budget-row">${rows}</div>
  </div>`;
}

async function finAdd(type) {
  const cats = FIN_CATS[type].map((c) => ({
    value: c.id,
    label: `${c.icon} ${c.label}`,
  }));
  const d = await siModal.form(
    type === "income" ? "+ Add Income" : "+ Add Expense",
    [
      {
        id: "amount",
        label: "Amount (₦)",
        type: "text",
        placeholder: "e.g. 50000",
        required: true,
      },
      {
        id: "category",
        label: "Category",
        type: "select",
        options: cats,
        default: cats[0].value,
      },
      {
        id: "note",
        label: "Note (optional)",
        placeholder: "e.g. Uber to Lekki",
      },
      {
        id: "date",
        label: "Date",
        type: "text",
        placeholder: "YYYY-MM-DD",
        default: new Date().toISOString().slice(0, 10),
      },
    ],
    { confirmLabel: type === "income" ? "Add Income" : "Add Expense" },
  );
  if (!d) return;
  const amount = parseFloat(String(d.amount).replace(/,/g, ""));
  if (!amount || amount <= 0) {
    toast("Enter a valid amount.");
    return;
  }
  const data = _finData();
  data.transactions.push({
    id: Date.now().toString(36),
    type,
    amount,
    category: d.category,
    note: d.note || "",
    date: d.date || new Date().toISOString().slice(0, 10),
  });
  _finSave(data);
  if (_finActiveTab === "overview") finRenderOverview();
  if (_finActiveTab === "transactions") finRenderTransactions();
  toast(`${type === "income" ? "Income" : "Expense"} added ✓`);
}

async function finDeleteTx(id) {
  const data = _finData();
  const tx = data.transactions.find((t) => t.id === id);
  if (!tx) return;
  if (
    !(await siModal.confirm(
      `Delete this ${tx.type} of ${_finFmt(tx.amount)}?`,
      { title: "Delete Transaction", confirmLabel: "Delete", danger: true },
    ))
  )
    return;
  data.transactions = data.transactions.filter((t) => t.id !== id);
  _finSave(data);
  if (_finActiveTab === "overview") finRenderOverview();
  if (_finActiveTab === "transactions") finRenderTransactions();
  toast("Transaction deleted");
}

function finSaveBudgetCat(catId) {
  const input = $(`fbi-${catId}`);
  if (!input) return;
  const val = parseFloat(input.value);
  const data = _finData();
  if (!data.budgets) data.budgets = {};
  if (val > 0) data.budgets[catId] = val;
  else delete data.budgets[catId];
  _finSave(data);
  finRenderBudget();
  toast("Budget updated ✓");
}

// ════════════ JOURNAL ════════════
const JNL_KEY = () => `sivarr_journal_${S.sid || "guest"}`;

const JNL_PROMPTS = [
  "What's one decision you made this week you'd make differently?",
  "What's something you've been avoiding that needs your attention?",
  "Describe a moment today where you felt fully present.",
  "What would you do this week if you weren't afraid of failing?",
  "What's one thing you learned today that surprised you?",
  "Who made a positive impact on you recently, and have you told them?",
  "What does success look like for you one year from now?",
  "What habit is quietly holding you back?",
  "What are you most grateful for right now?",
  "What's one thing you want to stop doing? One thing to start?",
  "Describe your energy level today. What drained you? What filled you?",
  "What problem have you been overthinking that needs a decision, not more thought?",
  "What did you build, create, or contribute today?",
  "If today was the only evidence someone had of who you are, what would it say?",
  "What's been on your mind that you haven't written down yet?",
  "Where did you spend the most focus today? Was it worth it?",
  "What's one conversation you need to have that you've been putting off?",
  "What's working well right now that you should protect?",
  "Name one thing you're proud of this week, however small.",
  "What boundary did you hold or fail to hold today?",
  "How has your thinking on a big goal shifted recently?",
  "What would you tell yourself 3 months ago?",
  "What's one thing you want to remember about today?",
  "Where are you being too hard on yourself?",
  "What would make next week significantly better than this one?",
  "Describe your ideal version of tomorrow.",
  "What are you currently building, and why does it matter to you?",
  "What's one relationship you want to invest more in?",
  "What does your gut say about a decision you're facing?",
  "What's the most important thing you didn't do today, and why?",
];

function journalInit() {
  const lbl = $("journal-date-label");
  if (lbl)
    lbl.textContent = new Date().toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });

  // Load today's draft
  const todayKey = `jnl_draft_${new Date().toISOString().split("T")[0]}`;
  const draft = localStorage.getItem(`${JNL_KEY()}_${todayKey}`) || "";
  const ta = $("journal-text");
  if (ta) ta.value = draft;

  // Daily prompt — fetch from API for server-consistent rotation, fall back to local
  const prompt2 = document.querySelector(".journal-prompt");
  if (prompt2) {
    const now = new Date();
    const dayOfYear = Math.floor(
      (now - new Date(now.getFullYear(), 0, 0)) / 86400000,
    );
    const localPrompt = JNL_PROMPTS[dayOfYear % JNL_PROMPTS.length];
    prompt2.innerHTML = `<strong>Today's prompt:</strong> ${localPrompt}`;
    fetch("/api/journal/prompt")
      .then((r) => r.json())
      .then((d) => {
        if (d.prompt)
          prompt2.innerHTML = `<strong>Today's prompt:</strong> ${d.prompt}`;
      })
      .catch(() => {});
  }

  journalRenderEntries();
}

function journalSave() {
  const ta = $("journal-text");
  const mood = $("journal-mood");
  if (!ta?.value?.trim()) {
    toast("Write something first!");
    return;
  }
  const entries = JSON.parse(localStorage.getItem(JNL_KEY()) || "[]");
  const today = new Date().toISOString().split("T")[0];
  const existing = entries.findIndex((e) => e.date === today);
  const entry = {
    date: today,
    text: ta.value.trim(),
    mood: mood?.value || "😊",
    ts: Date.now(),
  };
  if (existing >= 0) entries[existing] = entry;
  else entries.unshift(entry);
  localStorage.setItem(JNL_KEY(), JSON.stringify(entries));
  localStorage.setItem(`${JNL_KEY()}_jnl_draft_${today}`, ta.value.trim());
  _syncJournalToServer(entries);
  journalRenderEntries();
  _saveStatus("saved");
  _recordActivity();
  toast("Journal entry saved ✓");
}

function journalRenderEntries() {
  const list = $("journal-entries-list");
  if (!list) return;
  const entries = JSON.parse(localStorage.getItem(JNL_KEY()) || "[]");
  if (!entries.length) {
    list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text4);font-size:.83rem">No journal entries yet. Start writing above!</div>`;
    return;
  }
  list.innerHTML = entries
    .map(
      (e, i) => `
    <div class="journal-entry">
      <div class="je-date">${e.mood} ${new Date(e.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
      <div class="je-text">${esc(e.text)}</div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button data-onclick="reflectWithAI" data-onclick-args="[${i}]" style="background:none;border:1px solid var(--border);border-radius:7px;padding:5px 12px;color:var(--teal);font-size:.75rem;font-weight:600;cursor:pointer;font-family:var(--font)">✨ Reflect with AI</button>
        <button data-onclick="journalAddToReview" data-onclick-args="[${i}]" style="background:none;border:1px solid var(--border);border-radius:7px;padding:5px 12px;color:var(--muted);font-size:.75rem;font-weight:600;cursor:pointer;font-family:var(--font)">🧠 Add to Review</button>
      </div>
    </div>`,
    )
    .join("");
}

// Spaced repetition (js/features/review.js). Journal entries have no
// server-generated id -- `ts` (Date.now() at save time) is the closest
// thing to a stable identifier and is unique per entry already.
function journalAddToReview(idx) {
  const entries = JSON.parse(localStorage.getItem(JNL_KEY()) || "[]");
  const e = entries[idx];
  if (!e) return;
  const dateLabel = new Date(e.date + "T12:00:00").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  reviewAddFromPrompt(
    "journal",
    String(e.ts || e.date || idx),
    `What did I write about on ${dateLabel}?`,
    (e.text || "").slice(0, 500),
  );
}

function reflectWithAI(idx) {
  const entries = JSON.parse(localStorage.getItem(JNL_KEY()) || "[]");
  const e = entries[idx];
  if (!e) return;
  const prompt = `Here's my journal entry from ${e.date}:\n\n"${e.text}"\n\nReflect on this with me. What patterns do you notice? What should I pay attention to?`;
  nav("chat", null);
  setTimeout(() => {
    const ci = $("ci");
    if (ci) {
      ci.value = prompt;
      ci.focus();
    }
  }, 300);
}

// ════════════ PHASE 3 — ADVANCED AI ════════════

async function aiTaskExtractor() {
  const text = await siModal.input(
    "✨ Extract Tasks with AI",
    "Paste an email, note, or message. Sivarr will pull out the tasks.",
    "",
    { confirmLabel: "Extract", type: "text" },
  );
  if (!text?.trim()) return;
  toast("Extracting tasks…");
  const token = getToken() || "";
  try {
    const r = await fetch("/api/ai/extract-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, text: text.trim() }),
    });
    const d = await r.json();
    if (!d.tasks || d.tasks.length === 0) {
      toast("No tasks found in that text.");
      return;
    }
    _aiShowExtractedTasks(d.tasks);
  } catch (_) {
    toast("AI extraction failed. Try again.");
  }
}

function _aiShowExtractedTasks(tasks) {
  const checked = tasks.map((_, i) => i);
  const html = `
    <div class="si-modal-hd">
      <span class="si-modal-title">✨ ${tasks.length} task${tasks.length > 1 ? "s" : ""} found</span>
      <button class="si-modal-x" data-onclick="siModalDone" data-onclick-args="[null]"><i class="ti ti-x"></i></button>
    </div>
    <div class="si-modal-body" style="max-height:320px;overflow-y:auto">
      ${tasks
        .map(
          (t, i) => `
        <label style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">
          <input type="checkbox" id="ait-${i}" checked style="margin-top:2px;accent-color:var(--accent);width:15px;height:15px;flex-shrink:0">
          <div>
            <div style="font-size:.85rem;font-weight:600">${esc(t.title)}</div>
            <div style="font-size:.72rem;color:var(--muted);margin-top:2px">
              ${t.priority ? `<span style="color:${t.priority === "high" ? "var(--red,#ef4444)" : t.priority === "medium" ? "var(--amber,#f59e0b)" : "var(--muted)"}">● ${t.priority}</span>` : ""}
              ${t.due ? ` · Due ${t.due}` : ""}
            </div>
          </div>
        </label>`,
        )
        .join("")}
    </div>
    <div class="si-modal-ft">
      <button class="si-modal-btn si-modal-btn-cancel" data-onclick="siModalDone" data-onclick-args="[null]">Cancel</button>
      <button class="si-modal-btn si-modal-btn-primary" data-onclick="siModalDone" data-onclick-arg0="ok">Add selected tasks</button>
    </div>`;
  siModal._show_raw(html).then((result) => {
    if (!result) return;
    tasks.forEach((t, i) => {
      const cb = document.getElementById(`ait-${i}`);
      if (!cb || !cb.checked) return;
      _aiAddTask(t);
    });
    if (typeof window.renderAll === "function") window.renderAll();
    toast(`Tasks added ✓`);
  });
}

function _aiAddTask(t) {
  // Used to write the legacy sivarr_tasks_ key, then "mirror" into the
  // real store via getSHData/saveSHData -- same dead functions as
  // chatSaveTask() above, same silent loss.
  if (typeof window.addTask === "function") {
    window.addTask({
      title: t.title,
      priority: t.priority || "medium",
      date: t.due || "",
    });
  }
}

async function aiWriteAssist() {
  const vals = await siModal.form(
    "✍️ AI Writing Assistant",
    [
      {
        id: "text",
        label: "Your text",
        type: "textarea",
        placeholder: "Paste or type the text you want to improve…",
        required: true,
      },
      {
        id: "action",
        label: "What to do",
        type: "select",
        options: [
          { label: "Improve clarity & flow", value: "improve" },
          { label: "Shorten", value: "shorten" },
          { label: "Expand with detail", value: "expand" },
          { label: "Make formal", value: "formal" },
          { label: "Make casual", value: "casual" },
          { label: "Convert to bullets", value: "bullets" },
          { label: "Rewrite as email", value: "email" },
          { label: "Summarise", value: "summarise" },
        ],
        default: "improve",
      },
    ],
    { confirmLabel: "Rewrite" },
  );
  if (!vals?.text?.trim()) return;
  toast("Rewriting…");
  const token = getToken() || "";
  try {
    const r = await fetch("/api/ai/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        text: vals.text.trim(),
        action: vals.action || "improve",
      }),
    });
    const d = await r.json();
    if (d.result) {
      _aiShowWriteResult(d.result);
    } else {
      toast(d.detail || "AI unavailable. Try again.");
    }
  } catch (_) {
    toast("Writing assistant failed. Try again.");
  }
}

function _aiShowWriteResult(result) {
  siModal._show_raw(`
    <div class="si-modal-hd">
      <span class="si-modal-title">✍️ AI Result</span>
      <button class="si-modal-x" data-onclick="siModalDone" data-onclick-args="[null]"><i class="ti ti-x"></i></button>
    </div>
    <div class="si-modal-body">
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;font-size:.85rem;line-height:1.65;color:var(--text1);white-space:pre-wrap;max-height:300px;overflow-y:auto">${esc(result)}</div>
    </div>
    <div class="si-modal-ft">
      <button class="si-modal-btn si-modal-btn-cancel" data-onclick="siModalDone" data-onclick-args="[null]">Close</button>
      <button class="si-modal-btn si-modal-btn-primary" data-onclick="_aiCopyResult" data-onclick-arg0="${esc(result)}">Copy text</button>
    </div>`);
}

function _aiCopyResult(text) {
  navigator.clipboard?.writeText(text).then(() => toast("Copied ✓"));
}

// ════════════ COMMUNITY ════════════
let _commCategory = "all";
let _oppCategory = "all";

function commSetMode(mode, btn) {
  document
    .querySelectorAll(".comm-tab")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  const isFeed = mode === "feed";
  const fv = $("comm-view-feed");
  if (fv) fv.style.display = isFeed ? "" : "none";
  const ov = $("comm-view-opp");
  if (ov) ov.style.display = isFeed ? "none" : "";
  const postBtn = $("comm-post-quick-btn");
  const oppBtn = $("comm-opp-btn");
  if (postBtn) postBtn.style.display = isFeed ? "" : "none";
  if (oppBtn) oppBtn.style.display = isFeed ? "none" : "";
  if (isFeed) commLoadFeed();
  else commLoadOpportunities();
}

async function communityInit() {
  // Set avatar initial in composer
  const av = $("comm-av-init");
  if (av) av.textContent = (S.name || "?")[0].toUpperCase();
  await commLoadFeed();
}

function commFocusComposer() {
  const ta = $("comm-post-text");
  if (ta) {
    ta.scrollIntoView({ behavior: "smooth", block: "center" });
    ta.focus();
  }
}

// ── Saved/bookmarked posts — local-only (mirrors Marketplace's installed-
// items pattern, MKT_INSTALLED_KEY). No backend: genuinely empty until a
// user actually saves something themselves. ──
const COMM_SAVED_KEY = () => `sivarr_comm_saved_${S.sid || "guest"}`;
function _commSavedIds() {
  try {
    return JSON.parse(localStorage.getItem(COMM_SAVED_KEY()) || "[]");
  } catch (_) {
    return [];
  }
}
function _commIsSaved(id) {
  return _commSavedIds().includes(id);
}
function commToggleSave(id, btn) {
  const saved = _commSavedIds();
  const on = saved.includes(id);
  const next = on ? saved.filter((x) => x !== id) : [...saved, id];
  localStorage.setItem(COMM_SAVED_KEY(), JSON.stringify(next));
  if (btn) {
    btn.classList.toggle("saved", !on);
    const icon = btn.querySelector("i");
    if (icon) icon.className = `ti ${!on ? "ti-bookmark-filled" : "ti-bookmark"}`;
  }
  if (_commCategory === "saved") _commApplyFilters();
  else _commUpdateChipCounts();
}

// Full unfiltered batch, fetched once per load — chip/search/sort below
// are pure client-side filters over this, no per-click refetch.
let _commAllPosts = [];

async function commLoadFeed() {
  const feed = $("community-feed");
  if (!feed) return;
  skShow("community-feed", _SK.post, 4);
  try {
    const r = await fetch(`/api/community/posts?category=all&limit=100`);
    const d = await r.json();
    _commAllPosts = d.posts || [];
    _commApplyFilters();
  } catch (_) {
    feed.innerHTML =
      '<div style="text-align:center;padding:40px;color:var(--muted)">Could not load posts.</div>';
  }
}

function _commApplyFilters() {
  const feed = $("community-feed");
  if (!feed) return;
  const savedIds = _commSavedIds();
  const list =
    _commCategory === "all"
      ? _commAllPosts
      : _commCategory === "saved"
        ? _commAllPosts.filter((p) => savedIds.includes(p.id))
        : _commAllPosts.filter((p) => p.category === _commCategory);
  _commUpdateChipCounts();
  _commUpdateSubtitle();
  if (!list.length) {
    feed.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted)">${
      _commCategory === "saved"
        ? "No saved posts yet. Tap the bookmark icon on a post to save it here."
        : _commAllPosts.length
          ? "No posts in this category yet."
          : "No posts yet. Be the first to share!"
    }</div>`;
    return;
  }
  feed.innerHTML = list.map((p) => _commRenderPost(p)).join("");
}

function _commUpdateChipCounts() {
  const savedIds = _commSavedIds();
  const counts = { all: _commAllPosts.length, saved: savedIds.length };
  _commAllPosts.forEach((p) => {
    counts[p.category] = (counts[p.category] || 0) + 1;
  });
  document.querySelectorAll("#comm-chip-row .comm-chip").forEach((chip) => {
    const f = chip.dataset.filter;
    const span = chip.querySelector(".chip-count");
    if (span) span.textContent = counts[f] ? ` · ${counts[f]}` : "";
  });
}

function _commUpdateSubtitle() {
  const el = $("comm-head-sub");
  if (!el) return;
  // Guard against the opp/feed loads racing and stomping each other's text
  // in the shared subtitle element (both can be in-flight around a tab switch).
  if ($("comm-mode-feed") && !$("comm-mode-feed").classList.contains("active"))
    return;
  if (!_commAllPosts.length) {
    el.textContent = "";
    return;
  }
  const today = new Date().toDateString();
  const todayCount = _commAllPosts.filter(
    (p) => p.created && new Date(p.created).toDateString() === today,
  ).length;
  el.textContent = `${_commAllPosts.length} post${_commAllPosts.length === 1 ? "" : "s"}${todayCount ? ` · ${todayCount} today` : ""}`;
}

function _commRenderPost(p) {
  const ago = _timeAgo(p.created);
  const likes = (p.likes || []).length;
  const allReps = p.replies || [];
  const liked = (p.likes || []).includes(S.sid || "");
  const isOwn = p.sid && p.sid === S.sid;
  const isSaved = _commIsSaved(p.id);
  const initials = (p.author || "U")[0].toUpperCase();
  const tags = (p.tags || [])
    .map((t) => `<span class="feed-tag">${esc(t)}</span>`)
    .join("");
  const showReps = allReps.slice(-3);
  const moreReps = allReps.length - showReps.length;
  const repliesHtml = showReps
    .map(
      (r) => `
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg3);border-radius:8px;font-size:.78rem">
      <span style="font-weight:600">${esc(r.author)}</span>
      <span style="color:var(--muted);margin-left:6px;font-size:.7rem">${_timeAgo(r.created)}</span>
      <div style="margin-top:4px;color:var(--text2)">${esc(r.body)}</div>
    </div>`,
    )
    .join("");
  return `
    <div class="feed-card" data-id="${esc(p.id)}">
      <div class="feed-hd">
        <div class="feed-av">${initials}</div>
        <div style="flex:1;min-width:0">
          <div class="feed-name feed-author-link" data-onclick="commViewAuthor" data-onclick-arg0="${esc(p.sid || "")}" data-onclick-arg1="${esc(p.author)}">${esc(p.author)}</div>
          <div class="feed-time">${ago}</div>
        </div>
        ${p.category && p.category !== "general" ? `<span class="feat-badge">${esc(p.category)}</span>` : ""}
        <button class="comm-save-btn ${isSaved ? "saved" : ""}" title="${isSaved ? "Remove from saved" : "Save"}" data-onclick="commToggleSave" data-onclick-arg0="${esc(p.id)}" data-onclick-this>
          <i class="ti ${isSaved ? "ti-bookmark-filled" : "ti-bookmark"}"></i>
        </button>
        ${isOwn ? `<button class="feed-delete-btn" data-onclick="commDeletePost" data-onclick-arg0="${esc(p.id)}" title="Delete post"><i class="ti ti-trash"></i></button>` : ""}
      </div>
      <div class="feed-body">${esc(p.body)}</div>
      ${tags ? `<div class="feed-tags">${tags}</div>` : ""}
      ${moreReps > 0 ? `<div style="font-size:.72rem;color:var(--accent);margin-top:6px;cursor:pointer" data-onclick="commLoadFeed">↑ ${moreReps} earlier repl${moreReps > 1 ? "ies" : "y"}</div>` : ""}
      ${repliesHtml}
      <div class="feed-actions">
        <button class="feed-action-btn ${liked ? "liked" : ""}" data-onclick="commLike" data-onclick-arg0="${esc(p.id)}" data-onclick-this>
          <i class="ti ti-heart${liked ? " ti-heart-filled" : ""}"></i> <span>${likes}</span>
        </button>
        <button class="feed-action-btn" data-onclick="commReply" data-onclick-arg0="${esc(p.id)}" data-onclick-this>
          <i class="ti ti-message"></i> <span>${allReps.length}</span>
        </button>
        <button class="feed-action-btn" title="Draft a reply with Sivarr AI" data-onclick="commDraftReply" data-onclick-arg0="${esc(p.id)}">
          <i class="ti ti-sparkles"></i> Draft with AI
        </button>
      </div>
    </div>`;
}

// Reply drafting reuses the real chat, not a bespoke one-off completion
// call — quickPrompt() (js/app.js:3557) already does exactly "switch to
// chat, fill the input, send", the same thing the chat welcome screen's
// own prompt cards use. The user reviews/edits the AI's draft in the real
// chat UI, then pastes what they want into the existing Reply prompt back
// on the post to actually publish it via commReply() below — nothing
// posts automatically without the user choosing to.
function commDraftReply(postId) {
  const p = _commAllPosts.find((x) => x.id === postId);
  if (!p) return;
  const prompt = `Draft a short, friendly reply to this Community post: "${p.body}". Reply as ${S.name || "me"}, keep it under 3 sentences.`;
  nav("chat", null);
  if (typeof quickPrompt === "function") quickPrompt(prompt);
}

function _timeAgo(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function commCharCount(ta) {
  const cc = $("comm-char-count");
  if (cc) cc.textContent = `${ta.value.length} / 800`;
  const btn = $("comm-post-btn");
  if (btn) btn.disabled = ta.value.trim().length === 0;
}

async function communityPost() {
  const ta = $("comm-post-text");
  const catEl = $("comm-post-cat");
  const body = ta?.value.trim();
  if (!body) {
    ta?.focus();
    return;
  }
  if (body.length > 800) {
    toast("Post is too long (max 800 characters).");
    return;
  }
  const category = catEl?.value || "general";
  const token = getToken() || "";
  const btn = $("comm-post-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Posting…";
  }
  try {
    const r = await fetch("/api/community/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, body, category }),
    });
    const d = await r.json();
    if (d.ok) {
      if (ta) {
        ta.value = "";
        ta.style.height = "auto";
      }
      const cc = $("comm-char-count");
      if (cc) cc.textContent = "0 / 800";
      toast("Posted ✓");
      commLoadFeed();
    }
  } catch (_) {
    toast("Could not post. Try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Post →";
    }
  }
}

async function commDeletePost(postId) {
  if (
    !(await siModal.confirm("Delete this post? This cannot be undone.", {
      title: "Delete Post",
      confirmLabel: "Delete",
      danger: true,
    }))
  )
    return;
  const token = getToken() || "";
  try {
    const r = await fetch(`/api/community/posts/${postId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (r.ok) {
      toast("Post deleted");
      commLoadFeed();
    } else toast("Could not delete post.");
  } catch (_) {
    toast("Could not delete post.");
  }
}

function commViewAuthor(sid, name) {
  if (sid && sid === S.sid) {
    nav("profile", null);
    return;
  }
  // For other users — filter feed to show only their posts
  toast(`Showing posts by ${name}`);
  const feed = $("community-feed");
  if (!feed) return;
  fetch(`/api/community/posts?limit=100`)
    .then((r) => r.json())
    .then((d) => {
      const posts = (d.posts || []).filter(
        (p) => p.sid === sid || p.author === name,
      );
      feed.innerHTML = posts.length
        ? posts.map((p) => _commRenderPost(p)).join("")
        : `<div style="text-align:center;padding:32px;color:var(--muted)">No posts from ${esc(name)}.</div>`;
    })
    .catch(() => {});
}

async function commLike(postId, btn) {
  const token = getToken() || "";
  try {
    const r = await fetch(`/api/community/posts/${postId}/like`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const d = await r.json();
    if (d.ok) {
      const span = btn.querySelector("span");
      if (span) span.textContent = d.count;
      const icon = btn.querySelector("i");
      if (icon)
        icon.className = `ti ti-heart${d.liked ? " ti-heart-filled" : ""}`;
    }
  } catch (_) {}
}

async function commReply(postId, btn) {
  const body = await siModal.input("Reply", "Write your reply…", "", {
    confirmLabel: "Reply",
  });
  if (!body?.trim()) return;
  const token = getToken() || "";
  try {
    const r = await fetch(`/api/community/posts/${postId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, body: body.trim() }),
    });
    const d = await r.json();
    if (d.ok) {
      toast("Reply added ✓");
      commLoadFeed();
    }
  } catch (_) {
    toast("Could not reply.");
  }
}

function commFilter(cat, btn) {
  _commCategory = cat;
  document
    .querySelectorAll("#comm-chip-row .comm-chip")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  _commApplyFilters();
}

// ════════════ OPPORTUNITIES ════════════

// Local-only saves, same pattern as posts above.
const OPP_SAVED_KEY = () => `sivarr_opp_saved_${S.sid || "guest"}`;
function _oppSavedIds() {
  try {
    return JSON.parse(localStorage.getItem(OPP_SAVED_KEY()) || "[]");
  } catch (_) {
    return [];
  }
}
function _oppIsSaved(id) {
  return _oppSavedIds().includes(id);
}
function oppToggleSave(id, btn) {
  const saved = _oppSavedIds();
  const on = saved.includes(id);
  const next = on ? saved.filter((x) => x !== id) : [...saved, id];
  localStorage.setItem(OPP_SAVED_KEY(), JSON.stringify(next));
  if (btn) {
    btn.classList.toggle("saved", !on);
    const icon = btn.querySelector("i");
    if (icon) icon.className = `ti ${!on ? "ti-bookmark-filled" : "ti-bookmark"}`;
  }
  if (_oppCategory === "saved") _oppApplyFilters();
  else _oppUpdateChipCounts();
}

// Urgency badge for a deadline. Most real listings have a clean ISO date
// (see app.py's _SEED_OPPS-era comment), but the field has always been
// freeform text server-side (sanitize_text, no date validation) — "Rolling",
// "Open", or blank are real, valid values that must render gracefully
// with no urgency claim rather than "Invalid Date".
function _oppDeadlineMeta(deadline) {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (isNaN(d.getTime()))
    return { cls: "", label: deadline };
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (days < 0) return { cls: "", label: "Closed" };
  const cls = days <= 7 ? "opp-badge-urgent" : days <= 30 ? "opp-badge-soon" : "";
  const label = days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"} left`;
  return { cls, label };
}

let _oppAllList = [];

async function commLoadOpportunities() {
  const feed = $("opp-feed");
  if (!feed) return;
  skShow("opp-feed", _SK.post, 3);
  try {
    const r = await fetch(`/api/opportunities?category=all&limit=100`);
    const d = await r.json();
    _oppAllList = d.opportunities || [];
    _oppApplyFilters();
  } catch (_) {
    feed.innerHTML =
      '<div style="text-align:center;padding:40px;color:var(--muted)">Could not load opportunities.</div>';
  }
}

function _oppApplyFilters() {
  const feed = $("opp-feed");
  if (!feed) return;
  const savedIds = _oppSavedIds();
  const query = ($("opp-search")?.value || "").trim().toLowerCase();
  const sort = $("opp-sort")?.value || "newest";

  let list =
    _oppCategory === "all"
      ? _oppAllList
      : _oppCategory === "saved"
        ? _oppAllList.filter((o) => savedIds.includes(o.id))
        : _oppAllList.filter((o) => o.category === _oppCategory);

  if (query) {
    list = list.filter((o) =>
      [o.title, o.desc, o.organisation, o.location]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }

  list = [...list].sort((a, b) => {
    if (sort === "deadline") {
      const da = new Date(a.deadline).getTime();
      const db = new Date(b.deadline).getTime();
      return (isNaN(da) ? Infinity : da) - (isNaN(db) ? Infinity : db);
    }
    return new Date(b.created) - new Date(a.created);
  });

  _oppUpdateChipCounts();
  _oppUpdateSubtitle();

  if (!list.length) {
    feed.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted)">${
      _oppCategory === "saved"
        ? "No saved opportunities yet. Tap the bookmark icon on a listing to save it here."
        : _oppAllList.length
          ? query
            ? "No opportunities match your search."
            : "No opportunities in this category yet."
          : "No opportunities listed yet. Add the first one!"
    }</div>`;
    return;
  }
  feed.innerHTML = list.map((o) => _oppRenderCard(o)).join("");
}

function _oppUpdateChipCounts() {
  const savedIds = _oppSavedIds();
  const counts = { all: _oppAllList.length, saved: savedIds.length };
  _oppAllList.forEach((o) => {
    counts[o.category] = (counts[o.category] || 0) + 1;
  });
  document.querySelectorAll("#opp-chip-row .comm-chip").forEach((chip) => {
    const f = chip.dataset.filter;
    const span = chip.querySelector(".chip-count");
    if (span) span.textContent = counts[f] ? ` · ${counts[f]}` : "";
  });
}

function _oppUpdateSubtitle() {
  const el = $("comm-head-sub");
  if (!el) return;
  // Only overwrite the subtitle when Opportunities is actually the active
  // tab — commSetMode() re-runs each load, so this can't stomp Feed's text.
  if ($("comm-mode-opp") && !$("comm-mode-opp").classList.contains("active"))
    return;
  if (!_oppAllList.length) {
    el.textContent = "";
    return;
  }
  const closingSoon = _oppAllList.filter((o) => {
    const meta = _oppDeadlineMeta(o.deadline);
    return meta && meta.cls === "opp-badge-urgent";
  }).length;
  el.textContent = `${_oppAllList.length} open posting${_oppAllList.length === 1 ? "" : "s"}${closingSoon ? ` · ${closingSoon} closing this week` : ""}`;
}

function _oppRenderCard(o) {
  const initial = (o.organisation || o.title || "?")[0].toUpperCase();
  const isSaved = _oppIsSaved(o.id);
  const deadlineMeta = _oppDeadlineMeta(o.deadline);
  const pills = [
    o.location
      ? `<span class="opp-meta-pill"><i class="ti ti-map-pin"></i>${esc(o.location)}</span>`
      : "",
    deadlineMeta
      ? `<span class="opp-meta-pill ${deadlineMeta.cls}"><i class="ti ti-clock"></i>${esc(deadlineMeta.label)}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  return `
    <div class="opp-card" data-id="${esc(o.id)}">
      <div class="opp-card-hd">
        <div class="opp-card-ic">${esc(initial)}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div>
              <div class="opp-card-title">${esc(o.title)}</div>
              <div class="opp-card-org">${o.organisation ? esc(o.organisation) + " · " : ""}${_timeAgo(o.created)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
              <span class="feat-badge">${esc(o.category)}</span>
              <button class="comm-save-btn ${isSaved ? "saved" : ""}" title="${isSaved ? "Remove from saved" : "Save"}" data-onclick="oppToggleSave" data-onclick-arg0="${esc(o.id)}" data-onclick-this>
                <i class="ti ${isSaved ? "ti-bookmark-filled" : "ti-bookmark"}"></i>
              </button>
            </div>
          </div>
          ${o.desc ? `<div class="opp-card-desc">${esc(o.desc)}</div>` : ""}
          <div class="opp-card-meta">
            <div class="opp-meta-pills">${pills}</div>
            ${o.link && o.link !== "#" ? `<a class="opp-apply-btn" href="${esc(safeUrl(o.link))}" target="_blank" rel="noopener">Apply <i class="ti ti-arrow-up-right"></i></a>` : ""}
          </div>
        </div>
      </div>
    </div>`;
}

function oppFilter(cat, btn) {
  _oppCategory = cat;
  document
    .querySelectorAll("#opp-chip-row .comm-chip")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  _oppApplyFilters();
}

async function oppSubmit() {
  const vals = await siModal.form(
    "Add Opportunity",
    [
      {
        id: "title",
        label: "Title",
        type: "text",
        placeholder: "e.g. Google SWE Intern 2026",
        required: true,
      },
      {
        id: "desc",
        label: "Description",
        type: "textarea",
        placeholder: "What is this opportunity about?",
      },
      {
        id: "category",
        label: "Category",
        type: "select",
        options: [
          { label: "Job", value: "job" },
          { label: "Internship", value: "internship" },
          { label: "Scholarship", value: "scholarship" },
          { label: "Grant", value: "grant" },
          { label: "Other", value: "other" },
        ],
        default: "internship",
      },
      {
        id: "location",
        label: "Location (optional)",
        type: "text",
        placeholder: "e.g. Remote, or Lagos, Nigeria",
      },
      {
        id: "deadline",
        label: "Deadline (optional)",
        type: "text",
        placeholder: "e.g. 2026-07-31",
      },
      {
        id: "link",
        label: "Link / URL",
        type: "text",
        placeholder: "https://…",
      },
    ],
    { confirmLabel: "Submit" },
  );
  if (!vals?.title?.trim()) return;
  const token = getToken() || "";
  try {
    const r = await fetch("/api/opportunities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        title: vals.title.trim(),
        desc: (vals.desc || "").trim(),
        link: (vals.link || "").trim(),
        category: vals.category || "other",
        location: (vals.location || "").trim(),
        deadline: (vals.deadline || "").trim(),
      }),
    });
    const d = await r.json();
    if (d.ok) {
      toast("Opportunity added ✓");
      commLoadOpportunities();
    }
  } catch (_) {
    toast("Could not submit. Try again.");
  }
}

// ════════════ LIBRARY ════════════
let _libActiveCat = "all";

function libFilter(cat, btn) {
  document
    .querySelectorAll('[id^="lib-tab-"]')
    .forEach((b) => b.classList.remove("sp-add"));
  if (btn) btn.classList.add("sp-add");
  _libActiveCat = cat || "all";
  _libApplyFilters();
}

// CSP migration: takes the input element instead of the raw value string.
function libSearch(el) {
  _libApplyFilters(el.value);
}

// Category pills previously only toggled their own active style — they
// never actually filtered #lib-grid, unlike the search box next to them.
function _libApplyFilters(q) {
  const query = (q ?? $("lib-search")?.value ?? "").toLowerCase();
  const cards = document.querySelectorAll("#lib-grid .lib-card");
  let visible = 0;
  cards.forEach((c) => {
    const cats = (c.dataset.cat || "").split(" ");
    const matchesCat = _libActiveCat === "all" || cats.includes(_libActiveCat);
    const matchesQuery = !query || c.textContent.toLowerCase().includes(query);
    const show = matchesCat && matchesQuery;
    c.style.display = show ? "" : "none";
    if (show) visible++;
  });
  const empty = $("lib-empty");
  if (empty) empty.style.display = visible ? "none" : "";
}

// ═══════════════════════ TEMPLATES SYSTEM ════════════════════

// ── Template Library data (powers the Home "Featured templates" list) ──
const TPL_LIBRARY = [
  {
    name: "Weekly Task Manager",
    icon: "🗓️",
    desc: "Plan your week across days with priority tracking and focus blocks.",
    src: "/static/templates/weekly_habit_planner.html",
  },
  {
    name: "Daily Task Manager & Habit Tracker",
    icon: "✅",
    desc: "Combine daily tasks with habit streaks in a warm editorial layout.",
    src: "/static/templates/daily_task_manager.html",
  },
  {
    name: "Habit Tracker",
    icon: "🔥",
    desc: "Monthly habit grid with streaks, completion rings, and daily check-ins.",
    src: "/static/templates/habit_tracker.html",
  },
  {
    name: "Monthly Budget Tracker",
    icon: "💰",
    desc: "Track income, expenses, and categories with live chart visualisations.",
    src: "/static/templates/month_y_budget_tracker.html",
  },
];

// ── Template Library ──────────────────────────────────────────────
let _tplCurrentName = "";

function openTemplatePreview(name, desc, src) {
  _tplCurrentName = name;
  document.getElementById("tplModalTitle").textContent = name;
  document.getElementById("tplModalDesc").textContent = desc;

  const body = document.querySelector(".tpl-modal-body");
  const loader = document.getElementById("tplIframeLoader");
  loader.style.display = "flex";

  const existing = body.querySelector("iframe");
  if (existing) existing.remove();

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "width:100%;height:100%;border:none;display:block;";
  iframe.onload = () => {
    loader.style.display = "none";
  };
  iframe.src = src;
  body.appendChild(iframe);

  document.getElementById("tplModalBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeTemplatePreview() {
  document.getElementById("tplModalBackdrop").classList.remove("open");
  document.body.style.overflow = "";
  const iframe = document.querySelector(".tpl-modal-body iframe");
  if (iframe) iframe.remove();
}

function useTemplateFromModal() {
  useTemplate(_tplCurrentName);
  closeTemplatePreview();
}

// T1 fix: the Templates panel cards now seed REAL starter content into the
// standalone stores the default-nav panels read (sivarr_tasks/_habits/_finance),
// instead of faking a success toast.
const TEMPLATE_SEEDS = {
  "Weekly Task Manager": {
    tasks: [
      "Plan the week ahead",
      "Review last week's progress",
      "Set your top 3 priorities",
      "Weekly inbox & desk cleanup",
    ],
    nav: "flux",
  },
  "Daily Task Manager & Habit Tracker": {
    tasks: ["Plan today's top 3", "End-of-day review"],
    habits: [
      ["Morning planning", "🌅"],
      ["Evening review", "🌙"],
    ],
    nav: "flux",
  },
  "Habit Tracker": {
    habits: [
      ["Drink water", "💧"],
      ["Exercise", "🏃"],
      ["Read 20 minutes", "📖"],
      ["Sleep by 11pm", "😴"],
    ],
    nav: "habits",
  },
  "Monthly Budget Tracker": {
    budgets: [
      "Food & Dining",
      "Transport",
      "Rent & Bills",
      "Savings",
      "Entertainment",
    ],
    nav: "finance",
  },
};

function useTemplate(name) {
  const seed = TEMPLATE_SEEDS[name];
  if (!seed || !S.sid) {
    toast("Couldn't use this template. Try again.");
    return;
  }
  let n = 0,
    base = Date.now();
  if (seed.tasks) {
    // Used to write the legacy sivarr_tasks_ key, then "mirror" into the
    // real store via getSHData/saveSHData -- same dead functions as
    // chatSaveTask() above, same silent loss.
    seed.tasks.forEach((t) => {
      if (typeof window.addTask === "function") {
        window.addTask({ title: t });
      }
      n++;
    });
    if (typeof window.renderAll === "function") window.renderAll();
  }
  if (seed.habits) {
    const habits = JSON.parse(
      localStorage.getItem(`sivarr_habits_${S.sid}`) || "[]",
    );
    seed.habits.forEach(([t, e]) => {
      habits.push({
        id: String(++base),
        title: t,
        emoji: e || "📌",
        freq: "daily",
        completions: [],
        streak: 0,
        best_streak: 0,
      });
      n++;
    });
    localStorage.setItem(`sivarr_habits_${S.sid}`, JSON.stringify(habits));
    if (typeof _syncHabitsToServer === "function") _syncHabitsToServer(habits);
  }
  if (seed.budgets) {
    const fin = JSON.parse(
      localStorage.getItem(`sivarr_finance_${S.sid}`) ||
        '{"transactions":[],"budgets":{}}',
    );
    fin.budgets = fin.budgets || {};
    seed.budgets.forEach((b) => {
      if (!(b in fin.budgets)) {
        fin.budgets[b] = 0;
        n++;
      }
    });
    localStorage.setItem(`sivarr_finance_${S.sid}`, JSON.stringify(fin));
  }
  toast(`"${name}" added: ${n} item${n !== 1 ? "s" : ""} created ✓`);
  if (seed.nav) nav(seed.nav, null);
}

function setTemplateFilter(cat, btn) {
  document
    .querySelectorAll(".tpl-chip")
    .forEach((c) => c.classList.remove("active"));
  if (btn) btn.classList.add("active");
  filterTemplates(cat);
}

function filterTemplates(forceCat) {
  const cat =
    forceCat ||
    (() => {
      const active = document.querySelector(".tpl-chip.active");
      return active ? active.textContent.trim().toLowerCase() : "all";
    })();
  const query = (
    document.getElementById("templateSearch")?.value || ""
  ).toLowerCase();
  document.querySelectorAll(".tpl-card").forEach((card) => {
    const cats = (card.dataset.cat || "").split(" ");
    const name =
      card.querySelector(".tpl-name")?.textContent.toLowerCase() || "";
    const catMatch = cat === "all" || cats.includes(cat);
    const searchMatch = !query || name.includes(query);
    card.style.display = catMatch && searchMatch ? "" : "none";
  });
}

function tplInit() {
  filterTemplates();
}

// Close the preview modal on backdrop click or Escape
document.addEventListener("click", (e) => {
  const backdrop = document.getElementById("tplModalBackdrop");
  if (backdrop && e.target === backdrop) closeTemplatePreview();
});
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    document.getElementById("tplModalBackdrop")?.classList.contains("open")
  )
    closeTemplatePreview();
});
function openDiff() {
  $("diff-modal").classList.add("open");
}
function closeDiff(e) {
  if (e.target === $("diff-modal")) $("diff-modal").classList.remove("open");
}

async function setDiff(level) {
  await API("/api/difficulty", { token: getToken(), level });
  S.diff = level;
  updateDiff(level);
  $("diff-modal").classList.remove("open");
  const qd = $("qd-label");
  if (qd) qd.textContent = level.charAt(0).toUpperCase() + level.slice(1);
  toast(`Difficulty: ${level.charAt(0).toUpperCase() + level.slice(1)} 🎯`);
  document.querySelectorAll(".diff-opt").forEach((el) => {
    el.classList.toggle(
      "sel",
      el.querySelector(".dl").textContent.toLowerCase() === level,
    );
  });
}

function updateDiff(level) {
  // Difficulty pill now only lives in quiz section
  const btn = $("diff-btn");
  if (btn) {
    btn.className = `diff-pill diff-${level}`;
    btn.textContent = level.charAt(0).toUpperCase() + level.slice(1);
  }
  // Update quiz start label too
  const qd = $("qd-label");
  if (qd) qd.textContent = level.charAt(0).toUpperCase() + level.slice(1);
}

// ═══════════════════════════ SNAV (New Sidebar) ═════════════════

const SNAV_SECTION_HEIGHTS = {
  ai: 4,
  planner: 6,
  assessments: 3,
  insights: 3,
  templates: 3,
  spaces: 2,
};

// ═══════════════════════════ MOBILE SIDEBAR ══════════════════

const MOB_SNAV_HEIGHTS = {
  ai: 4,
  planner: 4,
  assessments: 3,
  insights: 3,
  spaces: 2,
};

// ── Sidebar toggle (desktop: retract/restore · mobile: back to launcher) ──
// Hamburger — opens/closes the full nav menu as a slide-in overlay, from
// any panel and any drill depth. Pure CSS class toggle on <body>; never
// touches browser history (see layout.css: body.mobile-sidebar-open .sidebar),
// so it can never interact with or reintroduce the login/OAuth history bug.
function toggleMobileSidebar(e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  const sidebar = $("sidebar");
  if (!sidebar) return;
  // Check if we're on the dashboard (sidebar exists and is visible)
  if (sidebar.style.display === "none") return;
  document.body.classList.contains("mobile-sidebar-open")
    ? closeMobileSidebar()
    : openMobileSidebar();
}

// ── Mobile Notion launcher: return to the full-screen home (pop the
//    drilled page). The sidebar IS the launcher on mobile, so we just
//    clear the drilled state and make sure no desktop collapse/retract
//    class is hiding it. ──────────────────────────────────────────────
// ── Mobile drill-down history stack ─────────────────────────────────
//   Each drill into a panel pushes a History API entry carrying the full
//   drill path (sivStack). The back chevron and the hardware/browser back
//   button both flow through popstate, so they share one source of truth.
let _mobStack = []; // drill path of panel names ([] = launcher home)
let _mobSyncing = false; // true while painting from popstate (suppress re-push)
let _mobReady = false; // becomes true after first landing (ignore boot nav)

// Pure visual reset to the launcher (no history side-effects)
function _mobHomeVisual() {
  document.body.classList.remove("mob-drilled");
  const sb = $("sidebar");
  if (sb && window.innerWidth <= 720)
    sb.classList.remove("retracted", "collapsed");
  document.body.classList.remove("mobile-sidebar-open");
  $("overlay")?.classList.remove("show");
  document.body.style.overflow = "";
  try {
    document.querySelector(".sb-scroll")?.scrollTo({ top: 0 });
  } catch (_) {}
}

// Record a drill into `name` (called from nav() on mobile)
function _mobPush(name) {
  if (!_mobReady || _mobSyncing) return;
  if (_mobStack[_mobStack.length - 1] === name) return; // ignore re-tap of current page
  _mobStack.push(name);
  try {
    history.pushState({ sivStack: _mobStack.slice() }, "");
  } catch (_) {}
}

// Paint the UI to match a target stack (programmatic — never pushes history)
function _mobApplyStack(stack) {
  _mobStack = Array.isArray(stack) ? stack.slice() : [];
  if (_mobStack.length === 0) {
    _mobHomeVisual();
    return;
  }
  _mobSyncing = true;
  document.body.classList.add("mob-drilled");
  nav(_mobStack[_mobStack.length - 1], null);
  _mobSyncing = false;
}

// Back chevron → pop one level (defer to history so hardware-back matches).
// Guard: only delegate to real history.back() when the CURRENT entry is one
// the app itself pushed/replaced (i.e. carries a sivStack payload). If it
// doesn't — e.g. _mobStack ever gets out of sync with real history — fall
// back to a pure in-memory visual pop instead of touching history.back(),
// so a mismatch can never surface pre-app/third-party pages (like an OAuth
// provider's pages) that happen to still sit earlier in the tab's session
// history.
function mobBack() {
  if (window.innerWidth > 720 || _mobStack.length === 0) return;
  const ownsCurrentEntry = !!(
    history.state && Array.isArray(history.state.sivStack)
  );
  if (ownsCurrentEntry) {
    try {
      history.back();
      return;
    } catch (_) {
      /* fall through */
    }
  }
  _mobApplyStack(_mobStack.slice(0, -1));
}

// Brand tap / boot → jump all the way back to the launcher home
function mobHome() {
  if (window.innerWidth <= 720 && _mobStack.length) {
    const depth = _mobStack.length;
    try {
      history.go(-depth);
      return;
    } catch (_) {}
  }
  _mobStack = [];
  _mobHomeVisual();
}

// ── Desktop URL routing ──────────────────────────────────────────────
//   Deep-linkable panels/spaces get a clean path (/marketplace, /org, ...)
//   mirroring the server's PUBLIC_APP_SLUGS allowlist (app.py). Mobile keeps
//   its own sivStack-based history model above and is left untouched here.
let _urlSyncBooted = false;
function _isUrlRoutable(name) {
  return name === "org" || !!NAV_TABS[name];
}
// Read the panel implied by the current URL at boot (used once, before login
// data has painted anything) — returns null for unknown/root paths.
function _panelFromUrl() {
  const slug = location.pathname.slice(1);
  return slug && _isUrlRoutable(slug) ? slug : null;
}
function _syncUrlForPanel(name) {
  if (window.innerWidth <= 720) return; // mobile owns its own history model
  if (!_isUrlRoutable(name)) return;
  const path = "/" + name;
  if (location.pathname === path) {
    _urlSyncBooted = true;
    return;
  }
  try {
    if (_urlSyncBooted) history.pushState({ panel: name }, "", path);
    else history.replaceState({ panel: name }, "", path);
  } catch (_) {}
  _urlSyncBooted = true;
}

// Hardware/browser back (and our own history.back/go) land here
window.addEventListener("popstate", (e) => {
  if (window.innerWidth > 720) {
    const slug = location.pathname.slice(1);
    if (_isUrlRoutable(slug)) nav(slug, null);
    return;
  }
  const _stack = e.state && Array.isArray(e.state.sivStack) ? e.state.sivStack : null;
  if (_stack) {
    _mobApplyStack(_stack);
  } else {
    // Landed on a "foreign" entry with no app-owned sivStack payload — e.g. a
    // fresh deep-link load or a pre-app entry (OAuth redirect, ...). Recover
    // the panel from the URL instead of collapsing to the launcher, which
    // would otherwise leave a stale panel showing behind an undrilled body.
    const _slug = _panelFromUrl();
    _mobApplyStack(_slug ? [_slug] : []);
  }
});

// Keep the launcher usable if the viewport crosses into mobile mid-session
window.addEventListener("resize", () => {
  if (window.innerWidth <= 720)
    $("sidebar")?.classList.remove("retracted", "collapsed");
});

// ── Command-center: rail collapse (64px icons-only), persisted ──
function sbToggleRail() {
  if (window.innerWidth <= 720) {
    // Mobile: retract launcher → return to last visited panel
    const last = localStorage.getItem("sb_last_panel") || "home";
    nav(last, null);
    return;
  }
  const sb = $("sidebar");
  if (!sb) return;
  const collapsed = sb.classList.toggle("collapsed");
  localStorage.setItem("sb_collapsed", collapsed ? "1" : "0");
  const ic = $("sb-rail-icon");
  if (ic)
    ic.className =
      "ti sb-brand-caret " +
      (collapsed
        ? "ti-layout-sidebar-left-expand"
        : "ti-layout-sidebar-left-collapse");
  const btn = ic && ic.closest(".sb-brand-btn");
  if (btn) btn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
}

// ── Mobile sidebar init: swap the collapse icon for a back-arrow on touch devices ──
function _mobSidebarInit() {
  if (window.innerWidth > 720) return;
  const closeIcon = document.querySelector(".sb-mob-close-icon");
  if (closeIcon) closeIcon.style.display = "inline-block";
  const railIcon = $("sb-rail-icon");
  if (railIcon) railIcon.style.display = "none";
}
document.addEventListener("DOMContentLoaded", _mobSidebarInit);

// ── Connect section order (Customize Sidebar removed — this now only feeds
// the fixed default order into navRenderSidebar's sgi-connect render) ──
function NAV_ORDER_KEY() {
  return `sivarr_nav_order_${(typeof S !== "undefined" && S.sid) || ""}`;
}

function _getSectionOrder(section) {
  try {
    const stored = JSON.parse(localStorage.getItem(NAV_ORDER_KEY()) || "{}");
    if (stored[section] && Array.isArray(stored[section]))
      return stored[section];
  } catch (e) {}
  return NAV_ORDER[section] ? NAV_ORDER[section].slice() : [];
}

// ── Command-center: parse the next upcoming event today → display label ──
function _sbNextEvent(events, today) {
  const todays = (events || []).filter((e) => (e.date || "").startsWith(today));
  if (!todays.length) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const toMin = (t) => {
    const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return -1; // all-day / unparseable → sort first
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = (m[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return h * 60 + min;
  };
  const sorted = todays
    .map((e) => ({ e, m: toMin(e.time) }))
    .sort((a, b) => a.m - b.m);
  const next = sorted.find((x) => x.m >= nowMin) || sorted[0];
  return next.e.time || "All day";
}

// ── Command-center: populate Today snapshot + inline nav stats from live data ──
function sbRenderStats() {
  try {
    if (typeof S === "undefined" || !S || !S.sid) return;
    const today = new Date().toISOString().split("T")[0];
    const tasks = JSON.parse(
      localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
    );
    const goals = JSON.parse(
      localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
    );
    const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
    const events = JSON.parse(localStorage.getItem(CAL_EVENTS_KEY()) || "[]");

    // Tasks due = open tasks due today or overdue
    const tasksDue = tasks.filter(
      (t) => !t.done && t.due_date && t.due_date <= today,
    ).length;
    // Activity streak (the headline streak used on Home)
    const streak =
      typeof _getActivityStreak === "function" ? _getActivityStreak() : 0;
    // Next event today
    const nextLabel = _sbNextEvent(events, today);
    // Average progress across active goals
    const active = goals.filter((g) => !g.completed);
    const goalsAvg = active.length
      ? Math.round(
          active.reduce((s, g) => s + (g.progress || 0), 0) / active.length,
        )
      : null;
    // 28-day habit completion rate (mirrors the Habits page formula)
    let habitRate = null;
    if (habits.length) {
      const range = [];
      for (let d = 27; d >= 0; d--) {
        const dt = new Date();
        dt.setDate(dt.getDate() - d);
        range.push(dt.toISOString().split("T")[0]);
      }
      const done = habits.reduce(
        (s, h) =>
          s + range.filter((ds) => (h.completions || []).includes(ds)).length,
        0,
      );
      habitRate = Math.round((done / (habits.length * 28)) * 100);
    }

    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    // Today snapshot
    set("sb-today-tasks", tasksDue);
    set("sb-today-streak", streak);
    set("sb-today-next", nextLabel || "–");
    // Inline nav stats (blank string → CSS :empty hides them)
    set("sbstat-tasks", tasksDue ? `${tasksDue} due` : "");
    set("sbstat-goals", goalsAvg !== null ? `${goalsAvg}% avg` : "");
    set("sbstat-habits", habitRate !== null ? `${habitRate}%` : "");
    // sbstat-stats (Analytics trend): no clean week-over-week source yet — left blank (follow-up)
  } catch (e) {
    /* non-fatal — sidebar still works without stats */
  }
}

// ── Fullscreen toggle ──────────────────────────────────────────
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement
      .requestFullscreen()
      .catch(() => toast("Fullscreen not available"));
  } else {
    document.exitFullscreen();
  }
}
document.addEventListener("fullscreenchange", () => {
  const fs = !!document.fullscreenElement;
  // Legacy top-bar button (null-safe — now removed; kept for compatibility).
  const icon = $("fullscreen-icon");
  if (icon) icon.className = fs ? "ti ti-minimize" : "ti ti-maximize";
  const btn = document.getElementById("fullscreen-btn");
  if (btn) btn.title = fs ? "Exit fullscreen" : "Fullscreen";
  // Profile-dropdown fullscreen item.
  const pdIcon = $("pd-fullscreen-icon");
  if (pdIcon)
    pdIcon.className = fs ? "ti ti-minimize pd-icon" : "ti ti-maximize pd-icon";
  const pdLabel = $("pd-fullscreen-label");
  if (pdLabel) pdLabel.textContent = fs ? "Exit Fullscreen" : "Fullscreen";
});

function openMobileSidebar() {
  document.body.classList.add("mobile-sidebar-open");
  const overlay = $("overlay");
  if (overlay) overlay.classList.add("show");
  document.body.style.overflow = "hidden";
}

function closeMobileSidebar() {
  document.body.classList.remove("mobile-sidebar-open");
  const overlay = $("overlay");
  if (overlay) overlay.classList.remove("show");
  document.body.style.overflow = "";
}

// CSP migration (templates/_shell.html's #overlay click, mobile only): was a
// nested ternary picking between closing the sidebar or showing the mobile
// home visual, depending on which mobile UI state is active.
window._overlayClick = function () {
  if (document.body.classList.contains("mobile-sidebar-open")) {
    closeMobileSidebar();
  } else if (
    window.innerWidth <= 720 &&
    !document.body.classList.contains("mob-drilled")
  ) {
    _mobHomeVisual();
  } else {
    closeMobileSidebar();
  }
};

function mobSnavToggle(sectionId, btn) {
  const items = $(`mob-items-${sectionId}`);
  const secBtn = $(`mob-sec-${sectionId}`) || btn;
  if (!items) return;
  const isOpen = items.classList.contains("open");
  if (isOpen) {
    items.style.maxHeight = "0px";
    items.classList.remove("open");
    if (secBtn) secBtn.classList.remove("open");
  } else {
    const count = MOB_SNAV_HEIGHTS[sectionId] || 5;
    items.style.maxHeight = count * 34 + "px";
    items.classList.add("open");
    if (secBtn) secBtn.classList.add("open");
  }
}

// Navigate and close sidebar
function navMob(panelName) {
  nav(panelName, null);
  closeMobileSidebar();
}

// Navigate to AI chat with a prefilled prompt
function navMobAI(feature) {
  nav("chat", null);
  closeMobileSidebar();
  const prompts = {
    "ask-notes": () => {
      setTimeout(() => $("attach-btn")?.click(), 300);
    },
    "study-help": () => {
      setTimeout(() => {
        const ci = $("ci");
        if (ci) {
          ci.value = "Help me plan and structure my study tasks";
          ci.focus();
        }
      }, 300);
    },
    "study-plan": () => {
      setTimeout(() => {
        const ci = $("ci");
        if (ci) {
          ci.value = "Create a personalised weekly study plan for me";
          ci.focus();
        }
      }, 300);
    },
    recommendations: () => {
      setTimeout(() => getSuggestions && getSuggestions(), 400);
    },
  };
  if (prompts[feature]) prompts[feature]();
}

// Swipe left to close sidebar

// Auto-open AI section on first load
document.addEventListener("DOMContentLoaded", () => {
  const aiItems = $("mob-items-ai");
  const aiBtn = $("mob-sec-ai");
  const count = MOB_SNAV_HEIGHTS["ai"] || 4;
  if (aiItems) {
    aiItems.style.maxHeight = count * 34 + "px";
    aiItems.classList.add("open");
  }
  if (aiBtn) aiBtn.classList.add("open");
});

// ═══════════════════════════ SNAV TOGGLE ═════════════════════
function snavToggle(sectionId, btn) {
  const items = $(`snav-items-${sectionId}`);
  const secBtn = $(`snav-sec-${sectionId}`) || btn;
  if (!items) return;
  const isOpen = items.classList.contains("open");
  if (isOpen) {
    items.style.maxHeight = "0px";
    items.classList.remove("open");
    if (secBtn) secBtn.classList.remove("open");
  } else {
    const count = SNAV_SECTION_HEIGHTS[sectionId] || 5;
    items.style.maxHeight = count * 34 + "px";
    items.classList.add("open");
    if (secBtn) secBtn.classList.add("open");
    // Update icon background
    const icon = secBtn ? secBtn.querySelector(".snav-section-icon") : null;
    if (icon) icon.style.background = getSectionColor(sectionId, true);
  }
}

function getSectionColor(sectionId, bg) {
  const map = {
    ai: "#818cf8",
    planner: "#fb923c",
    assessments: "#f472b6",
    insights: "#60a5fa",
  };
  const c = map[sectionId] || "#818cf8";
  return bg ? `${c}22` : c;
}

// Route map: snav item id → { panel, trigger }
const SNAV_ROUTE = {
  // AI
  chat: () => nav("chat", null),
  "ask-notes": () => {
    nav("chat", null);
    setTimeout(() => $("attach-btn")?.click(), 300);
  },
  "generate-quiz": () => nav("quiz", null),
  "study-help-ai": () => {
    nav("chat", null);
    setTimeout(() => {
      const ci = $("ci");
      if (ci) {
        ci.value = "Help me build a study plan";
        ci.focus();
      }
    }, 300);
  },
  // Academics
  announcements: () => nav("announcements", null),
  // Planner
  tasks: () => nav("flux", null),
  notes: () => nav("notes", null),
  "study-deck": () => nav("lab", null),
  "study-plan": () => nav("studyplan", null),
  studyplan: () => nav("studyplan", null),
  // Assessments
  quizzes: () => nav("quiz", null),
  results: () => nav("stats", null),
  // Insights
  recommendations: () => {
    nav("chat", null);
    setTimeout(() => getSuggestions(), 400);
  },
  // Spaces - Personal
  "task-tracker": () => nav("flux", null),
  "content-hub": () => nav("contenthub", null),
  // Spaces - Org
  goals: () => nav("goals", null),
  knowledge: () => nav("notes", null),
  // Global
  "create-new": () => {
    cnOpen();
  },
  settings: () => nav("settings", null),
  templates: () => nav("templates", null),
  "my-templates": () => {
    nav("templates", null);
  },
  "new-template": () => {
    nav("templates", null);
  },
};

let SNAV_ACTIVE = "chat";

function snavSelect(itemId, sectionId, btnEl) {
  // Clear all active states
  document
    .querySelectorAll(".snav-item")
    .forEach((b) => b.classList.remove("active"));
  const dash = $("snav-dash");
  if (dash) dash.classList.remove("active");

  // Set active
  const el = $(`snav-${itemId}`) || btnEl;
  if (el) el.classList.add("active");
  SNAV_ACTIVE = itemId;

  // Open the section if not already
  const items = $(`snav-items-${sectionId}`);
  if (items && !items.classList.contains("open")) snavToggle(sectionId, null);

  // Update sidebar footer name (mirror from topbar)
  const snavName = $("snav-name");
  const tbName = $("tb-name");
  if (snavName && tbName) snavName.textContent = tbName.textContent;
  const snavAv = $("snav-av");
  const tbAv = $("tb-av");
  if (snavAv && tbAv) snavAv.textContent = tbAv.textContent;

  // Execute route
  const route = SNAV_ROUTE[itemId];
  if (route) route();
}

// Sync sidebar active state with new .si[data-panel] system
function syncSnavFromPanel(name) {
  document.querySelectorAll(".si").forEach((b) => b.classList.remove("on"));
  const el = document.querySelector(`.si[data-panel="${name}"]`);
  if (el) el.classList.add("on");
}

// ── Sidebar section collapse ─────────────────────────────────
const SB_SECTIONS = [
  "core",
  "work",
  "grow",
  "connect",
  "org",
  "spaces",
];

// Map panel name → sidebar section id
const PANEL_SECTION_MAP = {
  chat: "core",
  home: "core",
  announcements: "core",
  flux: "work",
  notes: "work",
  calendar: "work",
  templates: "work",
  documenthub: "work",
  goals: "grow",
  habits: "grow",
  stats: "grow",
  journal: "grow",
  progress: "grow",
  finance: "grow",
  review: "grow",
  skills: "grow",
  community: "connect",
  library: "connect",
  opportunities: "connect",
  agents: "connect",
  team: "org",
  projects: "org",
  hr: "org",
  automations: "org",
  orgchat: "org",
  org: "org",
  personal: "spaces",
  academic: "spaces",
};

function sbEnsureExpanded(panelName) {
  const section = PANEL_SECTION_MAP[panelName];
  if (!section) return;
  const items = $("sgi-" + section);
  if (items && items.classList.contains("collapsed")) sbToggleSection(section);
}

function sbToggleSection(id) {
  const items = $("sgi-" + id);
  if (!items) return;
  const hd = items.previousElementSibling;
  const willCollapse = !items.classList.contains("collapsed");
  items.classList.toggle("collapsed", willCollapse);
  if (hd) hd.classList.toggle("collapsed", willCollapse);
  willCollapse
    ? localStorage.setItem("sivarr_sb_" + id, "1")
    : localStorage.removeItem("sivarr_sb_" + id);
}

function sbRestoreCollapse() {
  SB_SECTIONS.forEach((id) => {
    if (localStorage.getItem("sivarr_sb_" + id)) {
      const items = $("sgi-" + id);
      const hd = items?.previousElementSibling;
      if (items) {
        items.classList.add("collapsed");
        hd?.classList.add("collapsed");
      }
    }
  });
}

// New sidebar nav handler
function sidebarNav(btn) {
  const panel = btn.dataset.panel;
  if (!panel) return;
  sbEnsureExpanded(panel);
  nav(panel, null);
}

// ═══════════════════════════ NAV ════════════════════════════════
// Opportunities and Integrations no longer have their own panels/sidebar
// rows (2026-08) — Opportunities is a tab inside Community, Integrations
// (+ the curated Library) is a tab inside Marketplace. Redirecting here,
// at the single chokepoint every nav('opportunities'/'library', ...) call
// already goes through, means every existing caller (⌘K, marketplace
// buttons, space-settings links, etc.) lands in the right place with zero
// per-call-site changes.
// CSP migration: navigate to chat and prefill+focus the input once it's
// rendered -- was two near-duplicate multi-statement inline handlers (one
// of which broke its own attribute quoting via JSON.stringify, exactly
// like the quickPrompt bug above).
window._navChatWithPrefill = function (msg) {
  nav("chat", null);
  setTimeout(() => {
    const ci = $("ci");
    if (ci) {
      ci.value = msg;
      ci.focus();
    }
  }, 300);
};

function nav(name, btn) {
  if (name === "opportunities") {
    nav("community", btn);
    if (typeof commSetMode === "function") {
      const oppBtn = $("comm-mode-opp");
      if (oppBtn) commSetMode("opp", oppBtn);
    }
    return;
  }
  if (name === "library") {
    _mktPendingView = "integrations";
    nav("marketplace", btn);
    return;
  }
  // The standalone Goals panel was retired -- goals now live in the merged
  // Goals & Habits panel (panel-habits, js/features/habits.js). Redirect
  // rather than deleting the "goals" nav entry/keyboard shortcuts/search
  // results that already point at it everywhere.
  if (name === "goals") {
    nav("habits", btn);
    return;
  }
  _pushRecentNav(name);
  if (typeof cmdPushRecent === "function") cmdPushRecent(name);
  // Leaving the org space — tear down the live SSE + presence (it is kept alive
  // across all org tabs, so only a full nav-away should close it).
  if (
    name !== "org" &&
    name !== "orgchat" &&
    typeof _ocDisconnectSSE === "function"
  )
    _ocDisconnectSSE();
  document
    .querySelectorAll(".panel")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-btn, .mn-btn")
    .forEach((b) => b.classList.remove("active"));
  const p = document.getElementById(`panel-${name}`);
  if (p) p.classList.add("active");
  if (btn) btn.classList.add("active");
  const mob = document.getElementById(`mn-${name}`);
  if (mob) mob.classList.add("active");
  // Topbar (and hamburger menu) now stays visible on every panel, not just Home.
  // Mobile: navigating to a real panel marks the drill-down/history state
  // (still used for hardware/OS back-button support via popstate) and closes
  // the hamburger menu overlay if it was open — picking a destination should
  // always dismiss the menu, the same as tapping outside it.
  if (p && window.innerWidth <= 720) {
    document.body.classList.add("mob-drilled");
    _mobPush(name);
    document.body.classList.remove("mobile-sidebar-open");
    $("overlay")?.classList.remove("show");
    document.body.style.overflow = "";
    try {
      localStorage.setItem("sb_last_panel", name);
    } catch (e) {}
  }
  _updateMobileNav(name);
  syncSnavFromPanel(name);
  _trackNav(name);
  if (typeof sbRenderStats === "function") sbRenderStats();

  // ── Paywall guards ──
  const _GUARDED = {
    org: "Pro",
    orgchat: "Pro",
    team: "Pro",
    projects: "Pro",
    founder: "Team",
  };
  if (_GUARDED[name]) {
    // An active org seat subscription unlocks the org-base features for every member,
    // regardless of personal plan. (Founder Mode is a separate paid extension.)
    const orgUnlocked =
      name !== "founder" && !!(_ENTITLEMENTS && _ENTITLEMENTS.org_sub_active);
    if (!orgUnlocked && !_hasPlan(_GUARDED[name])) {
      _showPaywall(name);
      return;
    }
    _removePaywall(name);
  }

  _syncUrlForPanel(name);

  if (name === "chat") {
    chatCounterInit();
    setTimeout(chatProactiveGreet, 400);
    return;
  }
  if (name === "home") {
    loadHome();
    return;
  }
  if (name === "notes") {
    docInit();
    return;
  }
  if (name === "templates") {
    tplInit();
    return;
  }
  if (name === "calendar") {
    calInit();
    return;
  }
  if (name === "skills") {
    skillsInit();
    return;
  }
  if (name === "finance") {
    finInit();
    return;
  }
  if (name === "habits") {
    habitInit();
    return;
  }
  if (name === "journal") {
    journalInit();
    return;
  }
  if (name === "community") {
    communityInit();
    return;
  }
  if (name === "library") {
    integrationsRender();
    return;
  }
  if (name === "marketplace") {
    mktInit();
    return;
  }
  if (name === "stats") loadStats();
  if (name === "more") syncMore();
  if (name === "leaderboard") loadLeaderboard();
  if (name === "announcements") annLoad();
  if (name === "studyplan") {
    $("sp-date") && ($("sp-date").min = new Date().toISOString().split("T")[0]);
    setTimeout(spLoadSaved, 100);
  }
  if (name === "contenthub") chInit();
  if (name === "settings") stInit();
  if (name === "quiz" && !S.quizActive) {
    const qd = $("qd-label");
    if (qd) qd.textContent = S.diff.charAt(0).toUpperCase() + S.diff.slice(1);
  }
  if (name === "orgchat") orgChatInit();
  if (name === "automations") autoInit();
  if (name === "org") orgInit();
  if (name === "profile") profileInit();
  if (name === "trash") trashInit();
  if (name === "personal") psRenderOverview();
  // "academic" has no init here: its only caller, openSpace(), always
  // calls acadInit(sp) itself immediately after nav("academic") — this
  // used to call the (now-removed, dead) Academic Space v1 initializer.
  if (name === "agents") agInit();
  if (name === "review") reviewInit();
}

// Mobile tab bar navigation with smooth pill scroll
// CSP migration: Study Deck's "Flux" cross-link card -- navTab's 2nd arg
// is a DOM lookup by id, not `this`, so delegate.js's grammar can't express
// it directly.
window._navTabFlux = function () {
  navTab("flux", $("tab-flux"));
};
function navTab(name, btn) {
  // Same paywall guard nav() enforces — without it this was a bypass path
  // for any Pro/Team-gated panel name reachable through this function.
  const _GUARDED = {
    org: "Pro",
    orgchat: "Pro",
    team: "Pro",
    projects: "Pro",
    founder: "Team",
  };
  if (_GUARDED[name]) {
    const orgUnlocked =
      name !== "founder" && !!(_ENTITLEMENTS && _ENTITLEMENTS.org_sub_active);
    if (!orgUnlocked && !_hasPlan(_GUARDED[name])) {
      _showPaywall(name);
      return;
    }
    _removePaywall(name);
  }

  document
    .querySelectorAll(".panel")
    .forEach((p) => p.classList.remove("active"));
  const panel = document.getElementById(`panel-${name}`);
  if (panel) panel.classList.add("active");

  document
    .querySelectorAll(".tab-pill")
    .forEach((p) => p.classList.remove("active"));
  if (btn) {
    btn.classList.add("active");
    btn.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }

  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.classList.remove("active"));
  const desktopBtn = document.querySelector(`.nav-btn[onclick*="'${name}'"]`);
  if (desktopBtn) desktopBtn.classList.add("active");

  if (name === "skills") skillsInit();
  if (name === "finance") finInit();
  if (name === "stats") loadStats();
  if (name === "more") syncMore();
  if (name === "leaderboard") loadLeaderboard();
  if (name === "notes") docInit();
  if (name === "announcements") annLoad();
  if (name === "studyplan") {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    $("sp-date") && ($("sp-date").min = new Date().toISOString().split("T")[0]);
  }
  if (name === "contenthub") chInit();
  if (name === "settings") stInit();
  if (name === "goals") glLoad();
  if (name === "quiz" && !S.quizActive) {
    const qd = $("qd-label");
    if (qd) qd.textContent = S.diff.charAt(0).toUpperCase() + S.diff.slice(1);
  }
  if (name === "orgchat") orgChatInit();
  if (name === "automations") autoInit();
  if (name === "org") orgInit();
  if (name === "profile") profileInit();
  if (name === "trash") trashInit();
}

async function getSuggestionsMobile() {
  $("sug-txt-m").textContent = "Thinking...";
  try {
    const r = await fetch(
      `/api/suggest?token=${encodeURIComponent(getToken() || "")}`,
    );
    const d = await r.json();
    $("sug-txt-m").textContent = d.suggestion;
  } catch {
    $("sug-txt-m").textContent = "Couldn't load. Try again.";
  }
}

function syncMore() {
  // Sync topics
  const tl = $("topics-list-m");
  if (tl) tl.innerHTML = $("topics-list").innerHTML;
  // Sync wrong answers
  const wl = $("wrong-list-m");
  if (wl) wl.innerHTML = $("wrong-list").innerHTML;
  const wc = $("wc-m");
  if (wc) wc.textContent = $("wc").textContent;
}

// ═══════════════════════════ HELPERS ════════════════════════════
function updateSBStats() {
  const sqq = $("sq-q");
  if (sqq) sqq.textContent = S.stats.questions;
  const sqqz = $("sq-qz");
  if (sqqz) sqqz.textContent = S.stats.quizzes;
  const sqs = $("sq-s");
  if (sqs) sqs.textContent = S.stats.sessions;
  const sqw = $("sq-w");
  if (sqw) sqw.textContent = S.stats.wrong || 0;
}

function renderTopics(topics, weak) {
  const html = !topics.length
    ? `<span style="color:var(--muted);font-size:.78rem">Ask questions to build your topic list</span>`
    : topics
        .map(
          (t) =>
            `<span class="topic-tag ${weak.includes(t) ? "weak" : ""}">${esc(t)}</span>`,
        )
        .join("");
  const el = $("topics-list");
  if (el) el.innerHTML = html;
  const elm = $("topics-list-m");
  if (elm) elm.innerHTML = html;
}

async function refreshTopics() {
  const _rt = getToken() || "";
  const r = await fetch(
    `/api/progress?sid=${S.sid}&token=${encodeURIComponent(_rt)}`,
  );
  const d = await r.json();
  S.topics = Object.keys(d.topics);
  S.weak = d.weak;
  renderTopics(S.topics, S.weak);
}

// toast() now lives in js/core/dom.js.

async function runStudyHavenP(input) {
  const file = input.files[0];
  if (!file || !S.sid) return;
  await _processLabFile(file, "panel");
  input.value = "";
}

// CSP migration: shared drag-hover toggling for the Lab study-deck drop
// zones (delegate.js has no `this.style.x =` grammar). dragover must
// preventDefault() for the browser to fire drop at all.
window._dropZoneDragOver = function (e, el) {
  e.preventDefault();
  el.classList.add("drag-over");
};
window._dropZoneDragLeave = function (el) {
  el.classList.remove("drag-over");
};

function handleLabDropP(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) _processLabFile(file, "panel");
}

function switchLabTabP(tab, btn) {
  ["summary", "notes", "questions", "flashcards"].forEach((t) => {
    const el = $(`lab-${t}-p`);
    if (el) el.style.display = t === tab ? "block" : "none";
  });
  document
    .querySelectorAll('[data-onclick="switchLabTabP"]')
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  if (tab === "flashcards") sShowFlashcard();
}

function saveLabAsNoteP() {
  _saveLabNote();
}
function downloadLabResultP() {
  _downloadLab();
}

// toggleSHSidebar kept as no-op — superseded by snavToggle
function toggleSHSidebar(btn) {
  snavSelect("tasks", "planner", null);
}

// Init sidebar section heights on load so CSS transitions work
document.addEventListener("DOMContentLoaded", () => {
  Object.entries(SNAV_SECTION_HEIGHTS).forEach(([id, count]) => {
    const el = $(`snav-items-${id}`);
    if (el && el.classList.contains("open")) {
      el.style.maxHeight = count * 34 + "px";
    }
  });
});

// ═══════════════════════════ LECTURE LAB ════════════════════════

let LAB_RESULT_TEXT = "";

function parseLabResult(raw) {
  const summaryMatch = raw.match(/##\s*📋\s*SUMMARY([\s\S]*?)(?=##\s*📚|$)/i);
  const notesMatch = raw.match(
    /##\s*📚\s*STRUCTURED NOTES([\s\S]*?)(?=##\s*❓|$)/i,
  );
  const questMatch = raw.match(/##\s*❓\s*PRACTICE QUESTIONS([\s\S]*?)$/i);
  return {
    summary: summaryMatch ? summaryMatch[1].trim() : raw,
    notes: notesMatch ? notesMatch[1].trim() : "",
    questions: questMatch ? questMatch[1].trim() : "",
  };
}

function renderMarkdown(text) {
  if (!text) return "";
  let h = text
    // Code blocks first (before escaping)
    .replace(
      /```(\w*)\n?([\s\S]*?)```/g,
      (_, lang, code) =>
        `<pre style="background:var(--border);border-radius:8px;padding:.75rem;overflow-x:auto;margin:.4rem 0;font-size:.82rem"><code>${esc(code.trim())}</code></pre>`,
    )
    // Inline code — escape content before inserting to prevent XSS
    .replace(
      /`([^`]+)`/g,
      (_, c) =>
        `<code style="background:var(--border);border-radius:4px;padding:1px 6px;font-size:.85em">${esc(c)}</code>`,
    )
    // Escape remaining HTML
    .replace(/&(?!amp;|lt;|gt;|quot;)/g, "&amp;")
    .replace(/<(?!pre|\/pre|code|\/code)/g, "&lt;")
    // Headings
    .replace(
      /^### (.+)$/gm,
      '<div style="font-family:var(--font);font-size:.9rem;font-weight:700;margin:.6rem 0 .2rem;color:var(--accent)">$1</div>',
    )
    .replace(
      /^## (.+)$/gm,
      '<div style="font-family:var(--font);font-size:1rem;font-weight:800;margin:.7rem 0 .3rem">$1</div>',
    )
    .replace(
      /^# (.+)$/gm,
      '<div style="font-family:var(--font);font-size:1.1rem;font-weight:800;margin:.75rem 0 .3rem">$1</div>',
    )
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Bullet lists
    .replace(
      /^[\-\*] (.+)$/gm,
      '<li style="margin:.15rem 0;padding-left:.25rem">$1</li>',
    )
    .replace(
      /^(\d+)\. (.+)$/gm,
      '<li style="margin:.15rem 0;padding-left:.25rem">$2</li>',
    )
    // Wrap consecutive <li> in <ul>
    .replace(
      /(<li[^>]*>.*?<\/li>\n?)+/g,
      (m) =>
        `<ul style="padding-left:1.25rem;margin:.35rem 0;list-style:disc">${m}</ul>`,
    )
    // Horizontal rule
    .replace(
      /^---$/gm,
      '<hr style="border:none;border-top:1px solid var(--border);margin:.5rem 0">',
    )
    // Line breaks
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
  return typeof DOMPurify !== "undefined"
    ? DOMPurify.sanitize(h, { FORCE_BODY: true })
    : h;
}

async function runStudyHaven(input) {
  const file = input.files[0];
  if (!file || !S.sid) return;
  await _processLabFile(file, "mobile");
  input.value = "";
}

async function runStudyHavenD(input) {
  const file = input.files[0];
  if (!file || !S.sid) return;
  await _processLabFile(file, "desktop");
  input.value = "";
}

function handleLabDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) _processLabFile(file, "mobile");
}

function handleLabDropD(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) _processLabFile(file, "desktop");
}

async function _processLabFile(file, target) {
  const isMobile = target === "mobile";
  const isPanel = target === "panel";
  const sfxMap = { mobile: "", desktop: "-d", panel: "-p" };
  const sfx = sfxMap[target] || "";
  const dropZone = isMobile
    ? $("lab-drop-zone")
    : isPanel
      ? $("lab-drop-zone-p")
      : null;
  const resultDiv = $(`lab-result${sfx}`);
  const fnameEl = $(`lab-filename${sfx}`);

  if (dropZone)
    dropZone.innerHTML = `
    <div style="font-size:1.5rem;margin-bottom:.4rem">⏳</div>
    <div style="font-size:.82rem;color:var(--muted)">Processing "${esc(file.name)}"...</div>
    <div style="font-size:.72rem;color:var(--muted2);margin-top:3px">Takes 10-20 seconds</div>`;
  if (resultDiv) resultDiv.style.display = "none";

  try {
    const fd = new FormData();
    fd.append("token", getToken() || "");
    fd.append("file", file);
    const r = await fetch("/api/study-deck", { method: "POST", body: fd });
    if (!r.ok) {
      const e = await r.json();
      throw new Error(e.detail || "Processing failed");
    }
    const d = await r.json();

    LAB_RESULT_TEXT = d.result;
    const sections = parseLabResult(d.result);
    const sfx = isMobile ? "" : "-d";

    const sum = $(`lab-summary${sfx}`);
    const nts = $(`lab-notes${sfx}`);
    const qst = $(`lab-questions${sfx}`);

    if (sum) sum.innerHTML = renderMarkdown(sections.summary);
    if (nts) nts.innerHTML = renderMarkdown(sections.notes);
    if (qst) qst.innerHTML = renderMarkdown(sections.questions);
    if (fnameEl) fnameEl.textContent = `📄 ${file.name}`;
    if (resultDiv) resultDiv.style.display = "block";
    // Build flashcards from questions section — rendered by the shared
    // engine in academic.js (see sLoadFlashcards).
    if (isPanel)
      sLoadFlashcards(_parseFlashcards(sections.questions), {
        displayId: "lab-flashcards-p",
        tabId: "lab-tab-flash-p",
        emptyMsg: "No flashcards could be generated from this file.",
      });

    if (dropZone)
      dropZone.innerHTML = `
      <div style="font-size:1.75rem;margin-bottom:.4rem">✅</div>
      <div style="font-size:.82rem;color:var(--muted)">Done! Upload another file</div>
      <div style="font-size:.72rem;color:var(--muted2);margin-top:3px">.txt · .pdf · .md</div>`;

    // Activate first tab for correct context
    if (isPanel)
      switchLabTabP(
        "summary",
        document.querySelector('[data-onclick="switchLabTabP"]'),
      );
    else if (isMobile)
      switchLabTab("summary", document.querySelector(".lab-tab"));
    else
      switchLabTabD(
        "summary",
        document.querySelector('[onclick*="switchLabTabD"]'),
      );

    toast(`Study pack ready! ✓`);
  } catch (e) {
    toast("Study Deck: " + e.message);
    if (dropZone)
      dropZone.innerHTML = `
      <div style="font-size:1.75rem;margin-bottom:.4rem">📄</div>
      <div style="font-size:.82rem;color:var(--muted)">Drop file or tap to upload</div>
      <div style="font-size:.72rem;color:var(--muted2);margin-top:3px">.txt · .pdf · .md</div>`;
  }
}

function switchLabTab(tab, btn) {
  ["summary", "notes", "questions"].forEach((t) => {
    const el = $(`lab-${t}`);
    if (el) el.style.display = t === tab ? "block" : "none";
  });
  document
    .querySelectorAll(".lab-tab")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
}

function switchLabTabD(tab, btn) {
  ["summary", "notes", "questions"].forEach((t) => {
    const el = $(`lab-${t}-d`);
    if (el) el.style.display = t === tab ? "block" : "none";
  });
  document
    .querySelectorAll('[onclick*="switchLabTabD"]')
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
}

function saveLabAsNote() {
  _saveLabNote();
}
function saveLabAsNoteD() {
  _saveLabNote();
}
function _saveLabNote() {
  if (!LAB_RESULT_TEXT || !S.sid) {
    toast("No study pack to save.");
    return;
  }
  const notes = JSON.parse(
    localStorage.getItem(`sivarr_notes_${S.sid}`) || "[]",
  );
  notes.unshift({
    text: LAB_RESULT_TEXT,
    date: new Date().toLocaleString() + " (Study Deck)",
  });
  localStorage.setItem(
    `sivarr_notes_${S.sid}`,
    JSON.stringify(notes.slice(0, 50)),
  );
  toast("Saved to My Notes ✓");
}

function downloadLabResult() {
  _downloadLab();
}
function downloadLabResultD() {
  _downloadLab();
}
function _downloadLab() {
  if (!LAB_RESULT_TEXT) {
    toast("No study pack yet.");
    return;
  }
  const blob = new Blob(
    [`Sivarr AI: LECTURE LAB\n${"─".repeat(40)}\n\n${LAB_RESULT_TEXT}`],
    { type: "text/plain" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sivarr_study_pack_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════ STUDENT EXAM SYSTEM ════════════════

let EXAM_STATE = {
  examId: null,
  code: null,
  questions: [],
  answers: {},
  timerInterval: null,
  timeLeft: 0,
  tabSwitches: 0,
  title: "",
};

async function loadLeaderboard() {
  const list = $("leaderboard-list");
  if (!S.sid) return;

  list.innerHTML =
    '<div class="empty-state"><div class="es-icon">⏳</div><div class="es-text">Loading...</div></div>';

  try {
    const r = await fetch("/api/leaderboard");
    const d = await r.json();
    const students = d.leaderboard || [];

    if (!students.length) {
      list.innerHTML =
        '<div class="empty-state"><div class="es-icon">🏆</div><div class="es-text">No rankings yet, take a quiz to appear here!</div></div>';
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    list.innerHTML = students
      .map((s, i) => {
        const isMe = s.sid === S.sid;
        const rank = i + 1;
        return `
        <div class="lb-item ${isMe ? "me" : ""}">
          <div class="lb-rank">${rank <= 3 ? medals[rank - 1] : rank}</div>
          <div class="lb-avatar">${s.name[0].toUpperCase()}</div>
          <div class="lb-info">
            <div class="lb-name">${esc(s.name)} ${isMe ? '<span style="color:var(--accent);font-size:.7rem">(you)</span>' : ""}</div>
            <div class="lb-meta">${s.quizzes} quiz${s.quizzes !== 1 ? "zes" : ""} · ${s.questions} questions</div>
          </div>
          <div class="lb-score">${s.avg_score}%</div>
        </div>`;
      })
      .join("");

    // Show my rank card
    const myRank = students.findIndex((s) => s.sid === S.sid);
    if (myRank !== -1) {
      const me = students[myRank];
      $("my-rank-card").style.display = "block";
      {
        const _e = $("my-rank-num");
        if (_e) _e.textContent = `#${myRank + 1}`;
      }
      {
        const _e = $("my-rank-name");
        if (_e) _e.textContent = me.name;
      }
      {
        const _e = $("my-rank-score");
        if (_e) _e.textContent = `${me.avg_score}% avg · ${me.quizzes} quizzes`;
      }
    }
  } catch (e) {
    list.innerHTML =
      '<div class="empty-state"><div class="es-icon">⚠️</div><div class="es-text">Couldn\'t load leaderboard. Try again.</div></div>';
  }
}

// ═══════════════════════════ PROFILE DROPDOWN ═══════════════════
function toggleProfile() {
  const trigger = $("profile-trigger");
  const dropdown = $("profile-dropdown");
  if (!trigger || !dropdown) return;
  const isOpen = dropdown.classList.contains("open");
  if (isOpen) {
    closeProfile();
  } else {
    trigger.classList.add("open");
    dropdown.classList.add("open");
  }
}

function closeProfile() {
  const t = $("profile-trigger");
  if (t) t.classList.remove("open");
  const d = $("profile-dropdown");
  if (d) d.classList.remove("open");
}

// CSP migration (templates/_shell.html profile dropdown items): each item
// was multi-statement (navigate/act, then close the dropdown) -- delegate.js
// only dispatches to single named functions.
window._navThenCloseProfile = function (panel) {
  nav(panel, null);
  closeProfile();
};
window._showPricingThenCloseProfile = function () {
  showPricing();
  closeProfile();
};
window._triggerPfpInput = function () {
  $("pfp-input")?.click();
};
// Same idea, for the Settings-panel avatar (a second, separate hidden
// <input id="pfp-input-st">) and any other "click this hidden file input"
// site that shows up going forward.
window._triggerFileInputById = function (id) {
  $(id)?.click();
};
// CSP migration: window.open() detached from `window` and called via
// fn.apply(null, ...) throws "Illegal invocation" in some browsers -- this
// wrapper keeps the call properly bound.
window._openExternalLink = function (url) {
  window.open(url, "_blank");
};

document.addEventListener("click", (e) => {
  const menu = $("profile-menu");
  if (menu && !menu.contains(e.target)) closeProfile();
});

// Topbar / profile-menu quick toggle — flips between light and dark
// (resolving "system" to its current effective theme first)
function toggleThemeFromMenu() {
  const mode =
    localStorage.getItem("sivarr_theme_mode") ||
    (localStorage.getItem("sivarr_theme") === "dark" ? "dark" : "light");
  const eff = _resolveTheme(mode);
  stApplyThemeMode(eff === "dark" ? "light" : "dark");
}

function toggleTheme() {
  toggleThemeFromMenu();
}

// Apply saved theme on load
window.addEventListener("DOMContentLoaded", () => {
  sbRestoreCollapse();
  // Apply saved appearance: theme mode (light/dark/system), density, font size
  const mode =
    localStorage.getItem("sivarr_theme_mode") ||
    (localStorage.getItem("sivarr_theme") === "dark" ? "dark" : "light");
  stApplyThemeMode(mode);
  const dens = localStorage.getItem("sivarr_density");
  if (dens === "compact")
    document.documentElement.setAttribute("data-density", "compact");
  if (localStorage.getItem("sivarr_reduce_motion") === "on")
    document.documentElement.setAttribute("data-reduce-motion", "on");
  const fs = parseInt(localStorage.getItem("sivarr_font_scale"));
  if (fs) document.documentElement.style.setProperty("--font-scale", fs / 100);
  // Keep "system" mode reactive to OS theme changes
  if (window.matchMedia) {
    try {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => {
          if (localStorage.getItem("sivarr_theme_mode") === "system")
            stApplyThemeMode("system");
        });
    } catch (_) {}
  }
});

// ═══════════════════════════ FILE UPLOAD ════════════════════════
async function uploadFile(input) {
  const file = input.files[0];
  if (!file || !S.sid) return;
  const zone = $("upload-zone");
  zone.innerHTML = `<div class="uz-icon">⏳</div><div class="uz-text">Uploading ${file.name}...</div>`;

  const formData = new FormData();
  formData.append("token", getToken() || "");
  formData.append("file", file);

  try {
    const r = await fetch("/api/upload", { method: "POST", body: formData });
    if (!r.ok) {
      const e = await r.json();
      throw new Error(e.detail || "Upload failed");
    }
    const d = await r.json();

    // Reset zone
    zone.innerHTML = `<div class="uz-icon">📄</div><div class="uz-text">Drop a file or tap to upload</div><div class="uz-sub">.txt · .pdf · .md supported</div>`;

    // Show summary in chat
    addMsg("sivarr", `📎 File uploaded: ${d.filename}\n\n${d.summary}`);

    // Update file list
    S.uploadedFiles = S.uploadedFiles || [];
    S.uploadedFiles.push({ id: d.file_id, name: d.filename });
    renderFileList();

    toast(`${file.name} uploaded ✓`);
  } catch (e) {
    zone.innerHTML = `<div class="uz-icon">📄</div><div class="uz-text">Drop a file or tap to upload</div><div class="uz-sub">.txt · .pdf · .md supported</div>`;
    toast("Upload failed: " + e.message);
  }
  input.value = "";
}

function handleDrop(e) {
  e.preventDefault();
  $("upload-zone").classList.remove("drag");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  $("file-input").files = dt.files;
  uploadFile($("file-input"));
}

function renderFileList() {
  const list = $("file-list");
  if (!list || !S.uploadedFiles || !S.uploadedFiles.length) return;
  list.innerHTML = S.uploadedFiles
    .map(
      (f) => `
    <div class="file-item">
      <div>
        <div class="fi-name">📄 ${esc(f.name)}</div>
      </div>
      <button class="btn-file-quiz" data-onclick="quizFromFile" data-onclick-arg0="${esc(f.id)}">Quiz me</button>
    </div>`,
    )
    .join("");
}

function quizFromFile(fileId) {
  S.quizFileId = fileId;
  nav(
    "quiz",
    $("mn-quiz") || document.querySelector('.nav-btn[onclick*="quiz"]'),
  );
  startQuizFromFile(fileId);
}

async function startQuizFromFile(fileId) {
  S.quizActive = true;
  S.quizQ = 0;
  S.quizScore = 0;
  S.quizFileId = fileId;
  const qw = $("qw");
  qw.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--muted)">Generating question 1/5 from your document...</div>`;
  const r = await fetch(
    `/api/quiz/question?token=${encodeURIComponent(getToken())}&difficulty=${S.diff}&file_id=${fileId}`,
  );
  const q = await r.json();
  if (q.error) {
    toast(q.error);
    resetQuiz();
    return;
  }
  S.curQ = q;
  renderQ(q);
}

// ═══════════════════════════ DOWNLOAD ═══════════════════════════
// CSP migration: the "Save" button's argument was a DOM expression
// (this.closest(...).querySelector(...).innerText), not `this` itself --
// delegate.js's data-onclick-this only ever passes the element as-is.
window._chatDownloadFromBtn = function (btn) {
  downloadText(btn.closest(".msg").querySelector(".msg-bub").innerText);
};

function downloadText(text) {
  const clean = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
  const blob = new Blob(
    [
      `Sivarr AI Response\n${"─".repeat(40)}\n\n${clean}\n\nDownloaded from Sivarr AI`,
    ],
    { type: "text/plain" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sivarr_answer_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════ SHARE ══════════════════════════════
async function shareResult(score, topic) {
  try {
    const r = await API("/api/share", {
      name: S.name,
      score: score,
      topic: topic,
      difficulty: S.diff,
      type: "quiz",
    });
    const url = window.location.origin + r.url;
    // Copy to clipboard
    await navigator.clipboard.writeText(url);
    toast("Share link copied to clipboard! 🔗");
  } catch (e) {
    toast("Could not create share link. Try again.");
  }
}

//      MOBILE BUTTON
(function () {
  const fab = document.getElementById("mob-fab");
  let dragging = false,
    startX,
    startY,
    initLeft,
    initBottom;

  function getPos() {
    const r = fab.getBoundingClientRect();
    return {
      left: r.left,
      bottom: window.innerHeight - r.bottom,
    };
  }

  fab.addEventListener("pointerdown", (e) => {
    dragging = false;
    const pos = getPos();
    startX = e.clientX;
    startY = e.clientY;
    initLeft = pos.left;
    initBottom = pos.bottom;
    fab.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  fab.addEventListener("pointermove", (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) > 6) dragging = true;
    if (!dragging) return;

    // Clamp within viewport
    const size = 46;
    const margin = 10;
    let newLeft = Math.min(
      Math.max(initLeft + dx, margin),
      window.innerWidth - size - margin,
    );
    let newBottom = Math.min(
      Math.max(initBottom - dy, margin),
      window.innerHeight - size - margin,
    );

    fab.style.left = newLeft + "px";
    fab.style.bottom = newBottom + "px";
    fab.style.right = "auto";
    fab.style.top = "auto";
  });

  fab.addEventListener("pointerup", () => {
    if (!dragging) toggleMobileSidebar(); // treat as tap if no drag
    dragging = false;
  });
})();

// ═══════════════════════════════════════════════════════════════
// FEATURE 1 — QUICK CAPTURE (cmd palette extension)
// ═══════════════════════════════════════════════════════════════

// CSP migration (templates/_modals.html's "Capture as" buttons): mousedown +
// preventDefault() is deliberate -- it must fire before the click that would
// otherwise blur the command-palette input first, same reasoning as the
// docs-editor slash-menu's mousedown use elsewhere in this migration.
window._qcCaptureFromMousedown = function (e, type) {
  e.preventDefault();
  qcCapture(type);
};

function qcCapture(type, textOverride) {
  if (!S.sid) return;
  const text = (
    textOverride != null ? textOverride : $("cmd-input")?.value || ""
  ).trim();
  if (!text) {
    cmdDismiss();
    return;
  }

  const ts = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
  const sid = S.sid;

  if (type === "task") {
    // Was hand-writing to sivarr_tasks_${sid} -- a legacy key the real
    // Tasks panel (js/features/tasks.js, storage key sivarr_sh_${sid})
    // never reads, and which _hydrateFromServer() overwrites wholesale on
    // the next login anyway. Went through and confirmed the capture was
    // genuinely unrecoverable, not just "not shown yet" — a task
    // "✓ Captured" here was silently lost. Uses the real creation path
    // (js/features/tasks.js's window.addTask) instead, same one the
    // proper New Task sheet uses, so it gets real defaults, the real
    // storage key, and a real server sync.
    if (typeof window.addTask === "function") {
      window.addTask({ title: text, priority: "medium" });
      if (typeof window.renderAll === "function") window.renderAll();
    }
    toast(`📋 Task captured: "${text.slice(0, 40)}"`);
  } else if (type === "event") {
    const events = JSON.parse(
      localStorage.getItem(`sivarr_cal_${sid}`) || "[]",
    );
    events.push({
      id: Date.now(),
      title: text,
      date: new Date().toISOString().split("T")[0],
      time: "",
    });
    localStorage.setItem(`sivarr_cal_${sid}`, JSON.stringify(events));
    toast(`📅 Event captured: "${text.slice(0, 40)}"`);
  } else if (type === "journal") {
    const entries = JSON.parse(
      localStorage.getItem(`sivarr_journal_${sid}`) || "[]",
    );
    entries.unshift({ id: Date.now(), text, date: ts, prompt: "" });
    localStorage.setItem(`sivarr_journal_${sid}`, JSON.stringify(entries));
    toast(`📓 Journal entry saved`);
  } else if (type === "goal") {
    const goals = JSON.parse(
      localStorage.getItem(`sivarr_goals_${sid}`) || "[]",
    );
    goals.unshift({
      id: Date.now(),
      title: text,
      progress: 0,
      completed: false,
      created: Date.now(),
    });
    localStorage.setItem(`sivarr_goals_${sid}`, JSON.stringify(goals));
    toast(`🎯 Goal captured: "${text.slice(0, 40)}"`);
  } else if (type === "note") {
    docCaptureNote(text);
    toast(`💡 Note saved to Docs`);
  }

  cmdDismiss();
}

// ═══════════════════════════════════════════════════════════════
// FEATURE 2 — DAILY Sivarr BRIEF
// ═══════════════════════════════════════════════════════════════

function briefCheck() {
  if (!S.sid) return;
  const today = new Date().toDateString();
  const seen = localStorage.getItem(`sivarr_brief_${S.sid}`);
  if (seen === today) return;
  briefBuild();
  $("brief-overlay").classList.add("open");
}

function briefDismiss() {
  if (!S.sid) return;
  localStorage.setItem(`sivarr_brief_${S.sid}`, new Date().toDateString());
  $("brief-overlay")?.classList.remove("open");
}

function briefBuild() {
  const hr = new Date().getHours();
  const tod =
    hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  const firstName = (S.name || "there").split(" ")[0];
  const day = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const greetEl = $("brief-greeting");
  if (greetEl) greetEl.textContent = `${tod}, ${firstName} 👋`;
  const dateEl = $("brief-date-line");
  if (dateEl) dateEl.textContent = day;

  // Build Sivarr message
  let msg = `Here's your day at a glance, ${firstName}. `;
  const tasks = JSON.parse(
    localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
  ).filter((t) => !t.done);
  const habits = JSON.parse(
    localStorage.getItem(`sivarr_habits_${S.sid}`) || "[]",
  );
  const goals = JSON.parse(
    localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
  ).filter((g) => !g.completed);
  const journalLen = JSON.parse(
    localStorage.getItem(`sivarr_journal_${S.sid}`) || "[]",
  ).length;

  if (tasks.length)
    msg += `You have ${tasks.length} task${tasks.length > 1 ? "s" : ""} pending. `;
  if (goals.length)
    msg += `${goals.length} active goal${goals.length > 1 ? "s" : ""} in progress. `;
  if (journalLen > 0)
    msg += `Keep your journaling streak alive. Write something today. `;
  if (!tasks.length && !goals.length)
    msg += `Looks like a clean slate. Great time to set a goal or plan your day.`;

  const msgEl = $("brief-msg");
  if (msgEl) msgEl.textContent = msg;

  // Build chips
  const chips = [];
  const urgentT = tasks.filter((t) => t.priority === "high").slice(0, 2);
  urgentT.forEach((t) =>
    chips.push({ icon: "🔴", label: t.title.slice(0, 28), cls: "urgent" }),
  );

  const streakH = habits.find((h) => (h.streak || 0) > 1);
  if (streakH)
    chips.push({
      icon: "🔥",
      label: `${streakH.streak} day streak`,
      cls: "streak",
    });

  const nextGoal = goals[0];
  if (nextGoal)
    chips.push({ icon: "🎯", label: nextGoal.title.slice(0, 28), cls: "goal" });

  if (!chips.length && tasks.length)
    chips.push({ icon: "📋", label: `${tasks.length} tasks today`, cls: "" });

  const chipsEl = $("brief-chips");
  if (chipsEl) {
    chipsEl.innerHTML = chips
      .slice(0, 4)
      .map(
        (c) =>
          `<div class="brief-chip ${c.cls}">${c.icon} ${esc(c.label)}</div>`,
      )
      .join("");
  }
}

// ═══════════════════════════════════════════════════════════════
// FEATURE 3 — FOCUS MODE
// ═══════════════════════════════════════════════════════════════

const FOCUS = {
  task: "",
  duration: 25 * 60,
  remaining: 25 * 60,
  running: false,
  interval: null,
  session: 1,
  maxSessions: 4,
  totalCirc: 540,
};

function focusStart(taskName, minutes) {
  if (!S.sid) return;
  FOCUS.task = taskName || "Focus Session";
  FOCUS.duration = (minutes || 25) * 60;
  FOCUS.remaining = FOCUS.duration;
  FOCUS.running = false;
  FOCUS.session = 1;
  clearInterval(FOCUS.interval);

  const overlay = $("focus-overlay");
  if (!overlay) return;
  overlay.classList.add("open");

  const screen = $("focus-screen");
  const done = $("focus-done-screen");
  if (screen) screen.style.display = "flex";
  if (done) done.style.display = "none";

  focusRenderState();
  focusUpdateDots();

  const icon = $("focus-play-icon");
  if (icon) icon.className = "ti ti-player-play";
}

function focusToggle() {
  if (FOCUS.running) {
    FOCUS.running = false;
    clearInterval(FOCUS.interval);
    const icon = $("focus-play-icon");
    if (icon) icon.className = "ti ti-player-play";
  } else {
    FOCUS.running = true;
    FOCUS.interval = setInterval(focusTick, 1000);
    const icon = $("focus-play-icon");
    if (icon) icon.className = "ti ti-player-pause";
  }
}

function focusTick() {
  FOCUS.remaining--;
  focusRenderState();
  if (FOCUS.remaining <= 0) {
    clearInterval(FOCUS.interval);
    FOCUS.running = false;
    focusSessionComplete();
  }
}

function focusRenderState() {
  const mins = String(Math.floor(FOCUS.remaining / 60)).padStart(2, "0");
  const secs = String(FOCUS.remaining % 60).padStart(2, "0");
  const timeEl = $("focus-time");
  if (timeEl) timeEl.textContent = `${mins}:${secs}`;

  const pct = 1 - FOCUS.remaining / FOCUS.duration;
  const offset = FOCUS.totalCirc * (1 - pct);
  const ring = $("focus-ring");
  if (ring) ring.style.strokeDashoffset = offset;
}

function focusReset() {
  clearInterval(FOCUS.interval);
  FOCUS.running = false;
  FOCUS.remaining = FOCUS.duration;
  focusRenderState();
  const icon = $("focus-play-icon");
  if (icon) icon.className = "ti ti-player-play";
}

function focusEnd() {
  clearInterval(FOCUS.interval);
  FOCUS.running = false;
  $("focus-overlay")?.classList.remove("open");
}

function focusSessionComplete() {
  // Log session
  const log = JSON.parse(
    localStorage.getItem(`sivarr_focus_log_${S.sid}`) || "[]",
  );
  log.push({
    task: FOCUS.task,
    mins: Math.round(FOCUS.duration / 60),
    ts: Date.now(),
  });
  localStorage.setItem(`sivarr_focus_log_${S.sid}`, JSON.stringify(log));

  // Show post-session screen
  const screen = $("focus-screen");
  const done = $("focus-done-screen");
  if (screen) screen.style.display = "none";
  if (done) done.style.display = "flex";

  const sub = $("focus-done-sub");
  if (sub)
    sub.textContent = `You focused on "${FOCUS.task}" for ${Math.round(FOCUS.duration / 60)} min. Great work!`;

  const inp = $("focus-done-input");
  if (inp) inp.value = "";

  // Dot
  FOCUS.session = Math.min(FOCUS.session + 1, FOCUS.maxSessions);
  focusUpdateDots();
}

function focusUpdateDots() {
  const dots = document.querySelectorAll("#focus-session-dots .fsd");
  dots.forEach((d, i) => {
    d.className = "fsd";
    if (i < FOCUS.session - 1) d.classList.add("fsd-done");
    else if (i === FOCUS.session - 1) d.classList.add("fsd-active");
  });
}

function focusContinue() {
  FOCUS.remaining = FOCUS.duration;
  FOCUS.running = false;
  clearInterval(FOCUS.interval);

  const screen = $("focus-screen");
  const done = $("focus-done-screen");
  if (screen) screen.style.display = "flex";
  if (done) done.style.display = "none";

  focusRenderState();
  const icon = $("focus-play-icon");
  if (icon) icon.className = "ti ti-player-play";
}

function focusFinish() {
  const note = $("focus-done-input")?.value?.trim();
  if (note) {
    const entries = JSON.parse(
      localStorage.getItem(`sivarr_journal_${S.sid}`) || "[]",
    );
    const ts = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
    entries.unshift({
      id: Date.now(),
      text: `[Focus] ${FOCUS.task}: ${note}`,
      date: ts,
    });
    localStorage.setItem(`sivarr_journal_${S.sid}`, JSON.stringify(entries));
  }
  focusEnd();
  toast("Focus session logged ✓");
}

/* ══════════════════════════════════════════════════
   PHASE 5 — SPACE SWITCHER
   ══════════════════════════════════════════════════ */

let _currentSpace = "personal";

function switchSpace(space) {
  _currentSpace = space;
  ["personal", "academic", "org"].forEach((s) => {
    const btn = $("ss-" + s);
    if (btn) btn.classList.toggle("active", s === space);
  });
  // Only the Org section is conditionally hidden — personal/academic sections are always visible
  document.querySelectorAll(".sg-space-org").forEach((el) => {
    el.style.display = space === "org" ? "" : "none";
  });
  // Default panel per space
  const defaults = { personal: "home", academic: "courses", org: "org" };
  nav(defaults[space], null);
}

/* ══════════════════════════════════════════════════
   ORG SPACE — Work Hub
   ══════════════════════════════════════════════════ */

// ORG state — populated from API
 // { id, name, member_role, owner_sid, ... }




























// Board / List toggle (mirrors the personal Flux task views).






// Render whichever task view is active (board always kept fresh for quick switch).










// ── Org seat billing ──────────────────────────────────────────






// ══════════════════════════════════════════════════
//  S3 — GOALS & OKRs
// ══════════════════════════════════════════════════













// ══════════════════════════════════════════════════
//  S8 — Sivarr AI EXECUTIVE BRIEFING
// ══════════════════════════════════════════════════



// ══════════════════════════════════════════════════
//  S23 — FOUNDER MODE
// ══════════════════════════════════════════════════

































/* ══════════════════════════════════════════════════
   PHASE 5 — TEAM CHAT
   ══════════════════════════════════════════════════ */

// ── Org Chat state ────────────────────────────────────────────

 // EventSource
 // setInterval
 // [{id,name,desc}]
 // {channelId: count}
 // set of sids currently online
 // highest message id received via SSE

// Avatar colour palette (seeded by name)





// Idempotent: bring up the org SSE + presence if they aren't already running.
// Called both on org-space entry (so announcements/chat arrive on every tab) and
// when the Chat tab opens — without forcing a redundant reconnect.










// Mobile channel drawer: open/close the retractable sidebar. No arg = toggle.












 // {channel: messages[]} — instant re-render on switch











// ── Emoji picker ──────────────────────────────────────────────






// Close emoji picker on outside click


/* ══════════════════════════════════════════════════
   PHASE 5 — PROJECTS
   ══════════════════════════════════════════════════ */





/* ══════════════════════════════════════════════════
   PHASE 8 — AUTOMATIONS
   ══════════════════════════════════════════════════ */

let _autoBuilderOpen = false;

function autoNew() {
  _autoBuilderOpen = !_autoBuilderOpen;
  const builder = $("auto-builder");
  if (builder) builder.style.display = _autoBuilderOpen ? "flex" : "none";
}

function autoBuilderClose() {
  _autoBuilderOpen = false;
  const builder = $("auto-builder");
  if (builder) builder.style.display = "none";
}

function autoSave() {
  const trigger = $("auto-trigger")?.value;
  const action = $("auto-action")?.value;
  const name = $("auto-rule-name")?.value.trim();
  if (!name) {
    toast("Give your rule a name first.");
    return;
  }

  const key = `sivarr_automations_${S.sid}`;
  const list = JSON.parse(localStorage.getItem(key) || "[]");
  list.push({ id: Date.now(), name, trigger, action, enabled: true });
  localStorage.setItem(key, JSON.stringify(list));

  // Reset form
  if ($("auto-rule-name")) $("auto-rule-name").value = "";
  _autoBuilderOpen = false;
  if ($("auto-builder")) $("auto-builder").style.display = "none";

  autoRenderList();
  toast("Automation rule saved");
}

function autoToggle(id) {
  const key = `sivarr_automations_${S.sid}`;
  const list = JSON.parse(localStorage.getItem(key) || "[]");
  const rule = list.find((r) => r.id === id);
  if (rule) rule.enabled = !rule.enabled;
  localStorage.setItem(key, JSON.stringify(list));
  autoRenderList();
}

function autoDelete(id) {
  const key = `sivarr_automations_${S.sid}`;
  let list = JSON.parse(localStorage.getItem(key) || "[]");
  list = list.filter((r) => r.id !== id);
  localStorage.setItem(key, JSON.stringify(list));
  autoRenderList();
  toast("Rule deleted");
}

const AUTO_TRIGGER_LABELS = {
  task_done: "A task is marked done",
  goal_progress: "Goal reaches 100%",
  habit_streak: "Habit streak hits a milestone",
  daily_open: "I open Sivarr each day",
  focus_complete: "A Focus session completes",
};
const AUTO_ACTION_LABELS = {
  journal_prompt: "Add a journal prompt",
  notify_toast: "Show a notification",
  log_activity: "Log to activity feed",
  celebrate: "Show a celebration 🎉",
  create_task: "Create a follow-up task",
};

function autoRenderList() {
  const key = `sivarr_automations_${S.sid}`;
  const list = JSON.parse(localStorage.getItem(key) || "[]");
  const el = $("auto-list");
  if (!el) return;
  if (!list.length) {
    el.innerHTML =
      '<div class="auto-empty">No rules yet. Create your first automation above.</div>';
    return;
  }
  el.innerHTML = list
    .map(
      (r) => `
    <div class="auto-rule-card">
      <div class="auto-rule-icon">⚡</div>
      <div class="auto-rule-info">
        <div class="auto-rule-name">${escHtml(r.name)}</div>
        <div class="auto-rule-desc">
          When: ${AUTO_TRIGGER_LABELS[r.trigger] || r.trigger} → Then: ${AUTO_ACTION_LABELS[r.action] || r.action}
        </div>
      </div>
      <button class="auto-rule-toggle${r.enabled ? "" : " off"}" data-onclick="autoToggle" data-onclick-args="${esc(JSON.stringify([r.id]))}" title="Toggle rule"></button>
      <button data-onclick="autoDelete" data-onclick-args="${esc(JSON.stringify([r.id]))}" style="background:none;border:none;color:var(--text4);cursor:pointer;font-size:.9rem;padding:4px" title="Delete">✕</button>
    </div>`,
    )
    .join("");
}

function autoInit() {
  autoRenderList();
}

// ── Automation execution engine ───────────────────────────────
function _autoFire(trigger, context = {}) {
  if (!S.sid) return;
  const key = `sivarr_automations_${S.sid}`;
  const rules = JSON.parse(localStorage.getItem(key) || "[]");
  rules
    .filter((r) => r.enabled && r.trigger === trigger)
    .forEach((r) => _autoRunAction(r, context));
}

function _autoRunAction(rule, context) {
  switch (rule.action) {
    case "notify_toast":
      toast(`⚡ ${rule.name}`);
      break;

    case "celebrate":
      toast(`🎉 ${rule.name}`);
      // Brief confetti burst using DOM
      _autoCelebrate();
      break;

    case "journal_prompt":
      nav("journal", null);
      setTimeout(() => {
        const ta = $("journal-text");
        if (ta && !ta.value) {
          ta.value =
            context.journalPrompt || `Reflection triggered by: ${rule.name}. `;
          ta.focus();
        }
      }, 400);
      break;

    case "create_task": {
      const title = context.followUpTask || `Follow-up: ${rule.name}`;
      if (typeof window.addTask === "function") {
        window.addTask({ title, priority: "medium" });
        if (typeof window.renderAll === "function") window.renderAll();
      }
      toast(`✅ Task created: "${title}"`);
      break;
    }

    case "log_activity":
      _recordActivity();
      toast(`📋 Activity logged: ${rule.name}`);
      break;
  }
}

function _autoCelebrate() {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:99999;overflow:hidden";
  const emojis = ["🎉", "✨", "🎊", "⭐", "🏆"];
  for (let i = 0; i < 18; i++) {
    const el = document.createElement("div");
    el.textContent = emojis[i % emojis.length];
    el.style.cssText = `position:absolute;font-size:${1.5 + Math.random()}rem;left:${Math.random() * 100}%;top:-2rem;
      animation:confettiFall ${1.2 + Math.random() * 1.2}s ease-in forwards;animation-delay:${Math.random() * 0.5}s`;
    overlay.appendChild(el);
  }
  document.body.appendChild(overlay);
  if (!document.querySelector("#confetti-style")) {
    const s = document.createElement("style");
    s.id = "confetti-style";
    s.textContent =
      "@keyframes confettiFall{to{transform:translateY(110vh) rotate(720deg);opacity:0}}";
    document.head.appendChild(s);
  }
  setTimeout(() => overlay.remove(), 2500);
}


/* ══════════════════════════════════════════════════
   PHASE 7 — USER PROFILE
   ══════════════════════════════════════════════════ */

async function profileInit() {
  if (!S.sid) return;
  const key = `sivarr_profile_${S.sid}`;
  const prof = JSON.parse(localStorage.getItem(key) || "{}");

  // Avatar + name
  const av = $("profile-av-lg");
  if (av) av.textContent = (S.name || "?").charAt(0).toUpperCase();
  const nameEl = $("profile-name-disp");
  if (nameEl) nameEl.textContent = S.name || "Your Name";
  const bioEl = $("profile-bio-disp");
  if (bioEl) bioEl.textContent = prof.bio || "Click to add a bio…";

  // Data from all panels
  const goals = JSON.parse(
    localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
  );
  const tasks = JSON.parse(
    localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
  );
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const journal = JSON.parse(localStorage.getItem(JNL_KEY()) || "[]");
  const skills = _skData().skills || [];

  // Stats
  if ($("ps-goals")) $("ps-goals").textContent = goals.length;
  if ($("ps-tasks"))
    $("ps-tasks").textContent = tasks.filter((t) => t.done).length;
  if ($("ps-skills")) $("ps-skills").textContent = skills.length;
  if ($("ps-habits")) $("ps-habits").textContent = habits.length;
  if ($("ps-journal")) $("ps-journal").textContent = journal.length;

  // Fetch post count
  let postCount = 0;
  let myPosts = [];
  try {
    const r = await fetch(`/api/community/posts?limit=100`);
    const d = await r.json();
    myPosts = (d.posts || []).filter((p) => p.sid === S.sid);
    postCount = myPosts.length;
  } catch (_) {}
  if ($("ps-posts")) $("ps-posts").textContent = postCount;

  // Achievements
  profileRenderAchievements(goals, tasks, habits, journal, skills, myPosts);

  // Skills — from new Skills panel
  const sl = $("profile-skills-list");
  if (sl) {
    if (!skills.length) {
      sl.innerHTML = `<div style="font-size:.82rem;color:var(--text4);padding:6px 0">No skills tracked yet, <button data-onclick="nav" data-onclick-args="[&quot;skills&quot;,null]" style="background:none;border:none;color:var(--accent);cursor:pointer;font-family:var(--font);font-size:.82rem;padding:0">add one →</button></div>`;
    } else {
      sl.innerHTML =
        skills
          .slice(0, 5)
          .map((k) => {
            const lv = _skLevel(k.level || 0);
            return `<div class="profile-skill-row" data-onclick="nav" data-onclick-args="[&quot;skills&quot;,null]">
          <span style="font-size:1.1rem">${k.emoji || "💡"}</span>
          <div style="flex:1;min-width:0">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
              <span style="font-size:.82rem;font-weight:600">${esc(k.name)}</span>
              <span style="font-size:.68rem;color:var(--text3)">${lv.label} · ${k.level || 0}%</span>
            </div>
            <div style="height:4px;background:var(--border2);border-radius:3px;overflow:hidden">
              <div style="height:4px;width:${k.level || 0}%;background:${lv.color};border-radius:3px"></div>
            </div>
          </div>
        </div>`;
          })
          .join("") +
        (skills.length > 5
          ? `<div style="font-size:.72rem;color:var(--text3);padding:6px 0">+${skills.length - 5} more</div>`
          : "");
    }
  }

  // My Posts
  const pl = $("profile-posts-list");
  if (pl) {
    if (!myPosts.length) {
      pl.innerHTML = `<div style="font-size:.82rem;color:var(--text4);padding:6px 0">No posts yet, <button data-onclick="nav" data-onclick-args="[&quot;community&quot;,null]" style="background:none;border:none;color:var(--accent);cursor:pointer;font-family:var(--font);font-size:.82rem;padding:0">share something →</button></div>`;
    } else {
      pl.innerHTML = myPosts
        .slice(0, 5)
        .map((p) => {
          const likes = (p.likes || []).length;
          const reps = (p.replies || []).length;
          return `<div class="profile-post-item" data-onclick="nav" data-onclick-args="[&quot;community&quot;,null]">
          <div class="profile-post-body">${esc((p.body || "").slice(0, 120))}${p.body?.length > 120 ? "…" : ""}</div>
          <div class="profile-post-meta">
            <span>❤️ ${likes}</span><span>💬 ${reps}</span>
            <span>${_timeAgo(p.created)}</span>
            ${p.category !== "general" ? `<span class="feat-badge" style="font-size:.65rem">${esc(p.category)}</span>` : ""}
          </div>
        </div>`;
        })
        .join("");
    }
  }
}

function profileRenderAchievements(
  goals,
  tasks,
  habits,
  journal,
  skills,
  posts,
) {
  const grid = $("achievements-grid");
  if (!grid) return;
  const tasksDone = tasks.filter((t) => t.done).length;
  const bestStreak = habits.reduce(
    (m, h) => Math.max(m, h.best_streak || h.streak || 0),
    0,
  );
  const totalSkillHrs = (skills || []).reduce(
    (s, k) => s + Math.round((k.total_mins || 0) / 60),
    0,
  );
  const finData = _finData();
  const hasTx = (finData.transactions || []).length > 0;

  const badges = [
    tasksDone >= 1 && { icon: "✅", label: "First Task Done" },
    tasksDone >= 10 && { icon: "🏆", label: "10 Tasks Crushed" },
    tasksDone >= 50 && { icon: "💎", label: "50 Tasks Done" },
    goals.length >= 1 && { icon: "🎯", label: "Goal Setter" },
    goals.filter((g) => g.completed).length >= 1 && {
      icon: "🏅",
      label: "Goal Achieved",
    },
    journal.length >= 1 && { icon: "📓", label: "First Journal Entry" },
    journal.length >= 10 && { icon: "✍️", label: "10 Journal Entries" },
    bestStreak >= 3 && { icon: "🔥", label: `${bestStreak}-Day Streak` },
    bestStreak >= 30 && { icon: "🌟", label: "30-Day Streak" },
    habits.length >= 1 && { icon: "🔁", label: "Habit Builder" },
    (skills || []).length >= 1 && { icon: "🧠", label: "Skill Tracked" },
    (skills || []).length >= 5 && { icon: "💡", label: "5 Skills" },
    totalSkillHrs >= 10 && { icon: "⚡", label: "10h Practiced" },
    hasTx && { icon: "💰", label: "Finance Tracker" },
    (posts || []).length >= 1 && { icon: "👥", label: "Community Member" },
    (posts || []).length >= 5 && { icon: "📢", label: "Active Contributor" },
  ].filter(Boolean);

  if (!badges.length) {
    grid.innerHTML =
      '<div class="achieve-empty">Complete tasks, set goals, track habits, and log skills to earn badges.</div>';
    return;
  }
  grid.innerHTML = badges
    .map(
      (b) =>
        `<div class="achieve-badge"><span class="a-icon">${b.icon}</span>${escHtml(b.label)}</div>`,
    )
    .join("");
}

function profileRenderSkills(skills) {
  const wrap = $("skills-wrap");
  if (!wrap) return;
  wrap.innerHTML =
    skills
      .map(
        (s, i) =>
          `<span class="skill-tag">${escHtml(s)}<button data-onclick="profileRemoveSkill" data-onclick-args="[${i}]">✕</button></span>`,
      )
      .join("") +
    `<button class="skill-add-btn" data-onclick="profileAddSkill">+ Add skill</button>`;
}

async function profileEditBio() {
  const key = `sivarr_profile_${S.sid}`;
  const prof = JSON.parse(localStorage.getItem(key) || "{}");
  const bio = await siModal.input(
    "Edit Bio",
    "Tell people about yourself…",
    prof.bio || "",
    { confirmLabel: "Save Bio" },
  );
  if (bio === null) return;
  prof.bio = bio;
  localStorage.setItem(key, JSON.stringify(prof));
  const bioEl = $("profile-bio-disp");
  if (bioEl) bioEl.textContent = bio || "Click to add a bio…";
}

async function profileAddSkill() {
  const skill = await siModal.input(
    "Add Skill",
    "e.g. Python, Design, Leadership",
    "",
    { confirmLabel: "Add" },
  );
  if (!skill) return;
  const key = `sivarr_profile_${S.sid}`;
  const prof = JSON.parse(localStorage.getItem(key) || "{}");
  prof.skills = prof.skills || [];
  prof.skills.push(skill.trim());
  localStorage.setItem(key, JSON.stringify(prof));
  profileRenderSkills(prof.skills);
}

function profileRemoveSkill(idx) {
  const key = `sivarr_profile_${S.sid}`;
  const prof = JSON.parse(localStorage.getItem(key) || "{}");
  prof.skills = (prof.skills || []).filter((_, i) => i !== idx);
  localStorage.setItem(key, JSON.stringify(prof));
  profileRenderSkills(prof.skills);
}

/* ════════════════════════════════════════════════════════════
   SPACES — server sync layer
════════════════════════════════════════════════════════════ */

function _spToken() {
  return getToken() || "";
}

async function _spFetch(url, body) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: _spToken(), ...body }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Seed localStorage from server data (called on login/restore)
function seedSpacesFromServer(serverSpaces) {
  // Build the spaces list from server, merging with any local-only entries
  const existing = JSON.parse(localStorage.getItem(spacesKey()) || "[]");
  const serverIds = new Set(serverSpaces.map((s) => s.id));

  // Keep local spaces that the server doesn't know about yet (just created, pending sync)
  const localOnly = existing.filter((s) => !serverIds.has(s.id));

  const merged = [
    ...serverSpaces.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      icon: s.icon,
    })),
    ...localOnly,
  ];
  localStorage.setItem(spacesKey(), JSON.stringify(merged));

  // Seed each space's data blob
  serverSpaces.forEach((s) => {
    if (s.data && Object.keys(s.data).length) {
      const key = spaceDataKey(s.id);
      // Only overwrite if server has data; don't clobber a richer local cache
      const local = JSON.parse(localStorage.getItem(key) || "{}");
      const serverTs = s.data._updatedAt || 0;
      const localTs = local._updatedAt || 0;
      if (serverTs >= localTs) {
        localStorage.setItem(key, JSON.stringify(s.data));
      }
    }
  });
}

// Sync space metadata to server (fire-and-forget; surfaces the plan-cap 402)
async function syncSpaceMeta(space) {
  try {
    const r = await fetch("/api/spaces/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: _spToken(), space }),
    });
    if (r.status === 402) {
      const d = await r.json().catch(() => ({}));
      toast(d.detail || "Upgrade to add more spaces.");
      billingLoadStatus();
      if (typeof showPricing === "function") showPricing();
    }
  } catch (_) {}
}

// Debounced space data save to server
const _spDataTimers = {};
function syncSpaceData(id, data) {
  clearTimeout(_spDataTimers[id]);
  _spDataTimers[id] = setTimeout(() => {
    _spFetch("/api/spaces/data/save", { space_id: id, data });
  }, 1500);
}

/* ════════════════════════════════════════════════════════════
   SPACES — management layer
════════════════════════════════════════════════════════════ */

// ── Storage helpers ──────────────────────────────────────────
function spacesKey() {
  return `sivarr_spaces_${S.sid}`;
}
function spaceDataKey(id) {
  return `sivarr_sp_${S.sid}_${id}`;
}

function getSpaces() {
  return JSON.parse(localStorage.getItem(spacesKey()) || "[]");
}
function saveSpaces(list) {
  localStorage.setItem(spacesKey(), JSON.stringify(list));
}
function getSpaceData(id) {
  return JSON.parse(localStorage.getItem(spaceDataKey(id)) || "{}");
}
function setSpaceData(id, data) {
  // Tag with timestamp so server/client can resolve conflicts
  data._updatedAt = Date.now();
  localStorage.setItem(spaceDataKey(id), JSON.stringify(data));
  syncSpaceData(id, data);
}

// ── Sidebar render ───────────────────────────────────────────
function spaceRenderSidebar() {
  const list = $("sb-spaces-list");
  if (!list) return;
  const spaces = getSpaces();

  // Ensure the Org hub entry exists (one org per account — backend singleton).
  // Use the real organization name once ORG has loaded; fall back until then.
  const orgRow = spaces.find((s) => s.id === "org");
  if (!orgRow) {
    spaces.unshift({
      id: "org",
      name: (ORG && ORG.name) || "Organisation Hub",
      type: "org",
      icon: "🏢",
    });
    saveSpaces(spaces);
  } else if (ORG && ORG.name && orgRow.name !== ORG.name) {
    orgRow.name = ORG.name;
    saveSpaces(spaces);
  }

  // Dot colour + type label per space type
  const dotColor = {
    personal: "#185FA5",
    academic: "#EF9F27",
    org: "var(--teal)",
    default: "var(--purple)",
  };
  const typeLabel = { personal: "You", academic: "Academic", org: "Org" };

  list.innerHTML = spaces
    .map((sp) => {
      const col = dotColor[sp.type] || dotColor.default;
      const meta = typeLabel[sp.type] || "";
      return `<button class="si sp-si" id="sb-space-row-${sp.id}" data-tip="${sp.name}" data-tip-pos="right" data-onclick="openSpace" data-onclick-arg0="${sp.id}">
      <span class="si-ic sp-si-dot" style="color:${col};font-size:10px">●</span>
      <span class="si-lb">${sp.name}</span>
      ${meta ? `<span class="si-stat">${meta}</span>` : ""}
      <span class="sb-space-more" data-onclick="spMoreMenu" data-onclick-arg0="${sp.id}" data-onclick-this title="Options">
        <i class="ti ti-dots-vertical" style="font-size:12px;color:var(--text4)"></i>
      </span>
    </button>`;
    })
    .join("");

  // Restore the Spaces dropdown collapse state.
  try {
    const collapsed = localStorage.getItem("sivarr_spaces_collapsed") === "1";
    const grp = $("sgi-spaces"),
      head = $("sb-spaces-head");
    if (grp) grp.classList.toggle("collapsed", collapsed);
    if (head) head.classList.toggle("collapsed", collapsed);
  } catch (e) {}
}

// Collapse/expand the sidebar Spaces dropdown (persisted).
function spacesToggle() {
  const grp = $("sgi-spaces"),
    head = $("sb-spaces-head");
  if (!grp) return;
  const collapsed = !grp.classList.contains("collapsed");
  grp.classList.toggle("collapsed", collapsed);
  if (head) head.classList.toggle("collapsed", collapsed);
  try {
    localStorage.setItem("sivarr_spaces_collapsed", collapsed ? "1" : "0");
  } catch (e) {}
}

// ── Open a space ─────────────────────────────────────────────
function openSpace(id) {
  const spaces = getSpaces();
  const sp = spaces.find((s) => s.id === id);
  if (!sp) return;
  window.currentSpace = sp; // track the open space (any type) for extension mounting

  // Highlight active row (reuse .si.on style)
  document
    .querySelectorAll(".sp-si")
    .forEach((el) => el.classList.remove("on"));
  const row = $(`sb-space-row-${id}`);
  if (row) row.classList.add("on");

  if (sp.type === "org") {
    nav("org");
    return;
  }
  if (sp.type === "personal") {
    // Set name in panel
    const nameEl = $("ps-space-name");
    if (nameEl) nameEl.textContent = sp.name;
    nav("personal");
    psInit(id);
    return;
  }
  if (sp.type === "academic") {
    nav("academic");
    acadInit(sp);
    return;
  }
}

// ── Tab switching ─────────────────────────────────────────────
function spTab(prefix, pane, btn) {
  const panel = document.getElementById(
    `panel-${prefix === "ps" ? "personal" : "academic"}`,
  );
  if (!panel) return;
  panel.querySelectorAll(".sp-pane").forEach((p) => p.classList.remove("on"));
  panel.querySelectorAll(".sp-tab").forEach((t) => t.classList.remove("on"));
  const target = panel.querySelector(`#${prefix}-pane-${pane}`);
  if (target) target.classList.add("on");
  if (btn) btn.classList.add("on");
}

// ── Rename wrappers (HTML panels use type names, not space IDs) ──
function spRenameByType(type) {
  const sp = getSpaces().find((s) => s.type === type);
  if (sp) spRename(sp.id);
}

// ── Rename space ──────────────────────────────────────────────
async function spRename(id) {
  const spaces = getSpaces();
  const sp = spaces.find((s) => s.id === id);
  if (!sp) return;
  const name = await siModal.input("Rename Space", sp.name, sp.name, {
    confirmLabel: "Rename",
  });
  if (!name || !name.trim()) return;
  sp.name = name.trim();
  saveSpaces(spaces);
  if (id !== "org") syncSpaceMeta(sp);
  spaceRenderSidebar();
  // Update panel name display
  const nameEl =
    id === "org"
      ? $("os-space-name")
      : $(`${sp.type === "personal" ? "ps" : "ac"}-space-name`);
  if (nameEl) nameEl.textContent = sp.name;
}

// ── More-menu ─────────────────────────────────────────────────
function spMoreMenu(id, btn) {
  const spaces = getSpaces();
  const sp = spaces.find((s) => s.id === id);
  if (!sp) return;
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = "position:fixed;z-index:9999;";
  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 4 + "px";
  menu.style.left = r.left + "px";
  const isOrgOwner =
    sp.id === "org" &&
    ORG &&
    (ORG.member_role === "owner" || ORG.owner_sid === S.sid);
  menu.innerHTML = `
    <div class="ctx-item" data-onclick="openSpaceSettingsById" data-onclick-arg0="${id}"><i class="ti ti-settings"></i> Settings &amp; extensions</div>
    <div class="ctx-item" data-onclick="spRename" data-onclick-arg0="${id}"><i class="ti ti-pencil"></i> Rename</div>
    ${sp.id !== "org" ? `<div class="ctx-item ctx-danger" data-onclick="spDelete" data-onclick-arg0="${id}"><i class="ti ti-trash"></i> Delete</div>` : ""}
    ${isOrgOwner ? `<div class="ctx-item ctx-danger" data-onclick="orgDeleteFlow"><i class="ti ti-trash"></i> Delete Organization</div>` : ""}
  `;
  document.body.appendChild(menu);
  const remove = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("click", remove);
    }
  };
  setTimeout(() => document.addEventListener("click", remove), 0);
}

async function spDelete(id) {
  const spaces = getSpaces();
  const sp = spaces.find((s) => s.id === id);
  if (!sp || sp.id === "org") return;
  if (
    !(await siModal.confirmTyped(
      `"${esc(sp.name)}" and all its data will be permanently deleted. This cannot be undone.`,
      sp.name,
      { title: "Delete Space", confirmLabel: "Delete Space", danger: true },
    ))
  )
    return;
  saveSpaces(spaces.filter((s) => s.id !== id));
  localStorage.removeItem(spaceDataKey(id));
  _spFetch("/api/spaces/delete", { space_id: id });
  spaceRenderSidebar();
  nav("home");
}

// ── Delete Organization (owner-only, typed confirmation) ────────
async function orgDeleteFlow() {
  if (!ORG) return;
  const isOwner = ORG.member_role === "owner" || ORG.owner_sid === S.sid;
  if (!isOwner) {
    toast("Only the owner can delete the organization.");
    return;
  }
  const confirmed = await siModal.confirmTyped(
    `This permanently deletes "${esc(ORG.name)}" for every member. All shared tasks, docs, goals, announcements, and chat history will be lost. This cannot be undone.`,
    ORG.name,
    {
      title: "Delete Organization",
      confirmLabel: "Delete Organization",
      danger: true,
    },
  );
  if (!confirmed) return;
  const token = getToken();
  try {
    await API("/api/org/delete", { token, confirm_name: ORG.name });
    toast("Organization deleted");
    try {
      localStorage.removeItem(`sivarr_org_logo_${ORG.id}`);
    } catch (_) {}
    ORG = null;
    ORG_MEMBERS = [];
    ORG_TASKS = [];
    ORG_PROJECTS = [];
    ORG_DOCS = [];
    ORG_GOALS = [];
    ORG_FOUNDER = {};
    // Reset the sidebar's synthetic org entry back to its default label —
    // orgInit() shows the create-org setup card next time it's opened,
    // since /api/org/get will correctly report no org for this user now.
    const spaces = getSpaces();
    const orgRow = spaces.find((s) => s.id === "org");
    if (orgRow) {
      orgRow.name = "Organisation Hub";
      saveSpaces(spaces);
    }
    spaceRenderSidebar();
    nav("home");
  } catch (e) {
    toast(e.message || "Could not delete organization.");
  }
}

// ── Create Space modal ────────────────────────────────────────
let _cspType = "personal";

function openCreateSpaceModal() {
  _cspType = "";
  const modal = $("create-space-modal");
  if (!modal) return;
  modal
    .querySelectorAll(".csp-type")
    .forEach((el) => el.classList.remove("selected"));
  const inp = $("csp-name-input");
  if (inp) inp.value = "";
  const nameRow = $("csp-name-row");
  const footer = $("csp-footer");
  if (nameRow) nameRow.style.display = "none";
  if (footer) footer.style.display = "none";
  modal.style.display = "flex";
}
function closeCreateSpaceModal() {
  const modal = $("create-space-modal");
  if (modal) modal.style.display = "none";
}
function cspSelectType(type, el) {
  _cspType = type;
  document
    .querySelectorAll(".csp-type")
    .forEach((c) => c.classList.remove("selected"));
  el.classList.add("selected");
  const nameRow = $("csp-name-row");
  const footer = $("csp-footer");
  const roleStep = $("acadRoleStep");
  if (roleStep) roleStep.style.display = type === "academic" ? "block" : "none";
  if (type === "academic") acadSelectRole("student"); // default selection
  if (nameRow) {
    nameRow.style.display = "block";
    $("csp-name-input")?.focus();
  }
  if (footer) footer.style.display = "flex";
}
async function cspCreate() {
  const inp = $("csp-name-input");
  const name = inp ? inp.value.trim() : "";
  if (!_cspType) {
    toast("Please select a space type.");
    return;
  }
  if (!name) {
    inp && inp.focus();
    return;
  }
  const type = _cspType;
  if (type === "org") {
    // Org is a backend singleton: create (or open the existing) organization,
    // then pin it beneath Spaces. The org row auto-renders via spaceRenderSidebar
    // and picks up the real name once orgInit() loads ORG.
    const token = getToken() || "";
    try {
      const r = await API("/api/org/create", { token, name });
      if (r && r.ok) {
        toast(`${r.name || name} workspace created! Loading…`);
        sessionStorage.setItem("sivarr_post_create", "org");
        closeCreateSpaceModal();
        setTimeout(() => location.reload(), 800);
      }
    } catch (e) {
      if (e.status === 409) {
        // Already have an org (one per account) — just open it.
        toast("Loading your organization…");
        closeCreateSpaceModal();
        spaceRenderSidebar();
        openSpace("org");
        return;
      }
      toast(e.message || "Could not create space");
    }
    return;
  }
  const icon = type === "personal" ? "👤" : "🎓";
  const id = `sp_${Date.now()}`;
  const space = { id, name, type, icon };
  if (type === "academic") space.academic_role = _cspAcadRole || "student";
  const spaces = getSpaces();
  spaces.push(space);
  saveSpaces(spaces);
  syncSpaceMeta(space);
  // Persist the academic role into the space data blob (round-trips to Postgres,
  // survives fresh loads where the meta list is rebuilt from the server).
  if (type === "academic")
    setSpaceData(id, { academic_role: space.academic_role });
  spaceRenderSidebar();
  closeCreateSpaceModal();
  openSpace(id);
}

/* ════════════════════════════════════════════════════════════
   PERSONAL SPACE (ps-*)
════════════════════════════════════════════════════════════ */
let _psId = null;

function psInit(id) {
  _psId = id;
  // Show first pane
  spTab("ps", "overview", document.querySelector("#panel-personal .sp-tab"));
  psRenderOverview();
  hostMountExtensions(
    window.currentSpace || { id: id || "personal", type: "personal" },
  );
}

function psData() {
  return getSpaceData(_psId || "personal");
}
function psSave(d) {
  setSpaceData(_psId || "personal", d);
}

function psRenderOverview() {
  const d = psData();
  const done = (d.tasks || []).filter((t) => t.done).length;
  const goals = (d.goals || []).length;
  const bestStreak = (d.habits || []).reduce(
    (mx, h) => Math.max(mx, h.streak || 0),
    0,
  );
  const now = new Date();
  const entries = (d.journal || []).filter((e) => {
    const d2 = new Date(e.id);
    return (
      d2.getMonth() === now.getMonth() && d2.getFullYear() === now.getFullYear()
    );
  }).length;

  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = v;
  };
  set("ps-done-today", done);
  set("ps-active-goals", goals);
  set("ps-habit-streak", bestStreak + "🔥");
  set("ps-journal-month", entries);
  set("ps-streak", d.streak || 0);
}

// Tasks / Kanban
async function psNewTask() {
  const goals = JSON.parse(
    localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
  ).filter((g) => !g.completed);
  const goalOpts = [
    { value: "", label: "None" },
    ...goals.map((g) => ({ value: String(g.id), label: g.title })),
  ];
  const f = await siModal.form(
    "New Task",
    [
      {
        id: "title",
        label: "What needs to be done?",
        placeholder: "e.g. Finish assignment",
        required: true,
      },
      { id: "due_date", label: "Due date (optional)", type: "date" },
      {
        id: "priority",
        label: "Priority",
        type: "select",
        default: "medium",
        options: [
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
      },
      {
        id: "goalId",
        label: "Link to goal (optional)",
        type: "select",
        default: "",
        options: goalOpts,
      },
    ],
    { confirmLabel: "Add Task" },
  );
  if (!f?.title) return;
  const d = psData();
  d.tasks = d.tasks || [];
  d.tasks.push({
    id: Date.now(),
    title: f.title,
    status: "todo",
    done: false,
    created: Date.now(),
    due_date: f.due_date || null,
    priority: f.priority || "medium",
    goalId: f.goalId || null,
  });
  psSave(d);
  psRenderKanban();
}

function psRenderKanban() {
  const kanban = $("ps-kanban");
  if (!kanban) return;
  const d = psData();
  const tasks = d.tasks || [];
  const cols = [
    { key: "todo", label: "To Do" },
    { key: "inprogress", label: "In Progress" },
    { key: "done", label: "Done" },
  ];
  kanban.innerHTML = cols
    .map((col) => {
      const items = tasks.filter((t) => t.status === col.key);
      return `<div class="os-col" style="min-width:200px;max-width:260px;flex:1">
      <div class="os-col-hd">
        <span class="os-col-title">${col.label}</span>
        <span class="os-col-count">${items.length}</span>
      </div>
      <div class="os-col-body">
        ${items
          .map((t) => {
            const today8601 = new Date().toISOString().split("T")[0];
            const overdue = t.due_date && t.due_date < today8601 && !t.done;
            const priColor =
              t.priority === "high"
                ? "var(--red3,#f87171)"
                : t.priority === "low"
                  ? "var(--green3,#34d399)"
                  : "var(--amber3,#f59e0b)";
            return `<div class="os-task-card" data-onclick="psMoveTask" data-onclick-args="[${t.id}]">
            <span class="os-task-title">${esc(t.title)}</span>
            <div style="display:flex;gap:5px;align-items:center;margin-top:4px;flex-wrap:wrap">
              ${t.priority ? `<span style="font-size:.65rem;color:${priColor}">${t.priority}</span>` : ""}
              ${t.due_date ? `<span style="font-size:.65rem;color:${overdue ? "var(--red3,#f87171)" : "var(--text4)"}">${overdue ? "⚠ " : ""}${t.due_date}</span>` : ""}
            </div>
          </div>`;
          })
          .join("")}
        <button class="os-add-task-btn" data-onclick="psNewTask"><i class="ti ti-plus"></i> Add task</button>
      </div>
    </div>`;
    })
    .join("");
}

function psMoveTask(id) {
  const d = psData();
  const t = (d.tasks || []).find((t) => t.id === id);
  if (!t) return;
  const order = ["todo", "inprogress", "done"];
  const next = order[(order.indexOf(t.status) + 1) % order.length];
  t.status = next;
  t.done = next === "done";
  if (next === "done") {
    _recordActivity();
    if (t.goalId && S.sid) {
      try {
        const goals = JSON.parse(
          localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
        );
        const g = goals.find((g) => String(g.id) === String(t.goalId));
        if (g && !g.completed) {
          g.progress = Math.min(100, (g.progress || 0) + 10);
          if (g.progress >= 100) g.completed = true;
          localStorage.setItem(`sivarr_goals_${S.sid}`, JSON.stringify(goals));
          toast(`Goal: ${g.title} (${g.progress}%)`);
        }
      } catch (_) {}
    }
  }
  psSave(d);
  psRenderKanban();
}

// Goals
async function psNewGoal() {
  const title = await siModal.input(
    "New Goal",
    "e.g. Read 12 books this year",
    "",
    { confirmLabel: "Add Goal" },
  );
  if (!title) return;
  const d = psData();
  d.goals = d.goals || [];
  d.goals.push({ id: Date.now(), title, progress: 0, target: 100 });
  psSave(d);
  psRenderGoals();
}

function psRenderGoals() {
  const grid = $("ps-goals-grid");
  if (!grid) return;
  const goals = psData().goals || [];
  if (!goals.length) {
    grid.innerHTML =
      '<p style="color:var(--muted);font-size:.84rem">No goals yet.</p>';
    return;
  }
  grid.innerHTML = goals
    .map((g) => {
      const pct = Math.min(
        100,
        Math.round((g.progress / (g.target || 100)) * 100),
      );
      return `<div class="sp-goal-card">
      <div class="sp-goal-title">${esc(g.title)}</div>
      <div class="sp-goal-bar-bg"><div class="sp-goal-bar-fill" style="width:${pct}%"></div></div>
      <div class="sp-goal-meta"><span>${pct}%</span><span data-onclick="psUpdateGoal" data-onclick-args="[${g.id}]" style="cursor:pointer;color:var(--blue)">Update</span></div>
    </div>`;
    })
    .join("");
}

async function psUpdateGoal(id) {
  const d = psData();
  const g = (d.goals || []).find((g) => g.id === id);
  if (!g) return;
  const v = await siModal.input(
    `Update: ${g.title}`,
    `0 – ${g.target}`,
    String(g.progress),
    { type: "number", confirmLabel: "Update" },
  );
  if (v === null) return;
  g.progress = Math.max(0, Math.min(g.target, parseInt(v) || 0));
  psSave(d);
  psRenderGoals();
}

// Habits
async function psNewHabit() {
  const name = await siModal.input(
    "New Habit",
    "e.g. Read 30 mins, Morning walk",
    "",
    { confirmLabel: "Add Habit" },
  );
  if (!name) return;
  const d = psData();
  d.habits = d.habits || [];
  d.habits.push({ id: Date.now(), name, streak: 0, doneToday: false });
  psSave(d);
  psRenderHabits();
}

function psRenderHabits() {
  const list = $("ps-habits-list");
  if (!list) return;
  const habits = psData().habits || [];
  if (!habits.length) {
    list.innerHTML =
      '<p style="color:var(--muted);font-size:.84rem">No habits yet.</p>';
    return;
  }
  list.innerHTML = habits
    .map(
      (h) => `
    <div class="sp-habit-row">
      <div class="sp-habit-check ${h.doneToday ? "done" : ""}" data-onclick="psToggleHabit" data-onclick-args="[${h.id}]">
        ${h.doneToday ? '<i class="ti ti-check"></i>' : ""}
      </div>
      <span class="sp-habit-name">${h.name}</span>
      <span class="sp-habit-streak">🔥 ${h.streak}</span>
    </div>`,
    )
    .join("");
}

function psToggleHabit(id) {
  const d = psData();
  const h = (d.habits || []).find((h) => h.id === id);
  if (!h) return;
  h.doneToday = !h.doneToday;
  h.streak = h.doneToday
    ? (h.streak || 0) + 1
    : Math.max(0, (h.streak || 0) - 1);
  psSave(d);
  psRenderHabits();
}

// Journal
function psSaveJournal() {
  const textarea = $("ps-journal-text");
  if (!textarea || !textarea.value.trim()) return;
  const d = psData();
  d.journal = d.journal || [];
  d.journal.unshift({
    id: Date.now(),
    text: textarea.value.trim(),
    date: new Date().toLocaleString(),
  });
  textarea.value = "";
  psSave(d);
  psRenderJournal();
}

function psMood(mood, btn) {
  const d = psData();
  d.lastMood = mood;
  psSave(d);
  document
    .querySelectorAll(".sp-mood-btn")
    .forEach((b) => (b.style.opacity = ".4"));
  if (btn) btn.style.opacity = "1";
}

function psRenderJournal() {
  const entries = $("ps-journal-entries");
  if (!entries) return;
  const journal = psData().journal || [];
  entries.innerHTML =
    journal
      .map(
        (e) => `
    <div class="sp-journal-entry">
      <div class="sp-journal-entry-date">${esc(e.date)}</div>
      <div class="sp-journal-entry-text">${esc(e.text)}</div>
    </div>`,
      )
      .join("") ||
    '<p style="color:var(--muted);font-size:.84rem">No entries yet.</p>';
}

// Notes
async function psNewNote() {
  const title = await siModal.input("New Note", "Note title", "", {
    confirmLabel: "Create Note",
  });
  if (!title) return;
  const d = psData();
  d.notes = d.notes || [];
  d.notes.unshift({
    id: Date.now(),
    title,
    body: "",
    date: new Date().toLocaleDateString(),
  });
  psSave(d);
  psRenderNotes();
}

function psRenderNotes() {
  const grid = $("ps-notes-grid");
  if (!grid) return;
  const notes = psData().notes || [];
  if (!notes.length) {
    grid.innerHTML =
      '<p style="color:var(--muted);font-size:.84rem">No notes yet.</p>';
    return;
  }
  grid.innerHTML = notes
    .map(
      (n) => `
    <div class="sp-note-card" data-onclick="psEditNote" data-onclick-args="[${n.id}]">
      <div class="sp-note-title">${esc(n.title)}</div>
      <div class="sp-note-preview">${esc(n.body) || "Empty note…"}</div>
      <div class="sp-note-date">${esc(n.date)}</div>
    </div>`,
    )
    .join("");
}

async function psEditNote(id) {
  const d = psData();
  const n = (d.notes || []).find((n) => n.id === id);
  if (!n) return;
  const body = await siModal.input(
    `Edit: ${n.title}`,
    "Note content…",
    n.body,
    { confirmLabel: "Save", type: "text" },
  );
  if (body === null) return;
  n.body = body;
  psSave(d);
  psRenderNotes();
}


// ═══════════════════════════════════════════════════════════════
// ONBOARDING FLOW
// Shown once to new users on first login. Stores completion in
// localStorage keyed to the user's SID so it never repeats.
// Steps: 1 Welcome → 2 Role → 3 Feature tour → 4 Ready
// ═══════════════════════════════════════════════════════════════

let _siObStep = 1;
let _siObRole = "";
let _siObGoalCreated = false;

const _OB_ROLES = [
  {
    id: "student",
    icon: "🎓",
    label: "Student",
    desc: "Courses, exams, study tools & AI tutor",
  },
  {
    id: "founder",
    icon: "🚀",
    label: "Founder",
    desc: "Build a company: org space, team & metrics",
  },
  {
    id: "freelancer",
    icon: "💼",
    label: "Freelancer",
    desc: "Clients, projects, finance & scheduling",
  },
  {
    id: "creator",
    icon: "✨",
    label: "Creator",
    desc: "Content, community, goals & personal growth",
  },
];

const _OB_DONE_ACTIONS = {
  student: [
    {
      icon: "🤖",
      label: "Ask SIVA anything",
      desc: "Your AI tutor is ready, try it now",
      nav: "chat",
    },
    {
      icon: "📚",
      label: "Join or create a course",
      desc: "Connect with your class via Courses",
      nav: "courses",
    },
    {
      icon: "🎯",
      label: "View your first goal",
      desc: "You just set it, track progress in Goals",
      nav: "goals",
    },
  ],
  founder: [
    {
      icon: "🏢",
      label: "Set up your Org Space",
      desc: "Invite team, assign tasks, track goals",
      nav: "org",
    },
    {
      icon: "💰",
      label: "Track your finances",
      desc: "Log income & expenses in Finance",
      nav: "finance",
    },
    {
      icon: "🎯",
      label: "View your first goal",
      desc: "You just set it, track progress in Goals",
      nav: "goals",
    },
  ],
  freelancer: [
    {
      icon: "✅",
      label: "Add your first task",
      desc: "Manage client work in Flux",
      nav: "flux",
    },
    {
      icon: "💰",
      label: "Track income & expenses",
      desc: "Log your first transaction in Finance",
      nav: "finance",
    },
    {
      icon: "🎯",
      label: "View your first goal",
      desc: "You just set it, track progress in Goals",
      nav: "goals",
    },
  ],
  creator: [
    {
      icon: "✨",
      label: "Ask SIVA to help write",
      desc: "Draft posts, scripts or ideas with AI",
      nav: "chat",
    },
    {
      icon: "👥",
      label: "Join the community",
      desc: "Share and connect with other creators",
      nav: "community",
    },
    {
      icon: "🎯",
      label: "View your first goal",
      desc: "You just set it, track progress in Goals",
      nav: "goals",
    },
  ],
};

function siObMaybeStart() {
  if (!S.sid) return;
  if (localStorage.getItem(`si_onboarded_${S.sid}`)) return;
  _siObStep = 1;
  _siObRole = "";
  _siObGoalCreated = false;
  const el = $("si-onboard");
  if (el) el.style.display = "flex";
  siObRender();
}

// CSP migration: multi-statement (finish onboarding, then jump straight to
// a role-specific starting panel).
window._siObFinishThenNav = function (panel) {
  siObFinish();
  nav(panel, null);
};

async function siObFinish() {
  if (S.sid) localStorage.setItem(`si_onboarded_${S.sid}`, "1");
  // Persist role to backend
  const token = getToken();
  if (token && _siObRole) {
    fetch("/api/user/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, role: _siObRole }),
    }).catch(() => {});
  }
  const el = $("si-onboard");
  if (el) {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(() => {
      el.style.display = "none";
      el.style.opacity = "";
    }, 300);
  }
}

function siObRender() {
  const box = $("si-onboard-box");
  if (!box) return;
  const total = 5;
  const dots = Array.from(
    { length: total },
    (_, i) =>
      `<div class="si-ob-dot${_siObStep === i + 1 ? " active" : ""}"></div>`,
  ).join("");

  let content = "";

  if (_siObStep === 1) {
    const first = (S.name || "").split(" ")[0];
    content = `
      <div class="si-ob-emoji">👋</div>
      <div class="si-ob-title">Welcome to Sivarr,<br>${esc(first)}!</div>
      <div class="si-ob-sub">Your all-in-one productivity OS. Let's get you set up in under 2 minutes.</div>
      <div class="si-ob-actions">
        <button class="si-ob-btn-pri" data-onclick="siObNext">Get started →</button>
      </div>`;
  } else if (_siObStep === 2) {
    const cards = _OB_ROLES
      .map(
        (r) => `
      <div class="si-ob-role-card${_siObRole === r.id ? " sel" : ""}" data-onclick="siObSelectRole" data-onclick-arg0="${r.id}" data-onclick-this>
        <div class="si-ob-role-icon">${r.icon}</div>
        <div class="si-ob-role-label">${r.label}</div>
        <div class="si-ob-role-desc">${r.desc}</div>
      </div>`,
      )
      .join("");
    content = `
      <div class="si-ob-title">How will you use Sivarr?</div>
      <div class="si-ob-sub">Choose your primary focus. You can use every feature regardless.</div>
      <div class="si-ob-role-grid">${cards}</div>
      <div class="si-ob-actions">
        <button class="si-ob-btn-sec" data-onclick="siObPrev">← Back</button>
        <button class="si-ob-btn-pri" data-onclick="siObNext">Continue →</button>
      </div>`;
  } else if (_siObStep === 3) {
    const placeholders = {
      student: "e.g. Score a first class this semester",
      founder: "e.g. Launch beta by end of July",
      freelancer: "e.g. Land 3 new clients this month",
      creator: "e.g. Grow to 10k followers",
    };
    const ph = placeholders[_siObRole] || "e.g. My #1 goal right now…";
    content = `
      <div class="si-ob-emoji">🎯</div>
      <div class="si-ob-title">Set your first goal</div>
      <div class="si-ob-sub">What's the one thing you most want to achieve? You can always add more later.</div>
      <div class="si-ob-goal-form">
        <input class="si-ob-input" id="ob-goal-title" placeholder="${ph}" maxlength="120">
        <div class="si-ob-goal-row">
          <select class="si-ob-select" id="ob-goal-cat">
            <option value="career">Career / Work</option>
            <option value="education">Education</option>
            <option value="health">Health & Fitness</option>
            <option value="finance">Financial</option>
            <option value="personal">Personal Growth</option>
            <option value="business">Business</option>
            <option value="creative">Creative</option>
            <option value="other">Other</option>
          </select>
          <input class="si-ob-input" id="ob-goal-deadline" type="date" style="color-scheme:dark" title="Deadline (optional)">
        </div>
      </div>
      <div class="si-ob-actions">
        <button class="si-ob-btn-sec" data-onclick="siObPrev">← Back</button>
        <button class="si-ob-btn-pri" data-onclick="siObSaveGoal">Set goal →</button>
        <button class="si-ob-skip-step" data-onclick="siObNext">Skip</button>
      </div>`;
  } else if (_siObStep === 4) {
    content = `
      <div class="si-ob-emoji">🔗</div>
      <div class="si-ob-title">Connect your tools</div>
      <div class="si-ob-sub">Link your favourite apps. You can always do this later in Integrations.</div>
      <div class="si-ob-int-grid">
        <button class="si-ob-int-btn ${_GCAL_CONNECTED ? "done" : ""}" data-onclick="gcalConnect">
          <span class="si-ob-int-icon">📅</span>
          <span class="si-ob-int-label">${_GCAL_CONNECTED ? "✓ Calendar" : "Google Calendar"}</span>
        </button>
        <button class="si-ob-int-btn ${_GITHUB_CONNECTED ? "done" : ""}" data-onclick="githubConnect">
          <span class="si-ob-int-icon">🐙</span>
          <span class="si-ob-int-label">${_GITHUB_CONNECTED ? "✓ GitHub" : "GitHub"}</span>
        </button>
        <button class="si-ob-int-btn ${_MONO_CONNECTED ? "done" : ""}" data-onclick="monoConnect">
          <span class="si-ob-int-icon">🏦</span>
          <span class="si-ob-int-label">${_MONO_CONNECTED ? "✓ Mono Bank" : "Mono Bank"}</span>
        </button>
      </div>
      <div class="si-ob-actions">
        <button class="si-ob-btn-sec" data-onclick="siObPrev">← Back</button>
        <button class="si-ob-btn-pri" data-onclick="siObNext">Almost done →</button>
      </div>`;
  } else if (_siObStep === 5) {
    const actions = (_OB_DONE_ACTIONS[_siObRole] || _OB_DONE_ACTIONS.creator)
      .map(
        (a) => `
      <div class="si-ob-action-card" data-onclick="_siObFinishThenNav" data-onclick-arg0="${a.nav}">
        <div class="si-ob-action-icon">${a.icon}</div>
        <div><div class="si-ob-action-label">${a.label}</div><div class="si-ob-action-desc">${a.desc}</div></div>
      </div>`,
      )
      .join("");
    content = `
      <div class="si-ob-emoji">🎉</div>
      <div class="si-ob-title">You're all set!</div>
      <div class="si-ob-sub">Here's where to start. Pick one and dive in.</div>
      <div class="si-ob-done-actions">${actions}</div>
      <div class="si-ob-actions">
        <button class="si-ob-btn-pri" data-onclick="siObFinish">Go to dashboard →</button>
      </div>`;
  }

  box.innerHTML = `
    <div class="si-ob-logo">✦ Sivarr</div>
    <div class="si-ob-dots">${dots}</div>
    ${content}`;
}

function siObSelectRole(role, el) {
  _siObRole = role;
  document
    .querySelectorAll(".si-ob-role-card")
    .forEach((c) => c.classList.remove("sel"));
  el.classList.add("sel");
}

async function siObSaveGoal() {
  const title = $("ob-goal-title")?.value.trim();
  const subject = $("ob-goal-cat")?.value || "other";
  const deadline = $("ob-goal-deadline")?.value || "";
  if (!title) {
    $("ob-goal-title")?.focus();
    return;
  }
  // Create goal in the same way glSaveGoal does
  try {
    await API("/api/goals/add", {
      token: getToken(),
      title,
      subject,
      deadline: deadline || null,
      goal_type: "okr",
      target_score: null,
    });
    GL_GOALS = null; // bust cache so Goals panel reloads fresh
    _siObGoalCreated = true;
  } catch (_) {}
  siObNext();
}

function siObNext() {
  if (_siObStep < 5) {
    _siObStep++;
    siObRender();
  } else siObFinish();
}

function siObPrev() {
  if (_siObStep > 1) {
    _siObStep--;
    siObRender();
  }
}

// ═══════════════════════ NOTIFICATIONS ══════════════════════════

const NOTIF_KEY = () => `sivarr_notifs_${S.sid || "guest"}`;

function _buildNotifs() {
  if (!S.sid) return;
  const today8601 = new Date().toISOString().split("T")[0];
  const nowMs = Date.now();
  const existing = JSON.parse(localStorage.getItem(NOTIF_KEY()) || "[]");
  const existingIds = new Set(existing.map((n) => n.id));
  const fresh = [];

  try {
    // Overdue tasks
    const tasks = JSON.parse(
      localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
    ).filter(
      (t) => !t.done && t.date && new Date(t.date) < new Date(today8601),
    );
    tasks.slice(0, 3).forEach((t) => {
      const id = `overdue_${t.id}`;
      if (!existingIds.has(id))
        fresh.push({
          id,
          type: "overdue",
          icon: "⏰",
          msg: `Overdue: "${t.title.slice(0, 40)}"`,
          read: false,
          ts: nowMs,
        });
    });

    // Goals with deadline ≤ 3 days
    const goals = JSON.parse(
      localStorage.getItem(`sivarr_goals_${S.sid}`) || "[]",
    ).filter((g) => !g.completed && g.deadline);
    goals.forEach((g) => {
      const days = Math.ceil(
        (new Date(g.deadline) - new Date(today8601)) / 86400000,
      );
      if (days >= 0 && days <= 3) {
        const id = `goal_deadline_${g.id}`;
        if (!existingIds.has(id))
          fresh.push({
            id,
            type: "deadline",
            icon: "🎯",
            msg: `Goal deadline in ${days === 0 ? "today" : days + "d"}: "${g.title.slice(0, 35)}"`,
            read: false,
            ts: nowMs,
          });
      }
    });

    // Habit streak at risk (streak > 3, not done today)
    const habits = JSON.parse(
      localStorage.getItem(`sivarr_habits_${S.sid}`) || "[]",
    );
    const streakHabit = habits.find(
      (h) => (h.streak || 0) >= 3 && !(h.completions || []).includes(today8601),
    );
    if (streakHabit) {
      const id = `streak_risk_${today8601}`;
      if (!existingIds.has(id))
        fresh.push({
          id,
          type: "streak",
          icon: "🔥",
          msg: `${streakHabit.streak}-day streak at risk: complete "${streakHabit.title.slice(0, 30)}"`,
          read: false,
          ts: nowMs,
        });
    }

    // Journal not written in > 3 days
    const jnl = JSON.parse(
      localStorage.getItem(`sivarr_journal_${S.sid}`) || "[]",
    );
    if (jnl.length) {
      const daysSince = Math.floor(
        (nowMs - new Date(jnl[0].date + "T12:00:00").getTime()) / 86400000,
      );
      if (daysSince >= 3) {
        const id = `journal_gap_${today8601}`;
        if (!existingIds.has(id))
          fresh.push({
            id,
            type: "journal",
            icon: "📓",
            msg: `Last journal entry was ${daysSince} days ago. Write something today.`,
            read: false,
            ts: nowMs,
          });
      }
    }
  } catch (_) {}

  if (fresh.length) {
    const merged = [...fresh, ...existing].slice(0, 20);
    localStorage.setItem(NOTIF_KEY(), JSON.stringify(merged));
  }

  _renderNotifBadge();
}

function _renderNotifBadge() {
  const badge = $("notif-badge");
  if (!badge) return;
  const notifs = JSON.parse(localStorage.getItem(NOTIF_KEY()) || "[]");
  const unread = notifs.filter((n) => !n.read).length;
  badge.style.display = unread > 0 ? "block" : "none";
}

function notifToggle() {
  const panel = $("notif-panel");
  if (!panel) return;
  const open = panel.style.display !== "none";
  if (open) {
    panel.style.display = "none";
    return;
  }
  _renderNotifList();
  panel.style.display = "block";
  // Close on outside click
  setTimeout(() => {
    document.addEventListener("click", function _close(e) {
      if (
        !$("notif-panel")?.contains(e.target) &&
        e.target.id !== "notif-btn" &&
        !$("notif-btn")?.contains(e.target)
      ) {
        if ($("notif-panel")) $("notif-panel").style.display = "none";
        document.removeEventListener("click", _close);
      }
    });
  }, 0);
}

function _renderNotifList() {
  const list = $("notif-list");
  if (!list) return;
  const notifs = JSON.parse(localStorage.getItem(NOTIF_KEY()) || "[]");

  if (!notifs.length) {
    list.innerHTML = `<div style="padding:24px;text-align:center;font-size:.82rem;color:var(--text4)">You're all caught up 👌</div>`;
    return;
  }

  const NAV_MAP = {
    overdue: "flux",
    deadline: "goals",
    streak: "habits",
    journal: "journal",
  };
  list.innerHTML = notifs
    .map(
      (n) => `
    <div class="notif-row${n.read ? "" : " unread"}" data-onclick="notifAction" data-onclick-arg0="${esc(n.id)}">
      <span style="font-size:1.1rem;flex-shrink:0;margin-top:1px">${n.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:.8rem;color:var(--text);line-height:1.45">${esc(n.msg)}</div>
      </div>
      ${!n.read ? `<div style="width:7px;height:7px;background:var(--teal);border-radius:50%;flex-shrink:0;margin-top:5px"></div>` : ""}
    </div>`,
    )
    .join("");

  // store nav map for onclick
  list._navMap = NAV_MAP;
  notifMarkAllRead();
}

function notifAction(id) {
  const notifs = JSON.parse(localStorage.getItem(NOTIF_KEY()) || "[]");
  const n = notifs.find((x) => x.id === id);
  if (!n) return;
  if ($("notif-panel")) $("notif-panel").style.display = "none";
  if (n.invite_token) {
    _orgAcceptInvite(n.invite_token, n.org_name);
    return;
  }
  const dest = {
    overdue: "flux",
    deadline: "goals",
    streak: "habits",
    journal: "journal",
  }[n.type];
  if (dest) nav(dest, null);
}

function notifMarkAllRead() {
  const notifs = JSON.parse(localStorage.getItem(NOTIF_KEY()) || "[]").map(
    (n) => ({ ...n, read: true }),
  );
  localStorage.setItem(NOTIF_KEY(), JSON.stringify(notifs));
  _renderNotifBadge();
}

// ═══════════════════════════ FEEDBACK ═══════════════════════════

let _fbRating = 0;

function openFeedback() {
  _fbRating = 0;
  const modal = $("feedback-modal");
  if (!modal) return;
  const txt = $("fb-text");
  if (txt) txt.value = "";
  const ferr = $("fb-error");
  if (ferr) {
    ferr.style.display = "none";
    ferr.textContent = "";
  }
  document
    .querySelectorAll(".fb-star")
    .forEach((s) => s.classList.remove("active"));
  modal.style.display = "flex";
  setTimeout(() => txt?.focus(), 50);
}

function closeFeedback() {
  const modal = $("feedback-modal");
  if (modal) modal.style.display = "none";
}

// ═══════════════════════════════════════════════════════════════
//  FLUTTERWAVE BILLING
// ═══════════════════════════════════════════════════════════════

async function flutterwaveSubscribe(planId) {
  const token = getToken() || "";
  if (!token) {
    toast("Sign in to subscribe.");
    return;
  }
  try {
    const r = await API("/api/billing/flutterwave/subscribe", {
      token,
      plan_id: planId,
    });
    if (r.payment_url) {
      sessionStorage.setItem("flw_billing_plan", planId);
      window.location.href = r.payment_url;
    }
  } catch (e) {
    toast(e.message || "Flutterwave payment failed. Try Paystack instead.");
  }
}

async function flutterwaveVerify(ref, planId) {
  const token = getToken() || "";
  if (!token) return;
  try {
    const r = await fetch(
      `/api/billing/flutterwave/verify/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}&plan_id=${encodeURIComponent(planId || "")}`,
    );
    const d = await r.json();
    if (d.ok) {
      await billingLoadStatus();
      if (d.org_id) {
        // org seat subscription, not a personal plan
        toast("Organisation plan activated ✓");
        ["org", "orgchat", "team", "projects"].forEach(_removePaywall);
        if (typeof orgInit === "function") orgInit();
        return;
      }
      _unlockAfterPayment(d.name || planId || "Pro");
    }
  } catch (e) {
    toast("Could not verify payment. Please contact support.");
  }
}

// ═══════════════════════════════════════════════════════════════
//  MONO OPEN BANKING INTEGRATION
// ═══════════════════════════════════════════════════════════════

let _MONO_CONNECTED = false;
let _MONO_ACCOUNT = null;
let _MONO_PUBLIC_KEY = "";

async function monoCheckStatus() {
  const token = getToken() || "";
  if (!token) return;
  try {
    const r = await fetch(
      `/api/integrations/mono/status?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _MONO_CONNECTED = d.connected;
    integrationsRender();
    if (_MONO_CONNECTED) monoLoadAccount();
  } catch (_) {}
}

async function monoLoadAccount() {
  const token = getToken() || "";
  if (!token || !_MONO_CONNECTED) return;
  try {
    const r = await fetch(
      `/api/integrations/mono/account?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _MONO_ACCOUNT = d;
    monoRender();
  } catch (_) {}
}

function monoConnect() {
  const token = getToken() || "";
  if (!token) {
    toast("Sign in first.");
    return;
  }
  if (!_MONO_PUBLIC_KEY) {
    fetch(`/api/integrations/mono/status?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => {
        _MONO_PUBLIC_KEY = d.public_key || "";
        _monoOpenWidget(token);
      })
      .catch(() => _monoOpenWidget(token));
    return;
  }
  _monoOpenWidget(token);
}

function _monoOpenWidget(token) {
  if (typeof MonoConnect === "undefined") {
    toast("Mono Connect widget not loaded. Check your Mono public key.");
    return;
  }
  const mono = new MonoConnect({
    key: _MONO_PUBLIC_KEY,
    onSuccess: async ({ code }) => {
      try {
        const r = await API("/api/integrations/mono/auth", { token, code });
        if (r.ok) {
          _MONO_CONNECTED = true;
          toast("Bank account connected via Mono!");
          monoLoadAccount();
          integrationsRender();
        }
      } catch (e) {
        toast(e.message || "Mono auth failed.");
      }
    },
    onClose: () => {},
  });
  mono.open();
}

function monoRender() {
  const container = $("mono-account-container");
  if (!container) return;
  if (!_MONO_CONNECTED || !_MONO_ACCOUNT) {
    container.innerHTML = `
      <div class="mono-connect-card">
        <div class="mono-logo">M</div>
        <div class="mono-connect-title">Connect your bank</div>
        <div class="mono-connect-desc">Link your African bank account via Mono to view your balance and transactions inside Sivarr.</div>
        <button class="mono-connect-btn" data-onclick="monoConnect"><span style="font-weight:900">M</span> Connect Bank</button>
      </div>`;
    return;
  }
  const acc = _MONO_ACCOUNT?.account?.data || _MONO_ACCOUNT?.account || {};
  const txns = _MONO_ACCOUNT?.transactions || [];
  const balance = acc.balance
    ? `₦${(acc.balance / 100).toLocaleString()}`
    : "–";
  container.innerHTML = `
    <div class="mono-account-card">
      <div class="mono-acc-head">
        <div class="mono-acc-icon">M</div>
        <div>
          <div class="mono-acc-name">${esc(acc.name || "Account")}</div>
          <div class="mono-acc-bank">${esc(acc.institution?.name || "")} · ${esc(acc.accountNumber || "")}</div>
        </div>
      </div>
      <div class="mono-bal-row"><div class="mono-bal-label">Available Balance</div><div class="mono-bal-val">${balance}</div></div>
    </div>
    <div style="font-size:.82rem;font-weight:700;color:var(--fg);margin:12px 0 6px">Recent Transactions</div>
    <div class="mono-txn-list">
      ${
        txns
          .slice(0, 10)
          .map((t) => {
            const amt = t.amount ? `₦${(t.amount / 100).toLocaleString()}` : "";
            const cls = t.type === "credit" ? "credit" : "debit";
            const sign = t.type === "credit" ? "+" : "-";
            return `<div class="mono-txn-row">
          <div class="mono-txn-narration">${esc(t.narration || t.description || "Transaction")}</div>
          <div class="mono-txn-date">${t.date ? t.date.slice(0, 10) : ""}</div>
          <div class="mono-txn-amount ${cls}">${sign}${amt}</div>
        </div>`;
          })
          .join("") || '<div class="sp-empty">No transactions yet.</div>'
      }
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
//  METATRADER INTEGRATION (via MetaApi bridge)
//  Links a user's MT4/MT5 account → live balance, open positions and
//  trade history, consumed by the Trading Journal extension's Live tab.
// ═══════════════════════════════════════════════════════════════

let _MT_CONNECTED = false;
let _MT_STATUS = {}; // { login, server, platform }
let _MT_ACCOUNT = null; // last /account payload (info, positions, deals, state)
let _MT_POLL = null; // poll timer while an account is still deploying

async function mtCheckStatus() {
  const token = getToken() || "";
  if (!token) return;
  try {
    const r = await fetch(
      `/api/integrations/metatrader/status?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _MT_CONNECTED = !!d.connected;
    _MT_STATUS = d;
    if (typeof integrationsRender === "function") integrationsRender();
    if (_MT_CONNECTED) mtLoadAccount();
  } catch (_) {}
}

async function mtLoadAccount() {
  const token = getToken() || "";
  if (!token || !_MT_CONNECTED) return null;
  try {
    const r = await fetch(
      `/api/integrations/metatrader/account?token=${encodeURIComponent(token)}`,
    );
    if (!r.ok) return null;
    const d = await r.json();
    _MT_ACCOUNT = d;
    // While MetaApi is still deploying/syncing the broker connection, poll.
    if (d.state === "pending") {
      if (!_MT_POLL) _MT_POLL = setInterval(mtLoadAccount, 12000);
    } else if (_MT_POLL) {
      clearInterval(_MT_POLL);
      _MT_POLL = null;
    }
    if (typeof extTjRender === "function" && _extTjSeg === "live")
      extTjRender();
    return d;
  } catch (_) {
    return null;
  }
}

async function mtConnect() {
  const token = getToken() || "";
  if (!token) {
    toast("Sign in first.");
    return;
  }
  if (_MT_CONNECTED) {
    if (
      await siModal.confirm(
        `Disconnect MetaTrader account ${_MT_STATUS.login || ""}? Your journal entries stay; only the live link is removed.`,
        {
          title: "Disconnect MetaTrader",
          confirmLabel: "Disconnect",
          danger: true,
        },
      )
    ) {
      await mtDisconnect();
    }
    return;
  }
  const f = await siModal.form(
    "Connect MetaTrader",
    [
      {
        id: "platform",
        label: "Platform",
        type: "select",
        options: [
          { value: "mt5", label: "MetaTrader 5" },
          { value: "mt4", label: "MetaTrader 4" },
        ],
        default: "mt5",
      },
      {
        id: "login",
        label: "Account number (login)",
        placeholder: "e.g. 51234567",
        required: true,
      },
      {
        id: "password",
        label: "Investor (read-only) password",
        type: "password",
        placeholder: "Use your read-only password",
        required: true,
      },
      {
        id: "server",
        label: "Broker server",
        placeholder: "e.g. ICMarketsSC-Demo",
        required: true,
      },
    ],
    {
      confirmLabel: "Connect",
      description:
        "Sivarr links your account read-only through MetaApi. Tip: use your broker’s <b>investor (read-only) password</b> so trades can never be placed. We never store your password.",
    },
  );
  if (!f || !f.login || !f.password || !f.server) return;
  try {
    toast("Linking your MetaTrader account…");
    const r = await API("/api/integrations/metatrader/connect", {
      token,
      login: f.login,
      password: f.password,
      server: f.server,
      platform: f.platform || "mt5",
    });
    if (r.ok) {
      _MT_CONNECTED = true;
      _MT_STATUS = {
        login: f.login,
        server: f.server,
        platform: f.platform || "mt5",
      };
      toast(
        "MetaTrader linked, syncing your account (this can take a minute).",
      );
      if (typeof integrationsRender === "function") integrationsRender();
      mtLoadAccount();
    }
  } catch (e) {
    toast(e.message || "Could not link MetaTrader account.");
  }
}

async function mtDisconnect() {
  const token = getToken() || "";
  if (!token) return;
  try {
    await API("/api/integrations/metatrader/disconnect", { token });
  } catch (_) {}
  _MT_CONNECTED = false;
  _MT_STATUS = {};
  _MT_ACCOUNT = null;
  if (_MT_POLL) {
    clearInterval(_MT_POLL);
    _MT_POLL = null;
  }
  if (typeof integrationsRender === "function") integrationsRender();
  if (typeof extTjRender === "function") extTjRender();
  toast("MetaTrader disconnected.");
}

// ═══════════════════════════════════════════════════════════════
//  ORG ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════















// ═══════════════════════════════════════════════════════════════
//  ORG ANALYTICS DASHBOARD
// ═══════════════════════════════════════════════════════════════





// ═══════════════════════════════════════════════════════════════
//  EMAIL TASK REMINDER (triggered on login if tasks due soon)
// ═══════════════════════════════════════════════════════════════

async function _sendTaskReminderIfNeeded() {
  const token = getToken() || "";
  if (!token || !S.sid) return;
  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
  try {
    const tasks = JSON.parse(
      localStorage.getItem(`sivarr_tasks_${S.sid}`) || "[]",
    )
      .filter(
        (t) => !t.done && t.date && (t.date === today || t.date === tomorrow),
      )
      .slice(0, 5)
      .map((t) => ({
        title: t.title,
        due: t.date === today ? "today" : "tomorrow",
      }));
    if (!tasks.length) return;
    await API("/api/notify/tasks", { token, tasks });
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
//  MOBILE BOTTOM NAV — update active state
// ═══════════════════════════════════════════════════════════════

// Maps every panel name → which bottom nav button lights up
// 3-tab mobile nav map: panel name → tab button id suffix
const _MOB_NAV_MAP = {
  // Today tab
  home: "today",
  habits: "today",
  journal: "today",
  calendar: "today",
  stats: "today",
  progress: "today",
  announcements: "today",
  // AI tab
  chat: "ai",
  quiz: "ai",
  lab: "ai",
  studyplan: "ai",
  // Me tab
  "me-mobile": "me",
  goals: "me",
  settings: "me",
  profile: "me",
  opportunities: "me",
  community: "me",
  library: "me",
  // fallback: Tasks/Flux/Notes → Today
  flux: "today",
  notes: "today",
  documenthub: "today",
  org: "me",
  team: "me",
  orgchat: "me",
  projects: "me",
};

function navMobileMe() {
  nav("me-mobile", null);
  renderMobileMePanel();
}

function renderMobileMePanel() {
  const el = $("mob-me-content");
  if (!el || !S.sid) return;

  const habits = JSON.parse(
    localStorage.getItem(`sivarr_habits_${S.sid}`) || "[]",
  );
  const todayStr = new Date().toISOString().split("T")[0];
  const doneToday = habits.filter((h) =>
    (h.completions || []).includes(todayStr),
  ).length;
  const maxStreak = habits.length
    ? Math.max(...habits.map((h) => h.streak || 0), 0)
    : 0;
  const activeGoals = (typeof GL_GOALS !== "undefined" ? GL_GOALS : []).filter(
    (g) => !g.completed,
  ).length;
  const initial = (S.name?.[0] || "?").toUpperCase();
  const planName =
    (typeof _BILLING_STATUS !== "undefined" && _BILLING_STATUS?.name) || "Free";

  el.innerHTML = `
    <!-- Profile card -->
    <div class="me-profile-card">
      <div class="me-av">${initial}</div>
      <div>
        <div class="me-name">${esc(S.name || "My profile")}</div>
        <div class="me-plan">${planName} plan · ${esc(S.email || "")}</div>
      </div>
    </div>

    <!-- Stats -->
    <div class="me-stats">
      <div class="me-stat">
        <div class="me-stat-val">${maxStreak}</div>
        <div class="me-stat-lbl">Best streak</div>
      </div>
      <div class="me-stat">
        <div class="me-stat-val">${doneToday}/${habits.length}</div>
        <div class="me-stat-lbl">Done today</div>
      </div>
      <div class="me-stat">
        <div class="me-stat-val">${activeGoals}</div>
        <div class="me-stat-lbl">Active goals</div>
      </div>
    </div>

    <!-- Quick links -->
    <div class="me-links">
      <button class="me-link-btn" data-onclick="nav" data-onclick-args="[&quot;goals&quot;,null]">
        <div class="me-link-icon">🎯</div>
        <div class="me-link-label">Goals</div>
        <div class="me-link-sub">${activeGoals} active</div>
      </button>
      <button class="me-link-btn" data-onclick="nav" data-onclick-args="[&quot;habits&quot;,null]">
        <div class="me-link-icon">🔥</div>
        <div class="me-link-label">Habits</div>
        <div class="me-link-sub">${doneToday}/${habits.length} today</div>
      </button>
      <button class="me-link-btn" data-onclick="nav" data-onclick-args="[&quot;journal&quot;,null]">
        <div class="me-link-icon">✍️</div>
        <div class="me-link-label">Journal</div>
        <div class="me-link-sub">Write today's entry</div>
      </button>
      <button class="me-link-btn" data-onclick="nav" data-onclick-args="[&quot;settings&quot;,null]">
        <div class="me-link-icon">⚙️</div>
        <div class="me-link-label">Settings</div>
        <div class="me-link-sub">Account & appearance</div>
      </button>
    </div>

    <button class="me-sign-out" data-onclick="logout">Sign out</button>
  `;
}

function _updateMobileNav(panelName) {
  document
    .querySelectorAll(".mob-nav-btn")
    .forEach((b) => b.classList.remove("active"));
  const target = _MOB_NAV_MAP[panelName];
  if (target) {
    const btn = $("mob-" + target);
    if (btn) btn.classList.add("active");
  }
  if (window.innerWidth <= 720) closeMobileSidebar();
}

// ═══════════════════════════════════════════════════════════════
//  ONBOARDING — Step 5 (connect integration) + nav updates
// ═══════════════════════════════════════════════════════════════

function fbSetRating(v) {
  _fbRating = v;
  document.querySelectorAll(".fb-star").forEach((s) => {
    s.classList.toggle("active", parseInt(s.dataset.v) <= v);
  });
}

async function submitFeedback() {
  const text = $("fb-text")?.value.trim() || "";
  const ferr = $("fb-error");
  if (!text) {
    if (ferr) {
      ferr.textContent = "Please write something before sending.";
      ferr.style.display = "block";
    }
    return;
  }
  const token = getToken() || "";
  const page = window.location.pathname;
  try {
    await API("/api/feedback", {
      token,
      text,
      rating: _fbRating || null,
      page,
    });
    closeFeedback();
    track("Feedback_Sent", { rating: _fbRating });
  } catch (e) {
    if (ferr) {
      ferr.textContent = e.message || "Failed to send. Try again.";
      ferr.style.display = "block";
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  PAYSTACK FINANCIAL DASHBOARD  — ps* functions
// ═══════════════════════════════════════════════════════════════

const _PS_TABS = [
  "overview",
  "transactions",
  "balance",
  "settlements",
  "customers",
  "refunds",
  "analytics",
  "connect",
];
let _psConnected = false;
let _psTxnPage = 1;
let _psTxnTotal = 0;

function psGoTab(name, btn) {
  // Prefixed pstk- (not ps-): _panels_spaces.html also has a Personal Space
  // tab bar reusing "ps-tab-overview"/"ps-pane-overview" ids for a
  // different feature — an unscoped $()/getElementById here previously
  // only found the right (Paystack) element by DOM-order luck.
  _PS_TABS.forEach((t) => {
    const tb = $("pstk-tab-" + t),
      pn = $("pstk-pane-" + t);
    if (tb) tb.classList.remove("on");
    if (pn) {
      pn.style.display = "none";
      pn.classList.remove("on");
    }
  });
  const at = $("pstk-tab-" + name),
    ap = $("pstk-pane-" + name);
  if (at) at.classList.add("on");
  if (ap) {
    ap.style.display = "flex";
    ap.classList.add("on");
  }
  if (btn) {
    document
      .querySelectorAll(".ps-tab")
      .forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
  }

  if (name === "overview") psLoadOverview();
  if (name === "transactions") {
    _psTxnPage = 1;
    psLoadTransactions();
  }
  if (name === "balance") psLoadBalance();
  if (name === "settlements") psLoadSettlements();
  if (name === "customers") psLoadCustomers();
  if (name === "refunds") psLoadRefunds();
  if (name === "analytics") psLoadAnalytics();
  if (name === "connect") psCheckConnectStatus();
}

async function psFinancialsLoad() {
  const token = getToken() || "";
  if (!token) return;
  try {
    const r = await fetch(
      `/api/org/paystack/status?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _psConnected = !!d.connected;
  } catch (e) {
    _psConnected = false;
  }

  if (!_psConnected) {
    psGoTab("connect", null);
    const btn = $("pstk-tab-connect");
    if (btn) btn.classList.add("on");
  } else {
    psGoTab("overview", null);
    const btn = $("pstk-tab-overview");
    if (btn) btn.classList.add("on");
  }
}

function _psLoading(section, on) {
  const ld = $("ps-loading-" + section);
  const ct =
    $("ps-" + section + "-content") || $("ps-" + section + "-table") || null;
  if (ld) ld.style.display = on ? "flex" : "none";
  if (ct) ct.style.display = on ? "none" : "block";
}

function _psNgn(kobo) {
  return (
    "₦" +
    Number(kobo / 100).toLocaleString("en-NG", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
  );
}

function _psDate(iso) {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

function _psBadge(status) {
  const map = {
    success: "ps-badge-s",
    failed: "ps-badge-f",
    pending: "ps-badge-w",
    settled: "ps-badge-s",
    processing: "ps-badge-w",
    processed: "ps-badge-s",
    reversed: "ps-badge-n",
    abandoned: "ps-badge-n",
    active: "ps-badge-s",
    refunded: "ps-badge-n",
    awaiting: "ps-badge-a",
  };
  const cls = map[status?.toLowerCase()] || "ps-badge-n";
  return `<span class="ps-badge ${cls}">${status || "–"}</span>`;
}

async function psLoadOverview() {
  if (!_psConnected) return;
  _psLoading("overview", true);
  const token = getToken() || "";
  try {
    const r = await fetch(
      `/api/org/paystack/overview?token=${encodeURIComponent(token)}`,
    );
    if (!r.ok) {
      _psShowNotConnected();
      return;
    }
    const d = await r.json();
    _psLoading("overview", false);
    const oc = $("ps-overview-content");
    if (oc) oc.style.display = "block";

    const set = (id, v) => {
      const el = $(id);
      if (el) el.textContent = v;
    };
    set("ps-vol", _psNgn(d.volume || 0));
    set("ps-txn-count", (d.txn_count || 0).toLocaleString());
    set("ps-success-rate", `${d.success_rate || 0}% success rate`);
    set("ps-avail-bal", _psNgn(d.available_bal || 0));
    set("ps-pending-stl", _psNgn(d.pending_stl_amt || 0));
    set(
      "ps-pending-date",
      d.pending_stl_date ? "T+1 · " + _psDate(d.pending_stl_date) : "",
    );

    // Channels
    const chEl = $("ps-channels");
    if (chEl) {
      const ch = d.channels || {};
      const total = Object.values(ch).reduce((a, b) => a + b, 0) || 1;
      const colors = {
        card: "var(--teal)",
        bank: "var(--blue)",
        ussd: "var(--amber3)",
        mobile_money: "var(--purple)",
      };
      const labels = {
        card: "Card payments",
        bank: "Bank transfer",
        ussd: "USSD",
        mobile_money: "Mobile money",
      };
      chEl.innerHTML =
        Object.entries(ch)
          .map(([k, v]) => {
            const pct = Math.round((v / total) * 100);
            return `<div class="ps-ch-row">
          <div class="ps-ch-label"><span>${labels[k] || k}</span><span class="ps-ch-val" style="color:${colors[k] || "var(--teal)"}">${pct}%</span></div>
          <div class="ps-ch-bar-bg"><div class="ps-ch-bar-fill" style="width:${pct}%;background:${colors[k] || "var(--teal)"}"></div></div>
        </div>`;
          })
          .join("") ||
        '<div style="color:var(--text4);font-size:.8rem">No channel data yet.</div>';
    }

    // AI insights
    const ins = $("ps-ai-insights");
    if (ins) {
      const sr = d.success_rate || 0;
      const vol = _psNgn(d.volume || 0);
      ins.innerHTML = `
        <div class="ps-insight ps-insight-g"><i class="ti ti-trending-up" style="color:var(--teal);margin-right:5px"></i>
          Total volume of <strong>${vol}</strong> across ${d.success_count || 0} successful transactions this period.
        </div>
        <div class="ps-insight ${sr < 90 ? "ps-insight-a" : "ps-insight-g"}"><i class="ti ti-${sr < 90 ? "alert-triangle" : "circle-check"}" style="color:var(--${sr < 90 ? "amber3" : "teal"});margin-right:5px"></i>
          <strong>${sr}% success rate</strong>, ${sr < 90 ? "above the 5% failure threshold. Review failed transactions for decline patterns." : "excellent, below the 5% industry failure threshold."}.
        </div>
        <div class="ps-insight ps-insight-b"><i class="ti ti-building-bank" style="color:var(--blue);margin-right:5px"></i>
          Available balance: <strong>${_psNgn(d.available_bal || 0)}</strong>. ${d.pending_stl_amt ? `Settlement of ${_psNgn(d.pending_stl_amt)} expected ${d.pending_stl_date ? "on " + _psDate(d.pending_stl_date) : "soon"}.` : "No pending settlements."}
        </div>`;
    }

    // Recent transactions
    const rt = $("ps-recent-txns");
    if (rt && d.recent_txns) {
      rt.innerHTML =
        `<div class="ps-th-row" style="grid-template-columns:1fr 90px 110px 80px 80px">
          <span>Customer</span><span>Amount</span><span>Channel</span><span>Date</span><span>Status</span>
        </div>` +
        d.recent_txns
          .map(
            (
              t,
            ) => `<div class="ps-tr" style="grid-template-columns:1fr 90px 110px 80px 80px">
          <div><div class="ps-cust-name">${t.customer_name || t.customer || "–"}</div><div class="ps-cust-email">${t.customer}</div></div>
          <span class="ps-amount ${t.status === "success" ? "ps-amount-g" : "ps-amount-r"}">${_psNgn(t.amount)}</span>
          <span style="color:var(--text3);font-size:.78rem">${_psChan(t)}</span>
          <span style="color:var(--text4);font-size:.78rem">${_psDate(t.paid_at)}</span>
          ${_psBadge(t.status)}
        </div>`,
          )
          .join("");
    }
  } catch (e) {
    _psLoading("overview", false);
    toast("Could not load financial data.");
  }
}

function _psChan(t) {
  let s = (t.channel || "").replace("_", " ");
  if (t.card_type) s += ` · ${t.card_type}`;
  if (t.last4) s += ` ···${t.last4}`;
  return s || "–";
}

let _psTxnData = [];
async function psLoadTransactions() {
  if (!_psConnected) return;
  _psLoading("transactions", true);
  const el = $("ps-txn-table");
  if (el) el.innerHTML = "";
  const foot = $("ps-txn-footer");
  if (foot) foot.style.display = "none";
  const token = getToken() || "";
  const status = $("ps-txn-status")?.value || "";
  const channel = $("ps-txn-channel")?.value || "";
  _psTxnPage = 1;
  try {
    const r = await fetch(
      `/api/org/paystack/transactions?token=${encodeURIComponent(token)}&page=1&perPage=20&status=${status}&channel=${channel}`,
    );
    const d = await r.json();
    _psTxnData = d.transactions || [];
    _psTxnTotal = d.total || 0;
    _psLoading("transactions", false);
    _psRenderTxnTable(_psTxnData);
    const shown = $("ps-txn-shown");
    if (shown) shown.textContent = _psTxnData.length;
    const tot = $("ps-txn-total");
    if (tot) tot.textContent = _psTxnTotal;
    if (foot && _psTxnTotal > _psTxnData.length) foot.style.display = "flex";
  } catch (e) {
    _psLoading("transactions", false);
  }
}

async function psLoadMoreTxns() {
  const token = getToken() || "";
  const status = $("ps-txn-status")?.value || "";
  const channel = $("ps-txn-channel")?.value || "";
  _psTxnPage++;
  try {
    const r = await fetch(
      `/api/org/paystack/transactions?token=${encodeURIComponent(token)}&page=${_psTxnPage}&perPage=20&status=${status}&channel=${channel}`,
    );
    const d = await r.json();
    _psTxnData = [..._psTxnData, ...(d.transactions || [])];
    _psRenderTxnTable(_psTxnData);
    const shown = $("ps-txn-shown");
    if (shown) shown.textContent = _psTxnData.length;
    if (_psTxnData.length >= _psTxnTotal) {
      const foot = $("ps-txn-footer");
      if (foot) foot.style.display = "none";
    }
  } catch (e) {}
}

function _psRenderTxnTable(txns) {
  const el = $("ps-txn-table");
  if (!el) return;
  el.innerHTML =
    `<div class="ps-th-row" style="grid-template-columns:130px 1fr 90px 110px 70px 90px 80px">
      <span>Reference</span><span>Customer</span><span>Amount</span><span>Channel</span><span>Fees</span><span>Date</span><span>Status</span>
    </div>` +
      txns
        .map(
          (
            t,
          ) => `<div class="ps-tr" style="grid-template-columns:130px 1fr 90px 110px 70px 90px 80px">
      <span class="ps-ref">${t.reference}</span>
      <div><div class="ps-cust-name">${t.customer_name || t.customer || "–"}</div><div class="ps-cust-email">${t.customer}</div></div>
      <span class="ps-amount ${t.status === "success" ? "ps-amount-g" : "ps-amount-r"}">${_psNgn(t.amount)}</span>
      <span style="color:var(--text3);font-size:.78rem">${_psChan(t)}</span>
      <span style="color:var(--text4);font-size:.78rem">${t.fees ? _psNgn(t.fees) : "–"}</span>
      <span style="color:var(--text4);font-size:.78rem">${_psDate(t.paid_at)}</span>
      ${_psBadge(t.status)}
    </div>`,
        )
        .join("") ||
    '<div style="padding:24px;color:var(--text4);text-align:center;font-size:.82rem">No transactions found.</div>';
}

async function psLoadBalance() {
  if (!_psConnected) return;
  _psLoading("balance", true);
  const token = getToken() || "";
  try {
    const r = await fetch(
      `/api/org/paystack/balance?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _psLoading("balance", false);
    const ct = $("ps-balance-content");
    if (ct) ct.style.display = "block";
    const set = (id, v) => {
      const el = $(id);
      if (el) el.textContent = v;
    };
    set("ps-bal-avail", _psNgn(d.available || 0));
    set("ps-bal-pending", "–");
    set("ps-bal-currency", d.currency || "NGN");
    const hist = $("ps-bal-history");
    if (hist && d.history) {
      hist.innerHTML =
        `<div class="ps-th-row" style="grid-template-columns:90px 1fr 110px 100px">
          <span>Date</span><span>Activity</span><span>Type</span><span>Change</span>
        </div>` +
          d.history
            .map(
              (
                h,
              ) => `<div class="ps-tr" style="grid-template-columns:90px 1fr 110px 100px">
          <span style="color:var(--text4);font-size:.78rem">${_psDate(h.date)}</span>
          <span style="font-weight:500">${h.desc}</span>
          ${_psBadge("success")}
          <span class="ps-amount ${h.change >= 0 ? "ps-amount-g" : "ps-amount-r"}">${h.change >= 0 ? "+" : ""}${_psNgn(Math.abs(h.change))}</span>
        </div>`,
            )
            .join("") ||
        '<div style="padding:16px;color:var(--text4);font-size:.8rem">No history yet.</div>';
    }
  } catch (e) {
    _psLoading("balance", false);
  }
}

async function psLoadSettlements() {
  if (!_psConnected) return;
  _psLoading("settlements", true);
  const token = getToken() || "";
  try {
    const r = await fetch(
      `/api/org/paystack/settlements?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _psLoading("settlements", false);
    const ct = $("ps-settlements-content");
    if (ct) ct.style.display = "block";
    const el = $("ps-stl-table");
    if (!el) return;
    const rows = d.settlements || [];
    el.innerHTML =
      `<div class="ps-th-row" style="grid-template-columns:90px 130px 1fr 110px 80px">
        <span>Date</span><span>Settlement ID</span><span>Transactions</span><span>Amount</span><span>Status</span>
      </div>` +
        rows
          .map(
            (
              s,
            ) => `<div class="ps-tr" style="grid-template-columns:90px 130px 1fr 110px 80px">
        <span style="color:var(--text4);font-size:.78rem">${_psDate(s.settlement_date)}</span>
        <span class="ps-ref">${String(s.id).slice(0, 14)}</span>
        <span style="color:var(--text3);font-size:.78rem">${s.txn_count} transactions</span>
        <span class="ps-amount ${s.status === "settled" ? "ps-amount-g" : "ps-amber"}">${_psNgn(s.total_amount || 0)}</span>
        ${_psBadge(s.status)}
      </div>`,
          )
          .join("") ||
      '<div style="padding:20px;color:var(--text4);font-size:.8rem;text-align:center">No settlements yet.</div>';
  } catch (e) {
    _psLoading("settlements", false);
  }
}

async function psLoadCustomers() {
  if (!_psConnected) return;
  _psLoading("customers", true);
  const token = getToken() || "";
  try {
    const r = await fetch(
      `/api/org/paystack/customers?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _psLoading("customers", false);
    const ct = $("ps-customers-content");
    if (ct) ct.style.display = "block";
    const el = $("ps-cust-table");
    if (!el) return;
    const rows = d.customers || [];
    el.innerHTML =
      `<div class="ps-th-row" style="grid-template-columns:1fr 110px 70px 90px">
        <span>Customer</span><span>Total spend</span><span>Txns</span><span>Since</span>
      </div>` +
        rows
          .map(
            (
              c,
            ) => `<div class="ps-tr" style="grid-template-columns:1fr 110px 70px 90px">
        <div><div class="ps-cust-name">${c.name || c.email}</div><div class="ps-cust-email">${c.email}</div></div>
        <span class="ps-amount ps-amount-g">${_psNgn(c.total_spend || 0)}</span>
        <span style="color:var(--text3)">${c.txn_count || 0}</span>
        <span style="color:var(--text4);font-size:.78rem">${_psDate(c.created_at)}</span>
      </div>`,
          )
          .join("") ||
      '<div style="padding:20px;color:var(--text4);font-size:.8rem;text-align:center">No customers yet.</div>';
  } catch (e) {
    _psLoading("customers", false);
  }
}

async function psLoadRefunds() {
  if (!_psConnected) return;
  _psLoading("refunds", true);
  const token = getToken() || "";
  try {
    const r = await fetch(
      `/api/org/paystack/refunds?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _psLoading("refunds", false);
    const ct = $("ps-refunds-content");
    if (ct) ct.style.display = "block";
    const rl = $("ps-refund-list"),
      dl = $("ps-dispute-list");
    if (rl)
      rl.innerHTML =
        (d.refunds || [])
          .map(
            (r) => `
      <div class="ps-tr" style="display:flex;align-items:center;gap:10px">
        <div style="flex:1"><div class="ps-cust-name">${r.customer || r.transaction}</div><div class="ps-cust-email">${r.transaction}</div></div>
        <span class="ps-amount ps-amount-r">${_psNgn(r.amount)}</span>
        ${_psBadge(r.status)}
      </div>`,
          )
          .join("") ||
        '<div style="padding:16px;color:var(--text4);font-size:.8rem">No refunds yet.</div>';
    if (dl)
      dl.innerHTML =
        (d.disputes || [])
          .map(
            (dsp) => `
      <div style="border:1px solid var(--amber2);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--amber2)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
          <span class="ps-cust-name">${dsp.reference || dsp.id} · ${_psNgn(dsp.amount)}</span>
          ${_psBadge(dsp.status)}
        </div>
        <div style="font-size:.78rem;color:var(--text3);line-height:1.5">${dsp.message || "Dispute filed."}</div>
      </div>`,
          )
          .join("") ||
        '<div style="padding:16px;color:var(--text4);font-size:.8rem">No disputes.</div>';
  } catch (e) {
    _psLoading("refunds", false);
  }
}

async function psLoadAnalytics() {
  if (!_psConnected) return;
  _psLoading("analytics", true);
  const token = getToken() || "";
  try {
    const r = await fetch(
      `/api/org/paystack/analytics?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _psLoading("analytics", false);
    const ct = $("ps-analytics-content");
    if (ct) ct.style.display = "block";

    // Rates
    const ratesEl = $("ps-an-rates");
    if (ratesEl) {
      const sr = d.success_rate || 0,
        fr = 100 - sr;
      ratesEl.innerHTML = `
        <div class="ps-rate-row"><div class="ps-rate-label"><span>Successful</span><span class="ps-rate-val" style="color:var(--teal)">${sr}%</span></div><div class="ps-rate-bg"><div class="ps-rate-fill" style="width:${sr}%;background:var(--teal)"></div></div></div>
        <div class="ps-rate-row"><div class="ps-rate-label"><span>Failed</span><span class="ps-rate-val" style="color:var(--red3)">${fr.toFixed(1)}%</span></div><div class="ps-rate-bg"><div class="ps-rate-fill" style="width:${fr}%;background:var(--red3)"></div></div></div>`;
    }

    // Weekday
    const wdEl = $("ps-an-weekday");
    if (wdEl && d.by_weekday) {
      const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const max = Math.max(...Object.values(d.by_weekday), 1);
      wdEl.innerHTML = days
        .map((day) => {
          const v = d.by_weekday[day] || 0;
          const pct = Math.round((v / max) * 100);
          return `<div class="ps-wd-row">
          <span class="ps-wd-lbl">${day}</span>
          <div class="ps-wd-bar-bg"><div class="ps-wd-bar-fill" style="width:${pct}%;opacity:${0.4 + pct / 160}"></div></div>
          <span class="ps-wd-val">${v ? _psNgn(v) : "–"}</span>
        </div>`;
        })
        .join("");
    }

    // Daily bar chart
    const dayEl = $("ps-an-daily");
    if (dayEl && d.by_day) {
      const entries = Object.entries(d.by_day);
      const max = Math.max(...entries.map(([, v]) => v), 1);
      dayEl.innerHTML = entries
        .map(([day, v]) => {
          const pct = Math.round((v / max) * 100);
          return `<div class="ps-bar-wrap"><div class="ps-bar" style="height:${Math.max(pct, 4)}%"></div><div class="ps-bar-lbl">${day.slice(5)}</div></div>`;
        })
        .join("");
    }

    // AI summary
    const aiEl = $("ps-an-ai");
    if (aiEl) {
      const sr = d.success_rate || 0;
      const wd = d.by_weekday || {};
      const topDay = Object.entries(wd).sort((a, b) => b[1] - a[1])[0];
      aiEl.innerHTML = `
        <div class="ps-insight ps-insight-g">
          ${topDay ? `<strong>Peak day:</strong> ${topDay[0]} generates ${_psNgn(topDay[1])} on average. Schedule billing reminders and promotions on ${topDay[0]}s for maximum conversion.` : "Collect more transactions to see peak day analytics."}
        </div>
        <div class="ps-insight ${sr < 90 ? "ps-insight-a" : "ps-insight-g"}">
          <strong>Success rate: ${sr}%</strong>, ${sr < 90 ? "above the 5% industry failure threshold. Consider adding bank transfer as a fallback for card declines." : "excellent performance, within industry benchmarks."}
        </div>
        <div class="ps-insight ps-insight-b">
          <strong>Paystack fees:</strong> ${_psNgn(d.total_fees || 0)} paid across all transactions. Optimise by encouraging bank transfers (lower fee per transaction).
        </div>`;
    }
  } catch (e) {
    _psLoading("analytics", false);
  }
}

async function psCheckConnectStatus() {
  const token = getToken() || "";
  try {
    const r = await fetch(
      `/api/org/paystack/status?token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    _psConnected = !!d.connected;
  } catch (e) {}
  const info = $("ps-connected-info"),
    form = $("ps-connect-form");
  if (_psConnected) {
    if (info) info.style.display = "flex";
    if (form) form.style.display = "none";
  } else {
    if (info) info.style.display = "none";
    if (form) form.style.display = "block";
  }
}

async function psConnect() {
  const key = $("ps-key-input")?.value.trim() || "";
  const err = $("ps-connect-err");
  if (!key) {
    if (err) {
      err.textContent = "Enter your Paystack secret key.";
      err.style.display = "block";
    }
    return;
  }
  if (!key.startsWith("sk_live_") && !key.startsWith("sk_test_")) {
    if (err) {
      err.textContent = "Key must start with sk_live_ or sk_test_";
      err.style.display = "block";
    }
    return;
  }
  if (err) err.style.display = "none";
  const token = getToken() || "";
  try {
    const r = await API("/api/org/paystack/connect", {
      token,
      secret_key: key,
    });
    _psConnected = true;
    toast("Paystack connected!");
    psFinancialsLoad();
  } catch (e) {
    if (err) {
      err.textContent = e.message || "Could not connect. Check your key.";
      err.style.display = "block";
    }
  }
}

async function psDisconnect() {
  const token = getToken() || "";
  try {
    await fetch(
      `/api/org/paystack/disconnect?token=${encodeURIComponent(token)}`,
      { method: "DELETE" },
    );
    _psConnected = false;
    toast("Paystack disconnected.");
    psGoTab("connect", null);
    const btn = $("pstk-tab-connect");
    if (btn) {
      document
        .querySelectorAll(".ps-tab")
        .forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
    }
    psCheckConnectStatus();
  } catch (e) {
    toast("Failed to disconnect.");
  }
}

function _psShowNotConnected() {
  _psConnected = false;
  psGoTab("connect", null);
}

/* ═══════════════════════════════════════════════════════════════
   WEEKLY REVIEW
═══════════════════════════════════════════════════════════════ */

let _reviewGenerated = false;

function reviewInit() {
  _reviewGenerated = false;
  _reviewPopulateStats();
  const aiCard = $("review-ai-card");
  const empty = $("review-empty");
  if (aiCard) aiCard.style.display = "none";
  if (empty) empty.style.display = "flex";
  _moodChartLoad();
  _reviewAutoLoad();
}

async function _reviewAutoLoad() {
  const token = getToken() || "";
  if (!token) return;
  // Check for a cached review from this week in localStorage
  const weekStart = (() => {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d.toISOString().split("T")[0];
  })();
  const cacheKey = `sivarr_weekly_review_${S.sid}_${weekStart}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    _reviewShowContent(cached, weekStart);
    return;
  }
  // Try fetching from server if the review was auto-generated
  try {
    const r = await fetch(
      `/api/ai/weekly-review/latest?token=${encodeURIComponent(token)}`,
    );
    if (!r.ok) return;
    const d = await r.json();
    if (d.review && d.week_start === weekStart) {
      localStorage.setItem(cacheKey, d.review);
      _reviewShowContent(d.review, weekStart);
    }
  } catch (_) {}
}

function _reviewShowContent(text, weekStart) {
  const aiCard = $("review-ai-card");
  const empty = $("review-empty");
  const content = $("review-ai-content");
  const weekEl = $("review-ai-week");
  if (content)
    content.innerHTML =
      typeof _reviewFormatMd === "function" ? _reviewFormatMd(text) : text;
  if (weekEl) weekEl.textContent = `Week of ${weekStart}`;
  if (aiCard) {
    aiCard.style.display = "block";
    _reviewGenerated = true;
  }
  if (empty) empty.style.display = "none";
}

async function _moodChartLoad() {
  const token = getToken() || "";
  if (!token) return;
  let container = $("mood-chart-card");
  if (!container) {
    // Append card after the review stats section
    const reviewWrap =
      document.querySelector(".review-stats-wrap") ||
      document.querySelector("#review-ai-card")?.parentElement;
    if (!reviewWrap) return;
    container = document.createElement("div");
    container.id = "mood-chart-card";
    container.style.cssText =
      "margin-top:16px;padding:16px 18px;background:var(--surface);border:1px solid var(--border);border-radius:12px";
    reviewWrap.parentElement?.appendChild(container);
  }
  container.innerHTML =
    '<div style="font-size:.82rem;color:var(--muted)">Loading mood data…</div>';
  try {
    const r = await fetch(
      `/api/analytics/mood?token=${encodeURIComponent(token)}&days=30`,
    );
    const d = await r.json();
    const pts = d.data || [];
    if (pts.length < 3) {
      container.innerHTML =
        '<div style="font-weight:700;margin-bottom:8px;font-size:.9rem">Mood trend (last 30 days)</div><div style="font-size:.82rem;color:var(--muted)">Keep journalling to see your mood trend.</div>';
      return;
    }
    const W = 480,
      H = 120,
      PAD_L = 52,
      PAD_R = 12,
      PAD_T = 12,
      PAD_B = 28;
    const w = W - PAD_L - PAD_R,
      h = H - PAD_T - PAD_B;
    const COLORS = {
      great: "var(--teal)",
      good: "#22c55e",
      okay: "var(--amber,#f59e0b)",
      low: "#d97706",
      stressed: "var(--red,#ef4444)",
    };
    const LABELS = {
      5: "Great",
      4: "Good",
      3: "Okay",
      2: "Low",
      1: "Stressed",
    };
    const xs = pts.map((_, i) => PAD_L + (i / (pts.length - 1)) * w);
    const ys = pts.map((p) => PAD_T + h - ((p.mood_score - 1) / 4) * h);
    const poly = xs.map((x, i) => `${x},${ys[i]}`).join(" ");
    const dots = pts
      .map(
        (p, i) =>
          `<circle cx="${xs[i]}" cy="${ys[i]}" r="4" fill="${COLORS[p.mood] || "var(--teal)"}" stroke="var(--surface)" stroke-width="1.5"><title>${p.date}: ${p.mood}</title></circle>`,
      )
      .join("");
    const yLabels = [1, 3, 5]
      .map((v) => {
        const y = PAD_T + h - ((v - 1) / 4) * h;
        return `<text x="${PAD_L - 6}" y="${y + 4}" text-anchor="end" font-size="9" fill="var(--muted)">${LABELS[v]}</text><line x1="${PAD_L}" y1="${y}" x2="${PAD_L + w}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>`;
      })
      .join("");
    const step = Math.max(1, Math.floor(pts.length / 5));
    const xLabels = pts
      .filter((_, i) => i % step === 0)
      .map((p, i2) => {
        const idx = i2 * step;
        const label = p.date.slice(5); // MM-DD
        return `<text x="${xs[idx]}" y="${PAD_T + h + 16}" text-anchor="middle" font-size="9" fill="var(--muted)">${label}</text>`;
      })
      .join("");
    container.innerHTML = `
      <div style="font-weight:700;margin-bottom:10px;font-size:.9rem">Mood trend (last 30 days)</div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;display:block;overflow:visible">
        ${yLabels}
        <polyline points="${poly}" fill="none" stroke="var(--teal)" stroke-width="2" stroke-linejoin="round"/>
        ${dots}
        ${xLabels}
      </svg>`;
  } catch (_) {
    container.innerHTML =
      '<div style="font-size:.82rem;color:var(--muted)">Could not load mood data.</div>';
  }
}

function _reviewPopulateStats() {
  if (!S.sid) return;
  const sid = S.sid;
  const today = new Date().toISOString().split("T")[0];
  const weekAgo = new Date(Date.now() - 6 * 86400000)
    .toISOString()
    .split("T")[0];

  // Tasks
  try {
    const tasks = JSON.parse(
      localStorage.getItem(`sivarr_tasks_${sid}`) || "[]",
    );
    const done = tasks.filter((t) => t.done).length;
    const total = tasks.length;
    const tv = $("rs-tasks-val");
    if (tv) tv.textContent = `${done}/${total}`;
  } catch (_) {}

  // Habits
  try {
    const habits = JSON.parse(
      localStorage.getItem(`sivarr_habits_${sid}`) || "[]",
    );
    if (habits.length) {
      const days = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() - i * 86400000)
          .toISOString()
          .split("T")[0];
        days.push(d);
      }
      let completed = 0,
        possible = habits.length * 7;
      habits.forEach((h) => {
        const c = h.completions || [];
        days.forEach((d) => {
          if (c.includes(d)) completed++;
        });
      });
      const pct = possible ? Math.round((completed / possible) * 100) : 0;
      const hv = $("rs-habits-val");
      if (hv) hv.textContent = `${pct}%`;
    } else {
      const hv = $("rs-habits-val");
      if (hv) hv.textContent = "–";
    }
  } catch (_) {}

  // Goals
  try {
    const goals = JSON.parse(
      localStorage.getItem(`sivarr_goals_${sid}`) || "[]",
    );
    const active = goals.filter((g) => !g.done).length;
    const gv = $("rs-goals-val");
    if (gv) gv.textContent = active || "0";
  } catch (_) {}

  // Focus sessions this week
  try {
    const log = JSON.parse(
      localStorage.getItem(`sivarr_focus_log_${sid}`) || "[]",
    );
    const thisWeek = log.filter((f) => f.date && f.date >= weekAgo);
    const fv = $("rs-focus-val");
    if (fv) fv.textContent = thisWeek.length || "0";
  } catch (_) {}
}

async function reviewGenerate() {
  if (!S.sid || !getToken()) {
    toast("Journal your week to have a review.");
    return;
  }
  const btn = $("review-gen-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML =
      '<i class="ti ti-loader-2" style="animation:spin .8s linear infinite"></i> Generating…';
  }

  const sid = S.sid;
  // Collect week stats
  let tasksDone = 0,
    tasksTotal = 0,
    habitsPct = 0;
  const goals = [];

  try {
    const tasks = JSON.parse(
      localStorage.getItem(`sivarr_tasks_${sid}`) || "[]",
    );
    tasksDone = tasks.filter((t) => t.done).length;
    tasksTotal = tasks.length;
  } catch (_) {}

  try {
    const habits = JSON.parse(
      localStorage.getItem(`sivarr_habits_${sid}`) || "[]",
    );
    if (habits.length) {
      const days = [];
      for (let i = 0; i < 7; i++) {
        days.push(
          new Date(Date.now() - i * 86400000).toISOString().split("T")[0],
        );
      }
      let completed = 0,
        possible = habits.length * 7;
      habits.forEach((h) => {
        (h.completions || []).forEach((d) => {
          if (days.includes(d)) completed++;
        });
      });
      habitsPct = possible ? Math.round((completed / possible) * 100) : 0;
    }
  } catch (_) {}

  try {
    const gl = JSON.parse(localStorage.getItem(`sivarr_goals_${sid}`) || "[]");
    gl.filter((g) => !g.done)
      .slice(0, 5)
      .forEach((g) => {
        goals.push({ title: g.title || "", progress: g.progress || 0 });
      });
  } catch (_) {}

  const jnl = JSON.parse(localStorage.getItem(`sivarr_journal_${sid}`) || "[]");
  const mood = jnl.length ? jnl[jnl.length - 1].mood || "" : "";

  try {
    const res = await API("/api/ai/weekly-review", {
      token: getToken(),
      tasks_done: tasksDone,
      tasks_total: tasksTotal,
      habits_pct: habitsPct,
      goals,
      mood,
    });

    const aiCard = $("review-ai-card");
    const empty = $("review-empty");
    const content = $("review-ai-content");
    const weekEl = $("review-ai-week");

    if (content) content.innerHTML = _reviewFormatMd(res.review || "");
    if (weekEl) weekEl.textContent = res.week || "";
    if (aiCard) aiCard.style.display = "block";
    if (empty) empty.style.display = "none";
    _reviewGenerated = true;
  } catch (e) {
    toast("Could not generate review. Try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-sparkles"></i> Generate Review';
    }
  }
}

function _reviewFormatMd(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(
      /^- (.+)$/gm,
      '<span style="display:block;padding-left:12px;position:relative;margin-bottom:4px"><span style="position:absolute;left:0;color:var(--teal)">•</span>$1</span>',
    )
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

/* ═══════════════════════════════════════════════════════════════
   NATURAL LANGUAGE QUICK-ADD
═══════════════════════════════════════════════════════════════ */

let _nlParsed = null;
let _nlDebounce = null;

function nlOpen() {
  const overlay = $("nl-overlay");
  const input = $("nl-input");
  if (!overlay) return;
  overlay.classList.add("open");
  _nlReset();
  setTimeout(() => input?.focus(), 60);
}

// CSP migration: the natural-language capture input's Enter-to-submit /
// Escape-to-close, previously two `if` statements in one inline handler.
window._nlInputKeydown = function (e) {
  if (e.key === "Enter") nlSubmit();
  if (e.key === "Escape") nlClose();
};

function nlClose() {
  const overlay = $("nl-overlay");
  if (overlay) overlay.classList.remove("open");
  _nlParsed = null;
}

function _nlReset() {
  const input = $("nl-input");
  const preview = $("nl-preview");
  if (input) input.value = "";
  if (preview) preview.style.display = "none";
  _nlParsed = null;
  clearTimeout(_nlDebounce);
}

function nlExample(el) {
  const input = $("nl-input");
  if (!input) return;
  // Strip leading emoji + space
  input.value = el.textContent.replace(/^[\p{Emoji}\s]+/u, "").trim();
  input.focus();
  nlSubmit();
}

async function nlSubmit() {
  const input = $("nl-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  clearTimeout(_nlDebounce);
  _nlDebounce = setTimeout(async () => {
    const preview = $("nl-preview");
    if (preview) preview.style.display = "none";

    try {
      const res = await API("/api/ai/parse-intent", { token: getToken(), text });
      if (!res?.ok) return;
      _nlParsed = res.parsed;
      _nlShowPreview(res.parsed);
    } catch (_) {
      // Fallback — just create as task without preview
      _nlParsed = {
        action: "task",
        title: text,
        priority: "normal",
        due: null,
      };
      _nlShowPreview(_nlParsed);
    }
  }, 300);
}

function _nlShowPreview(p) {
  const preview = $("nl-preview");
  const badge = $("nl-prev-type");
  const title = $("nl-prev-title");
  const meta = $("nl-prev-meta");
  if (!preview) return;

  badge.textContent = p.action;
  badge.className = `nl-badge ${p.action}`;
  title.textContent = p.title || "";

  const parts = [];
  if (p.priority && p.priority !== "normal")
    parts.push(p.priority + " priority");
  if (p.due) parts.push("due " + p.due);
  if (p.subject) parts.push(p.subject);
  meta.textContent = parts.join(" · ");

  preview.style.display = "block";
}

async function nlConfirm() {
  if (!_nlParsed) return;
  const p = _nlParsed;
  const sid = S.sid;

  if (p.action === "task") {
    // Save to tasks localStorage (same key as Flux panel)
    try {
      const key = `sivarr_tasks_${sid}`;
      const tasks = JSON.parse(localStorage.getItem(key) || "[]");
      tasks.unshift({
        id: Date.now(),
        title: p.title,
        status: "todo",
        priority: p.priority || "normal",
        date: p.due || "",
        done: false,
        created: new Date().toISOString().split("T")[0],
      });
      localStorage.setItem(key, JSON.stringify(tasks));
      toast(`Task added: "${p.title}" ✓`);
    } catch (_) {
      toast("Could not save task.");
    }
  } else if (p.action === "goal") {
    // Call goals API
    try {
      await API("/api/goals/add", {
        token: getToken(),
        title: p.title,
        subject: p.subject || "",
        deadline: p.due || "",
        target_score: 70,
      });
      toast(`Goal added: "${p.title}" ✓`);
    } catch (_) {
      toast("Could not save goal.");
    }
  } else {
    // Note — save to journal/notes localStorage
    try {
      const key = `sivarr_notes_${sid}`;
      const notes = JSON.parse(localStorage.getItem(key) || "[]");
      notes.unshift({
        id: Date.now(),
        title: p.title,
        content: p.title,
        created: new Date().toISOString(),
      });
      localStorage.setItem(key, JSON.stringify(notes));
      toast(`Note saved ✓`);
    } catch (_) {
      toast("Could not save note.");
    }
  }

  nlClose();
}

// Keyboard shortcut: Alt+A
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "a" && !e.ctrlKey && !e.metaKey) {
    const active = document.activeElement;
    const isTyping =
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable);
    if (!isTyping) {
      e.preventDefault();
      nlOpen();
    }
  }
});

/* ── Sidebar sections (Favorites/Pinned/Connect) are flat and always expanded —
   no collapsible headers since the sidebar restructure. Clear any stale collapsed
   state a returning user might have in localStorage from the old collapsible UI. */
function sbRestoreSections() {
  ["sb-favs", "sgi-work", "sgi-grow", "sgi-connect"].forEach((gid) => {
    const g = document.getElementById(gid);
    if (g) g.classList.remove("collapsed");
  });
  try {
    ["favorites", "work", "grow", "connect"].forEach((key) =>
      localStorage.removeItem("sivarr_sb_" + key),
    );
  } catch (e) {}
}
try {
  sbRestoreSections();
} catch (e) {}

/* ── Stage 2: recently-used destinations in ⌘K (top of palette on empty query) ── */
function cmdPushRecent(name) {
  if (!name || !document.querySelector(`.si[data-panel="${name}"]`)) return; // only real sidebar destinations
  let r = [];
  try {
    r = JSON.parse(localStorage.getItem("sivarr_cmd_recent") || "[]");
  } catch (e) {}
  r = [name, ...r.filter((n) => n !== name)].slice(0, 6);
  try {
    localStorage.setItem("sivarr_cmd_recent", JSON.stringify(r));
  } catch (e) {}
}
function cmdRecentHTML() {
  let r = [];
  try {
    r = JSON.parse(localStorage.getItem("sivarr_cmd_recent") || "[]");
  } catch (e) {}
  const rows = r
    .map((name) => {
      const btn = document.querySelector(`.si[data-panel="${name}"]`);
      if (!btn) return "";
      const label = btn.querySelector(".si-lb")?.textContent || name;
      const icon = btn.querySelector(".si-icon")?.innerHTML || "";
      return `<button class="cmd-item" data-onclick="cmdRunNamed" data-onclick-arg0="${esc(name)}"><div class="cmd-item-icon">${icon}</div><div style="flex:1;min-width:0"><div class="cmd-item-label">${esc(label)}</div></div><span class="cmd-item-tag">Recent</span></button>`;
    })
    .filter(Boolean)
    .join("");
  return rows ? `<div class="cmd-section-label">Recent</div>${rows}` : "";
}
function cmdRunNamed(name) {
  cmdDismiss();
  if (typeof nav === "function") nav(name);
}

/* ── Stage 3: Org settings (members/roles/remove + audit) — gated, shown only in an org ── */









/* ── Stage 3: data controls + notification channels + timezone ── */
function stExtrasRestore() {
  [
    ["inapp", "st-notifch-inapp"],
    ["email", "st-notifch-email"],
  ].forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (localStorage.getItem("sivarr_notifch_" + k) === "off")
      el.classList.remove("on");
    else el.classList.add("on");
  });
  const tz = document.getElementById("st-tz-display");
  if (tz) {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const offset = -new Date().getTimezoneOffset() / 60;
      const gmt = "GMT" + (offset >= 0 ? "+" : "") + offset;
      tz.value = `${zone} (${gmt})`;
    } catch (e) {
      tz.value = "Unable to detect";
    }
  }
}
// CSP migration: param order flipped to (key, btn) -- delegate.js's
// data-onclick-this always appends the element LAST.
function stToggleNotifCh(key, btn) {
  const on = !btn.classList.contains("on");
  btn.classList.toggle("on", on);
  try {
    localStorage.setItem("sivarr_notifch_" + key, on ? "on" : "off");
  } catch (e) {}
}
async function stExportData() {
  if (typeof toast === "function") toast("Preparing your data…");
  try {
    const sid = S.sid;
    const g = (k) => {
      try {
        return JSON.parse(localStorage.getItem(`sivarr_${k}_${sid}`) || "null");
      } catch (e) {
        return null;
      }
    };
    const body = {
      token: getToken(),
      habits: g("habits") || [],
      journal: g("journal") || [],
      finance: g("finance") || {},
      skills: g("skills") || [],
    };
    const r = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("export failed");
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sivarr-data.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    if (typeof toast === "function") toast("Data exported");
  } catch (e) {
    if (typeof toast === "function") toast("Export failed, try again");
  }
}
async function stClearChat() {
  if (!confirm("Clear your chat history? This cannot be undone.")) return;
  try {
    await acadAPI("/api/chat/clear", {});
    if (typeof toast === "function") toast("Chat history cleared");
  } catch (e) {
    if (typeof toast === "function") toast("Could not clear chat");
  }
}
async function stDeleteAccount() {
  if (
    !confirm("Delete your account permanently? All your data will be removed.")
  )
    return;
  if (!confirm("This is final. There is no undo. Delete everything?")) return;
  try {
    await acadAPI("/api/account/delete", {});
  } catch (e) {
    // Server delete failed — the account still exists, so do NOT clear local state
    // or redirect (that would falsely look like a successful deletion).
    if (typeof toast === "function")
      toast(
        (e && e.message) || "Could not delete your account. Please try again.",
      );
    return;
  }
  try {
    localStorage.clear();
  } catch (e) {}
  location.href = "/";
}


// ═══════════════════════════════════════════════════════════════
// GLOBAL TOOLTIP ENGINE
// Usage: add data-tip="Label" to any element.
//        data-tip-pos="right|left|top|bottom" (default: bottom)
// Sidebar collapsed items get data-tip-pos="right" so the label
// floats out to the right of the icon.
// ═══════════════════════════════════════════════════════════════
(function _svTooltip() {
  const TIP_DELAY = 500; // ms before tooltip appears
  const tip = document.createElement("div");
  tip.id = "sv-tip";
  Object.assign(tip.style, {
    position: "fixed",
    zIndex: "999999",
    background: "var(--card,#1e1e2e)",
    color: "var(--text1,#f0f0f0)",
    border: "1px solid var(--border,rgba(255,255,255,.12))",
    borderRadius: "7px",
    padding: "5px 10px",
    fontSize: ".72rem",
    fontWeight: "600",
    lineHeight: "1.4",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    userSelect: "none",
    opacity: "0",
    transition: "opacity .15s",
    boxShadow: "0 4px 20px rgba(0,0,0,.25)",
    fontFamily: 'var(--font,"Inter",sans-serif)',
    maxWidth: "220px",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });
  document.body.appendChild(tip);

  let _timer = null;
  let _current = null;

  function show(target) {
    const text = target.dataset.tip;
    if (!text) return;
    tip.textContent = text;
    tip.style.opacity = "0";
    // Force layout so offsetWidth is accurate
    tip.style.display = "block";
    const rect = target.getBoundingClientRect();
    const pos = target.dataset.tipPos || "bottom";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x, y;
    if (pos === "right") {
      x = rect.right + 8;
      y = rect.top + (rect.height - th) / 2;
    } else if (pos === "left") {
      x = rect.left - tw - 8;
      y = rect.top + (rect.height - th) / 2;
    } else if (pos === "top") {
      x = rect.left + (rect.width - tw) / 2;
      y = rect.top - th - 8;
    } else {
      // bottom
      x = rect.left + (rect.width - tw) / 2;
      y = rect.bottom + 8;
    }
    // Clamp to viewport
    x = Math.max(6, Math.min(x, window.innerWidth - tw - 6));
    y = Math.max(6, Math.min(y, window.innerHeight - th - 6));
    tip.style.left = x + "px";
    tip.style.top = y + "px";
    tip.style.opacity = "1";
  }

  function hide() {
    tip.style.opacity = "0";
    _current = null;
  }

  document.addEventListener("mouseover", function (e) {
    const target = e.target.closest("[data-tip]");
    if (!target || target === _current) return;
    _current = target;
    clearTimeout(_timer);
    _timer = setTimeout(() => show(target), TIP_DELAY);
  });

  document.addEventListener("mouseout", function (e) {
    const target = e.target.closest("[data-tip]");
    if (!target) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    clearTimeout(_timer);
    hide();
  });

  // Hide on click, scroll, or Escape
  document.addEventListener("click", () => {
    clearTimeout(_timer);
    hide();
  });
  document.addEventListener(
    "scroll",
    () => {
      clearTimeout(_timer);
      hide();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      clearTimeout(_timer);
      hide();
    }
  });
})();