// Quote cards: turn a passage into a beautiful image to share or keep —
// typeset on paper, night or colour, in portrait, square or story size.
import { el, setKids, downloadBlob, hashHue } from "../core/util.js";
import { dialog, toast } from "./overlay.js";
import { icon } from "./icons.js";

const SIZES = { portrait: [1080, 1350, "Portrait"], square: [1080, 1080, "Square"], story: [1080, 1920, "Story"] };
const STYLES = {
  paper: { name: "Paper", bg: ["#F7F1E3", "#EFE6D2"], ink: "#2A241D", soft: "#7A6B57" },
  night: { name: "Night", bg: ["#171A21", "#0E1015"], ink: "#ECE7DD", soft: "#9AA1AD" },
  colour: { name: "Colour", bg: null, ink: "#FFFFFF", soft: "rgba(255,255,255,.78)" },
};

function wrap(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

export async function drawQuoteCard(canvas, { text, title, author, page }, { style = "paper", size = "portrait" } = {}) {
  const [W, H] = SIZES[size];
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const st = STYLES[style];
  const hue = hashHue(title || "Luma");
  const g = ctx.createLinearGradient(0, 0, W, H);
  if (st.bg) { g.addColorStop(0, st.bg[0]); g.addColorStop(1, st.bg[1]); }
  else { g.addColorStop(0, `hsl(${hue} 52% 42%)`); g.addColorStop(1, `hsl(${(hue + 40) % 360} 58% 24%)`); }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // paper grain
  if (style === "paper") {
    ctx.globalAlpha = 0.05;
    for (let i = 0; i < 2600; i++) { ctx.fillStyle = Math.random() > 0.5 ? "#000" : "#fff"; ctx.fillRect(Math.random() * W, Math.random() * H, 1.4, 1.4); }
    ctx.globalAlpha = 1;
  }
  const serif = '"Literata", "Newsreader", Georgia, serif';
  try { await Promise.all([document.fonts.load(`400 60px Literata`), document.fonts.load(`italic 400 40px Literata`), document.fonts.load(`600 30px "Atkinson Hyperlegible"`)]); } catch {}
  const pad = 110;
  const maxW = W - pad * 2;
  const clean = text.replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim();
  // largest size that fits the space
  let fs = 74, lines, lh;
  const room = H - pad * 2 - 260;
  for (; fs >= 30; fs -= 2) {
    ctx.font = `400 ${fs}px ${serif}`;
    lines = wrap(ctx, clean, maxW);
    lh = fs * 1.42;
    if (lines.length * lh <= room) break;
  }
  if (lines.length * lh > room) {
    const keep = Math.max(1, Math.floor(room / lh));
    lines = lines.slice(0, keep);
    lines[keep - 1] = lines[keep - 1].replace(/\s*\S*$/, "") + "…";
  }
  const blockH = lines.length * lh;
  let y = (H - blockH) / 2 - 40;
  // big opening mark
  ctx.fillStyle = style === "colour" ? "rgba(255,255,255,.28)" : `hsl(${hue} 55% 45% / .35)`;
  ctx.font = `400 220px ${serif}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("“", pad - 18, y + 70);
  ctx.fillStyle = st.ink;
  ctx.font = `400 ${fs}px ${serif}`;
  ctx.textBaseline = "top";
  for (const l of lines) { ctx.fillText(l, pad, y); y += lh; }
  // attribution
  y += 46;
  ctx.fillStyle = style === "colour" ? "rgba(255,255,255,.7)" : `hsl(${hue} 55% 42%)`;
  ctx.fillRect(pad, y, 64, 4);
  y += 30;
  ctx.fillStyle = st.ink;
  ctx.font = `italic 400 ${Math.max(30, Math.round(fs * 0.55))}px ${serif}`;
  const att = wrap(ctx, title || "", maxW).slice(0, 2);
  for (const l of att) { ctx.fillText(l, pad, y); y += Math.round(fs * 0.55 * 1.35); }
  ctx.fillStyle = st.soft;
  ctx.font = `600 28px "Atkinson Hyperlegible", system-ui, sans-serif`;
  const meta = [author, page ? `page ${page}` : ""].filter(Boolean).join(" · ");
  if (meta) ctx.fillText(meta, pad, y + 6);
  ctx.textAlign = "right";
  ctx.font = `600 24px "Atkinson Hyperlegible", system-ui, sans-serif`;
  ctx.globalAlpha = 0.6;
  ctx.fillText("Luma Reader", W - pad + 20, H - 80);
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

export function quoteCardDialog(quote) {
  let style = localStorage.getItem("luma.cardStyle") || "paper";
  let size = localStorage.getItem("luma.cardSize") || "portrait";
  const canvas = el("canvas.qc-canvas", { "aria-label": "Quote card preview" });
  const redraw = () => drawQuoteCard(canvas, quote, { style, size });
  const blob = () => new Promise((r) => canvas.toBlob(r, "image/png"));
  const fileName = () => `${(quote.title || "quote").slice(0, 40).replace(/[\\/:*?"<>|]+/g, "-")} – quote.png`;
  return dialog({
    title: "Quote card",
    className: "qc-dialog",
    body: (c) => {
      const seg = (opts, cur, set) => el("div.seg", { role: "group" }, Object.entries(opts).map(([k, v]) =>
        el("button" + (k === cur() ? ".on" : ""), { onclick: (e) => { set(k); [...e.currentTarget.parentElement.children].forEach((b) => b.classList.toggle("on", b === e.currentTarget)); redraw(); } }, v.name || v[2])));
      c.append(
        el("div.qc-preview", {}, canvas),
        el("div.qc-controls", {},
          seg(STYLES, () => style, (k) => { style = k; localStorage.setItem("luma.cardStyle", k); }),
          seg(SIZES, () => size, (k) => { size = k; localStorage.setItem("luma.cardSize", k); })),
        el("div.row.wrap.qc-actions", {},
          el("button.btn.primary", { onclick: async () => downloadBlob(await blob(), fileName()) }, icon("download", 17), "Save image"),
          navigator.clipboard?.write && window.ClipboardItem ? el("button.btn", { onclick: async () => {
            try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob() })]); toast("Image copied"); } catch { toast("Couldn't copy the image here — save it instead."); }
          } }, icon("copy", 17), "Copy") : null,
          navigator.canShare ? el("button.btn", { onclick: async () => {
            const file = new File([await blob()], fileName(), { type: "image/png" });
            if (navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: quote.title }).catch(() => {});
            else downloadBlob(file, file.name);
          } }, icon("upload", 17), "Share") : null));
      redraw();
    },
  });
}
