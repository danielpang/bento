"""Tiles stills into one contact sheet, for reviewing many frames at once.

    python3 sheet.py <stillsDir> <v|h> <out.png> 3 8.5 12 ...
"""
import os, sys
from PIL import Image

src, aspect, out, *times = sys.argv[1:]
ims = [Image.open(os.path.join(src, f"{aspect}-{t}.png")).convert("RGB") for t in times]
w, h = (432, 768) if aspect == "v" else (768, 432)
cols = 4 if aspect == "v" else 2
rows = (len(ims) + cols - 1) // cols
sheet = Image.new("RGB", (w * cols, h * rows), "#111")
for i, im in enumerate(ims):
    sheet.paste(im.resize((w, h), Image.LANCZOS), ((i % cols) * w, (i // cols) * h))
sheet.save(out)
