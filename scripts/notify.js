/* Scheduled emails: the daily digest and the weekly report. Run by .github/workflows/weekly-digest.yml.
     node scripts/notify.js daily     # reminders, deadline warnings, and the other person's routine activity
     node scripts/notify.js weekly    # the weekly report (same content as Log & report in the app)
   Each person's email settings (set in the app) decide what they get. Nothing is sent on a day with
   nothing to say. Uses the same core.js and projects.js as the site, so the emails and the app agree.

   Environment (GitHub Actions secrets, see README):
     FIREBASE_SERVICE_ACCOUNT_JSON, EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY
   Optional: TRACKER_LINK (site URL), DRY_RUN=1 (print instead of sending), TZ (set to Asia/Kolkata in the workflow). */
"use strict";
const C = require("../core.js");
const PROJECTS = require("../projects.js");

const MODE = (process.argv[2] || process.env.MODE || "daily").toLowerCase();
const DRY = !!process.env.DRY_RUN;
const LINK = process.env.TRACKER_LINK || "https://musharafqazii.github.io/research-tracker/";
const need = n => { const v = process.env[n]; if (!v) throw new Error("Missing environment variable " + n); return v; };

async function loadProject(db, project) {
  const ref = db.collection("trackers").doc(project.id), st = C.emptyState();
  const snap = await ref.get();
  st.legacy = snap.exists ? snap.data() : {};
  await Promise.all(C.LIST_COLLECTIONS.map(async c => { const s = await ref.collection(c).get(); st[c] = s.docs.map(d => Object.assign({ id: d.id }, d.data())); }));
  await Promise.all(C.MAP_COLLECTIONS.map(async c => { const s = await ref.collection(c).get(); const m = {}; s.docs.forEach(d => { m[d.id] = d.data(); }); st[c] = m; }));
  return st;
}

async function send(to, subject, text, html) {
  if (DRY) { console.log("\n=== to " + to + " — " + subject + "\n" + text); return; }
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: need("EMAILJS_SERVICE_ID"), template_id: need("EMAILJS_TEMPLATE_ID"),
      user_id: need("EMAILJS_PUBLIC_KEY"), accessToken: need("EMAILJS_PRIVATE_KEY"),
      template_params: { to_email: to, subject, message: text, message_html: html, link: LINK,
        from_name: "Research tracker", project: subject.split(" · ")[0], section: subject }
    })
  });
  if (!res.ok) throw new Error("EmailJS " + res.status + ": " + (await res.text().catch(() => "")));
  console.log("Sent “" + subject + "” to " + to);
}

function bullets(lines) { return lines.map(l => "• " + l).join("\n"); }
function htmlList(title, lines) {
  return '<h3 style="font:600 13px sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#5d6377;margin:18px 0 6px">' + C.esc(title) + "</h3>" +
    '<ul style="margin:0;padding-left:18px">' + lines.map(l => '<li style="margin:3px 0">' + C.esc(l) + "</li>").join("") + "</ul>";
}

async function runProject(db, project, now) {
  const st = await loadProject(db, project);
  const idx = C.buildIndex(project, st.deliverables);
  C.resolveItems(idx, st);
  let failures = 0;
  for (const person of project.people || []) {
    if (!C.shouldEmail(person)) { console.log("Emails are switched off for " + person.email + "."); continue; }
    const prefs = C.prefsFor(st, person.email);
    try {
      if (MODE === "weekly") {
        if (!prefs.weekly) continue;
        const r = C.weeklyReport(idx, st, C.weekBounds(now, 0), now);
        await send(person.email, project.name + " · Weekly report, " + C.fmtRange(r.window.start, C.addDays(r.window.end, -1)),
          C.reportText(r, project.name) + "\n\n" + LINK + "#log", C.reportHtml(r, project.name) + '<p style="margin-top:18px"><a href="' + C.esc(LINK) + '#log">Open the tracker</a></p>');
      } else {
        const d = C.dailyDigest(idx, st, { start: now - C.DAY, end: now, now, recipient: { role: person.role, email: person.email }, prefs });
        if (d.empty) { console.log("Nothing for " + person.email + " today."); continue; }
        const parts = [], html = [];
        if (d.attention.length) { parts.push("NEEDS ATTENTION\n" + bullets(d.attention)); html.push(htmlList("Needs attention", d.attention)); }
        if (d.activity.length) { parts.push("SINCE YESTERDAY\n" + bullets(d.activity)); html.push(htmlList("Since yesterday", d.activity)); }
        await send(person.email, project.name + " · Daily digest, " + C.fmtDay(now), parts.join("\n\n") + "\n\n" + LINK + "#today",
          html.join("") + '<p style="margin-top:18px"><a href="' + C.esc(LINK) + '#today">Open the tracker</a></p>');
      }
    } catch (e) { failures++; console.error("Failed for " + person.email + ": " + e.message); }
  }
  return failures;
}

async function main() {
  if (MODE !== "daily" && MODE !== "weekly") throw new Error("Mode must be daily or weekly, not " + MODE);
  const admin = require("firebase-admin");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(need("FIREBASE_SERVICE_ACCOUNT_JSON"))) });
  const db = admin.firestore(), now = Date.now();
  let failures = 0;
  for (const p of PROJECTS) failures += await runProject(db, p, now);
  if (failures) process.exitCode = 1;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { runProject };
