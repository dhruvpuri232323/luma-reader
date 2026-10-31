// The "Export notes" menu, shared by the reader and the Notes view.
import { menu, toast } from "./overlay.js";
import { collect, downloadMarkdown, downloadObsidian, downloadHtml, copyRich, toMarkdown } from "../data/exporters.js";

export function exportNotesMenu(anchor, { docIds, annotations, title = "Luma Reader notes" } = {}) {
  const groups = () => collect({ docIds, annotations });
  const guard = (fn) => async () => {
    const g = groups();
    if (!g.length || !g.some((x) => x.anns.length || x.bms.length)) { toast("No notes to export yet."); return; }
    try { await fn(g); } catch (e) { console.warn("Export:", e); toast("That didn't work here — try downloading instead.", { tone: "warn" }); }
  };
  menu(anchor, [
    { heading: "Download" },
    { label: "Markdown (.md)", icon: "file", onClick: guard((g) => downloadMarkdown(g, title)) },
    { label: "Obsidian — a note per book", icon: "file", onClick: guard((g) => downloadObsidian(g)) },
    { label: "Web page (.html)", icon: "globe", onClick: guard((g) => downloadHtml(g, title)) },
    "-",
    { heading: "Copy, then paste" },
    { label: "Into Google Docs, Word or email", icon: "copy", onClick: guard(async (g) => { await copyRich(g, title); toast("Copied with formatting — paste it into your document"); }) },
    { label: "Into Notion (Markdown)", icon: "copy", onClick: guard(async (g) => { await navigator.clipboard.writeText(toMarkdown(g)); toast("Copied — paste into a Notion page"); }) },
  ]);
}
