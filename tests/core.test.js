/* Unit tests for core.js: the state machine, the legacy mapping, reports and exports.
   Run with:  node --test tests/   (Node 18+, no dependencies) */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core.js");
const PROJECTS = require("../projects.js");
const P = PROJECTS[0];

const STUDENT = { role: "student", by: "u-student", name: "Musharaf", now: Date.UTC(2026, 9, 12, 10) };
const GUIDE = { role: "guide", by: "u-guide", name: "Guide", now: Date.UTC(2026, 9, 12, 11) };
const LEAF = "theory~homogeneous-case~free-field";

function run(it, steps) {
  for (const [who, action, args] of steps) {
    const r = C.transition(it, action, args || {}, who, LEAF);
    if (r) it = r.item;
  }
  return it;
}
const throwsMsg = (fn, re) => assert.throws(fn, e => e.name === "TransitionError" && re.test(e.userMessage));

test("Garani keeps guide access but receives no email", () => {
  const garani = P.people.find(p => p.email === "garani@physics.iitm.ac.in");
  assert.equal(garani.role, "guide");
  assert.equal(C.shouldEmail(garani), false);
  assert.equal(C.shouldEmail(P.people.find(p => p.role === "student")), true);
});

test("the happy path: derive → … → interpret → review → approved", () => {
  let it = C.blankItem();
  assert.equal(C.posOf(it), null);
  it = run(it, [[STUDENT, "stage", { to: 0 }], [STUDENT, "stage", { to: 4 }]]);
  assert.equal(it.stage, 4);
  const sub = C.transition(it, "submit", { note: "Bogoliubov coefficients done" }, STUDENT, LEAF);
  assert.equal(sub.event.type, "submit");
  it = sub.item;
  assert.equal(it.review, "submitted");
  assert.equal(C.posOf(it), C.S.REVIEW);
  const ap = C.transition(it, "approve", {}, GUIDE, LEAF);
  assert.equal(ap.item.review, "approved");
  assert.equal(C.posOf(ap.item), C.S.APPROVED);
  assert.equal(ap.item.updatedRole, "guide");
});

test("roles: the student owns work stages; the guide owns review", () => {
  let it = run(C.blankItem(), [[STUDENT, "stage", { to: 4 }]]);
  throwsMsg(() => C.transition(C.blankItem(), "stage", { to: 0 }, GUIDE), /student moves/i);
  throwsMsg(() => C.transition(it, "approve", {}, STUDENT), /guide/i);
  throwsMsg(() => C.transition(it, "submit", {}, GUIDE), /student/i);
  it = run(it, [[STUDENT, "submit"]]);
  throwsMsg(() => C.transition(it, "changes", { note: "fix" }, STUDENT), /guide/i);
  throwsMsg(() => C.transition(it, "discuss", {}, STUDENT), /guide/i);
  throwsMsg(() => C.transition(it, "withdraw", {}, GUIDE), /student/i);
});

test("you can't send unfinished or blocked work, or approve unsent work", () => {
  const early = run(C.blankItem(), [[STUDENT, "stage", { to: 2 }]]);
  throwsMsg(() => C.transition(early, "submit", {}, STUDENT), /Interpret/);
  throwsMsg(() => C.transition(early, "approve", {}, GUIDE), /hasn't been sent/);
  const blocked = run(C.blankItem(), [[STUDENT, "stage", { to: 4 }], [STUDENT, "block", { reason: "cluster down" }]]);
  throwsMsg(() => C.transition(blocked, "submit", {}, STUDENT), /blocked/);
});

test("stage is locked while with the guide and once approved", () => {
  let it = run(C.blankItem(), [[STUDENT, "stage", { to: 4 }], [STUDENT, "submit"]]);
  throwsMsg(() => C.transition(it, "stage", { to: 2 }, STUDENT), /Withdraw/);
  it = run(it, [[GUIDE, "approve"]]);
  throwsMsg(() => C.transition(it, "stage", { to: 2 }, STUDENT), /locked/);
  throwsMsg(() => C.transition(it, "block", { reason: "x" }, STUDENT), /Reopen/);
  throwsMsg(() => C.transition(it, "approve", {}, GUIDE), /already approved/);
});

test("withdraw returns work to the student", () => {
  let it = run(C.blankItem(), [[STUDENT, "stage", { to: 4 }], [STUDENT, "submit"], [STUDENT, "withdraw"]]);
  assert.equal(it.review, "none");
  it = run(it, [[STUDENT, "stage", { to: 3 }]]);
  assert.equal(it.stage, 3);
});

test("changes requested → rework → resubmit → approve", () => {
  let it = run(C.blankItem(), [[STUDENT, "stage", { to: 4 }], [STUDENT, "submit"]]);
  throwsMsg(() => C.transition(it, "changes", { note: "  " }, GUIDE), /Say what/);
  it = run(it, [[GUIDE, "changes", { note: "Use the adiabatic vacuum of order 4" }]]);
  assert.equal(it.review, "changes");
  assert.equal(C.posOf(it), 4);                 // back with the student, at the stage they were at
  it = run(it, [[STUDENT, "stage", { to: 1 }], [STUDENT, "stage", { to: 4 }]]);
  const re = C.transition(it, "submit", { note: "redone" }, STUDENT, LEAF);
  assert.equal(re.event.type, "resubmit");
  it = run(re.item, [[GUIDE, "approve"]]);
  assert.equal(it.review, "approved");
});

test("reopening an approved item resets independent checks to converged", () => {
  let it = run(C.blankItem(), [[STUDENT, "stage", { to: 4 }], [STUDENT, "verify", { to: "converged" }], [STUDENT, "submit"], [GUIDE, "approve"],
    [GUIDE, "verify", { to: "independent" }], [GUIDE, "verify", { to: "publication" }]]);
  assert.equal(it.verify, "publication");
  const r = C.transition(it, "changes", { note: "sign error in eq. 12" }, GUIDE, LEAF);
  assert.equal(r.item.review, "changes");
  assert.equal(r.item.verify, "converged");
  assert.equal(r.event.data.from, "approved");
  assert.equal(r.event.data.verifyFrom, "publication");
});

test("verification ladder: who can record what", () => {
  let it = C.blankItem();
  throwsMsg(() => C.transition(it, "verify", { to: "regulated" }, STUDENT), /Start the work/);
  it = run(it, [[STUDENT, "stage", { to: 3 }], [STUDENT, "verify", { to: "regulated" }], [STUDENT, "verify", { to: "converged" }]]);
  throwsMsg(() => C.transition(it, "verify", { to: "independent" }, STUDENT), /guide/);
  throwsMsg(() => C.transition(it, "verify", { to: "publication" }, GUIDE), /approved/);
  it = run(it, [[GUIDE, "verify", { to: "independent" }]]);
  assert.equal(it.verify, "independent");
  throwsMsg(() => C.transition(it, "verify", { to: "regulated" }, STUDENT), /Say why/);
  it = run(it, [[STUDENT, "verify", { to: "regulated", note: "cutoff dependence reappeared at higher k" }]]);
  assert.equal(it.verify, "regulated");
  assert.equal(it.verifyNote.kind, "down");
});

test("invalidating a result sends it back and clears verification", () => {
  let it = run(C.blankItem(), [[STUDENT, "stage", { to: 4 }], [STUDENT, "verify", { to: "converged" }], [STUDENT, "submit"], [GUIDE, "approve"]]);
  throwsMsg(() => C.transition(it, "invalidate", {}, STUDENT), /Say what/);
  const r = C.transition(it, "invalidate", { note: "the mode sum didn't converge after all" }, STUDENT, LEAF);
  assert.equal(r.item.verify, "unchecked");
  assert.equal(r.item.review, "changes");
  assert.equal(r.item.note.kind, "invalidated");
  assert.equal(C.isMaterial(r.event), true);
  throwsMsg(() => C.transition(C.blankItem(), "invalidate", { note: "x" }, STUDENT), /no result/);
});

test("discussion: only on submitted work, then approve or request changes", () => {
  let it = run(C.blankItem(), [[STUDENT, "stage", { to: 4 }]]);
  throwsMsg(() => C.transition(it, "discuss", {}, GUIDE), /waiting for review/);
  it = run(it, [[STUDENT, "submit"], [GUIDE, "discuss", { note: "Which regulator?" }]]);
  assert.equal(it.review, "discussion");
  assert.equal(C.posOf(it), C.S.REVIEW);
  throwsMsg(() => C.transition(it, "stage", { to: 1 }, STUDENT), /Withdraw/);
  const a = C.transition(it, "approve", {}, GUIDE, LEAF);
  assert.equal(a.item.review, "approved");
});

test("the deliverable is the guide's to write", () => {
  const it = C.blankItem();
  throwsMsg(() => C.transition(it, "spec", { what: "x" }, STUDENT), /guide/);
  const r = C.transition(it, "spec", { what: "Bogoliubov |β_k|² for k ∈ [1e-3,1e2] H", acceptance: "Matches the sudden limit", artifacts: "notebook + fig" }, GUIDE, LEAF);
  assert.equal(r.event.data.first, true);
  assert.ok(C.hasSpec(r.item));
  assert.equal(C.transition(r.item, "spec", { what: "Bogoliubov |β_k|² for k ∈ [1e-3,1e2] H", acceptance: "Matches the sudden limit", artifacts: "notebook + fig" }, GUIDE, LEAF), null, "unchanged spec is a no-op");
  const cleared = C.transition(r.item, "spec", { what: "", acceptance: "", artifacts: "" }, GUIDE, LEAF);
  assert.equal(cleared.item.spec, null);
});

test("no-op changes don't produce events", () => {
  const it = C.blankItem();
  assert.equal(C.transition(it, "due", { due: null }, STUDENT), null);
  assert.equal(C.transition(it, "link", { url: null }, STUDENT), null);
  assert.equal(C.transition(it, "critical", { on: false }, STUDENT), null);
  throwsMsg(() => C.transition(it, "due", { due: "13/10/2026" }, STUDENT), /valid date/);
  throwsMsg(() => C.transition(it, "due", { due: "2026-02-31" }, STUDENT), /valid date/);
});

test("toDoc writes every key and nothing else", () => {
  const it = run(C.blankItem(), [[STUDENT, "stage", { to: 2 }]]);
  const d = C.toDoc(Object.assign({}, it, { legacy: true, junk: 1 }));
  assert.deepEqual(Object.keys(d).sort(), C.ITEM_KEYS.slice().sort());
});

test("actionsFor matches the role", () => {
  const ready = run(C.blankItem(), [[STUDENT, "stage", { to: 4 }]]);
  assert.equal(C.actionsFor(ready, "student").submit, true);
  assert.equal(C.actionsFor(ready, "guide").submit, false);
  const sent = run(ready, [[STUDENT, "submit"]]);
  assert.equal(C.actionsFor(sent, "guide").approve, true);
  assert.equal(C.actionsFor(sent, "student").approve, false);
  assert.deepEqual(C.actionsFor(sent, "student").verifyTo, ["regulated", "converged"]);
  assert.deepEqual(C.actionsFor(sent, "guide").verifyTo, ["regulated", "converged", "independent"]);
});

test("legacy records: approvals and ticks come back as waiting for review, never approved", () => {
  const L = {
    stages: { a: { idx: 6, by: "s", name: "Musharaf", at: 5 }, b: { idx: 2, at: 6 }, c: { idx: 5, at: 7 } },
    review: { d: { status: "changes_requested", note: "fix", at: 8 }, e: { status: "needs_discussion", note: "hm", at: 9 } },
    ticks: { f: { by: "s", at: 10 } },
    dues: { b: new Date(2026, 9, 20).getTime() }, links: { b: "https://x.org/nb" }, blocked: { b: { reason: "waiting on cluster", at: 3 } }, critical: { b: { at: 1 } }
  };
  assert.equal(C.legacyItem(L, "a").review, "submitted");
  assert.equal(C.legacyItem(L, "a").note.kind, "legacy");
  assert.equal(C.legacyItem(L, "a").stage, 4);
  const b = C.legacyItem(L, "b");
  assert.equal(b.stage, 2); assert.equal(b.review, "none"); assert.equal(b.due, "2026-10-20");
  assert.equal(b.link, "https://x.org/nb"); assert.equal(b.blocked.reason, "waiting on cluster"); assert.equal(b.critical, true);
  assert.equal(C.legacyItem(L, "c").review, "submitted");
  assert.equal(C.legacyItem(L, "d").review, "changes");
  assert.equal(C.legacyItem(L, "e").review, "none");         // discussion on unsent work becomes a note
  assert.equal(C.legacyItem(L, "e").note.kind, "legacy");
  assert.equal(C.legacyItem(L, "f").review, "submitted");
  assert.equal(C.legacyItem(L, "zzz"), null);
  // A legacy-derived record can be acted on directly by the guide.
  const ap = C.transition(C.legacyItem(L, "a"), "approve", {}, GUIDE, "a");
  assert.equal(ap.item.review, "approved");
  assert.equal(ap.item.legacy, undefined);
});

test("deliverables added in the app slot into the outline", () => {
  const dl = [
    { id: "X1", parent: "theory~homogeneous-case~free-field", title: "Mode functions", order: 1, at: 1 },
    { id: "X2", parent: "theory~homogeneous-case~free-field", title: "Number density", order: 2, at: 2 },
    { id: "X3", parent: "dlv~X1", title: "WKB check", order: 1, at: 3 },
    { id: "X4", parent: "theory~homogeneous-case~free-field", title: "Archived one", archived: true, at: 4 },
    { id: "X5", parent: "nowhere", title: "Orphan", at: 5 }
  ];
  const idx = C.buildIndex(P, dl);
  const ff = idx.nodes.get("theory~homogeneous-case~free-field");
  assert.equal(ff.children.length, 2);
  assert.equal(ff.children[0].title, "Mode functions");
  assert.equal(idx.nodes.get("dlv~X3").parent.id, "dlv~X1");
  assert.ok(!idx.nodes.has("dlv~X4"));
  assert.equal(idx.orphans.length, 1);
  assert.ok(idx.leaves.some(l => l.id === "dlv~X3"));
  assert.ok(!idx.leaves.some(l => l.id === "theory~homogeneous-case~free-field"), "a section with deliverables is no longer a leaf");
  assert.equal(C.label(idx.nodes.get("dlv~X2")), "Number density (Theory)");
  // Theory/Numerics pairing still works at the outline's own items.
  const st = C.emptyState();
  const s = C.syncPairs(idx, st);
  assert.equal(s.pairs.length, 6);
});

function sampleState(idx, now) {
  const st = C.emptyState();
  const day = 86400000;
  const leaves = idx.leaves.map(l => l.id);
  const put = (id, steps) => { st.items[id] = C.toDoc(run(C.blankItem(), steps)); };
  put(leaves[0], [[STUDENT, "stage", { to: 4 }], [STUDENT, "verify", { to: "converged" }], [STUDENT, "submit"], [GUIDE, "approve"]]);
  put(leaves[1], [[STUDENT, "stage", { to: 4 }], [STUDENT, "submit"]]);
  put(leaves[2], [[STUDENT, "stage", { to: 4 }], [STUDENT, "submit"], [GUIDE, "changes", { note: "Check the sign" }]]);
  put(leaves[3], [[STUDENT, "stage", { to: 1 }], [STUDENT, "block", { reason: "Waiting for cluster time" }], [STUDENT, "due", { due: C.dateKey(now - 2 * day) }]]);
  put(leaves[4], [[GUIDE, "spec", { what: "Derive the second-order source", acceptance: "Reduces to known result", artifacts: "PDF" }]]);
  const ev = (type, node, data, at, by) => st.events.push({ id: "e" + st.events.length, type, node, data, at, by: by || "u-student", name: by === "u-guide" ? "Guide" : "Musharaf", role: by === "u-guide" ? "guide" : "student" });
  ev("stage", leaves[3], { from: null, to: 1 }, now - day);
  ev("submit", leaves[1], { note: "" }, now - day);
  ev("approve", leaves[0], { from: "submitted" }, now - day, "u-guide");
  ev("changes", leaves[2], { from: "submitted", note: "Check the sign" }, now - day, "u-guide");
  ev("invalidate", leaves[0], { note: "old run", verifyFrom: "converged", reviewFrom: "approved" }, now - 2 * day);
  ev("verify", leaves[0], { from: "regulated", to: "converged" }, now - day);
  ev("spec", leaves[4], { first: true }, now - day, "u-guide");
  ev("deliverable_add", "dlv~Q", { title: "New thing", parent: leaves[4] }, now - day, "u-guide");
  ev("stage", leaves[5], { from: 2, to: 3 }, now - day);
  st.comments.push({ id: "c1", node: leaves[1], text: "Can you check eq. 4?", at: now - day, by: "u-student", name: "Musharaf" });
  st.meetings.push({ id: "m1", at: now - day, duration: 60, status: "confirmed", note: "Agenda: signs", by: "u-guide", name: "Guide" });
  st.meetings.push({ id: "m2", at: now + 2 * day, duration: 60, status: "proposed", by: "u-student", name: "Musharaf" });
  st.decisions.push({ id: "d1", text: "Use adiabatic order 4", decision: "Use adiabatic order 4", status: "decided", at: now - day, decidedAt: now - day, by: "u-guide", name: "Guide" });
  st.decisions.push({ id: "d2", text: "Which initial time?", status: "open", at: now - day, by: "u-student", name: "Musharaf" });
  st.questions.push({ id: "q1", text: "Trace anomaly term?", answered: false, at: now - day, by: "u-student", name: "Musharaf" });
  st.questions.push({ id: "q2", text: "Old question", answered: true, answeredAt: now - day, at: now - 3 * day, by: "u-student", name: "Musharaf" });
  st.logs.push({ id: "l1", date: C.dateKey(now - day), intended: "derive", actual: "derived", failed: "the integrator blew up", tomorrow: "fix integrator", hours: { theory: 3, numerics: 2.5 }, at: now - day, by: "u-student", name: "Musharaf" });
  st.tasks.push({ id: "t1", node: leaves[1], text: "Check eq. 4", done: true, doneAt: now - day, at: now - 2 * day, by: "u-student" });
  st.tasks.push({ id: "t2", node: leaves[1], text: "Rerun at higher N", done: false, due: C.dateKey(now + day), at: now - day, by: "u-student" });
  st.claims.push({ id: "k1", text: "Particle number is finite after regulation", section: "§3", nodes: [leaves[0]], at: now - 3 * day, verifiedAt: now - 3 * day, by: "u-student", name: "Musharaf" });
  st.deliverables.push({ id: "ARCH", parent: leaves[4], title: "Old deliverable", archived: true, at: now - 5 * day });
  st.prefs["musharafqazi_physics_iitm_ac_in"] = Object.assign({}, C.DEFAULT_PREFS, { email: "musharafqazi@physics.iitm.ac.in", comments: "immediate" });
  return st;
}

test("analyze: the guide's and the student's lists come from the same records", () => {
  const now = Date.now(), idx = C.buildIndex(P, []), st = sampleState(idx, now);
  const A = C.analyze(idx, st, { now, me: { uid: "u-guide" }, role: "guide" });
  assert.equal(A.awaitingReview.length, 1);
  assert.equal(A.changesRequested.length, 1);
  assert.equal(A.blocked.length, 1);
  assert.equal(A.overdue.length, 1);
  assert.ok(A.specMissing.length >= 6);
  assert.equal(A.readyToCheck.length, 1, "approved and converged → ready for an independent check");
  assert.equal(A.staleClaims.length, 1, "the claim rests on a result invalidated after it was checked");
  assert.ok(A.actions[0].reasons[0].match(/review/i));
  const As = C.analyze(idx, st, { now, me: { uid: "u-student" }, role: "student" });
  assert.equal(As.actions[0].reasons[0], "Changes requested");
  assert.equal(As.withStudent.decisions.length, 0);
  assert.equal(A.withGuide.decisions.length, 1);
});

test("the weekly report covers every record type", () => {
  const now = Date.now(), idx = C.buildIndex(P, []), st = sampleState(idx, now);
  const w = { start: now - 7 * 86400000, end: now + 1 };
  const r = C.weeklyReport(idx, st, w, now);
  const secs = C.reportSections(r), titles = secs.map(s => s.title);
  for (const t of ["Completed (approved)", "Sent for review", "Active", "New results", "Verification", "Failed or invalidated", "Time by workstream",
    "Decisions", "Questions for the guide", "Meetings", "Deliverables", "Tasks", "Manuscript claims", "Blockers", "Discussion", "Plan for next week"])
    assert.ok(titles.indexOf(t) >= 0, "missing section " + t);
  const text = C.reportText(r, P.name);
  for (const needle of ["Check the sign", "Use adiabatic order 4", "Which initial time?", "Trace anomaly term?", "Theory: 3 h", "Numerics: 2.5 h",
    "the integrator blew up", "Rerun at higher N", "Waiting for cluster time", "wrote the deliverable", "Stale:", "Held ", "1 comment"])
    assert.ok(text.indexOf(needle) >= 0, "weekly report is missing: " + needle);
  assert.equal(text.includes("%"), false, "weekly report contains no percentages");
});

test("the snapshot export contains every record type", () => {
  const now = Date.now(), idx = C.buildIndex(P, []), st = sampleState(idx, now);
  const md = C.snapshotMarkdown(P, idx, st, { now, role: "student" });
  for (const needle of ["## Outline and deliverables", "Deliverable: Derive the second-order source", "Acceptance: Reduces to known result", "verification: Converged",
    "## Review history", "requested changes on", "## Decisions", "Open since", "## Questions", "[answered]", "## Meetings", "## Manuscript claims", "**stale**",
    "## Daily log", "Theory 3 h", "## Activity log", "## Email settings", "comments immediate", "Old deliverable (archived)", "task: Rerun at higher N", "> Musharaf"])
    assert.ok(md.indexOf(needle) >= 0, "snapshot is missing: " + needle);
  assert.equal(md.includes("%"), false, "snapshot contains no percentages");
});

test("daily digest: reminders for the right person, nothing about your own changes", () => {
  const now = Date.now(), idx = C.buildIndex(P, []), st = sampleState(idx, now);
  const prefs = Object.assign({}, C.DEFAULT_PREFS);
  const g = C.dailyDigest(idx, st, { start: now - 86400000 - 1000, end: now, now, recipient: { role: "guide", email: "g@x", uid: "u-guide" }, prefs });
  assert.ok(g.activity.some(a => /moved/.test(a)), "guide hears about the student's stage moves");
  assert.ok(!g.activity.some(a => /approved/.test(a)), "guide doesn't hear about their own approval");
  assert.ok(!g.activity.some(a => /sent .* for review/.test(a)), "review requests were already emailed immediately");
  const s = C.dailyDigest(idx, st, { start: now - 86400000 - 1000, end: now, now, recipient: { role: "student", email: "s@x", uid: "u-student" }, prefs });
  assert.ok(!s.activity.some(a => /moved/.test(a)), "student doesn't hear about their own moves");
  // Deadline warnings go out 2 days before, on the day and the day after, and not otherwise.
  const id = idx.leaves[7].id;
  for (const [offset, expect] of [[2, true], [1, false], [0, true], [-1, true], [-2, false]]) {
    st.items[id] = C.toDoc(run(C.blankItem(), [[STUDENT, "due", { due: C.dateKey(C.addDays(now, offset)) }]]));
    delete st.eff;
    const d = C.dailyDigest(idx, st, { start: now - 86400000, end: now, now, recipient: { role: "student", email: "s@x", uid: "u-student" }, prefs });
    const hit = d.attention.some(a => a.indexOf(C.label(idx.leaves[7])) >= 0);
    assert.equal(hit, expect, "deadline warning at offset " + offset);
  }
});
