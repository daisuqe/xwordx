"""JMdict の普通名詞から、読み(ひらがな)ごとの英語の意味を data/gloss/<先頭文字のコード>.json に書き出す。
ウィクショナリーに載っていない語の代わりに、ゲームがタップしたときに読み込んで出す (読み込みは先頭の文字ごとの小さなファイル)。
形式: { "読み(小さい字は大きい字にそろえる)": [ { "k": "漢字の表記", "g": "意味1; 意味2" }, ... ] }
使い方: python tools/make_gloss.py   (_work/JMdict_e.gz が必要。出典: JMdict (c) EDRDG, CC BY-SA 4.0)
"""
import gzip
import json
from pathlib import Path

from lxml import etree

root = Path(__file__).resolve().parent.parent
OUT = root / "data" / "gloss"
MAX_ENTRIES = 3  # 同じ読みの見出しは、多くてもこれだけ
MAX_GLOSS = 3  # 1 つの見出しにつき、意味の数
MAX_LEN = 90  # 意味の文字数

SMALL = "ぁぃぅぇぉっゃゅょゎ"
LARGE = "あいうえおつやゆよわ"
TO_CANON = {s: l for s, l in zip(SMALL, LARGE)}


def hira(text):
    return "".join(chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c for c in text)


def is_hira(text):
    return bool(text) and all("ぁ" <= c <= "ゖ" or c in "ーゝゞ" for c in text)


def canon(text):
    return "".join(TO_CANON.get(c, c) for c in text)


def local(e):
    return etree.QName(e).localname


words = {}  # canon(読み) -> [ {k, g} ]
with gzip.open(root / "_work" / "JMdict_e.gz", "rb") as f:
    for _, entry in etree.iterparse(f, events=("end",), tag="entry", load_dtd=True, resolve_entities=True, huge_tree=True):
        poss = [(e.text or "").strip() for e in entry.iter() if local(e) == "pos"]
        if any(p in ("n", "noun", "noun (common) (futsuumeishi)") for p in poss):
            kebs = [(e.text or "").strip() for e in entry.iter() if local(e) == "keb"]
            rebs = [hira((e.text or "").strip()) for e in entry.iter() if local(e) == "reb"]
            glosses = []
            for s in entry.iter():
                if local(s) != "sense":
                    continue
                for g in s:
                    if local(g) == "gloss" and g.text and len(glosses) < MAX_GLOSS:
                        glosses.append(g.text.strip())
            text = "; ".join(glosses)
            if len(text) > MAX_LEN:
                text = text[:MAX_LEN].rstrip() + "…"
            if text:
                for r in rebs:
                    if is_hira(r):
                        lst = words.setdefault(canon(r), [])
                        if len(lst) < MAX_ENTRIES:
                            lst.append({"k": kebs[0] if kebs else "", "g": text})
        entry.clear()
        parent = entry.getparent()
        if parent is not None:
            while entry.getprevious() is not None:
                del parent[0]

OUT.mkdir(parents=True, exist_ok=True)
for old in OUT.glob("*.json"):
    old.unlink()
shards = {}
for w, v in words.items():
    shards.setdefault(w[0], {})[w] = v
total = 0
for ch, d in shards.items():
    p = OUT / f"{ord(ch):x}.json"
    p.write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    total += p.stat().st_size
print("読み:", len(words), "ファイル:", len(shards), "合計バイト:", total)
