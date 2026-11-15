"""Draws the app icon: a white calendar page with a red header band and a grid of days, one of them marked."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

def icon(size):
    s = size * 4
    im = Image.new('RGB', (s, s), '#ffffff')
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, s, int(s * 0.27)], fill='#ff3b30')
    cols, rows = 4, 3
    x0, y0, x1, y1 = s * 0.2, s * 0.40, s * 0.8, s * 0.82
    r = s * 0.052
    for j in range(rows):
        for i in range(cols):
            cx = x0 + (x1 - x0) * i / (cols - 1)
            cy = y0 + (y1 - y0) * j / (rows - 1)
            hot = (i, j) == (2, 1)
            rr = r * 1.5 if hot else r
            d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill='#ff3b30' if hot else '#c7c7cc')
    return im.resize((size, size), Image.LANCZOS)

for n in (180, 512):
    icon(n).save(os.path.join(HERE, '..', 'icon-%d.png' % n))
    print('icon', n)
