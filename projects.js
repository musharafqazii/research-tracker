/* Projects tracked by this site.
   Read by the web app (as window.TRACKER_PROJECTS) and by the email digests (scripts/notify.js),
   so the outline lives in exactly one place.

   Outline syntax: two spaces of indent per level, "- Title" or "- Title :: short detail".
   Item ids are built from the titles, so keep a title unchanged once work has been recorded
   against it (a renamed item starts with a clean history). Adding or removing items is safe.

   people: who uses the tracker and in what role. "guide" decides which view opens first,
   who gets review requests, and how the Today page phrases things. Emails must match the
   Google accounts in firestore.rules. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TRACKER_PROJECTS = factory();
})(typeof self !== "undefined" ? self : this, function () {
  return [{
    id: "cgpp-scalar",
    name: "CGPP-SCALAR",
    goal: "Gravitational production of a conformally coupled massive scalar across a smooth inflation-to-radiation transition: to second order in scalar and tensor metric perturbations, first order in the quartic self-interaction, and their mixing.",
    people: [
      { email: "musharafqazi@physics.iitm.ac.in", role: "student" },
      // emails: false = this person is sent no emails at all (not right-away, not the daily digest, not the weekly
      // report), whatever their settings say. They keep full access. Delete the flag to turn their emails back on.
      { email: "garani@physics.iitm.ac.in", role: "guide", emails: false }
    ],
    outline: `
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
`
  }];
});
