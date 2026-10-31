// ─────────────────────────────────────────────────────────────────────────────
//  Luma Reader — Firebase connection settings
//
//  1. Create a Firebase project (see docs/SETUP.md, step 2).
//  2. In the Firebase console: Project settings → General → "Your apps" →
//     Web app → copy the `firebaseConfig` values into the object below.
//  3. Commit and push. GitHub Pages redeploys and sync turns on.
//
//  These values are NOT secrets — every Firebase web app ships them to the
//  browser. Your data is protected by the security rules in /firebase.
//  Leave `apiKey` empty and the app runs in local-only mode.
// ─────────────────────────────────────────────────────────────────────────────

export const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// Upload the original PDF files to Firebase Cloud Storage so the same books
// open on every device. Cloud Storage needs the pay-as-you-go (Blaze) plan;
// a personal library normally stays inside the free allowance if the bucket
// is in us-central1, us-east1 or us-west1 (see docs/SETUP.md, step 6).
// With this off, book lists, progress, words, notes and bookmarks still sync,
// and you add the PDF file once on each device.
export const ENABLE_CLOUD_PDFS = false;

// Firebase JavaScript SDK version loaded from Google's CDN.
export const FIREBASE_SDK_VERSION = "12.19.0";

// ─────────────────────────────────────────────────────────────────────────────
//  Google Drive book sync (free, optional — see docs/SETUP.md, "Google Drive")
//  Paste an OAuth "Web application" client ID from Google Cloud Console
//  (APIs & Services → Credentials). Your Firebase project already has one called
//  "Web client (auto created by Google Service)". Add your site's address to its
//  "Authorized JavaScript origins" and enable the Google Drive API.
//  Leave empty to hide the Drive option.
// ─────────────────────────────────────────────────────────────────────────────
export const GOOGLE_CLIENT_ID = "";
