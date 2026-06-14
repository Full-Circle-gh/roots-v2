# -*- coding: utf-8 -*-
"""Render the flash-sale-wizard mock HTML files to trimmed PNGs via Chrome headless.
  _fdm_<slug>.html  -> flash_pc_<slug>.png   (desktop)
  _fpm_<slug>.html  -> flash_ph_<slug>.png   (phone)
Chrome gotchas (learned): needs a fresh --user-data-dir or it writes nothing;
--force-device-scale-factor=2 for crisp text; --virtual-time-budget so the Google
Fonts + Tabler webfonts finish loading before the shot. Margins trimmed with Pillow."""
import os, glob, subprocess, tempfile, sys
from PIL import Image, ImageChops

OUTDIR = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

def render(html_path, png_path, win):
    tmp = tempfile.mkdtemp(prefix="fchrome_")
    url = "file:///" + html_path.replace("\\", "/")
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--force-device-scale-factor=2", "--virtual-time-budget=6000",
        "--window-size=%d,%d" % win, "--user-data-dir=" + tmp,
        "--screenshot=" + png_path, url,
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
    if not os.path.exists(png_path):
        print("  !! no screenshot for", os.path.basename(html_path)); return False
    trim(png_path)
    return True

def trim(png_path, pad=14):
    im = Image.open(png_path).convert("RGB")
    bg = Image.new("RGB", im.size, (255, 255, 255))
    bbox = ImageChops.difference(im, bg).getbbox()
    if bbox:
        l, t, r, b = bbox
        l = max(0, l - pad); t = max(0, t - pad)
        r = min(im.width, r + pad); b = min(im.height, b + pad)
        im.crop((l, t, r, b)).save(png_path)

def run(prefix, out_prefix, win):
    n = 0
    for html in sorted(glob.glob(os.path.join(OUTDIR, prefix + "*.html"))):
        slug = os.path.basename(html)[len(prefix):-5]
        png = os.path.join(OUTDIR, "%s%s.png" % (out_prefix, slug))
        if render(html, png, win):
            print("  ok ", os.path.basename(png), Image.open(png).size)
            n += 1
    return n

if __name__ == "__main__":
    print("desktop:")
    d = run("_fdm_", "flash_pc_", (1120, 1800))
    print("phone:")
    p = run("_fpm_", "flash_ph_", (760, 1200))
    print("rendered %d desktop + %d phone PNGs" % (d, p))
    if d == 0 or p == 0:
        sys.exit(1)
