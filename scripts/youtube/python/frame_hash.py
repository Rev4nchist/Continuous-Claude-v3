#!/usr/bin/env python
"""Print a 64-bit difference hash for one image, with no side effects."""
import sys
from PIL import Image


image = Image.open(sys.argv[1]).convert("L").resize((9, 8))
pixels = list(image.getdata())
bits = []
for row in range(8):
    start = row * 9
    bits.extend("1" if pixels[start + col] > pixels[start + col + 1] else "0" for col in range(8))
print("".join(bits))
