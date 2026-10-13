/* Tests for firestore.rules against the Firestore emulator, using the same core.js transitions the
   app uses (so the client and the server agree on every move).

   Run (needs Java and the Firebase CLI):
     npm i -D firebase-tools @firebase/rules-unit-testing firebase
     npx firebase emulators:exec --only firestore --project demo-tracker "node --test tests/rules.test.js"  */
"use strict";
const test = require("node:test");
const fs = require("fs");
const path = require("path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const C = require("../core.js");

const STUDENT = { uid: "u-student", email: "musharafqazi@physics.iitm.ac.in" };
const GUIDE = { uid: "u-guide", email: "garani@physics.iitm.ac.in" };
const STRANGER = { uid: "u-x", email: "someone@gmail.com" };
const T = "trackers/cgpp-scalar";
let env;

test.before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  env = await initializeTestEnvironment({
    projectId: "demo-tracker",
    firestore: { rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"), host, port: Number(port) }
  });
});
test.after(async () => { if (env) await env.cleanup(); });
test.beforeEach(async () => { await env.clearFirestore(); });

const db = who => env.authenticatedContext(who.uid, { email: who.email, email_verified: true }).firestore();
const actor = (who, role) => ({ role, by: who.uid, name: role, now: Date.now() });
const S = actor(STUDENT, "student"), G = actor(GUIDE, "guide");
async function seed(id, item) { await env.withSecurityRulesDisabled(c => c.firestore().doc(T + "/items/" + id).set(C.toDoc(item))); }
function walk(steps) { let it = C.blankItem(); for (const [a, act, args] of steps) { const r = C.transition(it, act, args || {}, a); if (r) it = r.item; } return it; }
// What the app writes for one move: the full record after the transition.
const write = (who, id, item) => db(who).doc(T + "/items/" + id).set(C.toDoc(item));
const after = (it, a, act, args) => C.transition(it, act, args || {}, a).item;

test("strangers can't read anything", async () => {
  await assertFails(db(STRANGER).doc(T + "/items/a").get());
  await assertFails(db(STRANGER).doc(T).get());
  await assertSucceeds(db(STUDENT).doc(T).get());
  await assertFails(db(STUDENT).doc(T).set({ ticks: {} }));
});

test("student works an item through to review; guide approves", async () => {
  let it = after(C.blankItem(), S, "stage", { to: 0 });
  await assertSucceeds(write(STUDENT, "a", it));
  it = after(it, S, "stage", { to: 4 });
  await assertSucceeds(write(STUDENT, "a", it));
  it = after(it, S, "submit", { note: "done" });
  await assertSucceeds(write(STUDENT, "a", it));
  const approved = after(it, G, "approve");
  await assertFails(write(STUDENT, "a", Object.assign({}, approved, { updatedBy: STUDENT.uid, updatedRole: "student" })));
  await assertSucceeds(write(GUIDE, "a", approved));
});

test("nobody can lie about their role, add fields, or skip the shape", async () => {
  const it = after(C.blankItem(), S, "stage", { to: 1 });
  await assertFails(write(STUDENT, "a", Object.assign({}, it, { updatedRole: "guide" })));
  await assertFails(db(STUDENT).doc(T + "/items/a").set(Object.assign(C.toDoc(it), { approvedBy: "me" })));
  await assertFails(write(STUDENT, "a", Object.assign({}, it, { stage: 7 })));
  await assertFails(write(STUDENT, "a", Object.assign({}, it, { review: "done" })));
  await assertFails(write(STUDENT, "a", Object.assign({}, it, { updatedBy: GUIDE.uid })));
});

test("the student can't create an approved item, a spec, or guide-only checks", async () => {
  await assertFails(write(STUDENT, "a", Object.assign(walk([[S, "stage", { to: 4 }]]), { review: "approved", updatedBy: STUDENT.uid, updatedRole: "student" })));
  await assertFails(write(STUDENT, "b", Object.assign(C.blankItem(), { spec: { what: "x", acceptance: "", artifacts: "" }, updatedBy: STUDENT.uid, updatedRole: "student" })));
  await assertFails(write(STUDENT, "c", Object.assign(walk([[S, "stage", { to: 3 }]]), { verify: "independent", updatedBy: STUDENT.uid, updatedRole: "student" })));
  await assertSucceeds(write(STUDENT, "d", walk([[S, "stage", { to: 3 }], [S, "verify", { to: "converged" }]])));
});

test("submitted work needs the last stage, and can't be submitted while blocked", async () => {
  const early = walk([[S, "stage", { to: 2 }]]);
  await seed("a", early);
  await assertFails(write(STUDENT, "a", Object.assign({}, early, { review: "submitted", updatedBy: STUDENT.uid, updatedRole: "student" })));
  const blocked = walk([[S, "stage", { to: 4 }], [S, "block", { reason: "cluster down" }]]);
  await seed("b", blocked);
  await assertFails(write(STUDENT, "b", Object.assign({}, blocked, { review: "submitted", updatedBy: STUDENT.uid, updatedRole: "student" })));
});

test("the guide can't send work for review, and nobody approves unsent work", async () => {
  const ready = walk([[S, "stage", { to: 4 }]]);
  await seed("a", ready);
  await assertFails(write(GUIDE, "a", Object.assign({}, ready, { review: "submitted", updatedBy: GUIDE.uid, updatedRole: "guide" })));
  await assertFails(write(GUIDE, "a", Object.assign({}, ready, { review: "approved", updatedBy: GUIDE.uid, updatedRole: "guide" })));
});

test("stage is locked while with the guide and after approval", async () => {
  const sent = walk([[S, "stage", { to: 4 }], [S, "submit"]]);
  await seed("a", sent);
  await assertFails(write(STUDENT, "a", Object.assign({}, sent, { stage: 2, updatedBy: STUDENT.uid, updatedRole: "student" })));
  await assertSucceeds(write(STUDENT, "a", after(sent, S, "withdraw")));
  const approved = walk([[S, "stage", { to: 4 }], [S, "submit"], [G, "approve"]]);
  await seed("b", approved);
  await assertFails(write(GUIDE, "b", Object.assign({}, approved, { stage: 1, updatedBy: GUIDE.uid, updatedRole: "guide" })));
});

test("guide: request changes, flag for discussion, reopen", async () => {
  const sent = walk([[S, "stage", { to: 4 }], [S, "submit"]]);
  await seed("a", sent);
  await assertFails(write(STUDENT, "a", Object.assign({}, sent, { review: "changes", updatedBy: STUDENT.uid, updatedRole: "student" })));
  await assertSucceeds(write(GUIDE, "a", after(sent, G, "discuss", { note: "which regulator?" })));
  const approved = walk([[S, "stage", { to: 4 }], [S, "verify", { to: "converged" }], [S, "submit"], [G, "approve"], [G, "verify", { to: "independent" }]]);
  await seed("b", approved);
  await assertSucceeds(write(GUIDE, "b", after(approved, G, "changes", { note: "sign error" })));
});

test("either can invalidate a result; the student can't reopen without invalidating", async () => {
  const approved = walk([[S, "stage", { to: 4 }], [S, "verify", { to: "converged" }], [S, "submit"], [G, "approve"]]);
  await seed("a", approved);
  await assertFails(write(STUDENT, "a", Object.assign({}, approved, { review: "changes", updatedBy: STUDENT.uid, updatedRole: "student" })));
  await assertSucceeds(write(STUDENT, "a", after(approved, S, "invalidate", { note: "didn't converge" })));
});

test("verification: publication needs approval; top levels are the guide's", async () => {
  const sent = walk([[S, "stage", { to: 4 }], [S, "verify", { to: "converged" }], [S, "submit"]]);
  await seed("a", sent);
  await assertFails(write(GUIDE, "a", Object.assign({}, sent, { verify: "publication", updatedBy: GUIDE.uid, updatedRole: "guide" })));
  await assertSucceeds(write(GUIDE, "a", after(sent, G, "verify", { to: "independent" })));
  await assertFails(write(STUDENT, "a", Object.assign({}, sent, { verify: "independent", updatedBy: STUDENT.uid, updatedRole: "student" })));
});

test("only the guide writes the deliverable", async () => {
  const it = walk([[S, "stage", { to: 1 }]]);
  await seed("a", it);
  await assertFails(write(STUDENT, "a", Object.assign({}, it, { spec: { what: "mine", acceptance: "", artifacts: "" }, updatedBy: STUDENT.uid, updatedRole: "student" })));
  const spec = after(it, G, "spec", { what: "Compute n_k(η) to 1%", acceptance: "Matches sudden limit", artifacts: "nb" });
  await assertSucceeds(write(GUIDE, "a", spec));
  await seed("a", spec);
  // the student can still move the stage without touching the spec
  await assertSucceeds(write(STUDENT, "a", after(spec, S, "stage", { to: 2 })));
});

test("nobody rewrites someone else's review note or the deliverable's author", async () => {
  const flagged = walk([[S, "stage", { to: 4 }], [S, "submit"], [G, "changes", { note: "fix the sign" }]]);
  await seed("a", flagged);
  const forged = Object.assign({}, flagged, { note: Object.assign({}, flagged.note, { text: "looks great" }), updatedBy: STUDENT.uid, updatedRole: "student" });
  await assertFails(write(STUDENT, "a", forged));
  const spec = walk([[G, "spec", { what: "x" }]]);
  await seed("b", spec);
  await assertFails(write(STUDENT, "b", Object.assign({}, spec, { specName: "Musharaf", updatedBy: STUDENT.uid, updatedRole: "student" })));
});

test("items can't be deleted", async () => {
  await seed("a", walk([[S, "stage", { to: 1 }]]));
  await assertFails(db(GUIDE).doc(T + "/items/a").delete());
});

test("history carries the right role; each person clears only their own", async () => {
  const ref = db(STUDENT).collection(T + "/events");
  await assertSucceeds(ref.doc("e1").set({ type: "stage", node: "a", data: {}, at: Date.now(), by: STUDENT.uid, role: "student", name: "S", email: STUDENT.email }));
  await assertFails(ref.doc("e2").set({ type: "approve", node: "a", data: {}, at: Date.now(), by: STUDENT.uid, role: "guide", name: "S", email: STUDENT.email }));
  await assertFails(ref.doc("e3").set({ type: "stage", node: "a", data: {}, at: Date.now(), by: GUIDE.uid, role: "student" }));
  await assertFails(ref.doc("e1").update({ type: "approve" }));
  await assertFails(db(GUIDE).doc(T + "/events/e1").delete());      // not the guide's entry
  await assertSucceeds(ref.doc("e1").delete());                      // the student clears their own
});

test("deliverables: the guide adds, renames and archives; nobody deletes", async () => {
  const d = { parent: "theory~homogeneous-case~free-field", title: "Mode functions", order: 1, archived: false, at: Date.now(), by: GUIDE.uid, email: GUIDE.email, name: "G", role: "guide" };
  await assertFails(db(STUDENT).doc(T + "/deliverables/x").set(Object.assign({}, d, { by: STUDENT.uid })));
  await assertSucceeds(db(GUIDE).doc(T + "/deliverables/x").set(d));
  await assertSucceeds(db(GUIDE).doc(T + "/deliverables/x").update({ title: "Mode functions in the WKB basis", updatedAt: Date.now() }));
  await assertSucceeds(db(GUIDE).doc(T + "/deliverables/x").update({ archived: true, updatedAt: Date.now() }));
  await assertFails(db(GUIDE).doc(T + "/deliverables/x").update({ by: STUDENT.uid }));
  await assertFails(db(STUDENT).doc(T + "/deliverables/x").update({ title: "mine" }));
  await assertFails(db(GUIDE).doc(T + "/deliverables/x").delete());
  await assertFails(db(GUIDE).doc(T + "/deliverables/y").set(Object.assign({}, d, { title: "" })));
});

test("email settings: each person edits only their own", async () => {
  await assertSucceeds(db(STUDENT).doc(T + "/prefs/musharafqazi_physics_iitm_ac_in").set({ email: STUDENT.email, daily: false }));
  await assertFails(db(STUDENT).doc(T + "/prefs/garani_physics_iitm_ac_in").set({ email: GUIDE.email, daily: false }));
  await assertSucceeds(db(GUIDE).doc(T + "/prefs/musharafqazi_physics_iitm_ac_in").get());
});

test("decisions: a requested decision is made by the other person", async () => {
  await assertSucceeds(db(STUDENT).doc(T + "/decisions/d").set({ text: "Which initial time?", status: "open", at: 1, by: STUDENT.uid }));
  await assertFails(db(STUDENT).doc(T + "/decisions/d").update({ status: "decided", decision: "my call" }));
  await assertSucceeds(db(GUIDE).doc(T + "/decisions/d").update({ status: "decided", decision: "η₀ = -10", decidedAt: 2, decidedBy: GUIDE.uid }));
  await assertFails(db(GUIDE).doc(T + "/decisions/d").delete());
});

test("meetings: the other person confirms; either can cancel", async () => {
  await assertSucceeds(db(STUDENT).doc(T + "/meetings/m").set({ at: Date.now() + 1e6, duration: 60, status: "proposed", by: STUDENT.uid }));
  await assertFails(db(STUDENT).doc(T + "/meetings/m").update({ status: "confirmed", respondedBy: STUDENT.uid, respondedAt: 1 }));
  await assertSucceeds(db(GUIDE).doc(T + "/meetings/m").update({ status: "confirmed", respondedBy: GUIDE.uid, respondedName: "G", respondedAt: 1 }));
  await assertSucceeds(db(STUDENT).doc(T + "/meetings/m").delete());
});

test("comments, questions and the daily log", async () => {
  await assertSucceeds(db(STUDENT).doc(T + "/comments/c").set({ node: "a", text: "check eq 4", at: 1, by: STUDENT.uid }));
  await assertFails(db(GUIDE).doc(T + "/comments/c").update({ text: "edited by someone else" }));
  await assertSucceeds(db(GUIDE).doc(T + "/comments/c").update({ taskId: "yes" }));
  await assertFails(db(GUIDE).doc(T + "/comments/c").delete());
  await assertSucceeds(db(STUDENT).doc(T + "/questions/q").set({ text: "Trace anomaly?", answered: false, at: 1, by: STUDENT.uid }));
  await assertSucceeds(db(GUIDE).doc(T + "/questions/q").update({ answered: true, answeredAt: 2 }));
  await assertFails(db(GUIDE).doc(T + "/questions/q").update({ text: "rewritten" }));
  await assertSucceeds(db(STUDENT).doc(T + "/logs/l").set({ date: "2026-10-12", actual: "derived", at: 1, by: STUDENT.uid }));
  await assertFails(db(GUIDE).doc(T + "/logs/l").update({ actual: "nothing" }));
  await assertSucceeds(db(GUIDE).doc(T + "/logs/l").get());
});
