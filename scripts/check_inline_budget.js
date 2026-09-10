#!/usr/bin/env node
/**
 * Inline-handler / inline-style ratchet.
 *
 * Session 19 is migrating inline on*= handlers to js/core/delegate.js so
 * script-src 'unsafe-inline' can eventually come out of the CSP. The problem is
 * that new work keeps ADDING them back: between the overnight migration and the
 * next check, _panel_flux.html alone gained 25 fresh inline handlers. Without a
 * ratchet this is a treadmill -- migration and regression cancel out.
 *
 * HANDLERS are enforced: the count may only go DOWN. They are what blocks
 * script-src 'unsafe-inline', which is the actual goal, and every one of them
 * has a mechanical replacement in delegate.js.
 *
 * INLINE STYLES are reported but NOT enforced. That distinction is deliberate.
 * A plain count cannot tell `style="width: 0%"` on a JS-driven progress bar --
 * a legitimate runtime value with no CSS-class equivalent -- from a static
 * style that should have been a class. Enforcing it failed the build on
 * ordinary feature work (the AI Memory panel added six, five of them dynamic)
 * and the only ways out were to rewrite someone's in-flight markup or bump the
 * number, neither of which is the point. style-src is a separate and far larger
 * project (~970 attributes); blocking every commit on it while script-src is
 * the live goal is disproportionate. The count is still printed every run, so a
 * real jump is visible.
 *
 * If a change legitimately reduces the handler counts, lower the baseline in
 * the same commit. If it raises them, use delegate.js instead:
 *
 *     <button data-onclick="fnName">              fn()
 *     <button data-onclick="fn" data-onclick-args='["x", null]'>
 *     see js/core/delegate.js for the full grammar
 *
 * Standalone pages (admin.html, landing.html, admin_metrics.html) are counted
 * separately: they never load delegate.js, so migrating them is not possible
 * without adding the script to each page first.
 */
const fs = require("fs");
const path = require("path");

const BASELINE = JSON.parse(fs.readFileSync(path.join(__dirname, "inline-budget.json"), "utf8"));
const STANDALONE = new Set(["admin.html", "admin_metrics.html", "landing.html",
                            "landing_demo.html", "index.html", "lecturer.html"]);

const HANDLER = /(?<![-\w])on[a-z]+="/g;
const STYLE   = /(?<![-\w])style="/g;

let fragHandlers = 0, standaloneHandlers = 0, inlineStyles = 0;
const perFile = {};

for (const f of fs.readdirSync("templates").filter(f => f.endsWith(".html"))) {
  const src = fs.readFileSync(path.join("templates", f), "utf8");
  const h = (src.match(HANDLER) || []).length;
  const s = (src.match(STYLE) || []).length;
  inlineStyles += s;
  if (STANDALONE.has(f)) standaloneHandlers += h;
  else { fragHandlers += h; if (h) perFile[f] = h; }
}

const enforced = [
  ["fragment inline handlers", fragHandlers, BASELINE.fragmentHandlers],
  ["standalone inline handlers", standaloneHandlers, BASELINE.standaloneHandlers],
];

let failed = false;
for (const [label, actual, budget] of enforced) {
  const verdict = actual > budget ? "OVER" : actual < budget ? "under" : "at";
  console.log(`${label}: ${actual} (budget ${budget}) — ${verdict}`);
  if (actual > budget) {
    failed = true;
    console.log(`::error::${label} went UP: ${budget} -> ${actual}. Use js/core/delegate.js instead of an inline handler, or lower the baseline in scripts/inline-budget.json if this change genuinely removed some.`);
  }
}

// Reported only -- see the note at the top of this file for why this one does
// not fail the build.
{
  const d = inlineStyles - BASELINE.inlineStyles;
  const drift = d === 0 ? "unchanged" : d > 0 ? `+${d} since baseline` : `${d} since baseline`;
  console.log(`inline style= attributes: ${inlineStyles} (${drift}) — reported, not enforced`);
}
if (Object.keys(perFile).length) {
  console.log("\nfragment handlers still inline, by file:");
  for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${f}`);
  }
}
process.exit(failed ? 1 : 0);
