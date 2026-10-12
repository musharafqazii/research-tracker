// Weekly progress digest, run on a schedule by .github/workflows/weekly-digest.yml.
// Reads the tracker's Firestore document (ticks, dues, comments, meetings) with a Firebase
// service account, builds a short summary, and emails it to everyone in NOTIFY_EMAILS via
// the EmailJS REST API (the same EmailJS account the live app uses for comment/meeting mail).
//
// Required environment variables (set as GitHub Actions secrets — see README.md):
//   FIREBASE_SERVICE_ACCOUNT_JSON  - full JSON key for a Firebase service account (see README)
//   EMAILJS_SERVICE_ID             - same service id as email-config.js
//   EMAILJS_TEMPLATE_ID            - same template id as email-config.js
//   EMAILJS_PUBLIC_KEY             - same public key as email-config.js
//   EMAILJS_PRIVATE_KEY            - EmailJS "Private Key" (Account -> API Keys); needed for
//                                     sending from a server instead of a browser
// Optional:
//   NOTIFY_EMAILS       - comma-separated recipient list (defaults to the two addresses below)
//   TRACKER_PROJECT_ID  - Firestore document id under trackers/ (defaults to cgpp-scalar)
//   TRACKER_PROJECT_NAME- display name used in the email (defaults to CGPP-SCALAR)
//   TRACKER_LINK        - URL to the live tracker (defaults to the GitHub Pages URL)

const admin = require("firebase-admin");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing required environment variable: " + name);
  return v;
}

// Keep this in sync with the `outline` in index.html's PROJECTS[0] if the outline ever changes.
// It's only used to turn node ids like "theory~perturbation~second-order-perturbation" back into
// readable titles for the digest email.
const OUTLINE = `
- Theory
  - Homogeneous-case
    - Free Field
    - Quartic Interaction
  - Perturbation
    - First order perturbation
    - Second order perturbation
    - First order perturbation + Quartic Interaction
    - Second order perturbation + Quartic interaction
- Numerics
  - Homogeneous-case
    - Free Field
    - Quartic Interaction
  - Perturbation
    - First order perturbation
    - Second order perturbation
    - First order perturbation + Quartic Interaction
    - Second order perturbation + Quartic interaction
`;

function slug(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function buildTitleMap() {
  const stack = [{ id: "root" }];
  const titles = {};
  for (const raw of OUTLINE.split("\n")) {
    if (!raw.trim()) continue;
    const ind = raw.match(/^ */)[0].length / 2;
    const title = raw.trim().replace(/^- /, "").split(" :: ")[0].trim();
    while (stack.length > ind + 1) stack.pop();
    const parent = stack[stack.length - 1];
    const id = (parent.id === "root" ? "" : parent.id + "~") + slug(title);
    titles[id] = title;
    const node = { id };
    stack.push(node);
  }
  return titles;
}

async function sendEmail({ to, project, section, message, link }) {
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: requireEnv("EMAILJS_SERVICE_ID"),
      template_id: requireEnv("EMAILJS_TEMPLATE_ID"),
      user_id: requireEnv("EMAILJS_PUBLIC_KEY"),
      accessToken: requireEnv("EMAILJS_PRIVATE_KEY"),
      template_params: {
        to_email: to,
        from_name: "Weekly digest",
        project,
        section,
        message,
        link
      }
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("EmailJS send failed (" + res.status + "): " + text);
  }
}

async function main() {
  const serviceAccount = JSON.parse(requireEnv("FIREBASE_SERVICE_ACCOUNT_JSON"));
  const PROJECT_DOC_ID = process.env.TRACKER_PROJECT_ID || "cgpp-scalar";
  const PROJECT_NAME = process.env.TRACKER_PROJECT_NAME || "CGPP-SCALAR";
  const TRACKER_LINK = process.env.TRACKER_LINK || "https://musharafqazii.github.io/research-tracker/";
  const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || "musharafqazi@physics.iitm.ac.in,garani@physics.iitm.ac.in")
    .split(",").map(s => s.trim()).filter(Boolean);

  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();
  const titles = buildTitleMap();
  const titleFor = id => titles[id] || id;

  const ref = db.collection("trackers").doc(PROJECT_DOC_ID);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const ticks = data.ticks || {};
  const dues = data.dues || {};

  const [commentsSnap, meetingsSnap] = await Promise.all([
    ref.collection("comments").orderBy("at").get(),
    ref.collection("meetings").orderBy("at").get()
  ]);
  const comments = commentsSnap.docs.map(d => d.data());
  const meetings = meetingsSnap.docs.map(d => d.data());

  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const weekAhead = now + 7 * 86400000;

  const tickedThisWeek = Object.values(ticks).filter(v => v && v.at >= weekAgo);
  const commentsThisWeek = comments.filter(c => c.at >= weekAgo);
  const overdue = Object.entries(dues).filter(([id, ms]) => ms < now && !ticks[id]);
  const dueSoon = Object.entries(dues).filter(([id, ms]) => ms >= now && ms <= weekAhead && !ticks[id]);
  const upcomingMeetings = meetings.filter(m => m.at >= now && m.at <= weekAhead && m.status !== "declined");
  const totalDone = Object.keys(ticks).length;

  const lines = [];
  lines.push(`This week: ${tickedThisWeek.length} item(s) ticked, ${commentsThisWeek.length} comment(s). ${totalDone} items done overall.`);
  if (overdue.length) {
    lines.push("Overdue: " + overdue.map(([id]) => titleFor(id)).join(", "));
  }
  if (dueSoon.length) {
    lines.push("Due in the next 7 days: " + dueSoon.map(([id, ms]) =>
      titleFor(id) + " (" + new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ")"
    ).join(", "));
  }
  if (upcomingMeetings.length) {
    lines.push("Upcoming meetings: " + upcomingMeetings.map(m =>
      new Date(m.at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) +
      " (" + (m.status || "proposed") + ")"
    ).join("; "));
  }
  if (!tickedThisWeek.length && !commentsThisWeek.length && !overdue.length && !dueSoon.length && !upcomingMeetings.length) {
    lines.push("No activity this week.");
  }
  const message = lines.join("\n");

  let failures = 0;
  for (const to of NOTIFY_EMAILS) {
    try {
      await sendEmail({ to, project: PROJECT_NAME, section: "Weekly digest", message, link: TRACKER_LINK });
      console.log("Digest sent to " + to);
    } catch (err) {
      failures++;
      console.error("Failed to send digest to " + to + ": " + err.message);
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
