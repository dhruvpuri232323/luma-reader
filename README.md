# Luma Reader

A calm reader for PDFs, EPUB books and web articles, on laptop and phone. It sets any of them as a real book in your typeface, reads it aloud like an audiobook (with a different voice for each character), defines any word you rest on, finds the hard words before you meet them, and keeps your place, notes and words in step across your devices. Free to use, no ads, no paid services.

- **Code & hosting:** GitHub repository, published to GitHub Pages by GitHub Actions
- **Sync (pick one or both, both free):** Firebase (Google sign-in + Firestore) for progress, notes and words — and/or your own **Google Drive** for the book files themselves (and, if you like, everything else)
- **No build step:** plain HTML, CSS and JavaScript modules. PDF.js is vendored in `vendor/`

**→ Setup guide: [docs/SETUP.md](docs/SETUP.md)** (≈15 minutes, no installs)

## What it does

**Bring anything to read**
- **PDF**, **EPUB**, plain text, Markdown and saved web pages (.html) — drop them on the window, pick them, “Open with” on desktop, or share them to the app on Android. EPUB endnotes and footnotes become tap-to-read pop-ups, split chapter titles (“1” + “A Purposeful Life”) are joined, and scene breaks (“* * *”, “—”, ornaments) are shown as a quiet ⁂. Locked (DRM) and Kindle files get a plain explanation instead of a blank page.
- **Web articles from a link**: Luma keeps just the text and pictures — no ads, no pop-ups — and sets it as a book. A **“Save to Luma” button** for your bookmarks bar sends any page you're on (even ones you're signed in to); on a phone, share a link to the app.
- **Paste text** to read, hear or study it.

**Read it your way**
- **Page view** — the original PDF, exactly as published: zoom, rotate, search, table of contents.
- **Book view** — any book set as a real book: running headers and page numbers stripped from PDFs, paragraphs rejoined, chapters detected, **footnotes lifted out into tap-to-read pop-ups**. Your typeface (Literata, EB Garamond, Newsreader, Libre Baskerville, Source Serif, IM Fell English, Atkinson Hyperlegible, Lexend, **OpenDyslexic** or your device's) — or each edition's own — and size, weight, letter and word spacing, line spacing, margins, justification and hyphenation. Two-page spreads on laptops, one page on phones; or **one continuous scroll**.
- **Chapters, on the side** — press C (or the contents button) for every part, chapter and section of the book, with where you are highlighted, what you've read dimmed, Previous/Next, a search box for long contents and a "Back to page …" after a jump. It works for any book: the book's own contents (nested outlines are opened up, broken entries dropped), else chapter headings found in the text, else sections of pages named by their first words. In Book view it opens on the chapter heading itself. ] and [ jump to the next or previous chapter.
- **Pinch to zoom the text** — pinch on a trackpad (Chrome, Edge, Safari) or with two fingers on a phone and the words grow or shrink right where you are, staying on the same line; in Page view it zooms the PDF around your fingers.
- **A page you can take by the corner** — hover near a page corner and it lifts; drag it with the mouse, your finger or a two-finger trackpad swipe and the page folds over and follows you, with the next page printed on its back, a crease and highlight along the curve and soft shadows beneath. Let go past halfway (or flick it) and it turns; let go early and it lies back down. Keys, clicks and the voice use the same page curl, in Book view and in Page view's one- and two-page layouts. Stiff, medium or soft paper.
- **Every edition set like the real thing** — *Modern* (clean sans headings, an accent rule), *Paperback* (Garamond, small-caps running heads with outer page numbers, italic chapter titles under spelled-out numbers, a drop cap and small-caps first line), *Hardcover* (Baskerville, generous margins, roman chapter numerals and a swelled rule, page numbers between dashes), *Pocket book* (compact, ruled running heads), *Antique* (IM Fell type, a vine headpiece, “Chapter I.”, red rubricated initials, ❧ ornaments, bracketed folios and **catchwords**, gently aged paper and a gilt-tooled leather binding), *Magazine* (Playfair headlines, **two columns on each page**, kickers, pull quotes) and *E-reader* (a calm grey screen with a progress line).
- **Book feel — every book its own kind of book**: its paper, texture, light, cover, desk, page turn and page-turn sound come with the edition. Then make it your own: page design, columns, running heads, page numbers (book-style, reading stats or none), drop caps, section ornaments, the desk it lies on (walnut, oak, linen, green felt, slate), cover (card, cloth, leather, device), page turn (page curl, hard flip, slide, fade, e-ink, instant), its speed and paper stiffness, the sound and its volume, paper colour, texture, light and its strength, page edges that thicken as you read. Saved with the book, so it feels the same on every device. Page-turn sounds are made on the device — nothing to download.
- **Reading themes** — Light, Sepia, Calm, Sage, Quiet, Dark, Midnight, Espresso and True black (plus Auto and a warm night light). **Calm reading**: while you read, the controls fade away and the desk runs under the whole screen; move towards them and they come back. A **progress bar you can scrub**, with chapter marks and a preview of where you'd land.
- **Page view a page at a time**: any PDF can show its original pages one at a time or **two side by side like an open book**, turning with the book's own animation and sound (arrow keys, swipe, tap the edges, the wheel or trackpad).
- **Reading ruler** (R) that keeps your eye on the line, **warm light** in the evening, focus mode, light/sepia/dark.
- **Auto-scroll** (A): the page glides — or turns — at your own reading speed, like a teleprompter.
- **“Where was I?”** — come back after a while and a card shows the chapter, the last lines you read and your latest note, with one tap to hear the last paragraph again.
- Minutes left in the chapter, learned from how fast *you* read.

**Listen like an audiobook**
- Press the headphones (or L), or **Listen** on a book in the library: read aloud sentence by sentence with natural pauses; **the sentence and the very word being spoken light up, and the page turns or scrolls by itself to follow the voice**. Scroll away and it waits, with a **Back to the voice** button.
- **Character voices**: Luma works out who is speaking each line of dialogue (“said Mary”, “she asked”, who is acting in the paragraph, the back-and-forth of a conversation) and gives each character their own voice — women and men in fitting voices — while the narrator keeps yours. Change any of them under *Who's who*.
- **No pauses between sentences**: the natural voice is made well ahead on several processor cores at once and each sentence is lined up on the audio clock to start the moment the last one ends — only the pause a narrator would leave. It loads quietly while you read, so Listen starts at once.
- **Natural voices** run on your device (Kokoro, ~90 MB once, then offline). **Fast mode** runs them on your graphics chip (WebGPU) — several times quicker on most laptops (on Snapdragon / Adreno laptops, Settings → Listening shows the one browser switch that turns it on). Until the voice is ready, the best voice your device has.
- Reads straight through scene breaks, dashes and image-only pages without stopping; skips citations like (Smith, 2004) and [12], figure captions, footnote markers and copyright-page small print (ISBNs); reads SMALL CAPS openings as ordinary words; **your own pronunciations** for names it gets wrong.
- **Save the sentence you're hearing** to your notes with one tap, then add a thought. Space pauses, Shift + ← / → move a sentence back or forward.
- **Save as an audiobook**: this chapter, or the whole book as one file per chapter (straight into a folder on Chrome/Edge) — made in parallel while you keep reading.
- Speed, sleep timer, headset and lock-screen controls; keeps playing with the screen off on phones.

**Know how you read**
- **The logo is a light switch**: tap it and choose Light, Sepia, Dark, **Night light** (dark with a warm amber glow), Auto (follows your device, night light after 8 pm) or any reading theme — the new light spreads out from the logo. Shift-tap steps to the next one. On phones the switch is on the Library page.
- **Reading time, measured for you**: Luma counts only real reading — a book open, the window in front, you turning pages or the voice reading — and stops when you step away (the wait adapts to how long a page takes you). Reading and listening are kept apart.
- **A reading timer** (⏱ at the bottom of the reader): today's minutes against your daily goal; start a 10–60 minute session, one to the end of the chapter, or an open one; a live clock, pages and pace, a soft chime at the goal, and a summary at the end.
- **Insights** (its own tab): totals, streak and goal days; minutes a day; a calendar of the days you read; when you read and when you're fastest; your pace in words a minute against the typical adult (≈238 non-fiction, ≈260 fiction — Brysbaert 2019) and week by week; your stamina (does your pace drop after 45 minutes?); **where you get stuck** — the pages that took you far longer than your own pace, and why (unusual words, long sentences, numbers, re-reading, look-ups, late nights, long sessions), with one tap to open, preview the words or have it read aloud; each book's time, pace and time left; books waiting for you; words, notes and listening. A few plain-language observations sit at the top.
- Sessions are kept with your account and sync between devices with no extra setup. Turn measuring off in Settings → Reading.

**Translation — English ⇄ one other language (Hindi by default), both ways**
- **A passage**: select a word, a sentence or a whole paragraph and choose *Translate* (or press T). The original sits above the translation; hear either in its own language's voice; copy it; **correct** it and Luma uses your version from then on. Tap a word in Hindi (or any other script) for its English, with the Hindi → English dictionary from Wiktionary.
- **A whole book** — PDF, EPUB, web article, pasted text or scanned book, all alike: the translate button in the reader's top bar translates every paragraph, whole (paragraphs split by a page break are joined first, so no sentence is cut in half), behind one progress screen. Then read the **original**, **both** (each paragraph with its translation under it) or the **translation** alone — Listen reads the translation in a voice for its language. An English book is translated into your language; a book in your language (or any other) into English.
- **How it translates, like a translator would**: paragraph by paragraph so tense and meaning carry across; long paragraphs split only at sentence ends; numbers checked against the original (and redone sentence by sentence if one went missing); every passage remembered, so repeats are instant and identical and your corrections stick.
- **Where**: on computers, Chrome and Edge translate on the device — private, free, offline once the language is downloaded. Phones have no built-in translator yet: a book translated on the computer syncs and reads on the phone, and passages are translated online with a free daily allowance (Settings → Translation, where you also choose the language).
- **Hindi documents**: Devanagari type in Book view; scanned Hindi pages are read with the Hindi model (picked by itself); Hindi PDFs typed in old non-Unicode fonts (Kruti Dev, DevLys), whose text comes out as gibberish, are read from their page images instead.

**Scanned books**
- A PDF that is only pictures of pages (a scanned book) is **read on your device** the first time you open it: every page at once, several side by side, with one progress screen — then the whole book opens in Book view as real text. Look up words, select phrases, listen, highlight and search inside it like any other book; in Page view an invisible layer of the words sits exactly over the scan. Each book is read once and kept on the device. Uses Tesseract 5 (WebAssembly) and its fast English model, bundled with the app (≈5 MB, downloaded once). Turn it off in Settings → Reading → *Read scanned books*.

**Understand every word**
- Hover (laptop) or tap (phone) any word: meanings, pronunciation, examples. If the dictionary doesn't know it: Wiktionary, WordNet, then Wikipedia for names and places; then “did you mean”, **Search Google**, or **add it with your own meaning**.
- **Look it up — without leaving the app**: select words and choose *Look up* (or press K). Wikipedia articles open right inside Luma, with pictures and folded sections; the dictionary meaning, and every place the words appear in your own books and notes, sit alongside. Save any article's subject to your words. Articles you've opened work offline. For anything else, *Search Google* is one tap away — in a slim window beside the app on laptops.
- **Several words at once**: select up to eight words and choose *Define*. *fastest human* = “the human that is faster than any other”, then each word on its own (*fastest* — the most fast; *fast* — moving quickly), and the sentence on Wikipedia that uses the phrase (“The fastest human footspeed on record is 44.72 km/h… by Usain Bolt”). Idioms are found in any tense (*kicked the bucket* → *kick the bucket*: to die), and names and topics (“Reserve Bank of India”) get their Wikipedia summary and key facts. Save any phrase to your words with its meaning.
- **Full forms**: hover, tap or select an abbreviation — *GDP*, *CEOs*, *U.S.*, *e.g.*, *Ph.D.*, *XIV*. Luma first looks for where **your book itself** spells it out (“Gross Domestic Product (GDP)”, with the page), then a built-in list of several hundred common ones (business, finance and consulting, India, government, science, tech, Latin abbreviations used in books — works offline), then Wiktionary and Wikipedia; tap a full form to see what it means.
- **More from Wikipedia**: articles open with their **key facts** (the infobox: born, population, founded…), a strip of **pictures** that open large with captions, and **related articles** — all inside the app, and kept for offline reading once opened. Names and places in the word card show their key facts too.
- **How a word is made, and where it comes from**: every word card shows the word's parts and what each part means — *fastest* = **fast** + **-est** (“the most”); *unbelievable* = **un-** (not) + **believe** + **-able** (can be); *transportation* = **trans-** (across) + **port** (carry) + **-ation**. If you don't know the base word either, its meaning is right there (“First, *fast*: moving quickly”), and you can tap it — or **any word in any meaning** — to look that up in the same card, with **Back** to retrace your steps. Below that, the road the word took into English (Latin → Old French → Middle English → English), and *The word's full story*: today's account from Wiktionary, the entries from **Skeat's *Concise Etymological Dictionary* (1901)** with what the word originally meant, and other words from the same root. Skeat's dictionary ships with the app, so word histories work offline.
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
│   ├── reader.css             Reader, dictionary card, highlights, reflow, page curl, mobile sheets
│   └── editions.css           How each edition is set: running heads, chapter openings, drop caps, covers, desks
├── js/
│   ├── firebase-config.js     ← the only file you edit (Firebase keys, Google Drive client ID)
│   ├── main.js                Boot, navigation, drag & drop
│   ├── core/                  util (DOM helpers), feel (themes, sounds, speech), pwa (install, share),
│   │                          bookfeel (editions, paper, light, desks, page sounds), typeset (each edition's typesetting)
│   ├── data/                  db (IndexedDB), store (records + outbox), library, importers (EPUB, articles,
│   │                          Markdown), dictionary, fulltext (search inside books), exporters, backup,
│   │                          morphology (word parts), etymology (Skeat + Wiktionary), wiki (Wikipedia),
│   │                          abbrev (full forms), phrases (several words), translate, activity, insights
│   ├── sync/                  sync (two-way engine), firebase (Firestore adapter), drive (Google Drive)
│   ├── reader/                reader (view), tab (one book), pdf (PDF.js), bookmodel (PDF → clean text),
│   │                          textmodel (EPUB/articles), bookview (Book view), player (Listen),
│   │                          dialogue (character voices), autoscroll, recap, hardwords (Words here),
│   │                          textindex (text ↔ DOM), lookup, annotate, compare, ocr + ocr-worker (scanned books), booktranslate,
│   │                          navigator (a book's chapters, whatever it's made of), pagecurl (the page taken by its corner), pageturn (flip, fade, e-ink and Page view turns)
│   ├── core/voice.js          natural (Kokoro, on-device) and device voices; tts-worker.js runs the model
│   ├── core/reminders.js      daily review count, nudges, notifications, calendar reminder
│   └── ui/                    library, add (files/links/paste), words, practice, notes, export, quote cards,
│                              settings, definition card, overlays, icons, router
├── vendor/pdfjs/              PDF.js 6.2 (Apache-2.0), fonts, CMaps, WASM decoders
├── vendor/skeat/              Skeat's Etymological Dictionary (1901), read from the scan: one file per letter
├── vendor/ocr/                Tesseract 5 (WebAssembly, Apache-2.0) and its fast English and Hindi models, for scanned books
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

The test (261 checks) drives a laptop, a phone (Pixel 7) and a tablet in Chromium with stand-ins for Firebase, Google Drive, the dictionaries, the article reader and the voice model: Page and Book view, typography, page turns, the page curl by mouse, finger and trackpad swipe, pinch-to-zoom, each edition's typesetting, themes, scroll layout, ruler, auto-scroll, footnotes, EPUB and web articles, dictionary fallbacks, “Words here”, highlights across both views, listening with character voices and word-by-word follow-along, chapter audio export, search inside books, tags and the commonplace book, exports (Markdown/Obsidian/Anki/quote cards), practice modes, word parts and word stories, phrases and full forms, Wikipedia key facts and pictures, scanned books read on the device (English and Hindi), translation of passages and whole books (with a stand-in for the built-in translator), sync through Firebase and through Drive, and reopening offline. Screenshots land in `tests/output/`. `tests/fixtures/make_v3_fixtures.py` rebuilds the sample EPUB and footnoted PDF; `make_structured.py` the PDF with a nested outline.

## Credits

PDF rendering by [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0). Natural voices by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via [kokoro-js](https://www.npmjs.com/package/kokoro-js) (Apache-2.0), downloaded on first use. Definitions from the [Free Dictionary API](https://dictionaryapi.dev/), [Wiktionary](https://en.wiktionary.org/), [Wikipedia](https://en.wikipedia.org/) and [Datamuse](https://www.datamuse.com/api/) (WordNet). Scanned books are read with [Tesseract](https://github.com/tesseract-ocr/tesseract) via [tesseract.js-core](https://github.com/naptha/tesseract.js-core) and the [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) English and Hindi models (Apache-2.0). Translation uses the browser's built-in [Translator API](https://developer.chrome.com/docs/ai/translator-api) where available, and the free [MyMemory](https://mymemory.translated.net/) service otherwise; Devanagari type is Noto Serif/Sans Devanagari (OFL, Google Fonts). Word histories from [Wiktionary](https://en.wiktionary.org/) (CC BY-SA) and Walter W. Skeat's *A Concise Etymological Dictionary of the English Language* (Clarendon Press, 1901; public domain), read from a scan with Tesseract — some foreign spellings in Skeat's full entries came through the scan imperfectly. Word frequencies for “Words here” from [Datamuse](https://www.datamuse.com/api/). Web articles fetched with [Jina Reader](https://jina.ai/reader/) (free, no key). Fonts: Newsreader, Literata, Atkinson Hyperlegible, Lexend (Google Fonts, OFL) and [OpenDyslexic](https://opendyslexic.org/) (OFL, via cdnjs).
