// Firebase web-app configuration for the shared tracker.
// Paste the object from: Firebase console -> Project settings -> General -> Your apps -> Web app -> "SDK setup and configuration" (Config).
// These values are public by design; access is controlled by firestore.rules (only the listed Google accounts).
// While this is null the page still works, but ticks and comments are saved only in the current browser.
window.TRACKER_FIREBASE = null;
/* Example:
window.TRACKER_FIREBASE = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  appId: "1:1234567890:web:abc123"
};
*/
