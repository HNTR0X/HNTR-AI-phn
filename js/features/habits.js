// Habits panel — extracted from js/app.js. Depends on app.js's shared globals
// (S, API, $, toast, _queueMutation) which load before this file. See
// templates/index.html for script load order.
//
// The old Habits panel never needed sheet open/close helpers — it used only
// siModal.form/siModal.confirm for Add/Edit/Delete. The new Goals sheets
// (New Goal, Link Habit) are custom multi-field UIs that don't fit siModal,
// so they need openSheet/closeSheetEls. I don't have visibility into the
// rest of app.js to confirm whether it already defines these (other panels
// with bottom sheets might), so these are guarded shims — if app.js already
// provides real ones, these no-op and defer to those instead.
if (typeof window.openSheet === "undefined") {
  window.openSheet = function (id, overlayId) {
    document.getElementById(id)?.classList.add("open");
    document.getElementById(overlayId)?.classList.add("show");
  };
}
if (typeof window.closeSheetEls === "undefined") {
  window.closeSheetEls = function (id, overlayId) {
    document.getElementById(id)?.classList.remove("open");
    document.getElementById(overlayId)?.classList.remove("show");
  };
}

// ════════════ HABITS ════════════
const HAB_KEY = () => `sivarr_habits_${S.sid || "guest"}`;

function _habFreqLabel(freq) {
  return (
    {
      daily: "Every day",
      weekdays: "Weekdays (M–F)",
      weekends: "Weekends",
      weekly: "Once a week",
    }[freq] || "Every day"
  );
}

// habitToggle/habitEdit/habitDelete all address habits by their position in
// the FULL localStorage array, not a stable id (unlike tasks/goals/docs) —
// pre-existing, not something this pass changes. So when soft-deleted habits
// are filtered out of what's rendered, each visible card must still carry
// its ORIGINAL index from the full array, not its position in the filtered
// list, or clicking a button would silently act on the wrong habit.
function _habVisible(habits) {
  return (habits || [])
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => !h.deleted_at);
}

// habitInit is kept as the single entry point (app.js's panel-switch logic
// calls this by name) but now renders BOTH goals and habits into the merged
// Goals & Habits panel — see renderGoalsAndHabits() below, which this just
// forwards to after pruning trash for both.
function habitInit() {
  _habPruneExpiredTrash();
  _goalPruneExpiredTrash();
  renderGoalsAndHabits();
}

function renderGoalsAndHabits() {
  renderGoalsList();
  renderHabitsList();
}

let GH_SEARCH_QUERY = "";
function ghPromptSearch() {
  const val = prompt("Search goals & habits by keyword:", GH_SEARCH_QUERY);
  if (val === null) return;
  GH_SEARCH_QUERY = val.trim();
  renderGoalsAndHabits();
  if (GH_SEARCH_QUERY) toast(`Filtering by: "${GH_SEARCH_QUERY}"`);
}
function _ghMatchesSearch(title) {
  if (!GH_SEARCH_QUERY) return true;
  return title.toLowerCase().includes(GH_SEARCH_QUERY.toLowerCase());
}

// Habits that appear in one or more goals' habit_ids get a "N goal(s)" tag,
// matching the mockup's "Standalone habits" list — despite the name, that
// list actually shows ALL habits (goal-linked ones included, tagged with
// their goal count), not just unlinked ones.
function _habGoalCount(habitId, allGoals) {
  return _goalVisible(allGoals).filter(({ g }) =>
    (g.habit_ids || []).some((id) => String(id) === String(habitId)),
  ).length;
}

function renderHabitsList() {
  const list = $("habitsList");
  if (!list) return;
  const allHabits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const habits = _habVisible(allHabits).filter(({ h }) =>
    _ghMatchesSearch(h.title),
  ); // [{h, i}], i = index into allHabits
  const allGoals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const today = new Date().toISOString().split("T")[0];

  if (!habits.length) {
    list.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;padding:2.5rem 1rem;gap:10px;color:var(--gh-t3)">
      <div style="font-size:2rem">🔥</div>
      <div style="font-weight:700;font-size:.95rem;color:var(--gh-t1)">No habits yet</div>
      <div style="font-size:.82rem;text-align:center;max-width:280px">Build consistency by tracking daily habits, and link them to a goal to track progress.</div>
    </div>`;
    return;
  }

  list.innerHTML = habits
    .map(({ h, i }) => {
      const isToday = (h.completions || []).includes(today);
      const streak = h.streak || 0;
      const goalCount = _habGoalCount(h.id, allGoals);
      return `
    <div class="habit-row">
      <div class="habit-check ${isToday ? "done" : ""}" data-onclick="habitToggle" data-onclick-args="${esc(JSON.stringify([i]))}" title="${isToday ? "Mark undone" : "Mark done today"}">${isToday ? '<i class="ti ti-check"></i>' : ""}</div>
      <div class="habit-emoji">${h.emoji || "📌"}</div>
      <div class="habit-name">${esc(h.title)}</div>
      ${goalCount ? `<div class="habit-goal-tag">${goalCount} goal${goalCount !== 1 ? "s" : ""}</div>` : ""}
      <div class="habit-streak-badge"><i class="ti ti-flame" style="font-size:12px;"></i>${streak}d</div>
      <div class="habit-row-actions">
        <button class="gh-action-btn" data-onclick="habitEdit" data-onclick-args="${esc(JSON.stringify([i]))}" title="Edit"><i class="ti ti-pencil"></i></button>
        <button class="gh-action-btn" data-onclick="habitDelete" data-onclick-args="${esc(JSON.stringify([i]))}" title="Delete"><i class="ti ti-trash"></i></button>
      </div>
    </div>`;
    })
    .join("");
}

function habitToggle(idx) {
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
    habits[idx].best_streak = Math.max(
      habits[idx].best_streak || 0,
      habits[idx].streak,
    );
    const streak = habits[idx].streak;
    if (streak > 0 && streak % 7 === 0)
      _autoFire("habit_streak", {
        habitTitle: habits[idx].title,
        streak,
        journalPrompt: `${streak}-day streak on "${habits[idx].title}"! How does it feel? `,
        followUpTask: `Keep the ${streak}-day streak: ${habits[idx].title}`,
      });
  }
  localStorage.setItem(HAB_KEY(), JSON.stringify(habits));
  _syncHabitsToServer(habits);
  _recordActivity();
  habitInit();
}

async function habitAdd() {
  const emojis = ["📚", "🧘", "🏃", "💧", "🥗", "✍️", "🎯", "🛌", "🔔", "💡"];
  const d = await siModal.form(
    "Add Habit",
    [
      {
        id: "title",
        label: "Habit name",
        placeholder: "e.g. Morning Study",
        required: true,
      },
      {
        id: "emoji",
        label: "Pick an emoji",
        type: "emoji",
        options: emojis,
        default: emojis[Math.floor(Math.random() * emojis.length)],
      },
      {
        id: "freq",
        label: "Frequency",
        type: "select",
        options: [
          { value: "daily", label: "Every day" },
          { value: "weekdays", label: "Weekdays (Mon–Fri)" },
          { value: "weekends", label: "Weekends" },
          { value: "weekly", label: "Once a week" },
        ],
        default: "daily",
      },
    ],
    { confirmLabel: "Add Habit" },
  );
  if (!d || !d.title) return;
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  habits.push({
    id: Date.now().toString(),
    title: d.title,
    emoji: d.emoji || "📌",
    freq: d.freq || "daily",
    completions: [],
    streak: 0,
    best_streak: 0,
  });
  localStorage.setItem(HAB_KEY(), JSON.stringify(habits));
  _syncHabitsToServer(habits);
  habitInit();
  toast("Habit added ✓");
}

async function habitEdit(idx) {
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const h = habits[idx];
  if (!h) return;
  const emojis = ["📚", "🧘", "🏃", "💧", "🥗", "✍️", "🎯", "🛌", "🔔", "💡"];
  const d = await siModal.form(
    "Edit Habit",
    [
      {
        id: "title",
        label: "Habit name",
        placeholder: "e.g. Morning Study",
        required: true,
        default: h.title,
      },
      {
        id: "emoji",
        label: "Pick an emoji",
        type: "emoji",
        options: emojis,
        default: h.emoji || "📌",
      },
      {
        id: "freq",
        label: "Frequency",
        type: "select",
        options: [
          { value: "daily", label: "Every day" },
          { value: "weekdays", label: "Weekdays (Mon–Fri)" },
          { value: "weekends", label: "Weekends" },
          { value: "weekly", label: "Once a week" },
        ],
        default: h.freq || "daily",
      },
    ],
    { confirmLabel: "Save" },
  );
  if (!d || !d.title) return;
  habits[idx].title = d.title;
  habits[idx].emoji = d.emoji || h.emoji || "📌";
  habits[idx].freq = d.freq || "daily";
  localStorage.setItem(HAB_KEY(), JSON.stringify(habits));
  _syncHabitsToServer(habits);
  habitInit();
  toast("Habit updated ✓");
}

async function habitDelete(idx) {
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const h = habits[idx];
  if (!h) return;
  if (
    !(await siModal.confirm(
      `Delete "${h.title}"? You can restore it from Trash within 30 days.`,
      { title: "Delete Habit", confirmLabel: "Delete", danger: true },
    ))
  )
    return;
  habits[idx].deleted_at = new Date().toISOString();
  localStorage.setItem(HAB_KEY(), JSON.stringify(habits));
  _syncHabitsToServer(habits);
  habitInit();
  toast("Habit moved to Trash");
}

function habitRestore(idx) {
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  if (!habits[idx]) return;
  delete habits[idx].deleted_at;
  localStorage.setItem(HAB_KEY(), JSON.stringify(habits));
  _syncHabitsToServer(habits);
  habitInit();
}

// ── Server sync — per-entity, not whole-array ───────────────────────────
// Same diff-against-a-snapshot approach as js/features/tasks.js's
// _syncTasksToServer — see that file for the full rationale. Habits are
// addressed by array index in the UI functions above (habitToggle/Edit/
// Delete/Restore all take `idx`), but every habit object still carries a
// stable `id` (set in habitAdd), which is what this diff keys off of.
const HAB_SYNCED_KEY = () => `sivarr_hab_synced_${S.sid || "guest"}`;

function _habGetSyncedSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(HAB_SYNCED_KEY()) || "{}");
  } catch {
    return {};
  }
}
function _habSetSyncedSnapshot(snap) {
  try {
    localStorage.setItem(HAB_SYNCED_KEY(), JSON.stringify(snap));
  } catch (_) {}
}

// The client has always used "freq"; the server column is "frequency" (see
// routes/habits.py's _CLIENT_FIELD_ALIASES for the write-side mapping and
// the bug this closes). This is the read-side mirror, for habit objects the
// server hands back (a hydrate/restore pull).
function _habServerHabitToLocal(h) {
  const out = { ...h };
  if ("frequency" in out) {
    out.freq = out.frequency;
    delete out.frequency;
  }
  return out;
}

function _habSendMutation(url, body) {
  const token = getToken();
  if (!token || !S.sid) return Promise.resolve(null);
  body = { token, ...body };
  if (!navigator.onLine) {
    _queueMutation(url, body);
    return Promise.resolve(null);
  }
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => {
      _queueMutation(url, body);
      return null;
    });
}

function _syncHabitsToServer(habits) {
  const token = getToken();
  if (!token || !S.sid) return;

  const snap = _habGetSyncedSnapshot();
  const nextSnap = {};

  (habits || []).forEach((h) => {
    const id = String(h.id);
    const serial = JSON.stringify(h);
    nextSnap[id] = serial;
    if (snap[id] === serial) return; // unchanged since last sync

    if (!(id in snap)) {
      _habSendMutation("/api/habits/add", { ...h });
      return;
    }
    let was;
    try {
      was = JSON.parse(snap[id]);
    } catch {
      was = {};
    }
    if (!was.deleted_at && h.deleted_at) {
      _habSendMutation("/api/habits/delete", { id: h.id });
    } else if (was.deleted_at && !h.deleted_at) {
      _habSendMutation("/api/habits/undelete", { id: h.id });
      _habSendMutation("/api/habits/update", { id: h.id, ...h });
    } else {
      _habSendMutation("/api/habits/update", { id: h.id, ...h });
    }
  });

  _habSetSyncedSnapshot(nextSnap);
}

// Same reasoning as tasks' _shPruneExpiredTrash — app.py's
// _purge_deleted_habits job purges the server side but never touches this
// browser's own localStorage copy, so the client has to prune that itself.
// Runs once per Habits-panel visit.
function _habPruneExpiredTrash() {
  const habits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const cutoff = Date.now() - 30 * 86400000;
  const kept = habits.filter((h) => {
    if (!h.deleted_at) return true;
    const ts = Date.parse(h.deleted_at);
    return Number.isNaN(ts) || ts >= cutoff;
  });
  if (kept.length !== habits.length) {
    localStorage.setItem(HAB_KEY(), JSON.stringify(kept));
    _syncHabitsToServer(kept);
  }
}

// ════════════ GOALS (merged into this panel) ════════════
// FLAGGED GAP: this Goals implementation was built without routes/goals.py
// or app.js's old `gl`-prefixed functions in hand (not provided when this
// was written). It follows the same localStorage-first + diff-against-a-
// snapshot sync pattern as habits above, and posts to /api/goals/add|update
// |delete|undelete, matching the endpoint-naming pattern documented for
// Tasks/Habits/Goals elsewhere in this codebase. What's NOT verified against
// the real backend:
//   - the goal object shape below (id/title/due/mode/manual_pct/
//     pct_override/milestones/habit_ids) — the old Goals doc mentions a
//     `subject` field indexed by AI chat retrieval, which isn't included
//     here since its meaning (category? linked space?) wasn't specified
//   - whether /api/goals/* expects per-entity payloads like this, or the
//     whole-list-rewrite shape the old Goals API doc described (the doc
//     described that as the SERVER's internal implementation, which,
//     matching Tasks/Habits, should mean the client-facing endpoints are
//     already per-entity — but this isn't confirmed)
// Before shipping, reconcile this against the real routes/goals.py.
const GOAL_KEY = () => `sivarr_goals_${S.sid || "guest"}`;

function _goalVisible(goals) {
  return (goals || [])
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => !g.deleted_at);
}

// Returns { pct: number|null, locked, editable } — pct is null only in
// milestone mode with zero milestones (nothing to compute from yet).
function _goalPct(g) {
  const milestones = g.milestones || [];
  const total = milestones.length;
  const done = milestones.filter((m) => m.done).length;
  const milestonePct = total ? Math.round((done / total) * 100) : null;

  if (g.mode === "manual") {
    return { pct: g.manual_pct || 0, locked: false, editable: true };
  }
  if (g.mode === "hybrid") {
    if (g.pct_override != null) {
      return {
        pct: g.pct_override,
        locked: false,
        editable: true,
        overridden: true,
      };
    }
    return {
      pct: milestonePct == null ? 0 : milestonePct,
      locked: false,
      editable: true,
    };
  }
  // milestone mode — fully locked/auto, no override
  if (milestonePct === null)
    return { pct: null, locked: true, editable: false };
  return { pct: milestonePct, locked: true, editable: false };
}

function _goalHabits(g, allHabits) {
  return (g.habit_ids || [])
    .map((id) => allHabits.find((h) => String(h.id) === String(id)))
    .filter(Boolean);
}

function _fmtGoalDue(due) {
  if (!due) return "";
  const d = new Date(due + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function renderGoalsList() {
  const wrap = $("goalsList");
  if (!wrap) return;
  const allGoals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const goals = _goalVisible(allGoals).filter(({ g }) =>
    _ghMatchesSearch(g.title),
  );
  const allHabits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");

  if (!goals.length) {
    wrap.innerHTML = `<div style="font-size:.82rem;color:var(--gh-t3);padding:6px 0 14px;">${GH_SEARCH_QUERY ? "No matching goals." : "No goals yet. Tap + to add one."}</div>`;
    return;
  }

  wrap.innerHTML = goals
    .map(({ g, i }) => renderGoalCard(g, i, allHabits))
    .join("");
}

function renderGoalCard(g, i, allHabits) {
  const p = _goalPct(g);
  const linkedHabits = _goalHabits(g, allHabits);
  const milestones = g.milestones || [];

  const milestonesHtml = milestones
    .map(
      (m) => `
    <div class="milestone-row">
      <div class="milestone-check ${m.done ? "done" : ""}" data-onclick="goalMilestoneToggle" data-onclick-args="${esc(JSON.stringify([i, m.id]))}">${m.done ? '<i class="ti ti-check"></i>' : ""}</div>
      <div class="milestone-name ${m.done ? "done" : ""}">${esc(m.name)}</div>
    </div>`,
    )
    .join("");

  const habitsHtml =
    linkedHabits
      .map(
        (h) =>
          `<div class="habit-mini-chip"><i class="ti ti-flame"></i>${esc(h.title)} <span class="habit-mini-streak">${h.streak || 0}d</span></div>`,
      )
      .join("") +
    `<div class="habit-mini-chip add-habit-chip" data-onclick="openLinkHabit" data-onclick-args="${esc(JSON.stringify([i]))}"><i class="ti ti-plus"></i>Link a habit</div>`;

  const pctDisplay = p.pct == null ? "—" : `${p.pct}%`;
  const fillWidth = p.pct == null ? 0 : p.pct;

  return `
  <div class="goal-card" data-goal-idx="${i}">
    <div class="goal-card-top">
      <div><div class="goal-title">${esc(g.title)}</div>${g.due ? `<div class="goal-due">Target: ${esc(_fmtGoalDue(g.due))}</div>` : ""}</div>
      <div class="goal-pct-wrap ${p.locked ? "locked" : p.editable ? "editable" : ""}">
        <div class="goal-pct"${p.editable ? ` data-onclick="goalPctEditStart" data-onclick-args="${esc(JSON.stringify([i]))}"` : ""}>${pctDisplay}</div>
        ${p.editable ? `<i class="ti ti-pencil goal-pct-edit-icon" data-onclick="goalPctEditStart" data-onclick-args="${esc(JSON.stringify([i]))}"></i>` : ""}
        ${p.locked ? `<i class="ti ti-lock goal-pct-lock" title="Auto from milestones"></i>` : ""}
      </div>
    </div>
    ${p.pct != null ? `<div class="progress-track"><div class="progress-fill" style="width:${fillWidth}%;"></div></div>` : ""}
    ${g.mode === "manual" ? `<div class="manual-slider-row"><input type="range" class="manual-slider" min="0" max="100" value="${g.manual_pct || 0}" oninput="goalManualSlide(${i},this.value)" onchange="goalManualSlideCommit(${i},this.value)"></div>` : ""}

    ${
      milestones.length
        ? `<div class="goal-milestones">${milestonesHtml}<div class="add-milestone-inline" data-onclick="goalAddMilestonePrompt" data-onclick-args="${esc(JSON.stringify([i]))}"><i class="ti ti-plus" style="font-size:11px;"></i>Add milestone</div></div>`
        : `<div class="no-milestone-note"><i class="ti ti-info-circle" style="margin-right:5px;"></i>No milestones yet. <span style="text-decoration:underline;cursor:pointer;" data-onclick="goalAddMilestonePrompt" data-onclick-args="${esc(JSON.stringify([i]))}">Add one to track progress.</span></div>`
    }

    <div class="goal-habits-row">${habitsHtml}</div>
    <div class="goal-card-actions">
      <button class="gh-action-btn" data-onclick="goalEdit" data-onclick-args="${esc(JSON.stringify([i]))}" title="Edit"><i class="ti ti-pencil"></i></button>
      <button class="gh-action-btn" data-onclick="goalDelete" data-onclick-args="${esc(JSON.stringify([i]))}" title="Delete"><i class="ti ti-trash"></i></button>
    </div>
  </div>`;
}

// ── Milestones ──────────────────────────────────────────────────────────
function goalMilestoneToggle(i, milestoneId) {
  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const g = goals[i];
  if (!g) return;
  const m = (g.milestones || []).find((x) => x.id === milestoneId);
  if (!m) return;
  m.done = !m.done;
  localStorage.setItem(GOAL_KEY(), JSON.stringify(goals));
  _syncGoalsToServer(goals);
  renderGoalsList();
}

function goalAddMilestonePrompt(i) {
  const name = prompt("Milestone name:", "");
  if (!name || !name.trim()) return;
  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const g = goals[i];
  if (!g) return;
  g.milestones = g.milestones || [];
  g.milestones.push({ id: `${Date.now()}`, name: name.trim(), done: false });
  localStorage.setItem(GOAL_KEY(), JSON.stringify(goals));
  _syncGoalsToServer(goals);
  renderGoalsList();
}

// ── Manual / hybrid percentage ──────────────────────────────────────────
// Live drag feedback writes straight to the DOM (avoids losing slider focus
// mid-drag from a full re-render); onchange (fires on release) is what
// actually persists + syncs.
window.goalManualSlide = function (i, val) {
  const card = document.querySelector(`.goal-card[data-goal-idx="${i}"]`);
  if (!card) return;
  const pctEl = card.querySelector(".goal-pct");
  const fill = card.querySelector(".progress-fill");
  if (pctEl) pctEl.textContent = `${val}%`;
  if (fill) fill.style.width = `${val}%`;
};
window.goalManualSlideCommit = function (i, val) {
  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  if (!goals[i]) return;
  goals[i].manual_pct = parseInt(val) || 0;
  localStorage.setItem(GOAL_KEY(), JSON.stringify(goals));
  _syncGoalsToServer(goals);
};

window.goalPctEditStart = function (i) {
  const card = document.querySelector(`.goal-card[data-goal-idx="${i}"]`);
  if (!card) return;
  const pctEl = card.querySelector(".goal-pct");
  if (!pctEl || card.querySelector(".goal-pct-input")) return;
  const input = document.createElement("input");
  input.type = "number";
  input.className = "goal-pct-input";
  input.value = parseInt(pctEl.textContent) || 0;
  pctEl.style.display = "none";
  pctEl.parentElement.insertBefore(input, pctEl);
  input.focus();
  input.select();
  const commit = () => {
    const v = Math.max(0, Math.min(100, parseInt(input.value) || 0));
    const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
    if (goals[i]) {
      if (goals[i].mode === "manual") goals[i].manual_pct = v;
      else goals[i].pct_override = v;
      localStorage.setItem(GOAL_KEY(), JSON.stringify(goals));
      _syncGoalsToServer(goals);
    }
    input.remove();
    renderGoalsList();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
};

// ── Goal CRUD ────────────────────────────────────────────────────────────
async function goalEdit(i) {
  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const g = goals[i];
  if (!g) return;
  const d = await siModal.form(
    "Edit Goal",
    [
      { id: "title", label: "Title", required: true, default: g.title },
      {
        id: "due",
        label: "Target date (optional)",
        type: "date",
        default: g.due || "",
      },
      {
        id: "mode",
        label: "Progress tracking",
        type: "select",
        options: [
          { value: "manual", label: "Manual" },
          { value: "milestone", label: "Milestone-driven" },
          { value: "hybrid", label: "Hybrid" },
        ],
        default: g.mode || "milestone",
      },
    ],
    { confirmLabel: "Save" },
  );
  if (!d || !d.title) return;
  g.title = d.title;
  g.due = d.due || "";
  g.mode = d.mode || "milestone";
  localStorage.setItem(GOAL_KEY(), JSON.stringify(goals));
  _syncGoalsToServer(goals);
  renderGoalsList();
  toast("Goal updated ✓");
}

async function goalDelete(i) {
  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const g = goals[i];
  if (!g) return;
  if (
    !(await siModal.confirm(
      `Delete "${g.title}"? You can restore it from Trash within 30 days.`,
      { title: "Delete Goal", confirmLabel: "Delete", danger: true },
    ))
  )
    return;
  g.deleted_at = new Date().toISOString();
  localStorage.setItem(GOAL_KEY(), JSON.stringify(goals));
  _syncGoalsToServer(goals);
  renderGoalsList();
  toast("Goal moved to Trash");
}

function goalRestore(i) {
  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  if (!goals[i]) return;
  delete goals[i].deleted_at;
  localStorage.setItem(GOAL_KEY(), JSON.stringify(goals));
  _syncGoalsToServer(goals);
  renderGoalsList();
}

// ── New Goal sheet ───────────────────────────────────────────────────────
let NEW_GOAL_MODE = "milestone";
let NEW_GOAL_SELECTED_HABITS = new Set();

const GOAL_MODE_DESCS = {
  manual:
    "% is fully manual — drag the slider yourself. Milestones are just a checklist, they don't move the number.",
  milestone:
    "% is calculated automatically from milestones checked. No milestones = no %.",
  hybrid:
    "% suggests itself from milestones checked, but tap the pencil to override it whenever the math doesn't match reality.",
};

function openNewGoal() {
  NEW_GOAL_MODE = "milestone";
  NEW_GOAL_SELECTED_HABITS = new Set();
  if ($("newGoalTitle")) $("newGoalTitle").value = "";
  if ($("newGoalDue")) $("newGoalDue").value = "";
  document
    .querySelectorAll("#newGoalModeRow .mode-btn")
    .forEach((b) => b.classList.toggle("on", b.dataset.mode === "milestone"));
  if ($("newGoalModeDesc"))
    $("newGoalModeDesc").textContent = GOAL_MODE_DESCS.milestone;
  const mb = $("milestoneBuilder");
  if (mb) {
    mb.innerHTML =
      '<div class="milestone-builder-row"><input class="field-input" type="text" placeholder="e.g. Complete beginner course"><i class="ti ti-x remove-milestone" onclick="this.closest(\'.milestone-builder-row\').remove()"></i></div>';
  }
  renderNewGoalHabitPickList();
  openSheet("newGoalSheet", "newGoalOverlay");
}
function closeNewGoal() {
  closeSheetEls("newGoalSheet", "newGoalOverlay");
}

function renderNewGoalHabitPickList() {
  const wrap = $("newGoalHabitPickList");
  if (!wrap) return;
  const habits = _habVisible(
    JSON.parse(localStorage.getItem(HAB_KEY()) || "[]"),
  );
  wrap.innerHTML =
    habits
      .map(({ h }) => {
        const sel = NEW_GOAL_SELECTED_HABITS.has(String(h.id));
        return `
    <div class="habit-pick-row" data-onclick="toggleNewGoalHabitPick" data-onclick-args="${esc(JSON.stringify([h.id]))}">
      <div class="habit-pick-check ${sel ? "sel" : ""}">${sel ? '<i class="ti ti-check"></i>' : ""}</div>
      <div class="habit-pick-name">${esc(h.title)}</div>
      <div class="habit-pick-streak">${h.streak || 0}d streak</div>
    </div>`;
      })
      .join("") ||
    `<div style="font-size:11.5px;color:var(--gh-t3);padding:8px 0;">No habits yet.</div>`;
}
window.toggleNewGoalHabitPick = function (habitId) {
  const key = String(habitId);
  if (NEW_GOAL_SELECTED_HABITS.has(key)) NEW_GOAL_SELECTED_HABITS.delete(key);
  else NEW_GOAL_SELECTED_HABITS.add(key);
  renderNewGoalHabitPickList();
};
window.createHabitForNewGoal = async function () {
  await habitAdd(); // opens siModal, persists, re-renders the habits list, toasts
  const allHabits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const last = allHabits[allHabits.length - 1];
  if (last) NEW_GOAL_SELECTED_HABITS.add(String(last.id));
  renderNewGoalHabitPickList();
};

function addMilestoneField() {
  const wrap = $("milestoneBuilder");
  if (!wrap) return;
  const row = document.createElement("div");
  row.className = "milestone-builder-row";
  row.innerHTML =
    '<input class="field-input" type="text" placeholder="Milestone name"><i class="ti ti-x remove-milestone" onclick="this.closest(\'.milestone-builder-row\').remove()"></i>';
  wrap.appendChild(row);
}

window.saveNewGoal = function () {
  const title = $("newGoalTitle")?.value.trim();
  if (!title) {
    toast("Enter a goal title.");
    $("newGoalTitle")?.focus();
    return;
  }
  const milestones = Array.from(
    document.querySelectorAll("#milestoneBuilder .milestone-builder-row input"),
  )
    .map((inp) => inp.value.trim())
    .filter(Boolean)
    .map((name, idx) => ({ id: `${Date.now()}_${idx}`, name, done: false }));

  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const goal = {
    id: Date.now().toString(),
    title,
    due: $("newGoalDue")?.value || "",
    mode: NEW_GOAL_MODE,
    manual_pct: 0,
    pct_override: null,
    milestones,
    habit_ids: Array.from(NEW_GOAL_SELECTED_HABITS),
  };
  goals.push(goal);
  localStorage.setItem(GOAL_KEY(), JSON.stringify(goals));
  _syncGoalsToServer(goals);
  closeNewGoal();
  renderGoalsAndHabits();
  toast("Goal added ✓");
};

// ── Link Habit sheet (from an existing goal card) ────────────────────────
let LINK_TARGET_GOAL_IDX = null;
let LINK_SELECTED_HABITS = new Set();

function openLinkHabit(goalIdx) {
  LINK_TARGET_GOAL_IDX = goalIdx;
  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const g = goals[goalIdx];
  LINK_SELECTED_HABITS = new Set(((g && g.habit_ids) || []).map(String));
  renderLinkHabitPickList();
  openSheet("linkHabitSheet", "linkHabitOverlay");
}
function closeLinkHabit() {
  closeSheetEls("linkHabitSheet", "linkHabitOverlay");
  LINK_TARGET_GOAL_IDX = null;
}
function renderLinkHabitPickList() {
  const wrap = $("linkHabitPickList");
  if (!wrap) return;
  const habits = _habVisible(
    JSON.parse(localStorage.getItem(HAB_KEY()) || "[]"),
  );
  wrap.innerHTML =
    habits
      .map(({ h }) => {
        const sel = LINK_SELECTED_HABITS.has(String(h.id));
        return `
    <div class="habit-pick-row" data-onclick="toggleLinkHabitPick" data-onclick-args="${esc(JSON.stringify([h.id]))}">
      <div class="habit-pick-check ${sel ? "sel" : ""}">${sel ? '<i class="ti ti-check"></i>' : ""}</div>
      <div class="habit-pick-name">${esc(h.title)}</div>
      <div class="habit-pick-streak">${h.streak || 0}d streak</div>
    </div>`;
      })
      .join("") ||
    `<div style="font-size:11.5px;color:var(--gh-t3);padding:8px 0;">No habits yet.</div>`;
}
window.toggleLinkHabitPick = function (habitId) {
  const key = String(habitId);
  if (LINK_SELECTED_HABITS.has(key)) LINK_SELECTED_HABITS.delete(key);
  else LINK_SELECTED_HABITS.add(key);
  renderLinkHabitPickList();
};
window.createHabitForLink = async function () {
  await habitAdd();
  const allHabits = JSON.parse(localStorage.getItem(HAB_KEY()) || "[]");
  const last = allHabits[allHabits.length - 1];
  if (last) LINK_SELECTED_HABITS.add(String(last.id));
  renderLinkHabitPickList();
};
window.saveLinkHabit = function () {
  if (LINK_TARGET_GOAL_IDX === null) return;
  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const g = goals[LINK_TARGET_GOAL_IDX];
  if (!g) return;
  g.habit_ids = Array.from(LINK_SELECTED_HABITS);
  localStorage.setItem(GOAL_KEY(), JSON.stringify(goals));
  _syncGoalsToServer(goals);
  closeLinkHabit();
  renderGoalsAndHabits();
  toast("Habits linked ✓");
};

// Mode-switcher clicks inside the New Goal sheet — scoped to #newGoalModeRow
// only (not a page-wide listener) since this sheet is the only place a
// goal's mode is chosen; editing an existing goal's mode goes through
// goalEdit()'s siModal select field instead.
function _wireNewGoalModeRow() {
  const row = $("newGoalModeRow");
  if (!row) return;
  row.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      row
        .querySelectorAll(".mode-btn")
        .forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      NEW_GOAL_MODE = btn.dataset.mode;
      if ($("newGoalModeDesc"))
        $("newGoalModeDesc").textContent = GOAL_MODE_DESCS[NEW_GOAL_MODE];
    });
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _wireNewGoalModeRow);
} else {
  _wireNewGoalModeRow();
}

// ── Server sync — same per-entity diff-against-snapshot approach as
// habits above (and tasks.js). See the FLAGGED GAP note at the top of this
// section for what's unverified about the actual /api/goals/* contract. ──
const GOAL_SYNCED_KEY = () => `sivarr_goal_synced_${S.sid || "guest"}`;

function _goalGetSyncedSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(GOAL_SYNCED_KEY()) || "{}");
  } catch {
    return {};
  }
}
function _goalSetSyncedSnapshot(snap) {
  try {
    localStorage.setItem(GOAL_SYNCED_KEY(), JSON.stringify(snap));
  } catch (_) {}
}

function _goalSendMutation(url, body) {
  const token = getToken();
  if (!token || !S.sid) return Promise.resolve(null);
  body = { token, ...body };
  if (!navigator.onLine) {
    _queueMutation(url, body);
    return Promise.resolve(null);
  }
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => {
      _queueMutation(url, body);
      return null;
    });
}

function _syncGoalsToServer(goals) {
  const token = getToken();
  if (!token || !S.sid) return;

  const snap = _goalGetSyncedSnapshot();
  const nextSnap = {};

  (goals || []).forEach((g) => {
    const id = String(g.id);
    const serial = JSON.stringify(g);
    nextSnap[id] = serial;
    if (snap[id] === serial) return;

    if (!(id in snap)) {
      _goalSendMutation("/api/goals/add", { ...g });
      return;
    }
    let was;
    try {
      was = JSON.parse(snap[id]);
    } catch {
      was = {};
    }
    if (!was.deleted_at && g.deleted_at) {
      _goalSendMutation("/api/goals/delete", { id: g.id });
    } else if (was.deleted_at && !g.deleted_at) {
      _goalSendMutation("/api/goals/restore", { id: g.id });
      _goalSendMutation("/api/goals/edit", { id: g.id, ...g });
    } else {
      // /api/goals/edit is the one endpoint that persists this panel's full
      // field set (title/due/mode/manual_pct/pct_override/milestones/
      // habit_ids) and recomputes `progress`/`completed` server-side from
      // them. /api/goals/update is a separate, older endpoint (still used
      // by legacy OKR-style goals) that only knows progress/completed as
      // raw inputs -- this panel's goal objects never carry those, so
      // calling it here would just zero them back out. Edit only.
      _goalSendMutation("/api/goals/edit", { id: g.id, ...g });
    }
  });

  _goalSetSyncedSnapshot(nextSnap);
}

function _goalPruneExpiredTrash() {
  const goals = JSON.parse(localStorage.getItem(GOAL_KEY()) || "[]");
  const cutoff = Date.now() - 30 * 86400000;
  const kept = goals.filter((g) => {
    if (!g.deleted_at) return true;
    const ts = Date.parse(g.deleted_at);
    return Number.isNaN(ts) || ts >= cutoff;
  });
  if (kept.length !== goals.length) {
    localStorage.setItem(GOAL_KEY(), JSON.stringify(kept));
    _syncGoalsToServer(kept);
  }
}
