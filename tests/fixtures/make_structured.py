"""A 30-page PDF with a nested outline (book title > parts > chapters > sections),
one entry with no destination and one named destination — for the chapter navigator."""
from reportlab.lib.pagesizes import A5
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
import io

buf = io.BytesIO()
c = canvas.Canvas(buf, pagesize=A5)
W, H = A5
chapters = {1: "Part One: Beginnings", 2: "Chapter 1: The Harbour", 6: "Chapter 2: Salt", 11: "Part Two: Crossings",
            12: "Chapter 3: The Ferry", 17: "Chapter 4: Fog", 22: "Part Three: Arrivals", 23: "Chapter 5: Lanterns", 28: "Chapter 6: Home"}
for p in range(1, 31):
    if p in chapters:
        c.setFont("Times-Bold", 20)
        c.drawCentredString(W / 2, H - 80, chapters[p])
    c.setFont("Times-Roman", 10.5)
    y = H - (130 if p in chapters else 70)
    while y > 60:
        c.drawString(50, y, f"Page {p}. The ferry left the harbour at dawn and the gulls followed it out past the light.")
        y -= 14
    c.drawCentredString(W / 2, 30, str(p))
    c.showPage()
c.save()
buf.seek(0)
r = PdfReader(buf)
w = PdfWriter()
for pg in r.pages:
    w.add_page(pg)
top = w.add_outline_item("The Long Crossing", 0)
for part, chs in [((0, "Part One: Beginnings"), [(1, "Chapter 1: The Harbour", [(2, "The quay"), (4, "Nets")]), (5, "Chapter 2: Salt", [])]),
                  ((10, "Part Two: Crossings"), [(11, "Chapter 3: The Ferry", [(13, "Below deck")]), (16, "Chapter 4: Fog", [])]),
                  ((21, "Part Three: Arrivals"), [(22, "Chapter 5: Lanterns", []), (27, "Chapter 6: Home", [])])]:
    pi = w.add_outline_item(part[1], part[0], parent=top)
    for ci, title, secs in chs:
        ch = w.add_outline_item(title, ci, parent=pi)
        for si, st in secs:
            w.add_outline_item(st, si, parent=ch)
w.add_outline_item("Acknowledgements (no page)", None, parent=top)
w.add_metadata({"/Title": "The Long Crossing"})
with open("structured.pdf", "wb") as f:
    w.write(f)
print("ok")
