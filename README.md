# Luma Reader

A calm PDF reader for laptop and phone. Rest the pointer on any word (or tap it on a phone) for an instant definition, save it to your vocabulary in one click, highlight and annotate passages on the original page, and pick up on one device exactly where you stopped on the other.

- **Code & hosting:** GitHub repository, published to GitHub Pages by GitHub Actions
- **Accounts & sync:** Firebase Authentication (Google sign-in) + Cloud Firestore; optional Cloud Storage for the PDF files
- **No build step:** plain HTML, CSS and JavaScript modules. PDF.js is vendored in `vendor/`

**→ Setup guide: [docs/SETUP.md](docs/SETUP.md)** (≈15 minutes, no installs)

## What it does

| Area | Features |
|---|---|
| Dictionary | Hover or tap to define · adjustable hover delay, on/off · pronunciation (audio or device voice) · phonetics · all parts of speech · synonyms & antonyms · works offline for words seen before · Define button on any selection |
| Vocabulary | One-click save with book, page and the sentence it came from · your own definition and memory trick · search · learning / mastered · flashcards · spaced-repetition review (Again/Hard/Good/Easy) · CSV export |
| Library | Import several PDFs, drag & drop, phone file picker, Android share sheet, "Open with" on desktop · duplicate detection (SHA-256) · cover thumbnails · rename, pin, search, filter, sort · progress %, status, continue reading · mark finished, reset progress · download original · delete |
| Reading | Tabs for several books (restored on reopen) · side-by-side comparison with its own page controls · continuous scroll · page jump · keyboard paging · zoom (buttons, Ctrl+wheel, pinch) · fit width/page · rotate · built-in table of contents · full-text search with result list *and* on-page highlights · focus mode · read page aloud · reflow mode with 5 fonts, size, spacing and column width |
| Annotation | Bookmarks (B) · select → 4 highlight colours or a note · edit/recolour/delete by clicking a highlight · per-book and library-wide notes views with search and colour filter · Markdown export |
| Comfort | Light, sepia, dark (pages dimmed too) and match-device themes · 5 accent colours · reduce motion · soft sound cues (can be turned off) |
| Sync & ownership | Works with no account · Google sign-in · progress, words, notes, bookmarks, settings sync live · changes made offline queue and upload later · deletions sync · optional PDF upload · installable app that works offline · full JSON backup & restore · erase device |

## Repository structure

```
luma-reader/
├── index.html                 App shell
├── manifest.webmanifest       Install metadata, "Open with" PDF handler, Android share target
├── sw.js                      Service worker: offline app, cached PDF engine, share-target receiver
├── css/
│   ├── app.css                Design tokens, themes, shell, library, words, notes, settings
│   └── reader.css             Reader, dictionary card, highlights, reflow, mobile sheets
├── js/
│   ├── firebase-config.js     ← the only file you edit (Firebase keys, cloud PDF switch)
│   ├── main.js                Boot, navigation, drag & drop
│   ├── core/                  util (DOM helpers), feel (themes, sounds, speech), pwa (install, share)
│   ├── data/                  db (IndexedDB), store (records + outbox), library, dictionary, backup
│   ├── sync/                  sync (two-way engine), firebase (Auth/Firestore/Storage adapter)
│   ├── reader/                reader (view), tab (one book), pdf (PDF.js), lookup (word under pointer),
│   │                          annotate (highlights/bookmarks), compare (second pane)
│   └── ui/                    library, words, notes, settings, definition card, overlays, icons, router
├── vendor/pdfjs/              PDF.js 6.2 (Apache-2.0), fonts, CMaps, WASM decoders
├── icons/                     App icons
├── firebase/                  firestore.rules, storage.rules, indexes
├── firebase.json              Rules + optional Firebase Hosting config
├── .github/workflows/
│   ├── deploy-pages.yml       Publishes to GitHub Pages on every push to main
│   └── firebase-rules.yml     Optional: publishes security rules
├── docs/                      SETUP.md, FEATURE_SPEC.md
├── scripts/serve.mjs          Local dev server (no dependencies)
└── tests/                     End-to-end test (laptop + phone + sync + offline) and sample PDFs
```

## How sync works

Every change is written to the device first (IndexedDB), so the app is instant and works offline. Each change also goes into an *outbox*. When you're signed in and online, the outbox is uploaded to `users/{your uid}/{docs|words|annotations|bookmarks|settings}` in Firestore, and live listeners bring other devices' changes in. When two devices edit the same item, the newer edit wins; deletions travel as tombstones so they reach every device.

A book's ID is the SHA-256 fingerprint of its PDF, so the same file added on two devices is recognised as the same book even without cloud PDF storage.

Data in Firestore per user:

| Collection | One document per |
|---|---|
| `docs` | book: title, pages, last/furthest page, pinned, finished, cloud flag |
| `words` | saved word: definitions, your definition, memory trick, status, source, review schedule |
| `annotations` | highlight/note: book, page, colour, text, note, position on page |
| `bookmarks` | bookmarked page |
| `settings` | your preferences |

## Run locally

```bash
node scripts/serve.mjs        # http://localhost:5173
```

To try sync locally, add `localhost` to Firebase → Authentication → Authorized domains (it's there by default).

## Tests

```bash
npm install && npx playwright install chromium
node scripts/serve.mjs &      # keep running
npm test
```

The test drives a laptop and a phone (Pixel 7 viewport) in Chromium against a stand-in cloud: import, hover/tap definitions, saving words, highlights and notes, bookmarks, contents, search, zoom, reflow, comparison, tabs, flashcard review, exports, theme, sign-in, laptop→phone and phone→laptop sync, deletion sync, and reopening offline. Screenshots land in `tests/output/`.

## Credits

PDF rendering by [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0). Definitions from the [Free Dictionary API](https://dictionaryapi.dev/). Fonts: Newsreader, Literata, Atkinson Hyperlegible, Lexend (Google Fonts, OFL).
