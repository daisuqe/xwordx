"""Noto Sans JP (可変フォント) から、盤面用の太字(700)・ひらがなのみの woff2 を作る。

使い方: python tools/build_font.py [NotoSansJP-VF.ttf のパス]
必要: pip install fonttools brotli
出力 : fonts/NotoSansJP-Bold-hira.woff2
ライセンス(OFL 1.1)は fonts/OFL.txt を参照。
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:\Windows\Fonts\NotoSansJP-VF.ttf")
DST = ROOT / "fonts" / "NotoSansJP-Bold-hira.woff2"

# ひらがな (ぁ-ゖ, 濁点等, ゝゞ) + 長音 ー + 全角スペース
UNICODES = list(range(0x3041, 0x3100)) + [0x30FC, 0x3000]


def main():
    font = TTFont(SRC)
    font = instancer.instantiateVariableFont(font, {"wght": 700})

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]  # 著作権・ライセンス表記を残す (OFL)
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)

    DST.parent.mkdir(exist_ok=True)
    font.flavor = "woff2"
    font.save(DST)
    print(f"{DST} {DST.stat().st_size} bytes")

    names = {n.nameID: n.toUnicode() for n in TTFont(SRC)["name"].names if n.platformID == 3}
    for i in (0, 13, 14):
        print(i, names.get(i))


if __name__ == "__main__":
    main()
