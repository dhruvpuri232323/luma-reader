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

# ── A book built like a real published EPUB: SVG cover, front matter, chapter
#    number + title on two lines, small caps, scene breaks, endnotes, footnotes ──
import base64
png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
X = lambda body, title="": f'<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{title}</title></head><body>{body}</body></html>'
cover = X('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 900"><image width="600" height="900" xlink:href="cover.png"/></svg>', "Cover")
titlep = X('<h1 class="title">The Glass Partnership</h1><p class="author">Ines Varga</p>', "Title")
copy = X('<p>Copyright © 2021 by Ines Varga. All rights reserved.</p><p>ISBN 978-0-00-000000-0</p>', "Copyright")
c1 = X('''<h1 class="ch-num" id="c1">1</h1><h1 class="ch-title">A Purposeful Life</h1>
<p class="first"><span class="sc">THE OFFICE WAS</span> quiet when Lena arrived. She had rehearsed the pitch on the train, twice, and each time the numbers came out the same.<sup><a epub:type="noteref" id="r1" href="notes.xhtml#n1">1</a></sup></p>
<p>Marcus looked up from his desk. “You’re early,” he said.</p>
<p>“I’m always early,” Lena replied. “It’s the only advantage I can count on.”</p>
<p>He laughed, and for a moment the tension left the room. Whatever it was, he was in her thrall.</p>
<p class="space-break">—</p>
<p><span class="sc">AFTER ALL THE DELAYS</span>, the partnership seemed to finally be getting off the ground in the early months of the year: as a beta run before a full launch, the companies had agreed on a single city.<a href="#fn2" epub:type="noteref">*</a></p>
<aside epub:type="footnote" id="fn2"><p>* The city was never named in public.</p></aside>
<p>* * *</p>
<p>The trial began on a Monday. By Friday, nobody could remember why it had seemed so difficult.</p>
<hr class="transition"/>
<blockquote><p>“Move fast,” the memo said, “but never faster than the truth.”</p></blockquote>
<p>Lena kept the memo pinned above her desk for years.</p>''', "Chapter 1")
c2 = X('''<h2>Chapter 2</h2><h2>The Demo</h2>
<p>The demonstration was set for nine o’clock. By eight, the room was full.<sup><a href="notes.xhtml#n2">2</a></sup></p>
<p>“Are we ready?” Marcus asked.</p>
<p>“We are,” she said.</p>''', "Chapter 2")
notes = X('''<h1>Notes</h1><ol>
<li id="n1"><p><a href="ch1.xhtml#r1">1.</a> Interview with the author, March 2016.</p></li>
<li id="n2"><p><a href="ch2.xhtml">2.</a> Company records, quoted with permission.</p></li></ol>''', "Notes")
nav2 = X('<nav epub:type="toc"><ol><li><a href="ch1.xhtml">1. A Purposeful Life</a></li><li><a href="ch2.xhtml">2. The Demo</a></li><li><a href="notes.xhtml">Notes</a></li></ol></nav>', "Contents")
opf2 = '''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">luma-test-real</dc:identifier><dc:title>The Glass Partnership</dc:title><dc:creator>Ines Varga</dc:creator><dc:language>en</dc:language><meta name="cover" content="img"/></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="img" href="cover.png" media-type="image/png" properties="cover-image"/>
<item id="cv" href="cover.xhtml" media-type="application/xhtml+xml" properties="svg"/><item id="tp" href="title.xhtml" media-type="application/xhtml+xml"/><item id="cp" href="copy.xhtml" media-type="application/xhtml+xml"/>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="nt" href="notes.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="cv"/><itemref idref="tp"/><itemref idref="cp"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="nt"/></spine></package>'''
with zipfile.ZipFile(os.path.join(here, "realbook.epub"), "w") as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
    for name, data in [("content.opf", opf2), ("nav.xhtml", nav2), ("cover.xhtml", cover), ("title.xhtml", titlep), ("copy.xhtml", copy), ("ch1.xhtml", c1), ("ch2.xhtml", c2), ("notes.xhtml", notes)]:
        z.writestr("OEBPS/" + name, data, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/cover.png", png)
print("realbook ok")
