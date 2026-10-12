# Research Tracker

A one-page progress tracker for research projects, shared between a student and a supervisor.
Every item of the project outline (Theory and Numerics, down to individual derivations, runs and plots)
has a tick box and a comment thread. Progress rolls up level by level: each level shares its parent's weight
equally among its items, and Theory and Numerics count half each. Ticks and comments are stored in a free
Firebase Firestore database and appear live for both people; sign-in is with Google accounts, and only the
addresses listed in `firestore.rules` can read or write.

Projects: **CGPP-SCALAR** (more can be added to the `PROJECTS` list in `index.html`).

## One-time setup (about 10 minutes)

1. **Firebase project** (free Spark plan): go to https://console.firebase.google.com, *Add project*
   (Google Analytics is not needed).
2. **Database**: *Build → Firestore Database → Create database* (production mode, any location).
3. **Sign-in**: *Build → Authentication → Get started → Sign-in method → Google → Enable*.
4. **Web app config**: *Project settings → General → Your apps → Web (</>)*, register an app (no hosting),
   copy the `firebaseConfig` object into `firebase-config.js` as `window.TRACKER_FIREBASE = {...}`.
5. **Access list**: put your Google address and your guide's in `firestore.rules`, then paste the file into
   *Firestore Database → Rules* and *Publish*.
6. **GitHub Pages**: push this folder to a GitHub repository, then *Settings → Pages → Deploy from a branch →
   main / (root)*. The site appears at `https://<username>.github.io/<repo>/`.
7. **Authorized domain**: *Authentication → Settings → Authorized domains → Add domain* →
   `<username>.github.io`.

Open the site, click **Sign in with Google**, and share the link with your guide.
To add someone later, add their address to `firestore.rules` and publish the rules again.

## Comment email notifications (optional, free)

When someone posts a comment, the other listed person can get an email automatically, using
[EmailJS](https://www.emailjs.com) (free tier, no credit card, sends straight from the browser —
no server needed).

1. Sign up free at https://www.emailjs.com.
2. **Email Services → Add New Service**: connect the Gmail/Outlook account that should send these
   (this becomes the "from" address). Note its **Service ID**.
3. **Email Templates → Create New Template**. Set the "To email" field to `{{to_email}}`, and use
   `{{from_name}}`, `{{project}}`, `{{section}}`, `{{message}}` and `{{link}}` in the subject/body,
   e.g. subject `{{from_name}} commented on {{project}}` and body including
   `{{section}}: {{message}}` and a link `{{link}}`. Note its **Template ID**.
4. **Account → General → Public Key**: copy it.
5. Paste all three into `email-config.js` as `window.TRACKER_EMAILJS = {publicKey, serviceId, templateId}`.

While `email-config.js` is left as `null`, comments still work normally — notifications are just skipped.

## Editing the outline

The outline is plain text in `index.html` (`outline:` inside `PROJECTS`): two spaces of indent per level,
`- Title :: detail` (the detail may contain `$...$` math). Ticks and comments are keyed by the titles, so
renaming an item starts it fresh; adding or removing items is safe.

Before step 4 the page runs in local mode: everything is saved in your browser only.

## Meetings

Click **Meetings** in the toolbar to open a small scheduler: either person can propose a date/time
with an optional multi-line agenda, the other can **Confirm** or **Decline** it, and a confirmed meeting
gets an **Add to calendar** button that downloads a `.ics` file you can open in Google Calendar, Apple
Calendar, Outlook, etc. Meetings are stored the same way as ticks and comments (shared Firestore, or this
browser only before Firebase is set up), and proposing or responding to a meeting sends the other person
an email if comment notifications are configured (see above) — it reuses the same EmailJS template.

## Due dates

Every leaf item (the actual work items at the bottom of the tree) has a **+ Due** button next to it.
Click it to pick a date; the button turns into a chip showing the date, amber if it's due within 7 days,
red if it's overdue, and green once the item is ticked. Click the chip again to change or clear the date.
Due dates are stored on the same shared document as ticks, so no extra Firebase setup is needed.

## Notebook / file links

Leaf items also have a **+ Link** button for pointing at the actual code, notebook, or writeup for that
item — paste a URL (a GitHub file, a Colab/Jupyter link, an Overleaf section, anything). Once set it shows
as a **Notebook ↗** link that opens in a new tab, with an **Edit link** button next to it to change it.

## What's next

The sidebar's **What's next** panel lists the next five un-ticked items, soonest due date first (items
with no due date are listed after those that do, in outline order). It's meant to answer "where do I pick
up" without scanning the whole tree.

## Export

The **Export** button in the toolbar downloads a Markdown snapshot of the current state: the full outline
with ticks, due dates, links and comment counts, plus the full comment and meeting history. Useful for
committee reports or just archiving progress at a chapter milestone.

## Weekly digest email (optional, free)

Besides the per-comment/per-meeting emails above, a GitHub Actions workflow
(`.github/workflows/weekly-digest.yml`) can send both of you a short summary every Monday: items ticked
and commented on that week, anything overdue, anything due in the next 7 days, and upcoming meetings. It
runs entirely on GitHub's free tier (no server, no Blaze plan) and reuses the same EmailJS account as the
rest of the app. Setup, once:

1. **Firebase service account key**: in the Firebase console, go to *Project settings → Service accounts →
   Generate new private key*. This downloads a JSON file — keep it secret, it's a master key for your
   Firestore data.
2. **EmailJS Private Key**: in the EmailJS dashboard, go to *Account → Security* and copy the **Private
   Key** (sometimes labelled API key). Browsers don't need this (the comment/meeting emails work without
   it), but a server-side script does, to prove it's really your account sending. If EmailJS has a setting
   there for allowing API calls from non-browser apps / servers, turn it on too — otherwise the digest
   send can come back with an authorization error.
3. In your GitHub repository, go to **Settings → Secrets and variables → Actions → New repository secret**
   and add these five:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — paste the *entire contents* of the JSON file from step 1.
   - `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY` — same values as in `email-config.js`.
   - `EMAILJS_PRIVATE_KEY` — the Private Key from step 2.
4. That's it — it'll run automatically every Monday at 06:00 UTC. To test it immediately, go to the
   **Actions** tab → **Weekly digest** → **Run workflow**, then check the run's log and your inbox.

If the outline in `index.html` is ever restructured, update the matching `OUTLINE` copy at the top of
`scripts/weekly-digest.js` too, so the digest's item names stay readable instead of showing raw ids.
