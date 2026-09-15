"""Build labeled review sheets from extracted or rendered frames."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

folder, pattern, output = sys.argv[1:4]
files = sorted(Path(folder).glob(pattern), key=lambda p: int(p.stem.split('-')[-1]))
width, height, columns = 480, 294, 4
sheet = Image.new('RGB', (columns * width, ((len(files)+columns-1)//columns)*height), '#dddddd')
draw = ImageDraw.Draw(sheet)
for i, path in enumerate(files):
    frame = Image.open(path).convert('RGB')
    frame.thumbnail((480, 270))
    x, y = (i % columns)*width, (i//columns)*height
    sheet.paste(frame, (x, y))
    draw.text((x+10, y+274), path.stem, fill='#111111')
sheet.save(output)
