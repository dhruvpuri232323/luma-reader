"""Builds the v3 test fixtures: story.epub (dialogue, chapters) and footnotes.pdf.
Run: python3 tests/fixtures/make_v3_fixtures.py"""
import zipfile, os
from reportlab.lib.pagesizes import A5
from reportlab.pdfgen import canvas

here = os.path.dirname(os.path.abspath(__file__))

# ── EPUB ──
ch1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>The Visit</title></head><body>
<h1>Chapter One: The Visit</h1>
<p>The rain had not stopped for three days when Mary finally opened the door to the old cottage by the river.</p>
<p>“Come in,” said Mary. “The kettle is on.”</p>
<p>“Thank you,” Tom replied, shaking the water from his coat. “I thought you had forgotten me entirely.”</p>
<p>“Forgotten you?” She laughed and took his hat. “Never.”</p>
<p>“Then why didn’t you write?”</p>
<p>“Because every letter came back unopened,” she said quietly.</p>
<p>He sat down by the fire. The obsequious clock on the mantel ticked on, and outside the river kept its own counsel through the long grey afternoon.</p>
</body></html>"""
ch2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Morning</title></head><body>
<h1>Chapter Two: Morning</h1>
<p>By morning the storm had blown itself out. Mary walked to the village, where the baker, a perspicacious woman with flour to her elbows, asked after the visitor.</p>
<p>“He’s an old friend,” Mary said. “Nothing more.”</p>
<p>The baker smiled the knowing smile of someone who had heard that sentence many times before, and wrapped two loaves in brown paper.</p>
</body></html>"""
nav = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>
<nav epub:type="toc"><ol><li><a href="ch1.xhtml">The Visit</a></li><li><a href="ch2.xhtml">Morning</a></li></ol></nav></body></html>"""
opf = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">luma-test-story</dc:identifier><dc:title>The River Cottage</dc:title><dc:creator>Ada Lindqvist</dc:creator><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>"""
container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""
with zipfile.ZipFile(os.path.join(here, "story.epub"), "w") as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/nav.xhtml", nav, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/ch1.xhtml", ch1, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/ch2.xhtml", ch2, compress_type=zipfile.ZIP_DEFLATED)

# ── PDF with footnotes ──
W, H = A5
c = canvas.Canvas(os.path.join(here, "footnotes.pdf"), pagesize=A5)
c.setTitle("Notes on Lamps")
def page(lines, notes, heading=None):
    y = H - 70
    if heading:
        c.setFont("Times-Bold", 18); c.drawString(50, y, heading); y -= 36
    for parts in lines:
        x = 50
        for kind, text in parts:
            if kind == "t":
                c.setFont("Times-Roman", 11); c.drawString(x, y, text); x += c.stringWidth(text, "Times-Roman", 11)
            else:
                c.setFont("Times-Roman", 7); c.drawString(x + 0.5, y + 4, text); x += c.stringWidth(text, "Times-Roman", 7) + 1
        y -= 15
    y = 80
    c.setLineWidth(0.5); c.line(50, y + 14, 140, y + 14)
    for n in notes:
        c.setFont("Times-Roman", 8); c.drawString(50, y, n); y -= 11
    c.setFont("Times-Roman", 9); c.drawCentredString(W / 2, 30, str(c.getPageNumber()))
    c.showPage()
page([
    [("t", "Gas lamps arrived in London in 1807, when Pall Mall was lit")],
    [("t", "for the King's birthday."), ("s", "1"), ("t", " Within twenty years most")],
    [("t", "streets of the city had them, and the lamplighter became a")],
    [("t", "familiar figure at dusk."), ("s", "2"), ("t", " Each carried a long pole with")],
    [("t", "a hook for the valve and a small flame at its tip.")],
    [("t", "")],
    [("t", "The work was steady but poorly paid, and many lamplighters")],
    [("t", "took second jobs in the daytime to make ends meet.")],
], ["1 Contemporary accounts call the display astonishing.", "2 Some cities kept them until the 1970s."], heading="Notes on Lamps")
page([
    [("t", "Electric light changed everything. By 1900 the arc lamp was")],
    [("t", "common in city centres, and the old gas mantles slowly went")],
    [("t", "dark one street at a time."), ("s", "3"), ("t", " A few were kept for their charm.")],
], ["3 A handful still burn in Westminster today."])
c.save()
print("ok")
