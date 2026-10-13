/* A line-by-line JavaScript model of the item rules in firestore.rules, checked against core.js.
   Thousands of random action sequences go through core.transition(); every write the app would
   make must be accepted by the rules, and forged writes must be refused. This guards against the
   app and the rules drifting apart. (tests/rules.test.js runs the real rules in the emulator.)
   Keep in step with firestore.rules.   Run: node --test tests/rules-model.test.js */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core.js");

const KEYS = ["stage", "review", "verify", "due", "link", "blocked", "critical", "spec", "note", "verifyNote", "stageAt", "reviewAt", "verifyAt",
  "specAt", "specBy", "specName", "updatedAt", "updatedBy", "updatedName", "updatedRole"];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const get = (o, k, d) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);
const studentVerify = v => ["unchecked", "regulated", "converged"].indexOf(v) >= 0;

function itemShape(d, role, uid) {
  return Object.keys(d).every(k => KEYS.indexOf(k) >= 0)
    && ["none", "submitted", "discussion", "changes", "approved"].indexOf(d.review) >= 0
    && ["unchecked", "regulated", "converged", "independent", "publication"].indexOf(d.verify) >= 0
    && (d.stage === null || (Number.isInteger(d.stage) && d.stage >= 0 && d.stage <= 4))
    && d.updatedBy === uid && d.updatedRole === role
    && (["submitted", "discussion", "approved"].indexOf(d.review) < 0 || d.stage === 4)
    && (d.verify !== "publication" || d.review === "approved");
}
function createOk(d, role) {
  const guide = role === "guide";
  return (d.review !== "approved" || guide) && (guide || studentVerify(d.verify)) && (guide || d.spec === null);
}
function reviewMove(rb, ra, d, role) {
  const guide = role === "guide", student = role === "student";
  return rb === ra
    || (student && ["none", "changes"].indexOf(rb) >= 0 && ra === "submitted" && d.blocked === null)
    || (student && ["submitted", "discussion"].indexOf(rb) >= 0 && ra === "none")
    || (guide && ["submitted", "discussion"].indexOf(rb) >= 0 && ["approved", "discussion", "changes"].indexOf(ra) >= 0)
    || (guide && rb === "approved" && ra === "changes")
    || (["submitted", "discussion", "approved"].indexOf(rb) >= 0 && ra === "changes" && d.verify === "unchecked");
}
function updateOk(d, o, role) {
  const guide = role === "guide", student = role === "student";
  return (guide || (eq(d.spec, get(o, "spec", null)) && d.specBy === get(o, "specBy", null) && d.specName === get(o, "specName", "") && d.specAt === get(o, "specAt", 0)))
    && (eq(d.note, get(o, "note", null)) || d.review !== get(o, "review", "none"))
    && (d.stage === get(o, "stage", null) || (student && ["none", "changes"].indexOf(get(o, "review", "none")) >= 0))
    && reviewMove(get(o, "review", "none"), d.review, d, role)
    && (d.verify === get(o, "verify", "unchecked") || guide || studentVerify(d.verify));
}
const allowWrite = (d, o, role, uid) => itemShape(d, role, uid) && (o ? updateOk(d, o, role) : createOk(d, role));

const UID = { student: "u-s", guide: "u-g" };
function randomArgs(action, rnd) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  switch (action) {
    case "stage": return { to: pick([null, 0, 1, 2, 3, 4, 4, 4]) };
    case "verify": return { to: pick(C.VERIFY.map(v => v.key)), note: pick(["", "because"]) };
    case "block": return { reason: pick(["", "cluster down"]) };
    case "due": return { due: pick([null, "2026-11-03"]) };
    case "link": return { url: pick([null, "https://github.com/x/nb"]) };
    case "critical": return { on: pick([true, false]) };
    case "spec": return { what: pick(["", "compute n_k"]), acceptance: pick(["", "matches limit"]), artifacts: "" };
    default: return { note: pick(["", "note"]) };
  }
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

test("every move the app makes is accepted by the rules", () => {
  const rnd = mulberry32(42);
  let moves = 0, refusals = 0;
  for (let walk = 0; walk < 3000; walk++) {
    let it = C.blankItem(), stored = null;
    for (let step = 0; step < 18; step++) {
      const role = rnd() < 0.5 ? "student" : "guide";
      const action = C.ACTIONS[Math.floor(rnd() * C.ACTIONS.length)];
      let r;
      try { r = C.transition(it, action, randomArgs(action, rnd), { role, by: UID[role], name: role, now: 1000 + step }, "n"); }
      catch (e) { if (e.name !== "TransitionError") throw e; refusals++; continue; }
      if (!r) continue;
      const doc = C.toDoc(r.item);
      assert.ok(allowWrite(doc, stored, role, UID[role]),
        "rules would refuse a legal move: " + role + " " + action + " from " + JSON.stringify({ stage: it.stage, review: it.review, verify: it.verify, blocked: !!it.blocked }));
      stored = doc; it = r.item; moves++;
    }
  }
  assert.ok(moves > 10000 && refusals > 1000, "the walk exercised enough states (" + moves + " moves, " + refusals + " refusals)");
});

test("forged writes are refused", () => {
  const S = { role: "student", by: UID.student, name: "s", now: 1 }, G = { role: "guide", by: UID.guide, name: "g", now: 2 };
  const walk = steps => steps.reduce((it, [a, act, args]) => C.transition(it, act, args || {}, a).item, C.blankItem());
  const sent = C.toDoc(walk([[S, "stage", { to: 4 }], [S, "submit"]]));
  const as = (doc, role, patch) => Object.assign({}, doc, patch, { updatedBy: UID[role], updatedRole: role });
  assert.equal(allowWrite(as(sent, "student", { review: "approved" }), sent, "student", UID.student), false, "student approves");
  assert.equal(allowWrite(as(sent, "student", { stage: 2 }), sent, "student", UID.student), false, "stage moves while with guide");
  assert.equal(allowWrite(as(sent, "guide", { review: "none" }), sent, "guide", UID.guide), false, "guide withdraws");
  const ready = C.toDoc(walk([[S, "stage", { to: 4 }]]));
  assert.equal(allowWrite(as(ready, "guide", { stage: 2 }), ready, "guide", UID.guide), false, "guide moves student's stage");
  assert.equal(allowWrite(as(ready, "guide", { review: "approved" }), ready, "guide", UID.guide), false, "approve unsent");
  assert.equal(allowWrite(as(ready, "student", { verify: "independent" }), ready, "student", UID.student), false, "student independent check");
  assert.equal(allowWrite(Object.assign(as(ready, "student", {}), { updatedRole: "guide" }), ready, "student", UID.student), false, "role spoof");
  assert.equal(allowWrite(Object.assign(as(ready, "student", {}), { extra: 1 }), ready, "student", UID.student), false, "extra key");
  assert.equal(allowWrite(as(ready, "student", { spec: { what: "x", acceptance: "", artifacts: "" } }), ready, "student", UID.student), false, "student writes spec");
  assert.equal(allowWrite(as(sent, "guide", { verify: "publication" }), sent, "guide", UID.guide), false, "publication before approval");
});

test("legacy-derived records can be materialised by whoever touches them first", () => {
  const L = { stages: { a: { idx: 6, at: 1 }, b: { idx: 2, at: 1 }, c: { idx: 5, at: 1 } },
    review: { d: { status: "changes_requested", note: "x", at: 1 } }, ticks: { e: { at: 1 } }, blocked: { b: { reason: "r", at: 1 } } };
  for (const id of ["a", "b", "c", "d", "e"]) for (const role of ["student", "guide"]) for (const action of C.ACTIONS) {
    let r;
    try { r = C.transition(C.legacyItem(L, id), action, randomArgs(action, () => 0.99), { role, by: UID[role], name: role, now: 5 }, id); }
    catch (e) { continue; }
    if (!r) continue;
    assert.ok(allowWrite(C.toDoc(r.item), null, role, UID[role]), "first write refused: " + role + " " + action + " on legacy " + id);
  }
});
