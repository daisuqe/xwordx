"""JMdict + KANJIDIC2 から、読み(ひらがな)ごとの「難しさの素材」を _work/nouns_scored.tsv に出力する。

列: reading <TAB> nf <TAB> pri <TAB> grade
  nf    : 頻度順位 nf01〜nf48 の最小値 (印なしは 99)
  pri   : ichi1/ichi2/news1/news2/spec1/spec2/gai1/gai2 のうち付いていたもの (カンマ区切り, なければ -)
  grade : 一番やさしい表記の「最も難しい漢字の学年」
          0=漢字なし(仮名のみ) 1-6=小学 8=中学以上の常用 9-10=人名用 11=表外
同じ読みが複数エントリにある場合は、やさしい方(nf小・grade小)を残す。

使い方: python tools/make_scored.py   (_work/JMdict_e.gz, _work/kanjidic2.xml.gz が必要)
"""
import gzip
import re
from pathlib import Path

from lxml import etree

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "_work"
PRI_KEYS = ("ichi1", "ichi2", "news1", "news2", "spec1", "spec2", "gai1", "gai2")


def ln(e):
    return etree.QName(e).localname


def hira(t):
    return "".join(chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c for c in t)


def is_hira(t):
    return all("ぁ" <= c <= "ゖ" or c in "ーゝゞ" for c in t)


def load_grades():
    g = {}
    with gzip.open(WORK / "kanjidic2.xml.gz", "rb") as f:
        for _, e in etree.iterparse(f, events=("end",), tag="character", load_dtd=True, huge_tree=True):
            lit = e.findtext("literal")
            grade = e.findtext("misc/grade")
            g[lit] = int(grade) if grade else 11
            e.clear()
    return g


def is_kanji(c):
    return "一" <= c <= "鿿" or c in "々〆ヶ" or "㐀" <= c <= "䶿"


def main():
    grades = load_grades()
    best = {}  # reading -> (nf, pris, grade)
    with gzip.open(WORK / "JMdict_e.gz", "rb") as f:
        for _, e in etree.iterparse(f, events=("end",), tag="entry", load_dtd=True, resolve_entities=True, huge_tree=True):
            pos = [(x.text or "").strip() for x in e.iter() if ln(x) == "pos"]
            if any(p in ("n", "noun", "noun (common) (futsuumeishi)") for p in pos):
                kebs = []
                for k in e.iter():
                    if ln(k) == "k_ele":
                        keb = k.findtext("keb") or ""
                        pri = [p.text for p in k if ln(p) == "ke_pri"]
                        kebs.append((keb, pri))
                # 表記ごとの学年 (「々」は直前の漢字と同じ扱いで無視)
                def kgrade(keb):
                    gs = [grades.get(c, 11) for c in keb if is_kanji(c) and c != "々"]
                    return max(gs) if gs else 0
                keb_grades = [kgrade(k) for k, _ in kebs if k]
                for r in e.iter():
                    if ln(r) != "r_ele":
                        continue
                    reb = hira((r.findtext("reb") or "").strip())
                    if not reb or not is_hira(reb):
                        continue
                    pris = {p.text for p in r if ln(p) == "re_pri"}
                    for _, kp in kebs:
                        pris.update(kp)
                    nfs = [int(p[2:]) for p in pris if re.fullmatch(r"nf\d\d", p)]
                    nf = min(nfs) if nfs else 99
                    flags = sorted(p for p in pris if p in PRI_KEYS)
                    grade = min(keb_grades) if keb_grades else 0
                    cur = best.get(reb)
                    if cur:
                        nf = min(nf, cur[0])
                        flags = sorted(set(flags) | set(cur[1]))
                        grade = min(grade, cur[2])
                    best[reb] = (nf, flags, grade)
            e.clear()
            while e.getprevious() is not None:
                del e.getparent()[0]

    out = WORK / "nouns_scored.tsv"
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        for w in sorted(best):
            nf, flags, grade = best[w]
            f.write(f"{w}\t{nf}\t{','.join(flags) or '-'}\t{grade}\n")
    print(f"{len(best)} words -> {out}")


if __name__ == "__main__":
    main()
