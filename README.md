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

## Editing the outline

The outline is plain text in `index.html` (`outline:` inside `PROJECTS`): two spaces of indent per level,
`- Title :: detail` (the detail may contain `$...$` math). Ticks and comments are keyed by the titles, so
renaming an item starts it fresh; adding or removing items is safe.

Before step 4 the page runs in local mode: everything is saved in your browser only.
