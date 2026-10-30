# Luma Reader — full reader-focused feature blueprint

**Key:** ✅ included in current code · 🟡 partial/platform-limited · 🧭 worthwhile future improvement · — deliberately excluded to keep reading fast.

## 1. Instant comprehension (top priority)

| Feature | Why a reader needs it | Status |
|---|---|---|
| Hover a word for a popup definition | Understand without selecting/copying | ✅ |
| Single tap on mobile to define | Equivalent of Kindle's dictionary popup | ✅ |
| Adjustable hover delay | Prevent distracting false popups | ✅ |
| Turn hover lookups off | Give the reader full control | ✅ |
| Save a word with one click | No manual transcription | ✅ |
| View phonetic notation | Learn correct pronunciation | ✅ |
| Read word aloud | Hear the correct pronunciation | ✅ browser voice |
| Multiple meanings/parts of speech | Ambiguous words in context | ✅ API-dependent |
| Dictionary caching | See previously looked-up meanings offline | ✅ |
| Remember source PDF/page | Jump back to encountered context | ✅ |
| Remember nearby text | Study how the word was used | ✅ limited to local text run |
| Add your own definition | Personalize a difficult term | ✅ |
| Edit a word and personal memory trick | Deepen recall | ✅ |
| Search your saved vocabulary | Find an old word quickly | ✅ |
| Mastered / learning states | Separate known and unknown words | ✅ |
| Flip flashcards | Review without another learning app | ✅ |
| Export words to CSV | Keep a reusable vocabulary list | ✅ |
| In-app synonyms and antonyms | More insight than a bare definition | 🧭 |
| Example sentences from multiple sources | Learn subtle usage | 🧭 |
| Translate non-English text | Multilingual reading | 🧭 |
| Daily spaced-repetition schedule | Systematic memory reinforcement | 🧭 |
| Dictionary for scanned PDFs via OCR | Understand words in image-only books | 🧭 substantial complexity |

## 2. Documents, library, and progress

| Feature | Reader benefit | Status |
|---|---|---|
| Import one or several PDFs | Quick library creation | ✅ |
| Drag and drop PDFs | Fast laptop workflow | ✅ |
| Import from phone file picker | Simple mobile workflow | ✅ |
| Prevent duplicate PDFs | Avoid messy libraries | ✅ file SHA-256 |
| Attractive colored document cards | Recognize books easily | ✅ |
| Rename document title | Find books by meaningful names | ✅ |
| Search library titles | Locate a document instantly | ✅ |
| Reading progress by percent | Know how far you've come | ✅ furthest page reached |
| Continue from last page | Lose less reading time | ✅ |
| Currently reading / not started / completed | Instant visual status | ✅ |
| Sort recent books first | Keep ongoing reading prominent | ✅ |
| Delete books with confirmation | Keep library tidy | ✅ |
| Reset reading progress | Re-read from the beginning | ✅ |
| Download original PDF | Keep full file ownership | ✅ |
| Device-local PDF file storage | Read without cloud | ✅ |
| PDF cloud upload and download | See actual books on all devices | 🟡 optional Blaze Firebase Storage |
| Google sync of library metadata | Keep book list consistent | ✅ after setup |
| Shelves/folders/tags | Organize very large libraries | 🧭 |
| Favorites / pinned books | One-tap access to key texts | 🧭 |
| Manually mark as complete | For readers who jump around | 🧭 |
| Completion date and reading timeline | Reflect on what you've read | 🧭 |
| Automatic PDF metadata/cover extraction | More visual library identity | 🧭 |

## 3. Multitasking and navigation

| Feature | Reader benefit | Status |
|---|---|---|
| Multiple PDFs kept open as tabs | Switch without losing your place | ✅ |
| Restore last open tab session | Continue after reopening | ✅ same-browser session |
| Compare two PDFs side by side | Study different sources together | ✅ main + secondary image pane |
| Independent second-pane page controls | Compare relevant passages | ✅ |
| On-phone tab switching | Multidocument use on small screens | ✅ |
| Continuous scrolling | Read naturally | ✅ |
| Page number jump | Move directly to cited pages | ✅ |
| Keyboard next/previous page | Comfortable laptop reading | ✅ |
| Document-wide text search | Find specific terms | ✅ result list |
| Smooth PDF zoom | Comfortable larger content | ✅ |
| Fit-to-screen width behavior | Reduce sideways scrolling | ✅ baseline fit |
| Reader focus mode | Reduce visual clutter | ✅ |
| Read current page aloud | Hands-free reading | ✅ browser speech |
| Screen rotation / landscape support | Adapt to tablet use | ✅ responsive |
| Page rotation control | Handle sideways scans | 🧭 |
| Sidebar thumbnails | Jump visually between chapters | 🧭 |
| Linked PDF table of contents | Navigate structured books | 🧭 |
| Multiple-window independent reading | Use separate monitors | 🧭 |
| Full-text search result highlighting | Make matches visible on page | 🧭 |
| Reading history and back/forward | Jump back after searching | 🧭 |

## 4. Annotation and memory

| Feature | Reader benefit | Status |
|---|---|---|
| One-tap page bookmark | Save a useful position | ✅ |
| List of bookmarks by PDF | Jump straight to saved pages | ✅ |
| Remove bookmarks | Correct mistakes | ✅ |
| Select passage → toolbar | Annotation without extra menu | ✅ |
| Highlight selected text | Preserve important passages | ✅ original PDF layout |
| Four highlight colors | Separate themes/topics | ✅ |
| Write a note on selection | Keep thoughts beside the text | ✅ |
| Edit annotation note | Refine ideas later | ✅ |
| Notes and highlights panel | Review your own annotations | ✅ |
| Return to a highlighted page | Revisit source quickly | ✅ |
| Synchronize annotations to Firebase | Continue research on another device | ✅ after setup |
| Export annotations as Markdown | Use in your own notes system | 🧭 |
| Search across all highlights | Locate captured ideas | 🧭 |
| Ink pen / stylus drawings | Tablet-friendly handwritten annotation | 🧭 |
| Highlight sharing or collaboration | Work with others | — for individual reading focus |

## 5. Reading comfort, style, and motion

| Feature | Reader benefit | Status |
|---|---|---|
| Beautiful desktop/tablet/mobile interface | Pleasant long sessions | ✅ |
| Light and dark theme | Day/night readability | ✅ |
| Warm sepia theme | Book-like feeling | ✅ |
| Five accent palettes | Make the app personal | ✅ |
| Animated transitions | Smooth interactions | ✅ |
| Sound effects for save/bookmark | Small satisfying feedback | ✅ |
| Disable sounds instantly | Quiet reading environment | ✅ |
| Reduce motion | Comfort and accessibility | ✅ |
| Adjustable PDF zoom | Enlarge fixed-layout content | ✅ |
| Reflow text mode | Comfortably read extracted text | ✅ text-based PDFs only |
| Five reflow fonts | Choose typography you enjoy | ✅ |
| Reflow font size slider | Suit eyesight and preference | ✅ |
| Reflow line spacing | Make dense texts comfortable | ✅ |
| Narrow/balanced/wide column widths | Control reading line length | ✅ |
| Per-PDF font and theme settings | Different books, different needs | 🧭 |
| Reading ruler / focus line | Follow dense paragraphs | 🧭 |
| Page margin controls | Customize PDF display | 🧭 |
| Continuous paginated view toggle | Choose reading style | 🧭 |

## 6. Sync, ownership, installation

| Feature | Reader benefit | Status |
|---|---|---|
| Sign in using Google | One identity across devices | ✅ after Firebase setup |
| Work with no account | Keep reading private/local | ✅ |
| Firestore sync for progress/words/notes/bookmarks | Avoid duplicate work | ✅ after Firebase setup |
| Optional sync original PDF blobs | Read original files on phone/laptop | 🟡 requires Cloud Storage Blaze |
| Per-user Firestore/Storage rules | Keep private data isolated | ✅ supplied rules |
| Installable PWA | Launch like a normal app | ✅ when deployed over HTTPS |
| Desktop PDF 'Open with' registration | Open from File Explorer/Finder | 🟡 Chromium desktop; OS-dependent |
| Android Share target for a PDF | Start reading from another app | 🟡 depends on browser/Android support |
| Offline cached imported PDFs | Read on a plane/commute | ✅ after engine is cached |
| Offline cached definitions | Look up previously seen words | ✅ |
| Export full portable backup | Avoid vendor lock-in | ✅ |
| Restore backup | Move data manually | ✅ |
| Conflict-aware, multi-device merge | Avoid unintended overwrites | 🟡 last-write-wins timestamps |
| Strong multi-device sync with change logs | Resolve deletes/edits while offline | 🧭 |
| True encrypted cloud file storage | Additional privacy protection | 🧭 requires key design |

## 7. Features intentionally excluded now

- PDF form filling, digital signature workflows and document conversion: useful for document management, but not central to reading.
- AI chat with books or document summaries: complexity, cost, and privacy concerns; can be assessed later.
- Social feeds, reading streak pressure, points/leaderboards: distracting for this workflow.
- Subscription payments, ads, analytics trackers or remote user telemetry: no benefit to personal reading.

### What should come next?

**Recommended iteration 2:** OCR for scanned PDFs (with reliable selection), full-text search highlights, true PDF outline navigation, annotation export, per-book appearance settings, and a robust offline sync queue. These are useful reading improvements and take priority over flashy unrelated features.
