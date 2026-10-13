/* Shared, DOM-free logic for the research tracker.
   Loaded by the web app (window.TrackerCore), by the email digests (scripts/notify.js) and by the
   tests (require("../core.js")), so the site, the emails and firestore.rules agree on what every
   state means and which moves are allowed.

   The model, in one paragraph: every deliverable (a leaf of the outline) has ONE record. It has a
   work stage (Derive … Interpret), a review state (not sent / with the guide / flagged for
   discussion / changes requested / approved) and, separately, a scientific verification level
   (Unchecked … Publication-ready). Only legal moves exist: the student sends finished work for
   review, only the guide approves or asks for changes, an approved item is locked until the guide
   reopens it, and nothing counts as done until it is approved. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TrackerCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86400000;
  const LOCALE = "en-GB";

  /* ---------------------------------------------------------------- vocabulary */
  // The pipeline as people see it: five work stages, then the two review steps.
  const STAGES = ["Derive", "Implement", "Test", "Produce artifact", "Interpret", "Guide review", "Approved"];
  const S = { DERIVE: 0, IMPLEMENT: 1, TEST: 2, PRODUCE: 3, INTERPRET: 4, REVIEW: 5, APPROVED: 6 };
  const LAST_WORK = S.INTERPRET;
  const STAGE_HELP = ["Work out the analytic result", "Write the code or the calculation", "Check against known limits and tests",
    "Make the plot, table or note", "Write down what it means", "With your guide for sign-off", "Signed off by your guide"];
  const REVIEW = ["none", "submitted", "discussion", "changes", "approved"];
  const REVIEW_LABEL = { none: "Not sent", submitted: "Waiting for review", discussion: "Flagged for discussion", changes: "Changes requested", approved: "Approved" };
  const VERIFY = [
    { key: "unchecked", short: "Unchecked", label: "Unchecked", help: "No check recorded yet." },
    { key: "regulated", short: "Regulated", label: "Regulated", help: "Divergences regulated or renormalised: the result is finite and the scheme is stated." },
    { key: "converged", short: "Converged", label: "Converged", help: "Stable under changes of resolution, cutoff, step size and initial time." },
    { key: "independent", short: "Indep. checked", label: "Independently checked", help: "Reproduced by someone else, or by an independent method (e.g. analytic against numerical)." },
    { key: "publication", short: "Pub-ready", label: "Publication-ready", help: "Signed off for the paper or the thesis." }
  ];
  const VIDX = {}; VERIFY.forEach((v, i) => { VIDX[v.key] = i; });
  const STUDENT_VERIFY_MAX = VIDX.converged;      // the top two levels are the guide's call
  const ROLES = ["student", "guide"];
  const PHASES = [
    { key: "none", label: "Not started" },
    { key: "work", label: "Deriving / building" },
    { key: "results", label: "Results in hand" },
    { key: "changes", label: "Changes requested" },
    { key: "review", label: "With guide" },
    { key: "approved", label: "Approved" }
  ];
  const WORKSTREAMS = [["theory", "Theory"], ["numerics", "Numerics"], ["other", "Other"]];
  // Firestore layout under trackers/{project}: list collections, and keyed collections read as maps.
  const LIST_COLLECTIONS = ["comments", "meetings", "decisions", "questions", "logs", "tasks", "claims", "events", "deliverables"];
  const MAP_COLLECTIONS = ["items", "prefs"];
  const COLLECTIONS = LIST_COLLECTIONS.concat(MAP_COLLECTIONS);
  // Fields the project document carried before records were split out (read-only, migrated on the fly).
  const LEGACY_FIELDS = ["ticks", "dues", "links", "stages", "review", "blocked", "critical", "notify"];
  const DEFAULT_PREFS = { reviews: true, deliverables: true, decisions: true, blockers: true, meetings: true, comments: "daily",
    daily: true, reminders: true, deadlines: true, weekly: true };

  /* ---------------------------------------------------------------- text */
  const PRETTY = [[/\bbeta squared\b/g, "β²"], [/\bpsi squared\b/g, "ψ²"], [/\bh squared\b/g, "h²"],
    [/\blambda\b/g, "λ"], [/\bpsi\b/g, "ψ"], [/\bH1\b/g, "H₁"], [/\brho1\b/g, "ρ₁"]];
  function pretty(t) { let s = String(t == null ? "" : t); for (const [re, r] of PRETTY) s = s.replace(re, r); return s; }
  function slug(t) { return String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40); }
  function clip(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function emailKey(e) { return String(e || "").toLowerCase().replace(/[^a-z0-9]/g, "_"); }
  function shouldEmail(person) { return !!person && person.emails !== false; }
  function textToHtml(text) { return esc(text).replace(/\n/g, "<br>"); }
  const oneLine = s => String(s || "").replace(/\s*\n+\s*/g, " / ").trim();

  /* ---------------------------------------------------------------- dates (local time) */
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(ms, n) { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
  function dayDiff(ms, now) { return Math.round((startOfDay(ms) - startOfDay(now)) / DAY); }   // 0 today, 1 tomorrow, -1 yesterday
  function dateKey(ms) { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function parseDateKey(k) { const p = String(k).split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]).getTime(); }
  function isDateKey(k) {
    if (typeof k !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
    const p = k.split("-").map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
  }
  // Due dates are stored as calendar days ("2026-11-03") so they mean the same day for everyone;
  // older records stored a timestamp. Both read back as local midnight.
  function dueMs(v) { if (v == null || v === "") return null; if (typeof v === "number") return startOfDay(v); return isDateKey(v) ? parseDateKey(v) : null; }
  function weekBounds(now, offset) {
    const s = startOfDay(now), dow = (new Date(s).getDay() + 6) % 7;          // Monday = 0
    const start = addDays(s, -dow + 7 * (offset || 0));
    return { start, end: addDays(start, 7) };
  }
  function fmtDate(ms, year) { return new Date(ms).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: year ? "numeric" : undefined }); }
  function fmtDay(ms) { return new Date(ms).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" }); }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit", hour12: true }); }
  function fmtWhen(ms) { return fmtDay(ms) + ", " + fmtTime(ms); }
  function fmtRange(a, b) {
    const da = new Date(a), db = new Date(b);
    return da.getMonth() === db.getMonth() ? da.getDate() + "–" + fmtDate(b) : fmtDate(a) + " – " + fmtDate(b);
  }
  function dueLabel(ms, now) {
    const d = dayDiff(ms, now);
    if (d < 0) return "Overdue by " + plural(-d, "day");
    if (d === 0) return "Due today";
    if (d === 1) return "Due tomorrow";
    if (d < 7) return "Due " + new Date(ms).toLocaleDateString(LOCALE, { weekday: "long" });
    return "Due " + fmtDate(ms, new Date(ms).getFullYear() !== new Date(now).getFullYear());
  }
  function ago(ms, now) {
    const s = Math.max(0, (now - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    const d = -dayDiff(ms, now);
    if (d === 1) return "yesterday";
    if (d < 7) return d + " days ago";
    return fmtDate(ms, new Date(ms).getFullYear() !== new Date(now).getFullYear());
  }
  function fmtHours(h) { return (Math.round(h * 10) / 10) + " h"; }

  /* ---------------------------------------------------------------- outline + deliverables */
  function parseOutline(text) {
    const root = { id: "root", title: "", detail: "", children: [], depth: -1, parent: null, static: true };
    const stack = [root];
    for (const raw of String(text).split("\n")) {
      if (!raw.trim()) continue;
      const ind = Math.floor(raw.match(/^ */)[0].length / 2);
      const body = raw.trim().replace(/^- /, "");
      const cut = body.indexOf(" :: ");
      const title = (cut < 0 ? body : body.slice(0, cut)).trim();
      const detail = cut < 0 ? "" : body.slice(cut + 4).trim();
      while (stack.length > ind + 1) stack.pop();
      const parent = stack[stack.length - 1];
      const node = { title, detail, children: [], depth: stack.length - 1, parent, static: true };
      let id = (parent.id === "root" ? "" : parent.id + "~") + slug(title), n = 2;
      while (parent.children.some(c => c.id === id)) id = id.replace(/-\d+$/, "") + "-" + n++;
      node.id = id;
      parent.children.push(node); stack.push(node);
    }
    return root;
  }
  const DLV = "dlv~";
  function dlvId(docId) { return DLV + docId; }
  // The outline from projects.js, plus the deliverables your guide added in the app (stored in
  // Firestore). A deliverable can sit under any section, or under another deliverable.
  function buildTree(outline, deliverables) {
    const root = parseOutline(outline);
    const all = new Map();
    (function walk(n) { all.set(n.id, n); n.staticLeaf = n.id !== "root" && !n.children.length; n.children.forEach(walk); })(root);
    let pending = (deliverables || []).filter(d => d && !d.archived && d.title && d.parent)
      .slice().sort((a, b) => (a.order || 0) - (b.order || 0) || (a.at || 0) - (b.at || 0));
    for (let changed = true; pending.length && changed;) {
      changed = false;
      const next = [];
      for (const d of pending) {
        const parent = all.get(d.parent);
        if (!parent || parent.id === "root") { next.push(d); continue; }
        const node = { id: dlvId(d.id), title: d.title, detail: "", children: [], depth: parent.depth + 1, parent, static: false, staticLeaf: false, dlv: d.id };
        parent.children.push(node); all.set(node.id, node); changed = true;
      }
      pending = next;
    }
    return { root, orphans: pending };
  }
  function indexTree(root) {
    const nodes = new Map(), leaves = [];
    (function walk(n) { nodes.set(n.id, n); if (n.id !== "root" && !n.children.length) leaves.push(n); n.children.forEach(walk); })(root);
    return { root, nodes, leaves, pillars: root.children };
  }
  function buildIndex(project, deliverables) {
    const t = buildTree(project.outline, deliverables);
    const idx = indexTree(t.root);
    idx.orphans = t.orphans;
    idx.signature = [...idx.nodes.keys()].join("|") + "#" + [...idx.nodes.values()].map(n => n.title).join("|");
    return idx;
  }
  function leavesOf(n) { return n.children.length ? n.children.flatMap(leavesOf) : [n]; }
  function pillarOf(n) { let p = n; while (p.parent && p.parent.id !== "root") p = p.parent; return p; }
  function trail(n) { const parts = []; let p = n; while (p && p.id !== "root") { parts.unshift(pretty(p.title)); p = p.parent; } return parts; }
  function crumb(n) { return trail(n).join(" › "); }
  function parentCrumb(n) { return n && n.parent ? trail(n.parent).join(" › ") : ""; }
  // Theory and Numerics share titles ("Free Field"), so anything shown out of context names its pillar.
  function label(n) { if (!n) return "(an item no longer in the outline)"; const p = pillarOf(n); return p === n ? pretty(n.title) : pretty(n.title) + " (" + pretty(p.title) + ")"; }
  function labelId(idx, id) { return label(idx.nodes.get(id)); }

  /* ---------------------------------------------------------------- state */
  function emptyState() {
    const st = { legacy: {}, items: {}, prefs: {} };
    for (const c of LIST_COLLECTIONS) st[c] = [];
    return st;
  }
  function sameActor(x, who) {
    if (!x || !who) return false;
    if (who.uid && x.by && x.by === who.uid) return true;
    return !!(who.email && x.email && String(x.email).toLowerCase() === String(who.email).toLowerCase());
  }
  function roleOfEmail(project, email) {
    const p = (project.people || []).find(x => String(x.email).toLowerCase() === String(email || "").toLowerCase());
    return p ? p.role : null;
  }
  function prefsFor(st, email) {
    const k = emailKey(email);
    const legacy = st.legacy && st.legacy.notify && st.legacy.notify[k];
    return Object.assign({}, DEFAULT_PREFS, legacy || {}, (st.prefs && st.prefs[k]) || {});
  }
  function logTime(l) { return l.date ? parseDateKey(l.date) : (l.at || 0); }
  function decisionDone(d) { return d.status === "decided" || d.status === "recorded"; }   // "recorded" = older entries
  function decisionText(d) { return d.decision || d.text || ""; }

  /* ---------------------------------------------------------------- the item record */
  function blankItem() {
    return { stage: null, review: "none", verify: "unchecked", due: null, link: null, blocked: null, critical: false,
      spec: null, note: null, verifyNote: null, stageAt: 0, reviewAt: 0, verifyAt: 0, specAt: 0, specBy: null, specName: "",
      updatedAt: 0, updatedBy: null, updatedName: "", updatedRole: null };
  }
  const ITEM_KEYS = Object.keys(blankItem());
  function normItem(x) {
    const it = blankItem();
    if (!x) return it;
    for (const k of ITEM_KEYS) if (x[k] !== undefined) it[k] = x[k];
    if (REVIEW.indexOf(it.review) < 0) it.review = "none";
    if (VIDX[it.verify] == null) it.verify = "unchecked";
    if (!(it.stage === null || (Number.isInteger(it.stage) && it.stage >= 0 && it.stage <= LAST_WORK))) it.stage = null;
    if (it.due != null && !isDateKey(it.due)) it.due = typeof it.due === "number" ? dateKey(it.due) : null;
    it.critical = !!it.critical;
    return it;
  }
  function hasSpec(it) { return !!(it && it.spec && String(it.spec.what || "").trim()); }

  // Records written before the item model existed lived as maps on the project document. They are
  // read through this mapping until the item is next changed. An old "approved" or a bare tick is
  // never carried over as approved: it comes back as waiting for review, so the guide confirms it.
  function legacyItem(L, id) {
    if (!L) return null;
    const pick = f => (L[f] && L[f][id]) || null;
    const st = pick("stages"), rv = pick("review"), tk = pick("ticks"), due = pick("dues"), link = pick("links"), bl = pick("blocked"), cr = pick("critical");
    if (!st && !rv && !tk && !due && !link && !bl && !cr) return null;
    const it = blankItem();
    const old = st && typeof st.idx === "number" ? st.idx : null;
    const who = x => ({ by: (x && x.by) || null, name: (x && x.name) || "", role: null, at: (x && x.at) || 0 });
    if (old !== null) { it.stage = Math.min(old, LAST_WORK); it.stageAt = st.at || 0; }
    const sentOrDone = old !== null && old >= S.REVIEW;
    if (sentOrDone || (rv && rv.status === "approved") || tk) {
      it.stage = LAST_WORK; it.review = "submitted"; it.reviewAt = (rv && rv.at) || (st && st.at) || (tk && tk.at) || 0;
      const was = (old === S.APPROVED || (rv && rv.status === "approved")) ? "approved" : tk && old !== S.REVIEW ? "ticked as complete" : null;
      if (was) it.note = Object.assign(who(rv || st || tk), { kind: "legacy", text: "Was " + was + " in the earlier version of the tracker. Approve it again to confirm." });
    }
    if (rv && rv.status === "changes_requested") { it.review = "changes"; it.reviewAt = rv.at || 0; it.note = Object.assign(who(rv), { kind: "changes", text: rv.note || "" }); }
    else if (rv && rv.status === "needs_discussion") {
      if (it.review === "submitted") { it.review = "discussion"; it.reviewAt = rv.at || 0; it.note = Object.assign(who(rv), { kind: "discussion", text: rv.note || "" }); }
      else it.note = Object.assign(who(rv), { kind: "legacy", text: "Flagged for discussion in the earlier version" + (rv.note ? ": " + rv.note : ".") });
    }
    if (due) it.due = typeof due === "number" ? dateKey(due) : isDateKey(due) ? due : null;
    if (link) it.link = String(link);
    if (bl && bl.reason) it.blocked = { reason: bl.reason, by: bl.by || null, name: bl.name || "", role: null, at: bl.at || 0 };
    if (cr) it.critical = true;
    it.legacy = true;
    return it;
  }
  // The effective record for every node, computed once per render.
  function resolveItems(idx, st) {
    const m = new Map();
    for (const n of idx.nodes.values()) {
      if (n.id === "root") continue;
      const doc = st.items[n.id];
      m.set(n.id, doc ? normItem(doc) : (legacyItem(st.legacy, n.id) || blankItem()));
    }
    st.eff = m;
    return m;
  }
  function itemOf(st, id) {
    if (st.eff && st.eff.has(id)) return st.eff.get(id);
    const doc = st.items && st.items[id];
    return doc ? normItem(doc) : (legacyItem(st.legacy, id) || blankItem());
  }
  // Position on the seven-step pipeline: null = not started, 0..4 work, 5 with the guide, 6 approved.
  function posOf(it) {
    if (it.review === "approved") return S.APPROVED;
    if (it.review === "submitted" || it.review === "discussion") return S.REVIEW;
    return it.stage;
  }
  const stageIdx = (st, id) => posOf(itemOf(st, id));
  const isApproved = (st, id) => itemOf(st, id).review === "approved";
  const isDone = isApproved;            // nothing is done until the guide approves it
  function flagOf(st, id) {
    const it = itemOf(st, id);
    if (it.review !== "changes" && it.review !== "discussion") return null;
    const n = it.note || {};
    return { status: it.review === "changes" ? "changes_requested" : "needs_discussion", note: n.text || "", kind: n.kind || it.review,
      by: n.by || null, name: n.name || "", role: n.role || null, at: it.reviewAt || n.at || 0 };
  }
  function phaseOf(st, id) {
    const it = itemOf(st, id), p = posOf(it);
    if (p === S.APPROVED) return "approved";
    if (p === S.REVIEW) return "review";
    if (it.review === "changes") return "changes";
    if (p === null) return "none";
    return p >= S.PRODUCE ? "results" : "work";
  }
  function stageText(st, id) {
    const it = itemOf(st, id), p = posOf(it);
    if (it.review === "discussion") return "With guide · discussion";
    if (it.review === "changes") return "Changes requested" + (it.stage !== null ? " · " + STAGES[it.stage] : "");
    return p === null ? "Not started" : STAGES[p];
  }
  const verifyIdx = (st, id) => VIDX[itemOf(st, id).verify];
  // A leaf counts by how far along the pipeline it is; a section is the average of its items.
  function leafValue(st, id) { const p = stageIdx(st, id); return p === null ? 0 : (p + 1) / STAGES.length; }
  function progress(n, st, memo) {
    memo = memo || new Map();
    if (memo.has(n.id)) return memo.get(n.id);
    const p = n.children.length ? n.children.reduce((s, c) => s + progress(c, st, memo), 0) / n.children.length : leafValue(st, n.id);
    memo.set(n.id, p); return p;
  }

  /* ---------------------------------------------------------------- moves (the state machine)
     check() returns why a move isn't allowed (or null); transition() applies it. firestore.rules
     enforce the role and lock parts of the same rules on the server. */
  const ACTIONS = ["stage", "submit", "withdraw", "approve", "changes", "discuss", "verify", "invalidate",
    "block", "unblock", "due", "link", "critical", "spec"];
  function check(it, action, args, role) {
    args = args || {};
    const r = it.review, guide = role === "guide", student = role === "student";
    const working = r === "none" || r === "changes";
    if (!guide && !student) return "This account has no role in this project.";
    switch (action) {
      case "stage":
        if (!student) return "The student moves work through its stages.";
        if (!working) return r === "approved" ? "It's approved, so it's locked. Your guide can reopen it." : "It's with your guide. Withdraw it from review to keep working on it.";
        if (!(args.to === null || (Number.isInteger(args.to) && args.to >= 0 && args.to <= LAST_WORK))) return "Unknown stage.";
        return null;
      case "submit":
        if (!student) return "The student sends work for review; the guide approves it.";
        if (r === "approved") return "It's already approved.";
        if (!working) return "It's already with your guide.";
        if (it.stage !== LAST_WORK) return "Finish the Interpret stage first: write down what the result means, then send it.";
        if (it.blocked) return "It's marked blocked. Unblock it before sending it for review.";
        return null;
      case "withdraw":
        if (!student) return "Only the student can withdraw work from review.";
        if (r !== "submitted" && r !== "discussion") return "It isn't waiting for review.";
        return null;
      case "approve":
        if (!guide) return "Only your guide can approve.";
        if (r === "approved") return "It's already approved.";
        if (r !== "submitted" && r !== "discussion") return "It hasn't been sent for review yet.";
        return null;
      case "changes":
        if (!guide) return "Only your guide can request changes.";
        if (r !== "submitted" && r !== "discussion" && r !== "approved") return "Changes can be requested on work that was sent for review or approved.";
        if (!String(args.note || "").trim()) return "Say what needs to change.";
        return null;
      case "discuss":
        if (!guide) return "Only your guide flags submitted work for discussion.";
        if (r !== "submitted") return "Only work waiting for review can be flagged for discussion.";
        return null;
      case "verify": {
        const to = VIDX[args.to], from = VIDX[it.verify];
        if (to == null) return "Unknown verification level.";
        if (to === from) return "It's already at that level.";
        if (student && to > STUDENT_VERIFY_MAX) return "Independent checks and publication sign-off are recorded by your guide.";
        if (to > 0 && it.stage === null && posOf(it) === null) return "Start the work before recording checks on it.";
        if (args.to === "publication" && r !== "approved") return "Only approved results can be publication-ready.";
        if (to < from && !String(args.note || "").trim()) return "Say why the earlier check no longer holds.";
        return null;
      }
      case "invalidate":
        if (!String(args.note || "").trim()) return "Say what is wrong with the result.";
        if (posOf(it) === null) return "There's no result yet to invalidate.";
        if (it.review === "changes" && it.verify === "unchecked") return "It's already back for changes, with no checks recorded.";
        return null;
      case "block":
        if (r === "approved") return "Approved work can't be blocked. Reopen it first.";
        if (!String(args.reason || "").trim()) return "Say what's in the way.";
        return null;
      case "unblock": return it.blocked ? null : "It isn't blocked.";
      case "due":
        if (args.due != null && !isDateKey(args.due)) return "That isn't a valid date.";
        return null;
      case "link": case "critical": return null;
      case "spec":
        if (!guide) return "Your guide writes the deliverable.";
        return null;
      default: return "Unknown action.";
    }
  }
  function TransitionError(message) { const e = new Error(message); e.name = "TransitionError"; e.userMessage = message; return e; }
  // Returns { item, event } or null when nothing would change. Throws TransitionError when not allowed.
  function transition(it, action, args, actor, node) {
    args = args || {};
    const why = check(it, action, args, actor.role);
    if (why) throw TransitionError(why);
    const n = Object.assign({}, it), now = actor.now || Date.now();
    const by = { by: actor.by || null, name: actor.name || "", role: actor.role, at: now };
    const ev = { type: action, data: {} };
    const note = String(args.note || "").trim();
    delete n.legacy;
    switch (action) {
      case "stage":
        if (args.to === it.stage) return null;
        ev.data = { from: it.stage, to: args.to };
        n.stage = args.to; n.stageAt = now;
        break;
      case "submit":
        ev.type = it.review === "changes" ? "resubmit" : "submit";
        ev.data = { note };
        n.review = "submitted"; n.reviewAt = now;
        n.note = Object.assign({ kind: ev.type, text: note }, by);
        break;
      case "withdraw":
        ev.data = { note };
        n.review = "none"; n.reviewAt = now;
        n.note = Object.assign({ kind: "withdrawn", text: note }, by);
        break;
      case "approve":
        ev.data = { from: it.review, note };
        n.review = "approved"; n.reviewAt = now;
        n.note = Object.assign({ kind: "approved", text: note }, by);
        if (it.blocked) n.blocked = null;
        break;
      case "changes":
        ev.data = { from: it.review, note };
        n.review = "changes"; n.reviewAt = now;
        n.note = Object.assign({ kind: "changes", text: note }, by);
        // An independent check or a publication sign-off was of the version that's now changing.
        if (VIDX[it.verify] > STUDENT_VERIFY_MAX) { ev.data.verifyFrom = it.verify; ev.data.verifyTo = "converged"; n.verify = "converged"; n.verifyAt = now;
          n.verifyNote = Object.assign({ kind: "reset", text: "Reset when changes were requested." }, by); }
        break;
      case "discuss":
        ev.data = { note };
        n.review = "discussion"; n.reviewAt = now;
        n.note = Object.assign({ kind: "discussion", text: note }, by);
        break;
      case "verify":
        ev.data = { from: it.verify, to: args.to, note };
        n.verify = args.to; n.verifyAt = now;
        n.verifyNote = Object.assign({ kind: VIDX[args.to] < VIDX[it.verify] ? "down" : "up", text: note }, by);
        break;
      case "invalidate":
        ev.data = { verifyFrom: it.verify, reviewFrom: it.review, note };
        n.verify = "unchecked"; n.verifyAt = now;
        n.verifyNote = Object.assign({ kind: "invalidated", text: note }, by);
        if (it.review === "submitted" || it.review === "discussion" || it.review === "approved") {
          n.review = "changes"; n.reviewAt = now; n.note = Object.assign({ kind: "invalidated", text: note }, by);
        }
        break;
      case "block":
        ev.type = "blocked";
        ev.data = { reason: String(args.reason).trim() };
        n.blocked = Object.assign({ reason: ev.data.reason }, by);
        break;
      case "unblock":
        ev.type = "unblocked";
        ev.data = { reason: it.blocked ? it.blocked.reason : "" };
        n.blocked = null;
        break;
      case "due":
        if ((args.due || null) === (it.due || null)) return null;
        ev.data = { due: args.due || null, from: it.due || null };
        n.due = args.due || null;
        break;
      case "link": {
        const url = args.url || null;
        if (url === (it.link || null)) return null;
        ev.data = { url };
        n.link = url;
        break;
      }
      case "critical":
        if (!!args.on === !!it.critical) return null;
        ev.data = { on: !!args.on };
        n.critical = !!args.on;
        break;
      case "spec": {
        const spec = { what: String(args.what || "").trim(), acceptance: String(args.acceptance || "").trim(), artifacts: String(args.artifacts || "").trim() };
        const old = it.spec || { what: "", acceptance: "", artifacts: "" };
        if (spec.what === (old.what || "") && spec.acceptance === (old.acceptance || "") && spec.artifacts === (old.artifacts || "")) return null;
        ev.data = { first: !hasSpec(it), cleared: !spec.what && !spec.acceptance && !spec.artifacts };
        n.spec = ev.data.cleared ? null : spec;
        n.specAt = now; n.specBy = actor.by || null; n.specName = actor.name || "";
        break;
      }
    }
    n.updatedAt = now; n.updatedBy = actor.by || null; n.updatedName = actor.name || ""; n.updatedRole = actor.role;
    return { item: n, event: Object.assign({ node: node || null, at: now }, ev) };
  }
  // What this person can do with this item right now (for showing the right buttons only).
  function actionsFor(it, role) {
    const out = {};
    for (const a of ACTIONS) out[a] = !check(it, a, a === "stage" ? { to: 0 } : a === "verify" ? { to: "regulated", note: "x" } : { note: "x", reason: "x" }, role);
    out.verifyTo = VERIFY.filter(v => !check(it, "verify", { to: v.key, note: "x" }, role)).map(v => v.key);
    return out;
  }
  // The record as written to Firestore (every key present, nothing extra), so the rules can check it.
  function toDoc(it) { const d = {}; for (const k of ITEM_KEYS) d[k] = it[k] === undefined ? blankItem()[k] : it[k]; return d; }

  /* ---------------------------------------------------------------- events */
  const MATERIAL = new Set(["stage", "changes", "invalidate", "link", "withdraw"]);
  function isMaterial(e) {
    if (MATERIAL.has(e.type)) return true;
    return e.type === "verify" && e.data && VIDX[e.data.to] < VIDX[e.data.from];
  }
  function eventCategory(e) {
    const d = e.data || {};
    if (["submit", "resubmit", "withdraw", "approve", "changes", "discuss", "invalidate"].indexOf(e.type) >= 0) return "reviews";
    if (e.type === "verify" && (VIDX[d.to] > STUDENT_VERIFY_MAX || VIDX[d.to] < VIDX[d.from])) return "reviews";
    if (e.type === "spec" || e.type === "deliverable_add") return "deliverables";
    if (e.type === "blocked") return "blockers";
    if (e.type && e.type.indexOf("meeting_") === 0) return "meetings";
    if (e.type === "decision_request" || e.type === "decision_record") return "decisions";
    return "minor";
  }
  const VL = k => (VIDX[k] != null ? VERIFY[VIDX[k]].label : k);
  function describeEvent(e, idx, nameOf) {
    const who = nameOf ? nameOf(e) : (e.name || "Someone"), d = e.data || {}, item = e.node ? labelId(idx, e.node) : "";
    const q = (t, n) => (t ? ": “" + clip(t, n || 140) + "”" : "");
    switch (e.type) {
      case "stage":
        if (d.to === null || d.to === undefined) return who + " reset " + item + " to not started";
        return who + " moved " + item + " to " + STAGES[d.to];
      case "submit": return who + " sent " + item + " for review" + q(d.note);
      case "resubmit": return who + " made the requested changes and resent " + item + " for review" + q(d.note);
      case "withdraw": return who + " withdrew " + item + " from review" + q(d.note);
      case "approve": return who + " approved " + item + q(d.note);
      case "changes": return who + (d.from === "approved" ? " reopened " + item + " and requested changes" : " requested changes on " + item) + q(d.note)
        + (d.verifyFrom ? " (verification reset from " + VL(d.verifyFrom) + " to " + VL(d.verifyTo) + ")" : "");
      case "discuss": return who + " flagged " + item + " for discussion" + q(d.note);
      case "verify": return VIDX[d.to] < VIDX[d.from] ? who + " downgraded " + item + " from " + VL(d.from) + " to " + VL(d.to) + q(d.note)
        : who + " recorded " + item + " as " + VL(d.to) + q(d.note);
      case "invalidate": return who + " marked the result of " + item + " invalid" + q(d.note);
      case "blocked": return who + " marked " + item + " blocked" + q(d.reason);
      case "unblocked": case "unblock": return who + " unblocked " + item;
      case "critical": return who + (d.on ? " marked " + item + " as critical" : " unmarked " + item + " as critical");
      case "due": return d.due ? who + " set " + item + " due " + fmtDate(dueMs(d.due)) : who + " cleared the due date on " + item;
      case "link": return d.url ? who + " linked a notebook/file to " + item : who + " removed the link from " + item;
      case "spec": return d.cleared ? who + " cleared the deliverable for " + item : who + (d.first ? " wrote the deliverable for " : " updated the deliverable for ") + item;
      case "deliverable_add": return who + " added a deliverable: " + (item || "“" + clip(d.title, 100) + "”") + (d.parent ? " under " + labelId(idx, d.parent) : "");
      case "deliverable_rename": return who + " renamed a deliverable from “" + clip(d.from, 80) + "” to “" + clip(d.to, 80) + "”";
      case "deliverable_archive": return who + " archived the deliverable “" + clip(d.title, 100) + "”";
      case "deliverable_restore": return who + " restored the deliverable “" + clip(d.title, 100) + "”";
      case "task_add": return who + " added a task" + (item ? " on " + item : "") + ": “" + clip(d.text, 120) + "”";
      case "task_done": return who + " finished a task: “" + clip(d.text, 120) + "”";
      case "decision_request": return who + " asked for a decision: “" + clip(d.text, 140) + "”";
      case "decision_record": return who + " recorded a decision: “" + clip(d.text, 140) + "”";
      case "claim_verify": return who + " re-verified a manuscript claim: “" + clip(d.text, 120) + "”";
      case "meeting_propose": return who + " proposed a meeting for " + fmtWhen(d.at);
      case "meeting_confirm": return who + " confirmed the meeting on " + fmtWhen(d.at);
      case "meeting_decline": return who + " declined the meeting on " + fmtWhen(d.at);
      case "meeting_cancel": return who + " cancelled the meeting on " + fmtWhen(d.at);
      default: return "";
    }
  }

  /* ---------------------------------------------------------------- activity helpers */
  function touchMap(st) {
    const any = new Map(), material = new Map();
    const bump = (m, id, t) => { if (id && t && (!m.has(id) || m.get(id) < t)) m.set(id, t); };
    for (const e of st.events) { bump(any, e.node, e.at); if (isMaterial(e)) bump(material, e.node, e.at); }
    for (const c of st.comments) bump(any, c.node, c.at);
    if (st.eff) for (const [id, it] of st.eff) { bump(any, id, it.updatedAt); bump(material, id, it.stageAt); }
    return { any, material };
  }
  function unansweredComments(idx, st, me) {
    const by = new Map();
    for (const c of st.comments) { if (!by.has(c.node)) by.set(c.node, []); by.get(c.node).push(c); }
    const out = [];
    for (const [node, list] of by) {
      if (!idx.nodes.has(node)) continue;
      list.sort((a, b) => a.at - b.at);
      const last = list[list.length - 1];
      if (!last || last.taskId || sameActor(last, me)) continue;
      out.push({ node: idx.nodes.get(node), comment: last });
    }
    return out.sort((a, b) => a.comment.at - b.comment.at);
  }

  /* ---------------------------------------------------------------- theory vs numerics */
  // Pairs items that sit at the same place in both pillars ("Perturbation › Free Field"). A pair is
  // the outline's own items, so deliverables your guide adds underneath count towards their parent.
  function syncPairs(idx, st) {
    if (idx.pillars.length !== 2) return null;
    const [A, B] = idx.pillars, sfx = id => id.slice(id.indexOf("~") + 1);
    const units = p => { const out = []; (function walk(n) { if (n.staticLeaf) out.push(n); else n.children.forEach(walk); })(p); return out; };
    const inB = new Map(); for (const n of units(B)) inB.set(sfx(n.id), n);
    const pairs = [], step = 3 / STAGES.length - 1e-9, memo = new Map();
    for (const a of units(A)) {
      const b = inB.get(sfx(a.id)); if (!b) continue;
      const va = progress(a, st, memo), vb = progress(b, st, memo);
      let status = "in-step";
      if (vb > 0 && va === 0) status = "b-without-a";       // numerics started on something not yet derived
      else if (va - vb >= step) status = "a-ahead";
      else if (vb - va >= step) status = "b-ahead";
      pairs.push({ a, b, va, vb, status, name: trail(a).slice(1).join(" › ") });
    }
    const out = pairs.filter(p => p.status !== "in-step").length;
    return { A, B, pairs, inStep: pairs.length - out, outOfStep: out };
  }

  /* ---------------------------------------------------------------- manuscript claims */
  function claimStatus(idx, st, c, touches) {
    const base = c.verifiedAt || c.at || 0, evidence = [];
    let stale = false, unsupported = false;
    const ids = Array.isArray(c.nodes) ? c.nodes : [];
    if (!ids.length) unsupported = true;
    for (const id of ids) {
      const n = idx.nodes.get(id), reasons = [];
      if (!n) { reasons.push("no longer in the outline"); stale = true; evidence.push({ id, node: null, reasons, soft: [] }); continue; }
      const it = itemOf(st, id), soft = [];
      if (it.review === "changes") { reasons.push(it.note && it.note.kind === "invalidated" ? "result marked invalid" : "changes requested"); stale = true; }
      const changed = touches.material.get(id) || 0;
      if (changed > base) { reasons.push("changed " + fmtDate(changed) + ", after the claim was last checked"); stale = true; }
      if (it.review !== "approved") { soft.push("not approved yet"); unsupported = true; }
      if (VIDX[it.verify] < VIDX.independent) { soft.push(VIDX[it.verify] ? VERIFY[VIDX[it.verify]].label.toLowerCase() + " only" : "unchecked"); unsupported = true; }
      evidence.push({ id, node: n, reasons, soft });
    }
    return { status: stale ? "stale" : unsupported ? "unsupported" : "current", evidence };
  }

  /* ---------------------------------------------------------------- what to do next */
  function topActions(idx, st, A, ctx) {
    const now = ctx.now, me = ctx.me || {}, cand = new Map();
    const add = (key, score, reason, extra) => {
      const c = cand.get(key);
      if (c) { if (c.reasons.indexOf(reason) < 0) c.reasons.push(reason); c.score = Math.max(c.score, score) + 3; }
      else cand.set(key, Object.assign({ key, score, reasons: [reason] }, extra));
    };
    const crit = id => (itemOf(st, id).critical ? 12 : 0);
    if (ctx.role === "guide") {
      for (const r of A.awaitingReview) add(r.node.id, 100 + Math.min(r.days, 14) + crit(r.node.id),
        r.days ? "Waiting " + plural(r.days, "day") + " for your review" : "Ready for your review", { node: r.node, kind: "review" });
      for (const f of A.needsDiscussion) add(f.node.id, 84 + crit(f.node.id), "Flagged for discussion: approve or ask for changes", { node: f.node });
      for (const d of A.openDecisions) if (!sameActor(d, me)) add("dec:" + d.id, 90, "Decision requested", { kind: "decision", decision: d, title: d.text });
      for (const n of A.specMissing) {
        const started = itemOf(st, n.id).stage !== null;
        add(n.id, started ? 78 : 30, started ? "Work started, deliverable not written" : "Write the deliverable", { node: n, kind: "spec" });
      }
      for (const n of A.readyToCheck) add(n.id, 52 + crit(n.id), "Converged: ready for an independent check", { node: n, kind: "verify" });
      for (const u of A.unanswered) add(u.node.id, 70, "Unanswered comment", { node: u.node, kind: "comment" });
      const soon = A.nextMeeting && dayDiff(A.nextMeeting.at, now) <= 2;
      for (const q of A.openQuestions) if (!sameActor(q, me)) add("q:" + q.id, soon ? 62 : 36, soon ? "For the meeting " + fmtDay(A.nextMeeting.at) : "Open question", { kind: "question", question: q, title: q.text });
      for (const b of A.blocked) add(b.node.id, 50 + crit(b.node.id), "Blocked, may need your input", { node: b.node });
    } else {
      const today = startOfDay(now);
      const plan = st.logs.filter(l => sameActor(l, me) && l.tomorrow && logTime(l) < today && logTime(l) >= addDays(today, -3))
        .sort((a, b) => logTime(b) - logTime(a))[0];
      if (plan) add("log", 95, "Your plan from " + fmtDay(logTime(plan)), { kind: "log", title: plan.tomorrow });
      for (const l of idx.leaves) {
        const id = l.id, it = itemOf(st, id);
        if (it.blocked) continue;
        if (it.review === "changes") add(id, 100 + crit(id), it.note && it.note.kind === "invalidated" ? "Result invalidated, redo it" : "Changes requested", { node: l });
        if (it.review === "discussion") add(id, 72 + crit(id), "Your guide wants to discuss it", { node: l });
        if (it.review === "approved" || it.review === "submitted" || it.review === "discussion") continue;
        if (it.stage === LAST_WORK) add(id, 88 + crit(id), it.review === "changes" ? "Ready to resend for review" : "Ready to send for review", { node: l, kind: "submit" });
        const due = dueMs(it.due);
        if (due) {
          const d = dayDiff(due, now);
          if (d < 0) add(id, 90 + Math.min(-d, 10) + crit(id), dueLabel(due, now), { node: l });
          else if (d <= 3) add(id, 84 - d * 4 + crit(id), dueLabel(due, now), { node: l });
          else if (d <= 7) add(id, 58 + crit(id), dueLabel(due, now), { node: l });
        }
        if (it.critical) add(id, it.stage === null ? 45 : 55, it.stage === null ? "Critical, not started" : "Critical", { node: l });
        if (it.stage !== null && it.stage < LAST_WORK) add(id, 40 + (now - (A.touches.any.get(id) || 0) < 2 * DAY ? 6 : 0), "In progress: " + STAGES[it.stage], { node: l });
        if (it.stage !== null && it.stage >= S.PRODUCE && it.verify === "unchecked") add(id, 38, "Record your checks (regulated, converged)", { node: l, kind: "verify" });
      }
      for (const u of A.unanswered) add(u.node.id, 70, "Unanswered comment", { node: u.node });
      for (const t of A.openTasks) {
        let score = 46, reason = "Open task";
        const due = dueMs(t.due);
        if (due) {
          const d = dayDiff(due, now);
          if (d < 0) score = 86; else if (d <= 3) score = 78 - d * 3; else score = 50;
          reason = "Task, " + dueLabel(due, now).toLowerCase();
        }
        add("task:" + t.id, score, reason, { kind: "task", task: t, node: idx.nodes.get(t.node) || null, title: t.text });
      }
    }
    return [...cand.values()].sort((a, b) => b.score - a.score);
  }

  /* ---------------------------------------------------------------- one pass over everything */
  function analyze(idx, st, ctx) {
    resolveItems(idx, st);
    const now = ctx.now, me = ctx.me || {}, leaves = idx.leaves;
    const A = { now, touches: touchMap(st) };
    const roleOf = x => (x.role ? x.role : sameActor(x, me) ? ctx.role : ctx.role === "guide" ? "student" : "guide");
    const it = id => itemOf(st, id);

    A.awaitingReview = leaves.filter(l => it(l.id).review === "submitted")
      .map(l => ({ node: l, since: it(l.id).reviewAt || 0, days: Math.max(0, -dayDiff(it(l.id).reviewAt || now, now)) }))
      .sort((a, b) => a.since - b.since);
    A.flags = leaves.map(l => ({ node: l, flag: flagOf(st, l.id) })).filter(x => x.flag).sort((a, b) => a.flag.at - b.flag.at);
    A.changesRequested = A.flags.filter(x => x.flag.status === "changes_requested");
    A.needsDiscussion = A.flags.filter(x => x.flag.status === "needs_discussion");
    A.blocked = leaves.filter(l => it(l.id).blocked).map(l => ({ node: l, info: it(l.id).blocked })).sort((a, b) => (a.info.at || 0) - (b.info.at || 0));
    A.specMissing = leaves.filter(l => !hasSpec(it(l.id)) && it(l.id).review !== "approved");
    A.readyToSubmit = leaves.filter(l => { const x = it(l.id); return (x.review === "none" || x.review === "changes") && x.stage === LAST_WORK && !x.blocked; });
    A.readyToCheck = leaves.filter(l => { const x = it(l.id); return (x.review === "approved" || x.review === "submitted") && x.verify === "converged"; });
    A.openDecisions = st.decisions.filter(d => !decisionDone(d)).sort((a, b) => a.at - b.at);
    A.decided = st.decisions.filter(decisionDone).sort((a, b) => (b.decidedAt || b.at) - (a.decidedAt || a.at));
    A.openQuestions = st.questions.filter(q => !q.answered).sort((a, b) => a.at - b.at);
    A.openTasks = st.tasks.filter(t => !t.done).sort((a, b) => (dueMs(a.due) || Infinity) - (dueMs(b.due) || Infinity) || a.at - b.at);
    A.unanswered = unansweredComments(idx, st, me).map(u => Object.assign(u, { from: roleOf(u.comment) }));

    const upcoming = st.meetings.filter(m => m.at + (m.duration || 30) * 60000 >= now).sort((a, b) => a.at - b.at);
    A.nextMeeting = upcoming.find(m => m.status === "confirmed") || null;
    A.pendingMeetings = upcoming.filter(m => m.status === "proposed");
    A.lastMeeting = st.meetings.filter(m => m.status === "confirmed" && m.at < now).sort((a, b) => b.at - a.at)[0] || null;
    A.sinceRef = A.lastMeeting ? A.lastMeeting.at : addDays(now, -7);

    const dueOf = l => dueMs(it(l.id).due);
    A.overdue = leaves.filter(l => dueOf(l) && !isDone(st, l.id) && dayDiff(dueOf(l), now) < 0).sort((a, b) => dueOf(a) - dueOf(b));
    A.deadlines = leaves.filter(l => dueOf(l) && !isDone(st, l.id) && dayDiff(dueOf(l), now) <= 14).map(l => ({ node: l, due: dueOf(l) }))
      .concat(A.openTasks.filter(t => dueMs(t.due) && dayDiff(dueMs(t.due), now) <= 14).map(t => ({ task: t, node: idx.nodes.get(t.node) || null, due: dueMs(t.due) })))
      .sort((a, b) => a.due - b.due);
    // Results that exist (or are approved) but haven't been checked independently.
    A.unverified = leaves.filter(l => { const p = stageIdx(st, l.id); return p !== null && p >= S.PRODUCE && VIDX[it(l.id).verify] < VIDX.independent; });
    A.resultsSince = leaves.filter(l => { const x = it(l.id); return x.stage !== null && x.stage >= S.PRODUCE && (x.stageAt > A.sinceRef || (x.review === "approved" && x.reviewAt > A.sinceRef)); });
    const weekAgo = addDays(now, -7);
    A.recentlyRevised = leaves.filter(l => (A.touches.any.get(l.id) || 0) > weekAgo).sort((a, b) => A.touches.any.get(b.id) - A.touches.any.get(a.id));
    A.week = recentChanges(idx, st, weekAgo, now + 1);

    A.claims = st.claims.map(c => Object.assign({ claim: c }, claimStatus(idx, st, c, A.touches)))
      .sort((a, b) => (a.claim.section || "").localeCompare(b.claim.section || "", undefined, { numeric: true }) || a.claim.at - b.claim.at);
    A.staleClaims = A.claims.filter(c => c.status === "stale");
    A.sync = syncPairs(idx, st);
    A.pillars = idx.pillars.map(p => {
      const counts = {}, vcounts = {}; PHASES.forEach(ph => { counts[ph.key] = 0; }); VERIFY.forEach(v => { vcounts[v.key] = 0; });
      const ls = leavesOf(p);
      ls.forEach(l => { counts[phaseOf(st, l.id)]++; vcounts[it(l.id).verify]++; });
      return { node: p, total: ls.length, counts, vcounts };
    });

    A.withGuide = { reviews: A.awaitingReview, discuss: A.needsDiscussion, decisions: A.openDecisions.filter(d => roleOf(d) !== "guide"),
      questions: A.openQuestions, comments: A.unanswered.filter(u => u.from === "student"), specs: A.specMissing.filter(l => it(l.id).stage !== null) };
    A.withStudent = { changes: A.changesRequested, discuss: A.needsDiscussion, comments: A.unanswered.filter(u => u.from === "guide"),
      tasks: A.openTasks, decisions: A.openDecisions.filter(d => roleOf(d) === "guide"), ready: A.readyToSubmit };
    A.actions = topActions(idx, st, A, ctx);
    return A;
  }

  function recentChanges(idx, st, from, to) {
    const inW = t => t >= from && t < to;
    const ev = st.events.filter(e => inW(e.at));
    const approvals = ev.filter(e => e.type === "approve");
    const newResults = ev.filter(e => e.type === "stage" && e.data && e.data.to != null && e.data.to >= S.PRODUCE && (e.data.from == null || e.data.from < S.PRODUCE));
    const flagsRaised = ev.filter(e => e.type === "changes" || e.type === "discuss" || e.type === "invalidate");
    const submissions = ev.filter(e => e.type === "submit" || e.type === "resubmit");
    const moves = ev.filter(e => e.type === "stage");
    const checks = ev.filter(e => e.type === "verify");
    const comments = st.comments.filter(c => inW(c.at));
    const logs = st.logs.filter(l => inW(logTime(l)));
    const decisions = st.decisions.filter(d => decisionDone(d) && inW(d.decidedAt || d.at));
    return { from, to, events: ev, approvals, newResults, flagsRaised, submissions, moves, checks, comments, logs, decisions,
      total: ev.length + comments.length + logs.length };
  }

  /* ---------------------------------------------------------------- weekly report (every record type) */
  function weeklyReport(idx, st, w, now) {
    if (!st.eff) resolveItems(idx, st);
    const inW = t => t >= w.start && t < w.end;
    const ev = st.events.filter(e => inW(e.at)).sort((a, b) => a.at - b.at);
    const node = id => idx.nodes.get(id) || null;
    const it = id => itemOf(st, id);
    const uniqNodes = types => { const seen = new Set(), out = []; for (const e of ev) if (types.indexOf(e.type) >= 0 && node(e.node) && !seen.has(e.node)) { seen.add(e.node); out.push(e); } return out; };

    const completed = uniqNodes(["approve"]).filter(e => it(e.node).review === "approved").map(e => ({ node: node(e.node), verify: it(e.node).verify, by: e.name || "" }));
    const submitted = uniqNodes(["submit", "resubmit"]).map(e => ({ node: node(e.node), again: e.type === "resubmit", now: it(e.node).review }));
    const active = idx.leaves.filter(l => { const p = stageIdx(st, l.id); return p !== null && p !== S.APPROVED; })
      .map(l => { const x = it(l.id); return { node: l, text: stageText(st, l.id), blocked: x.blocked, critical: x.critical, verify: x.verify }; })
      .sort((a, b) => (stageIdx(st, b.node.id) || 0) - (stageIdx(st, a.node.id) || 0));
    const newResults = uniqNodes(["stage"]).filter(e => ev.some(x => x.node === e.node && x.type === "stage" && x.data && x.data.to != null && x.data.to >= S.PRODUCE && (x.data.from == null || x.data.from < S.PRODUCE)))
      .map(e => ({ node: node(e.node), stage: it(e.node).stage }));
    const checksUp = ev.filter(e => e.type === "verify" && node(e.node) && VIDX[e.data.to] > VIDX[e.data.from]).map(e => ({ node: node(e.node), to: e.data.to, by: e.name || "" }));

    const failed = [];
    for (const e of ev) {
      const d = e.data || {}, n = node(e.node);
      if (e.type === "changes") failed.push({ kind: d.from === "approved" ? "Reopened after approval" : "Changes requested", node: n, text: d.note || "" });
      else if (e.type === "invalidate") failed.push({ kind: "Result invalidated", node: n, text: d.note || "" });
      else if (e.type === "verify" && VIDX[d.to] < VIDX[d.from]) failed.push({ kind: "Check downgraded to " + VL(d.to), node: n, text: d.note || "" });
    }
    for (const l of st.logs) if (inW(logTime(l)) && l.failed) failed.push({ kind: "Daily log, " + fmtDay(logTime(l)), node: null, text: l.failed });

    const time = { theory: 0, numerics: 0, other: 0 }, days = new Set();
    for (const l of st.logs) if (inW(logTime(l))) {
      const hrs = l.hours || {};
      for (const [k] of WORKSTREAMS) time[k] += Number(hrs[k]) || 0;
      days.add(dateKey(logTime(l)));
    }
    const decisions = st.decisions.filter(d => decisionDone(d) && inW(d.decidedAt || d.at));
    const decisionsOpen = st.decisions.filter(d => !decisionDone(d));
    const questions = st.questions.filter(q => !q.answered);
    const answered = st.questions.filter(q => q.answered && inW(q.answeredAt || 0));
    const meetingsHeld = st.meetings.filter(m => m.status === "confirmed" && inW(m.at) && m.at < now).sort((a, b) => a.at - b.at);
    const meetingsNext = st.meetings.filter(m => m.status !== "declined" && m.at >= Math.max(now, w.end - 7 * DAY) && m.at < addDays(w.end, 7)).sort((a, b) => a.at - b.at);
    const specs = ev.filter(e => (e.type === "spec" || e.type === "deliverable_add" || e.type === "deliverable_archive" || e.type === "deliverable_rename" || e.type === "deliverable_restore"));
    const specMissing = idx.leaves.filter(l => !hasSpec(it(l.id)) && it(l.id).review !== "approved");
    const tasksDone = st.tasks.filter(t => t.done && inW(t.doneAt || 0));
    const tasksOpen = st.tasks.filter(t => !t.done);
    const touches = touchMap(st);
    const claims = st.claims.map(c => Object.assign({ claim: c }, claimStatus(idx, st, c, touches)));
    const claimsChecked = ev.filter(e => e.type === "claim_verify");
    const blockers = idx.leaves.filter(l => it(l.id).blocked).map(l => ({ node: l, info: it(l.id).blocked }));
    const comments = st.comments.filter(c => inW(c.at));
    const commenters = {}; for (const c of comments) commenters[c.name || "Someone"] = (commenters[c.name || "Someone"] || 0) + 1;

    const next = { start: w.end, end: addDays(w.end, 7) }, plan = [], seen = new Set();
    const lastPlan = st.logs.filter(l => l.tomorrow && logTime(l) < w.end).sort((a, b) => logTime(b) - logTime(a))[0];
    for (const l of idx.leaves) {
      const id = l.id, x = it(id); if (x.review === "approved") continue;
      const due = dueMs(x.due);
      let why = "";
      if (x.review === "changes") why = x.note && x.note.kind === "invalidated" ? "redo the invalidated result" : "address the requested changes";
      else if (x.review === "discussion") why = "discuss with your guide";
      else if (x.review === "none" && x.stage === LAST_WORK && !x.blocked) why = "send for review";
      else if (due && due < next.end) why = due < next.start ? "overdue since " + fmtDate(due) : "due " + fmtDay(due);
      else if (x.critical && x.review !== "submitted") why = "critical, " + (x.stage === null ? "not started" : STAGES[x.stage].toLowerCase());
      if (why && !seen.has(id)) { seen.add(id); plan.push({ node: l, why }); }
    }
    for (const t of tasksOpen) { const d = dueMs(t.due); if (!d || d < next.end) plan.push({ task: t, node: node(t.node), why: d ? "task due " + fmtDay(d) : "open task" }); }
    for (const m of meetingsNext) if (m.at >= next.start) plan.push({ meeting: m, why: (m.status === "confirmed" ? "meeting " : "proposed meeting ") + fmtWhen(m.at) });

    return { window: w, now, completed, submitted, active, newResults, checksUp, failed, time, loggedDays: days.size,
      decisions, decisionsOpen, questions, answered, meetingsHeld, meetingsNext, specs, specMissing, tasksDone, tasksOpen,
      claims, claimsChecked, blockers, comments, commenters, plan, lastPlan: lastPlan ? lastPlan.tomorrow : "", idx };
  }

  function reportSections(r) {
    const L = n => label(n), idx = r.idx;
    const sec = (title, lines, empty) => ({ title, lines, empty: empty || "Nothing this week." });
    const out = [];
    out.push(sec("Completed (approved)", r.completed.map(c => L(c.node) + " — verification: " + VL(c.verify))
      .concat(r.tasksDone.map(t => "Task: " + t.text + (idx && idx.nodes.get(t.node) ? " (" + L(idx.nodes.get(t.node)) + ")" : "")))));
    out.push(sec("Sent for review", r.submitted.map(s => L(s.node) + (s.again ? " (resubmitted)" : "") + " — now " + REVIEW_LABEL[s.now].toLowerCase())));
    out.push(sec("Active", r.active.map(a => L(a.node) + ": " + a.text + (a.verify !== "unchecked" ? ", " + VL(a.verify).toLowerCase() : "")
      + (a.blocked ? ", blocked" : "") + (a.critical ? ", critical" : "")), "Nothing in progress."));
    out.push(sec("New results", r.newResults.map(x => L(x.node) + (x.stage != null ? " (now " + STAGES[x.stage] + ")" : ""))));
    out.push(sec("Verification", r.checksUp.map(c => L(c.node) + " → " + VL(c.to) + (c.by ? " (" + c.by + ")" : "")), "No checks recorded this week."));
    out.push(sec("Failed or invalidated", r.failed.map(f => f.kind + (f.node ? ": " + L(f.node) : "") + (f.text ? " — " + clip(oneLine(f.text), 220) : ""))));
    const total = r.time.theory + r.time.numerics + r.time.other;
    out.push(sec("Time by workstream", total ? WORKSTREAMS.filter(([k]) => r.time[k]).map(([k, n]) => n + ": " + fmtHours(r.time[k]))
      .concat(["Total: " + fmtHours(total) + " over " + plural(r.loggedDays, "logged day")]) : [], "No hours logged this week. Add them in the daily log."));
    out.push(sec("Decisions", r.decisions.map(d => "Decided: " + decisionText(d) + (d.text && d.decision && d.decision !== d.text ? " (on: " + clip(d.text, 100) + ")" : ""))
      .concat(r.decisionsOpen.map(d => "Still open: " + d.text)), "No decisions made or pending."));
    out.push(sec("Questions for the guide", r.questions.map(q => q.text).concat(r.answered.length ? [plural(r.answered.length, "question") + " answered this week"] : []), "No open questions."));
    out.push(sec("Meetings", r.meetingsHeld.map(m => "Held " + fmtWhen(m.at) + (m.note ? " — " + clip(oneLine(m.note), 160) : ""))
      .concat(r.meetingsNext.filter(m => m.at >= r.now).map(m => (m.status === "confirmed" ? "Next: " : "Proposed: ") + fmtWhen(m.at)))));
    out.push(sec("Deliverables", r.specs.map(e => describeEvent(e, idx || { nodes: new Map() }, x => x.name || "Someone"))
      .concat(r.specMissing.length ? [plural(r.specMissing.length, "item") + " still without a written deliverable"] : []), "No changes to deliverables."));
    out.push(sec("Tasks", r.tasksOpen.map(t => { const d = dueMs(t.due); return "Open: " + t.text + (d ? " (" + dueLabel(d, r.now).toLowerCase() + ")" : ""); }), "No open tasks."));
    const stale = r.claims.filter(c => c.status === "stale"), weak = r.claims.filter(c => c.status === "unsupported");
    out.push(sec("Manuscript claims", stale.map(c => "Stale: " + clip(c.claim.text, 140)).concat(weak.map(c => "Not yet fully supported: " + clip(c.claim.text, 140)))
      .concat(r.claimsChecked.length ? [plural(r.claimsChecked.length, "claim") + " re-verified this week"] : []),
    r.claims.length ? "All " + plural(r.claims.length, "claim") + " rest on approved, independently checked evidence." : "No claims recorded."));
    out.push(sec("Blockers", r.blockers.map(b => L(b.node) + ": " + clip(b.info.reason, 160)), "Nothing blocked."));
    out.push(sec("Discussion", r.comments.length ? [plural(r.comments.length, "comment") + " this week (" + Object.keys(r.commenters).map(k => k + " " + r.commenters[k]).join(", ") + ")"] : [], "No comments this week."));
    out.push(sec("Plan for next week", r.plan.slice(0, 14).map(p => (p.meeting ? "Meeting" : p.task ? p.task.text + (p.node ? " (" + L(p.node) + ")" : "") : L(p.node)) + " — " + p.why)
      .concat(r.lastPlan ? ["First action from the latest log: " + r.lastPlan] : [])));
    return out;
  }
  function reportTitle(r, projectName) { return projectName + " — week of " + fmtRange(r.window.start, addDays(r.window.end, -1)); }
  function reportText(r, projectName) {
    return reportTitle(r, projectName) + "\n\n" + reportSections(r).map(s => s.title.toUpperCase() + "\n" + (s.lines.length ? s.lines.map(l => "• " + l).join("\n") : "  " + s.empty)).join("\n\n");
  }
  function reportMarkdown(r, projectName) {
    return "# " + reportTitle(r, projectName) + "\n\n" +
      reportSections(r).map(s => "## " + s.title + "\n\n" + (s.lines.length ? s.lines.map(l => "- " + l).join("\n") : "_" + s.empty + "_")).join("\n\n") + "\n";
  }
  function reportHtml(r, projectName) {
    return "<h2 style=\"font:600 18px Georgia,serif;margin:0 0 12px\">" + esc(reportTitle(r, projectName)) + "</h2>" +
      reportSections(r).map(s => "<h3 style=\"font:600 13px sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#5d6377;margin:18px 0 6px\">" + esc(s.title) + "</h3>" +
        (s.lines.length ? "<ul style=\"margin:0;padding-left:18px\">" + s.lines.map(l => "<li style=\"margin:3px 0\">" + esc(l) + "</li>").join("") + "</ul>"
          : "<p style=\"margin:0;color:#7b8195\">" + esc(s.empty) + "</p>")).join("");
  }

  /* ---------------------------------------------------------------- daily digest (emails) */
  // attention: reminders and deadline warnings; activity: what the other person did that wasn't
  // already emailed the moment it happened. Your own changes never appear in your digest.
  function dailyDigest(idx, st, o) {
    if (!st.eff) resolveItems(idx, st);
    const { start, end, now, recipient, prefs } = o, who = { email: recipient.email, uid: recipient.uid };
    const attention = [], activity = [];
    const every3 = days => days >= 3 && days % 3 === 0;
    if (prefs.reminders) {
      for (const l of idx.leaves) {
        const it = itemOf(st, l.id), days = -dayDiff(it.reviewAt || now, now);
        if (recipient.role === "guide" && (it.review === "submitted" || it.review === "discussion") && every3(days))
          attention.push(label(l) + (it.review === "submitted" ? " has waited " : " has been flagged for discussion for ") + plural(days, "day") + (it.review === "submitted" ? " for your review." : "."));
        if (recipient.role === "student" && it.review === "changes" && every3(days))
          attention.push((it.note && it.note.kind === "invalidated" ? "The result of " + label(l) + " was marked invalid " : "Changes were requested on " + label(l) + " ") + plural(days, "day") + " ago.");
      }
      for (const d of st.decisions) if (!decisionDone(d) && !sameActor(d, who)) {
        const days = -dayDiff(d.at, now);
        if (every3(days)) attention.push("A decision has been waiting " + plural(days, "day") + ": “" + clip(d.text, 140) + "”");
      }
    }
    if (prefs.deadlines) {
      const warn = d => d === 2 || d === 0 || d === -1;
      for (const l of idx.leaves) {
        const due = dueMs(itemOf(st, l.id).due);
        if (due && !isDone(st, l.id) && warn(dayDiff(due, now))) attention.push(dueLabel(due, now) + ": " + label(l));
      }
      for (const t of st.tasks) { const due = dueMs(t.due); if (!t.done && due && warn(dayDiff(due, now))) attention.push("Task " + dueLabel(due, now).toLowerCase() + ": " + t.text); }
    }
    if (prefs.daily) {
      const inW = t => t >= start && t < end, other = x => !sameActor(x, who);
      for (const e of st.events.slice().sort((a, b) => a.at - b.at)) {
        if (!inW(e.at) || !other(e)) continue;
        const cat = eventCategory(e);
        if (cat !== "minor" && prefs[cat]) continue;              // already emailed the moment it happened
        const s = describeEvent(e, idx); if (s) activity.push(s);
      }
      if (prefs.comments === "daily") for (const c of st.comments) if (inW(c.at) && other(c))
        activity.push((c.name || "Someone") + " commented on " + labelId(idx, c.node) + ": “" + clip(c.text, 200) + "”");
      for (const q of st.questions) if (inW(q.at) && other(q)) activity.push((q.name || "Someone") + " added a question for the next meeting: “" + clip(q.text, 160) + "”");
      for (const c of st.claims) if (inW(c.at) && other(c)) activity.push((c.name || "Someone") + " added a manuscript claim: “" + clip(c.text, 160) + "”");
      for (const l of st.logs) if (inW(l.updatedAt || l.at) && other(l)) {
        const bits = [];
        if (l.actual) bits.push("did: " + clip(l.actual, 160));
        if (l.blocker) bits.push("blocker: " + clip(l.blocker, 120));
        activity.push((l.name || "Someone") + " logged " + fmtDay(logTime(l)) + (bits.length ? " — " + bits.join("; ") : ""));
      }
    }
    return { attention, activity, empty: !attention.length && !activity.length };
  }

  /* ---------------------------------------------------------------- full snapshot (export) */
  function snapshotMarkdown(project, idx, st, o) {
    if (!st.eff) resolveItems(idx, st);
    const now = o.now, nameOf = o.nameOf || (x => (x && x.name) || "Someone");
    const out = [], H = t => out.push("", "## " + t, "");
    const it = id => itemOf(st, id);
    const A = analyze(idx, st, { now, me: o.me || {}, role: o.role || "student" });
    out.push("# " + project.name + " — full snapshot, " + fmtDate(now, true) + " " + fmtTime(now), "", project.goal || "");
    H("Where things stand");
    for (const p of A.pillars) {
      out.push("- **" + pretty(p.node.title) + "** (" + p.total + " deliverables): " + PHASES.filter(ph => p.counts[ph.key]).map(ph => p.counts[ph.key] + " " + ph.label.toLowerCase()).join(", "));
      out.push("  - verification: " + VERIFY.filter(v => p.vcounts[v.key]).map(v => p.vcounts[v.key] + " " + v.label.toLowerCase()).join(", "));
    }
    if (A.sync) out.push("- Theory and Numerics: " + (A.sync.outOfStep ? "out of step on " + plural(A.sync.outOfStep, "pair") + " of " + A.sync.pairs.length : "in step on all " + A.sync.pairs.length + " pairs"));
    H("Outline and deliverables");
    (function walk(n, d) {
      for (const c of n.children) {
        const pad = "  ".repeat(d), leaf = !c.children.length;
        if (!leaf) {
          const ls = leavesOf(c), approved = ls.filter(l => isApproved(st, l.id)).length;
          out.push(pad + "- **" + pretty(c.title) + "** — " + approved + " of " + ls.length + " approved" + (c.dlv ? " (added deliverable group)" : ""));
        }
        else {
          const x = it(c.id), bits = [stageText(st, c.id), "verification: " + VL(x.verify)];
          if (x.blocked) bits.push("blocked: " + oneLine(x.blocked.reason));
          if (x.due && x.review !== "approved") bits.push(dueLabel(dueMs(x.due), now).toLowerCase());
          if (x.critical) bits.push("critical");
          if (x.link) bits.push(x.link);
          out.push(pad + "- " + (x.review === "approved" ? "[x] " : "[ ] ") + pretty(c.title) + (c.dlv ? " _(added by guide)_" : "") + " — " + bits.join(" · "));
          if (x.spec) {
            if (x.spec.what) out.push(pad + "  - Deliverable: " + oneLine(x.spec.what));
            if (x.spec.acceptance) out.push(pad + "  - Acceptance: " + oneLine(x.spec.acceptance));
            if (x.spec.artifacts) out.push(pad + "  - Artifacts: " + oneLine(x.spec.artifacts));
          } else out.push(pad + "  - Deliverable: _not written yet_");
          if (x.note && x.note.text) out.push(pad + "  - Last review note (" + (x.note.kind || "") + ", " + (x.note.name || "") + "): " + oneLine(x.note.text));
          if (x.verifyNote && x.verifyNote.text) out.push(pad + "  - Verification note: " + oneLine(x.verifyNote.text));
          for (const t of st.tasks.filter(t => t.node === c.id)) { const dd = dueMs(t.due); out.push(pad + "  - " + (t.done ? "[x]" : "[ ]") + " task: " + t.text + (dd && !t.done ? " (" + dueLabel(dd, now).toLowerCase() + ")" : "")); }
        }
        for (const cm of st.comments.filter(x => x.node === c.id).sort((a, b) => a.at - b.at)) out.push(pad + "  > " + nameOf(cm) + ", " + fmtDate(cm.at, true) + ": " + oneLine(cm.text));
        walk(c, d + 1);
      }
    })(idx.root, 0);
    const archived = st.deliverables.filter(d => d.archived);
    H("Archived or orphaned deliverables");
    out.push(...(archived.length || idx.orphans.length ? archived.map(d => "- " + d.title + " (archived)").concat(idx.orphans.map(d => "- " + d.title + " (its section no longer exists)")) : ["_None._"]));
    const orphanTasks = st.tasks.filter(t => t.node && !idx.nodes.has(t.node)).concat(st.tasks.filter(t => !t.node));
    if (orphanTasks.length) { H("Tasks not tied to a current item"); out.push(...orphanTasks.map(t => "- " + (t.done ? "[x] " : "[ ] ") + t.text)); }
    H("Review history");
    const rev = st.events.filter(e => ["submit", "resubmit", "withdraw", "approve", "changes", "discuss", "invalidate", "verify"].indexOf(e.type) >= 0).sort((a, b) => a.at - b.at);
    out.push(...(rev.length ? rev.map(e => "- " + fmtDate(e.at, true) + " " + fmtTime(e.at) + " — " + describeEvent(e, idx, nameOf)) : ["_No review activity yet._"]));
    H("Decisions");
    out.push(...(st.decisions.length ? st.decisions.slice().sort((a, b) => a.at - b.at).map(d => "- " + (decisionDone(d) ? "Decided " + fmtDate(d.decidedAt || d.at, true) + ": " + decisionText(d) + (d.decision && d.text && d.decision !== d.text ? " (asked: " + oneLine(d.text) + ")" : "") : "Open since " + fmtDate(d.at, true) + ": " + d.text)) : ["_None._"]));
    H("Questions");
    out.push(...(st.questions.length ? st.questions.slice().sort((a, b) => a.at - b.at).map(q => "- " + (q.answered ? "[answered] " : "[open] ") + oneLine(q.text) + " — " + nameOf(q) + ", " + fmtDate(q.at, true)) : ["_None._"]));
    H("Meetings");
    out.push(...(st.meetings.length ? st.meetings.slice().sort((a, b) => a.at - b.at).map(m => "- " + fmtWhen(m.at) + " (" + (m.duration || 30) + " min) — " + m.status + (m.note ? ": " + oneLine(m.note) : "")) : ["_None._"]));
    H("Manuscript claims");
    out.push(...(A.claims.length ? A.claims.map(c => "- " + (c.claim.section ? c.claim.section + ": " : "") + oneLine(c.claim.text) + " — **" + c.status + "**"
      + (c.evidence.length ? " (rests on: " + c.evidence.map(e => (e.node ? label(e.node) : e.id) + (e.reasons.length ? " [" + e.reasons.join("; ") + "]" : "")).join(", ") + ")" : "")) : ["_None recorded._"]));
    H("Daily log");
    const FIELDS = [["intended", "Intended"], ["actual", "Did"], ["produced", "Produced"], ["failed", "Failed"], ["learned", "Learned"], ["blocker", "Blocker"], ["tomorrow", "Next"]];
    out.push(...(st.logs.length ? st.logs.slice().sort((a, b) => logTime(a) - logTime(b)).flatMap(l => {
      const hrs = l.hours ? WORKSTREAMS.filter(([k]) => l.hours[k]).map(([k, n]) => n + " " + fmtHours(l.hours[k])).join(", ") : "";
      return ["- **" + fmtDay(logTime(l)) + "**, " + nameOf(l) + (hrs ? " (" + hrs + ")" : "")].concat(FIELDS.filter(([k]) => l[k]).map(([k, n]) => "  - " + n + ": " + oneLine(l[k])));
    }) : ["_No entries._"]));
    H("Activity log");
    out.push(...(st.events.length ? st.events.slice().sort((a, b) => a.at - b.at).map(e => { const t = describeEvent(e, idx, nameOf); return t ? "- " + fmtDate(e.at, true) + " " + fmtTime(e.at) + " — " + t : null; }).filter(Boolean) : ["_No activity recorded._"]));
    H("Email settings");
    const keys = Object.keys(st.prefs || {});
    out.push(...(keys.length ? keys.map(k => { const p = st.prefs[k]; return "- " + (p.email || k) + ": " + ["reviews", "deliverables", "decisions", "blockers", "meetings", "daily", "reminders", "deadlines", "weekly"].filter(x => p[x]).join(", ") + "; comments " + (p.comments || "daily"); }) : ["_Defaults for everyone._"]));
    return out.join("\n") + "\n";
  }

  return {
    DAY, LOCALE, STAGES, S, LAST_WORK, STAGE_HELP, REVIEW, REVIEW_LABEL, VERIFY, VIDX, STUDENT_VERIFY_MAX, ROLES, PHASES, WORKSTREAMS,
    LIST_COLLECTIONS, MAP_COLLECTIONS, COLLECTIONS, LEGACY_FIELDS, DEFAULT_PREFS, ACTIONS, ITEM_KEYS,
    pretty, slug, clip, esc, plural, emailKey, textToHtml, oneLine,
    startOfDay, addDays, dayDiff, dateKey, parseDateKey, isDateKey, dueMs, weekBounds, fmtDate, fmtDay, fmtTime, fmtWhen, fmtRange, dueLabel, ago, fmtHours,
    parseOutline, buildTree, indexTree, buildIndex, dlvId, leavesOf, pillarOf, trail, crumb, parentCrumb, label, labelId,
    emptyState, sameActor, roleOfEmail, prefsFor, shouldEmail, logTime, decisionDone, decisionText,
    blankItem, normItem, hasSpec, legacyItem, resolveItems, itemOf, posOf, stageIdx, isApproved, isDone, flagOf, phaseOf, stageText, verifyIdx, leafValue, progress,
    check, transition, actionsFor, toDoc, isMaterial, eventCategory, describeEvent,
    touchMap, unansweredComments, syncPairs, claimStatus, topActions, analyze, recentChanges,
    weeklyReport, reportSections, reportTitle, reportText, reportMarkdown, reportHtml, dailyDigest, snapshotMarkdown
  };
});
