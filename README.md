# Research tracker

A shared tracker for a PhD project between a student and a guide. Every deliverable in the outline
has one record: where the work is, whether the guide has signed it off, and how far the result has been
checked. Both of you see the same live data; each of you can only make the moves that are yours.

Project: **CGPP-SCALAR**. Live at https://musharafqazii.github.io/research-tracker/

## How an item moves

```
Derive → Implement → Test → Produce artifact → Interpret → Guide review → Approved
└──────────── the student's work stages ──────────────┘   └─── the guide's ───┘
```

- The student moves an item through the five work stages and, from **Interpret**, sends it for review
  (optionally with a note). Unfinished or blocked work can't be sent.
- While it's with the guide, its stage is locked. The student can **withdraw** it to keep working.
- The guide **approves**, **requests changes** (a note is required), or **flags it for discussion**
  (then approves or requests changes after talking).
- Changes requested → the item is back with the student, who reworks it and **resends** it.
- **Approved** is locked. Only the guide can reopen it (which is a change request with a note).
- Nothing counts as done until it's approved. There are no tick boxes any more.
- Either of you can **mark a result invalid** (a note is required): it goes back for changes and its
  verification is cleared. Invalidated results show up in the weekly report under "Failed or invalidated".

## Verification (separate from review)

`Unchecked → Regulated → Converged → Independently checked → Publication-ready`

- The student can record Regulated and Converged. **Independently checked** and **Publication-ready**
  are the guide's call. Publication-ready needs the item to be approved.
- Lowering a level needs a reason. Requesting changes on an independently checked result resets it to
  Converged, because the result is about to change.

## Deliverables (written by the guide)

Each item has a **Deliverable** block at the top of its panel: what exactly to produce, how it will be
judged, and the expected artifacts. Only the guide can write or edit it. The Today and Review pages list
items that don't have one yet, with items where work has already started first.

The guide can also **add deliverables** under any section, or split an item into smaller deliverables,
straight from the Outline (open the section, "Add a deliverable here"). They can be renamed and archived
(never deleted, so history stays readable). To expand the CGPP outline in bulk, either add the items in
the app or put them in `projects.js` (two spaces of indent per level).

## The pages

- **Home**: only what needs you right now. For the student: what to do next, what's waiting for you,
  what's coming up, and what's with your guide. For the guide: items to review (with Approve right
  there), what needs your input, what's coming up, and what's back with your student.
- **Items**: the outline. Click an item to see its status and the one next step, what to deliver,
  its checks, due date, link and comments. Less frequent things (blocking, critical, "the result is
  wrong", reopening, splitting into smaller deliverables) are under **More options**.
- **Meetings**: propose and confirm times, questions for the next meeting, and decisions.
- **Journal**: the daily log and the weekly report.
- **More ▾** (top right): manuscript claims, email settings, downloads and backup, sign out.

If Firebase isn't set up (or you open `index.html` straight from disk), the tracker runs in a
browser-only preview with a Student/Guide switch, so you can try both sides.

## Email

What arrives right away (each person turns these on or off under **Email settings**):
review requests, approvals, change requests, invalidations and independent checks; deliverables
written or added; blockers; decisions; meeting changes; comments only if you choose "right away".
Your own changes never email you.

Scheduled (GitHub Actions, `.github/workflows/weekly-digest.yml`):
- **Daily digest** at 07:00 IST, only on days with something to say: reminders when a review or a
  change request has waited 3+ days, deadline warnings (2 days before, on the day, the day after), and
  the other person's routine activity.
- **Weekly report** on Sunday at 19:00 IST: completed, sent for review, active, new results,
  verification, failed or invalidated, time by workstream, decisions, questions, meetings, deliverables,
  tasks, manuscript claims, blockers, discussion, and the plan for next week.

### One-time email setup

1. **EmailJS template**: change its *Subject* to `{{subject}}` and its *Content* to `{{{message_html}}}`
   (three braces, so the formatting comes through). *To Email* stays `{{to_email}}`.
2. **For the scheduled emails**, add these as repository secrets (GitHub → Settings → Secrets and
   variables → Actions):
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: Firebase console → Project settings → Service accounts →
     Generate new private key; paste the whole file. Keep it secret.
   - `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`: the values in `email-config.js`.
   - `EMAILJS_PRIVATE_KEY`: EmailJS → Account → Security. If EmailJS has an option to allow API calls
     from non-browser applications, switch it on.
3. Test: GitHub → Actions → *Email digests* → *Run workflow*. "dry run" is ticked by default, so the
   emails are printed in the log instead of sent; untick it to send for real.

## Security rules

`firestore.rules` enforces the same moves on the server, so the database itself refuses a student
approving their own work, a stage change while the item is with the guide, a student writing the
deliverable or recording an independent check, publication-ready before approval, or anyone outside the
two accounts. **After any change to it: Firebase console → Firestore Database → Rules → paste the whole
file → Publish.** The emails in `firestore.rules` must match `people` in `projects.js`.

## Data

Stored under `trackers/{project}` in Firestore: `items` (one record per deliverable), `events`
(append-only history), `deliverables`, `comments`, `meetings`, `decisions`, `questions`, `tasks`,
`claims`, `logs`, `prefs`. Records from the earlier version of the tracker (ticks and stages on the
project document) are read automatically. An earlier "approved" or tick comes back as *waiting for
review*, so the guide confirms it once.

**Export ▾** in the header gives a full readable snapshot (.md), this week's report (.md), and a
**backup (.json) of every record**. The free Firebase plan has no automatic backups, so take one now
and then.

## First-time setup

1. Firebase project (free Spark plan) with Firestore and Google sign-in enabled.
2. Put the web app config in `firebase-config.js` (`window.TRACKER_FIREBASE = {...}`).
3. Publish `firestore.rules` (see above).
4. GitHub Pages: Settings → Pages → Deploy from branch `main`, folder `/`. Add
   `<username>.github.io` under Authentication → Settings → Authorized domains.
5. Email: `email-config.js` plus the steps under *One-time email setup*.

## Files

`index.html` (page shell) · `app.css` · `app.js` (the interface) · `core.js` (the model, the rules
about moves, reports and digests, shared by everything) · `projects.js` (outline and people) ·
`firestore.rules` · `scripts/notify.js` (scheduled emails) · `tests/`.

## Tests

```
node --test tests/core.test.js tests/rules-model.test.js   # the state machine, reports, exports, rules model
python3 tests/e2e.py                                        # both roles in a real browser (needs Playwright)
npx firebase emulators:exec --only firestore --project demo-tracker "node --test tests/rules.test.js"
```

The last one runs `firestore.rules` in the Firestore emulator (needs Java and
`npm i -D firebase-tools @firebase/rules-unit-testing firebase`).
