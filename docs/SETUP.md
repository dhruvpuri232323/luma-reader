# Setting up Luma Reader (GitHub + Firebase)

About 15 minutes. You need a GitHub account and a Google account. Nothing to install on your computer.

When you're done you'll have:

- the app live at `https://<your-username>.github.io/luma-reader/`
- Google sign-in, with your progress, words, highlights, notes, bookmarks and settings syncing between phone and laptop
- the app installed on both devices like a normal app

---

## Step 1 — Put the code on GitHub

1. Go to <https://github.com/new>. Name the repository `luma-reader`. Public or private both work (private Pages needs a paid GitHub plan — if you're on the free plan, choose **Public**; your books and notes never go into the repo, only the app code).
2. Click **Create repository**, then **uploading an existing file**.
3. Unzip `luma-reader.zip` on your computer, open the `luma-reader` folder, select **everything inside it** (including the hidden `.github` folder — on a Mac press `Cmd+Shift+.` to show hidden files; on Windows tick *View → Hidden items*) and drag it into the GitHub upload page. Click **Commit changes**.

   > Prefer the command line? Inside the unzipped folder:
   > ```bash
   > git remote add origin https://github.com/<your-username>/luma-reader.git
   > git push -u origin main
   > ```

4. In the repo: **Settings → Pages → Build and deployment → Source → GitHub Actions**.
5. Open the **Actions** tab. The "Deploy to GitHub Pages" workflow runs (≈1 minute). When it's green, your app is live at `https://<your-username>.github.io/luma-reader/`.

At this point the app already works in **local mode** — everything is saved on the device you use. Steps 2–4 turn on sync.

---

## Step 2 — Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Create a project**. Name it `luma-reader`. Google Analytics: turn it **off** (the app doesn't use it).
2. On the project home page click the **web icon `</>`** ("Add app"). Nickname: `luma-web`. Leave "Firebase Hosting" unticked. Click **Register app**.
3. Firebase shows a `firebaseConfig = { ... }` block. Keep this tab open — you'll copy it in Step 4.

## Step 3 — Turn on sign-in and the database

**Google sign-in**

1. Left menu → **Build → Authentication → Get started**.
2. **Sign-in method → Google → Enable**, choose your support email, **Save**.
3. **Settings → Authorized domains → Add domain** → enter `<your-username>.github.io` (no `https://`, no path).

**Firestore database**

1. Left menu → **Build → Firestore Database → Create database**.
2. Location: pick one near you (e.g. `asia-south1` (Mumbai)). This can't be changed later.
3. Start in **production mode** → **Create**.
4. Open the **Rules** tab, delete what's there, paste the contents of [`firebase/firestore.rules`](../firebase/firestore.rules), click **Publish**.

These rules mean each Google account can only read and write its own data.

## Step 4 — Connect the app to Firebase

1. In GitHub, open `js/firebase-config.js` and click the ✏️ pencil.
2. Copy the six values from Firebase's `firebaseConfig` into `FIREBASE_CONFIG`:

   ```js
   export const FIREBASE_CONFIG = {
     apiKey: "AIza...",
     authDomain: "luma-reader-xxxx.firebaseapp.com",
     projectId: "luma-reader-xxxx",
     storageBucket: "luma-reader-xxxx.firebasestorage.app",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abc123",
   };
   ```

   (Lost the tab? Firebase → ⚙️ **Project settings → General → Your apps**.)
3. **Commit changes**. Wait for the Actions run to turn green.

These values are not secret — every Firebase web app sends them to the browser. The security rules from Step 3 are what protect your data.

## Step 5 — Use it on your laptop and phone

**Laptop (Chrome or Edge):** open your app URL → Settings → **Sign in with Google**. Then click the install icon in the address bar (or Settings → Install app). The installed app can also open PDFs from your file manager ("Open with → Luma Reader").

**Android (Chrome):** open the URL → Settings → Sign in with the **same** Google account → menu ⋮ → **Add to Home screen / Install app**. You can now share a PDF from Files, Gmail or Drive straight to Luma.

**iPhone/iPad (Safari):** open the URL → Settings → Sign in → Share → **Add to Home Screen**.

Everything you do now syncs: open a book on the laptop, carry on from the same page on the phone.

---

## Step 6 (optional) — Sync the PDF files themselves

Without this, each device needs its own copy of a PDF. When you add the same file on your phone, Luma recognises it (by its fingerprint) and joins it to your synced progress, notes and words automatically. Most people are fine with this.

If you want books to download onto your phone by themselves:

1. Firebase → ⚙️ → **Usage and billing → Details & settings → Modify plan → Blaze** (pay-as-you-go). Cloud Storage needs it. Set a **budget alert** of e.g. ₹100 so you're warned if anything changes.
2. **Build → Storage → Get started** → production mode → choose **us-central1, us-east1 or us-west1**. Only buckets in those three regions get the no-cost allowance (5 GB stored, 100 GB downloaded per month), which comfortably covers a personal library; any other region is billed from the first byte. Your Firestore data can stay in its own region.
3. **Rules** tab → paste [`firebase/storage.rules`](../firebase/storage.rules) → **Publish**.
4. In `js/firebase-config.js` set `ENABLE_CLOUD_PDFS = true` and commit.

New books upload automatically when you're signed in; existing ones upload the next time you open the app on the device that has them. On another device, opening the book offers **Download from cloud**.

---

## Troubleshooting

| What you see | Fix |
|---|---|
| "This address isn't allowed yet" when signing in | Step 3: add `<your-username>.github.io` to Authorized domains |
| "Firestore refused access" | Step 3: publish `firebase/firestore.rules` |
| "Google sign-in is turned off" | Step 3: enable the Google provider |
| Sign-in popup closes and nothing happens on iPhone | Allow pop-ups for the site (Settings → Safari → Block Pop-ups off), then try again |
| Changes don't appear on the other device | Both devices must use the same Google account. Settings shows "Up to date" when everything has synced |
| The site shows an old version | Reload once — the app picks up the new version on the next open |
| Actions run fails at "Check JavaScript syntax" | A typo in `js/firebase-config.js` — check quotes and commas |

## Optional: deploy the rules from GitHub automatically

`.github/workflows/firebase-rules.yml` publishes the rules files whenever they change. Add a repository **variable** `FIREBASE_PROJECT_ID` and a **secret** `FIREBASE_SERVICE_ACCOUNT` (the JSON key of a Google Cloud service account with the *Firebase Rules Admin* role). Until you do, the workflow is skipped and pasting rules in the console (Step 3) is all you need.

## Optional: host on Firebase instead of GitHub Pages

`firebase.json` is ready: `npx firebase-tools login`, copy `.firebaserc.example` to `.firebaserc` with your project id, then `npx firebase-tools deploy`. Your site will be at `https://<project-id>.web.app` — add nothing to Authorized domains, it's already there.
