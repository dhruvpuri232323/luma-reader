// Firebase adapter: Google sign-in, Firestore mirror of the synced stores, and
// optional Cloud Storage for the original PDF files. The SDK is loaded from
// Google's CDN only when a Firebase config is present, so local-only use
// downloads nothing extra.

import { FIREBASE_CONFIG, ENABLE_CLOUD_PDFS, FIREBASE_SDK_VERSION } from "../firebase-config.js";

export const firebaseConfigured = () => Boolean(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);

const cdn = (m) => `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-${m}.js`;

export async function createFirebaseAdapter() {
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(cdn("app")),
    import(cdn("auth")),
    import(cdn("firestore")),
  ]);
  const {
    getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
    onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, indexedDBLocalPersistence,
  } = authMod;
  const { getFirestore, collection, doc, setDoc, onSnapshot } = fsMod;

  const app = initializeApp(FIREBASE_CONFIG);
  const auth = getAuth(app);
  try { await setPersistence(auth, indexedDBLocalPersistence); }
  catch { await setPersistence(auth, browserLocalPersistence).catch(() => {}); }
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  // Finish a redirect sign-in if one is in flight (used when popups are blocked).
  getRedirectResult(auth).catch((e) => console.warn("Redirect sign-in:", e?.code || e));

  let storageApi = null;
  async function storage() {
    if (!ENABLE_CLOUD_PDFS || !FIREBASE_CONFIG.storageBucket) return null;
    if (storageApi) return storageApi;
    const s = await import(cdn("storage"));
    storageApi = { ...s, instance: s.getStorage(app) };
    return storageApi;
  }
  const pdfRef = (s, uid, docId) => s.ref(s.instance, `users/${uid}/pdfs/${docId}.pdf`);

  return {
    name: "firebase",
    cloudPdfs: ENABLE_CLOUD_PDFS && Boolean(FIREBASE_CONFIG.storageBucket),

    onAuth(cb) {
      return onAuthStateChanged(auth, (u) =>
        cb(u ? { uid: u.uid, name: u.displayName, email: u.email, photo: u.photoURL } : null)
      );
    },

    async signIn() {
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        const code = e?.code || "";
        if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(code)) {
          await signInWithRedirect(auth, provider);
        } else if (!/popup-closed-by-user|cancelled-popup-request/.test(code)) {
          throw e;
        }
      }
    },

    signOut: () => signOut(auth),

    listen(uid, coll, onRecords, onError) {
      return onSnapshot(
        collection(db, "users", uid, coll),
        (snap) => {
          const recs = [];
          snap.docChanges().forEach((ch) => {
            if (ch.type !== "removed") recs.push(ch.doc.data());
          });
          onRecords(recs, { fromCache: snap.metadata.fromCache });
        },
        onError
      );
    },

    write(uid, coll, rec) {
      return setDoc(doc(db, "users", uid, coll, rec.id), rec);
    },

    async uploadPdf(uid, docId, blob, onProgress) {
      const s = await storage();
      if (!s) throw new Error("Cloud PDF storage is turned off in js/firebase-config.js");
      const task = s.uploadBytesResumable(pdfRef(s, uid, docId), blob, { contentType: "application/pdf" });
      await new Promise((res, rej) =>
        task.on("state_changed", (snap) => onProgress?.(snap.bytesTransferred / snap.totalBytes), rej, res)
      );
    },

    async downloadPdf(uid, docId) {
      const s = await storage();
      if (!s) throw new Error("Cloud PDF storage is turned off");
      return s.getBlob(pdfRef(s, uid, docId));
    },

    async deletePdf(uid, docId) {
      const s = await storage();
      if (!s) return;
      await s.deleteObject(pdfRef(s, uid, docId)).catch(() => {});
    },
  };
}
