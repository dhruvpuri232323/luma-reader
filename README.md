# Luma Reader

A calm reader for PDFs, EPUB books and web articles, on laptop and phone. It sets any of them as a real book in your typeface, reads it aloud like an audiobook (with a different voice for each character), defines any word you rest on, finds the hard words before you meet them, and keeps your place, notes and words in step across your devices. Free to use, no ads, no paid services.

- **Code & hosting:** GitHub repository, published to GitHub Pages by GitHub Actions
- **Sync (pick one or both, both free):** Firebase (Google sign-in + Firestore) for progress, notes and words — and/or your own **Google Drive** for the book files themselves (and, if you like, everything else)
- **No build step:** plain HTML, CSS and JavaScript modules. PDF.js is vendored in `vendor/`

**→ Setup guide: [docs/SETUP.md](docs/SETUP.md)** (≈15 minutes, no installs)

## What it does

**Bring anything to read**
- **PDF**, **EPUB**, plain text, Markdown and saved web pages (.html) — drop them on the window, pick them, “Open with” on desktop, or share them to the app on Android.
- **Web articles from a link**: Luma keeps just the text and pictures — no ads, no pop-ups — and sets it as a book. A **“Save to Luma” button** for your bookmarks bar sends any page you're on (even ones you're signed in to); on a phone, share a link to the app.
- **Paste text** to read, hear or study it.

**Read it your way**
- **Page view** — the original PDF, exactly as published: zoom, rotate, search, table of contents.
- **Book view** — any book set as a real book: running headers and page numbers stripped from PDFs, paragraphs rejoined, chapters detected, **footnotes lifted out into tap-to-read pop-ups**. Your typeface (Literata, EB Garamond, Newsreader, Atkinson Hyperlegible, Lexend, **OpenDyslexic** or your device's), size, spacing, margins, justification. Two-page spreads on laptops, one page on phones; **page turns that slide, curl like paper, or snap**; or **one continuous scroll**.
- **Reading ruler** (R) that keeps your eye on the line, **warm light** in the evening, focus mode, light/sepia/dark.
- **Auto-scroll** (A): the page glides — or turns — at your own reading speed, like a teleprompter.
- **“Where was I?”** — come back after a while and a card shows the chapter, the last lines you read and your latest note, with one tap to hear the last paragraph again.
- Minutes left in the chapter, learned from how fast *you* read.

**Listen like an audiobook**
- Press the headphones (or L): read aloud sentence by sentence with natural pauses; **the sentence and the very word being spoken light up, and the page turns or scrolls by itself to follow the voice**. Scroll away and it waits, with a **Back to the voice** button.
- **Character voices**: Luma works out who is speaking each line of dialogue (“said Mary”, “she asked”, who is acting in the paragraph, the back-and-forth of a conversation) and gives each character their own voice — women and men in fitting voices — while the narrator keeps yours. Change any of them under *Who's who*.
- **No pauses between sentences**: the natural voice is made well ahead on several processor cores at once and each sentence is lined up on the audio clock to start the moment the last one ends — only the pause a narrator would leave. It loads quietly while you read, so Listen starts at once.
- **Natural voices** run on your device (Kokoro, ~90 MB once, then offline). **Fast mode** runs them on your graphics chip (WebGPU) — several times quicker on most laptops. Until the voice is ready, the best voice your device has.
- Skips citations like (Smith, 2004) and [12], figure captions and footnote markers; **your own pronunciations** for names it gets wrong.
- **Save as an audiobook**: this chapter, or the whole book as one file per chapter (straight into a folder on Chrome/Edge) — made in parallel while you keep reading.
- Speed, sleep timer, headset and lock-screen controls; keeps playing with the screen off on phones.

**Understand every word**
- Hover (laptop) or tap (phone) any word: meanings, pronunciation, examples. If the dictionary doesn't know it: Wiktionary, WordNet, then Wikipedia for names and places; then “did you mean”, **Search Google**, or **add it with your own meaning**.
- **Words here**: before you read a chapter, Luma lists the rare words in it (real word frequencies, not guesses), with their meanings and the sentence they're in — save one or all, and have them underlined as you read.

**Learn what you read**
- Save words with the book, page and sentence you found them in; your saved words are underlined wherever they turn up again, and each word shows **where else it appears in your library**.
- Practise in five ways: spaced-repetition review **in the original sentence**, flashcards, **meaning quiz**, **spell it from sound**, **say it aloud** (speech recognition), and **use it in your own sentence**.
- Daily goal and streak, a count on the Words tab, **daily review reminders** (notifications where the browser allows, or a calendar reminder), CSV and **Anki** export.

**Notes & thinking**
- Highlights in four colours, notes, **tags**, and a **Starred** collection — your commonplace book across every book. Quote **cards** (paper, night or colour; portrait, square or story) to save or share.
- **Search everything**: titles, the full text inside every book you've opened, your notes and your words — from the library's search box.
- Export to **Markdown**, **Obsidian** (one note per book, with front matter and tags), a web page, or copy with formatting straight into **Google Docs, Word, Notion** or an email.

**Library & sync**
- Covers, pin, rename, filter, sort, progress, continue reading, tabs for several books, side-by-side comparison.
- Works with no account. Sign in with Google to sync through Firebase; connect **Google Drive** and books you add on one device open on all the others — Drive can also carry your notes, words and progress on its own. Offline-first, installable, full JSON backup and restore.

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
│   ├── firebase-config.js     ← the only file you edit (Firebase keys, Google Drive client ID)
│   ├── main.js                Boot, navigation, drag & drop
│   ├── core/                  util (DOM helpers), feel (themes, sounds, speech), pwa (install, share)
│   ├── data/                  db (IndexedDB), store (records + outbox), library, importers (EPUB, articles,
│   │                          Markdown), dictionary, fulltext (search inside books), exporters, backup
│   ├── sync/                  sync (two-way engine), firebase (Firestore adapter), drive (Google Drive)
│   ├── reader/                reader (view), tab (one book), pdf (PDF.js), bookmodel (PDF → clean text),
│   │                          textmodel (EPUB/articles), bookview (Book view), player (Listen),
│   │                          dialogue (character voices), autoscroll, recap, hardwords (Words here),
│   │                          textindex (text ↔ DOM), lookup, annotate, compare
│   ├── core/voice.js          natural (Kokoro, on-device) and device voices; tts-worker.js runs the model
│   ├── core/reminders.js      daily review count, nudges, notifications, calendar reminder
│   └── ui/                    library, add (files/links/paste), words, practice, notes, export, quote cards,
│                              settings, definition card, overlays, icons, router
├── vendor/pdfjs/              PDF.js 6.2 (Apache-2.0), fonts, CMaps, WASM decoders
├── icons/                     App icons
├── firebase/                  firestore.rules, storage.rules, indexes
├── firebase.json              Rules + optional Firebase Hosting config
├── .github/workflows/
│   ├── deploy-pages.yml       Publishes to GitHub Pages on every push to main
│   └── firebase-rules.yml     Optional: publishes security rules
├── docs/                      SETUP.md, FEATURE_SPEC.md
├── scripts/serve.mjs          Local dev server (no dependencies)
└── tests/                     End-to-end test (laptop + phone + tablet + sync + Drive + offline), sample books
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

The test (109 checks) drives a laptop, a phone (Pixel 7) and a tablet in Chromium with stand-ins for Firebase, Google Drive, the dictionaries, the article reader and the voice model: Page and Book view, typography, page turns and page curl, scroll layout, ruler, auto-scroll, footnotes, EPUB and web articles, dictionary fallbacks, “Words here”, highlights across both views, listening with character voices and word-by-word follow-along, chapter audio export, search inside books, tags and the commonplace book, exports (Markdown/Obsidian/Anki/quote cards), practice modes, sync through Firebase and through Drive, and reopening offline. Screenshots land in `tests/output/`. `tests/fixtures/make_v3_fixtures.py` rebuilds the sample EPUB and footnoted PDF.

## Credits

PDF rendering by [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0). Natural voices by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via [kokoro-js](https://www.npmjs.com/package/kokoro-js) (Apache-2.0), downloaded on first use. Definitions from the [Free Dictionary API](https://dictionaryapi.dev/), [Wiktionary](https://en.wiktionary.org/), [Wikipedia](https://en.wikipedia.org/) and [Datamuse](https://www.datamuse.com/api/) (WordNet). Word frequencies for “Words here” from [Datamuse](https://www.datamuse.com/api/). Web articles fetched with [Jina Reader](https://jina.ai/reader/) (free, no key). Fonts: Newsreader, Literata, Atkinson Hyperlegible, Lexend (Google Fonts, OFL) and [OpenDyslexic](https://opendyslexic.org/) (OFL, via cdnjs).
