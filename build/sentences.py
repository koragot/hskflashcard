#!/usr/bin/env python3
"""Pick one exam-grade example sentence per HSK word, from the Tatoeba corpus.

Tatoeba (https://tatoeba.org) sentences + their English translations, CC-BY 2.0 FR.
Traditional sentences are converted to simplified with OpenCC's TSCharacters map
rather than discarded - that lifts word coverage from 70% to 79%.

Pinyin comes from pypinyin (`pip install pypinyin`), which resolves 多音字 by context.
"""

import bz2
import collections
import os
import re
import urllib.request

TATOEBA = "https://downloads.tatoeba.org/exports/per_language"
OPENCC = "https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt"
SOURCES = {
    "cmn_sentences.tsv": f"{TATOEBA}/cmn/cmn_sentences.tsv.bz2",
    "eng_sentences.tsv": f"{TATOEBA}/eng/eng_sentences.tsv.bz2",
    "cmn-eng_links.tsv": f"{TATOEBA}/cmn/cmn-eng_links.tsv.bz2",
    "TSCharacters.txt": OPENCC,
}

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
HAN = re.compile(r"[一-鿿]")
LATIN = re.compile(r"[A-Za-z]{2,}")

# a sentence has to clear this to be shown at all - better no example than a bad one
MIN_SCORE = 0


def cached(name, url):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        raw = urllib.request.urlopen(url).read()
        if url.endswith(".bz2"):
            raw = bz2.decompress(raw)
        with open(path, "wb") as f:
            f.write(raw)
    with open(path, encoding="utf-8") as f:
        return f.read().splitlines()


def load_t2s():
    """Traditional -> simplified, one character at a time (first candidate wins)."""
    t2s = {}
    for line in cached("TSCharacters.txt", OPENCC):
        if line.startswith("#") or "\t" not in line:
            continue
        key, val = line.split("\t", 1)
        t2s[key] = val.split(" ")[0]
    return t2s


def load_pairs():
    """{simplified chinese sentence: english translation}, deduplicated."""
    t2s = load_t2s()
    convert = lambda s: "".join(t2s.get(c, c) for c in s)

    def read(name):
        out = {}
        for line in cached(name, SOURCES[name]):
            parts = line.split("\t")
            if len(parts) >= 3:
                out[parts[0]] = parts[2]
        return out

    cmn = read("cmn_sentences.tsv")
    eng = read("eng_sentences.tsv")

    pairs = {}
    for line in cached("cmn-eng_links.tsv", SOURCES["cmn-eng_links.tsv"]):
        a, _, b = line.partition("\t")
        if a in cmn and b in eng:
            pairs.setdefault(convert(cmn[a]), eng[b])
    return pairs


def score(sentence, word, common):
    """Reward exam-length, multi-clause, fully comprehensible sentences."""
    han = HAN.findall(sentence)
    n = len(han)

    if n <= len(word) + 3:
        return -99  # barely more than the word itself ("我很好。")
    if n < 8:
        s = -3 * (8 - n)
    elif n <= 14:
        s = 0.5 * n
    elif n <= 28:
        s = 7 + 0.1 * (28 - n)
    else:
        s = -0.5 * (n - 28)  # too long to read on a flashcard

    s -= 2 * sum(1 for c in han if c not in common)  # obscure characters
    if "，" in sentence or "；" in sentence:
        s += 2  # two clauses read as exam-grade rather than drill-book
    if LATIN.search(sentence):
        s -= 4
    if sentence.count(word) > 1:
        s -= 2
    return s


PUNCT = re.compile(r"^[，。！？；：、…”’）】》,.!?;:)]+$")


def to_pinyin(sentence):
    """"我很忙。" -> "wǒ hěn máng." - punctuation stays attached, syllables spaced."""
    from pypinyin import Style, pinyin

    out = []
    for group in pinyin(sentence, style=Style.TONE, errors="default"):
        token = group[0].strip()
        if not token:
            continue
        if out and PUNCT.match(token):
            out[-1] += token
        else:
            out.append(token)
    return " ".join(out)


def toneless(py):
    """'dōu' -> 'dou' - tone marks off, so sandhi (不 bù->bú) does not read as a mismatch."""
    import unicodedata

    flat = unicodedata.normalize("NFD", py)
    return "".join(c for c in flat if not unicodedata.combining(c)).replace(" ", "").lower()


def reading_matches(zh, word, want, cache):
    """Is `word` pronounced `want` in this sentence? 都 is dōu but dū in 都市."""
    from pypinyin import Style, pinyin

    if zh not in cache:
        han = "".join(HAN.findall(zh))  # han-only => pypinyin returns one group per char
        cache[zh] = (han, [g[0] for g in pinyin(han, style=Style.NORMAL)])
    han, syllables = cache[zh]

    start = han.find(word)
    if start < 0:  # the match straddled punctuation; treat as unverifiable
        return True
    got = "".join(syllables[start:start + len(word)])
    return got.lower() == toneless(want)


def build(readings, keep=6):
    """readings: {simplified headword: pinyin} -> {word: {'zh','py','en'}}"""
    pairs = load_pairs()
    common = {c for w in readings for c in w}  # every character HSK 3.0 uses

    by_len = collections.defaultdict(set)
    for w in readings:
        by_len[len(w)].add(w)
    longest = max(by_len)

    # one pass over the corpus, keeping the top few candidates per word
    best = collections.defaultdict(list)
    for zh, en in pairs.items():
        found = set()
        for i in range(len(zh)):
            for length in range(1, min(longest, len(zh) - i) + 1):
                sub = zh[i:i + length]
                if sub in by_len[length]:
                    found.add(sub)
        for w in found:
            sc = score(zh, w, common)
            if sc > MIN_SCORE:
                cands = best[w]
                cands.append((sc, zh, en))
                if len(cands) > keep * 3:
                    cands.sort(key=lambda c: -c[0])
                    del cands[keep:]

    # then take the best candidate that actually uses the reading being taught
    out, cache = {}, {}
    for w, cands in best.items():
        cands.sort(key=lambda c: -c[0])
        for _, zh, en in cands[:keep]:
            if reading_matches(zh, w, readings[w], cache):
                out[w] = {"zh": zh, "py": to_pinyin(zh), "en": en}
                break
    return out


if __name__ == "__main__":
    import json
    import sys

    data = json.load(open(sys.argv[1], encoding="utf-8"))
    ws = {e["s"]: e["py"] for e in data}
    got = build(ws)
    print(f"{len(got)}/{len(ws)} covered")
    for w in list(ws)[:12]:
        ex = got.get(w)
        print(f"\n{w}: " + (f"{ex['zh']}\n   {ex['py']}\n   {ex['en']}" if ex else "-"))
