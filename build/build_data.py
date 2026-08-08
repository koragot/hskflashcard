#!/usr/bin/env python3
"""Build trimmed flashcard data from drkameleon/complete-hsk-vocabulary (newest = HSK 3.0).

Source schema (.min.json):
  s = simplified, r = radical, q = frequency rank, p = [pos]
  f = [{ t: traditional, i: {y: pinyin, n: numbered, b: bopomofo}, m: [meanings], c: [classifiers] }]

Output: ../public/data/hsk-<level>.json
  -> [{s, r, py, en: [...], pos: [...], q, ex: {zh, py, en}}]   ex is omitted when unmatched
"""

import json
import os
import re
import urllib.request

import sentences

BASE = "https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/wordlists/exclusive/newest"
LEVELS = ["1", "2", "3", "4", "5", "6", "7"]
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
OUT = os.path.abspath(os.path.join(HERE, "..", "public", "data"))

# meanings we drop as flashcard answers - too generic to distinguish
NOISE = re.compile(
    r"^(surname \w+|variant of|abbr\. for|see [A-Z]|old variant of|CL:|used in )", re.I
)

# markers of a secondary reading; e.g. 听 lists yǐn "smile (archaic)" before tīng
ARCHAIC = re.compile(r"\((archaic|old|literary|dialect)\)", re.I)
REGISTER = re.compile(r"^\((coll\.|colloquial|slang|dialect)\)", re.I)
VARIANT = re.compile(r"^(old )?variant of ", re.I)

# 多音字 the scoring heuristic gets wrong: character -> substring of the wanted sense.
# The form containing that sense wins, and that sense is shown first.
OVERRIDES = {
    "年": "year", "雨": "rain", "长": "long", "着": "aspect particle",
    "卡": "card", "胖": "fat", "咳": "cough", "重": "heavy", "空": "empty",
    "转": "to turn", "数": "number", "喝": "to drink", "趟": "classifier for times",
}


def fetch(level):
    path = os.path.join(CACHE, f"{level}.json")
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        urllib.request.urlretrieve(f"{BASE}/{level}.min.json", path)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clean_meaning(m):
    m = m.strip()
    m = re.sub(r"\s*\(CL:[^)]*\)", "", m)  # strip classifier hints
    m = re.sub(r"\s*\((Taiwan|also) pr\.[^)]*\)", "", m)  # strip pronunciation notes
    m = re.sub(r"\s+", " ", m)
    return m.strip(" ;")


def pick_meanings(form, limit=3):
    out = []
    for m in form.get("m", []):
        m = clean_meaning(m)
        if not m or NOISE.match(m):
            continue
        if m not in out:
            out.append(m)
    # everyday senses first, archaic/literary ones last (stable within each group)
    out.sort(key=lambda m: bool(ARCHAIC.search(m)))
    return out[:limit]


def score_form(form):
    """How suitable this reading is as *the* flashcard answer. Higher is better."""
    meanings = pick_meanings(form, limit=10)
    if not meanings:
        return -1
    score = len(meanings)
    if all(ARCHAIC.search(m) for m in meanings):
        score -= 5
    raw = form.get("m") or [""]
    if VARIANT.match(raw[0].strip()):
        score -= 2  # the form is a cross-reference to another character, not a reading
    if all(REGISTER.match(m) for m in meanings):
        score -= 1  # colloquial-only reading (吗 má "what?" vs ma question particle)
    if form.get("i", {}).get("y", "")[:1].isupper():
        score -= 3  # capitalised pinyin = proper noun reading (日 Rì "Japan")
    return score


def build(level):
    entries = []
    for item in fetch(level):
        forms = item.get("f") or []
        if not forms:
            continue

        simp = item["s"]
        want = OVERRIDES.get(simp)

        # a word may have several readings - keep the best-scoring one, first on ties
        best = max(range(len(forms)), key=lambda n: (score_form(forms[n]), -n))
        if want:
            match = next(
                (n for n, f in enumerate(forms)
                 if any(want in clean_meaning(m).lower() for m in f.get("m", []))),
                None,
            )
            if match is not None:
                best = match
        chosen = forms[best]

        meanings = pick_meanings(chosen, limit=20 if want else 3)
        if want:  # lead with the sense the override asked for, then trim
            meanings.sort(key=lambda m: want not in m.lower())
            meanings = meanings[:3]
        if not meanings:
            continue

        entries.append(
            {
                "s": simp,
                "r": item.get("r") or "",
                "py": chosen.get("i", {}).get("y", ""),
                "en": meanings,
                "pos": item.get("p") or [],
                "q": item.get("q") or 0,
            }
        )

    # stable order: most frequent first, unranked (q == 0) last
    entries.sort(key=lambda e: (e["q"] == 0, e["q"], e["s"]))
    return entries


def main():
    os.makedirs(OUT, exist_ok=True)
    levels = {lv: build(lv) for lv in LEVELS}
    all_words = {e["s"]: e["py"] for entries in levels.values() for e in entries}

    print("matching example sentences (Tatoeba)...")
    examples = sentences.build(all_words)

    index = []
    for level, entries in levels.items():
        for e in entries:
            ex = examples.get(e["s"])
            if ex:
                e["ex"] = ex
        name = "7-9" if level == "7" else level
        path = os.path.join(OUT, f"hsk-{level}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, separators=(",", ":"))
        n_ex = sum(1 for e in entries if "ex" in e)
        index.append({"level": level, "label": name, "count": len(entries)})
        size = os.path.getsize(path) / 1024
        print(f"HSK {name:>3}: {len(entries):>5} words  "
              f"{n_ex:>5} examples ({n_ex / len(entries) * 100:>3.0f}%)  {size:>6.0f} KB")

    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    total = sum(i["count"] for i in index)
    print(f"total   : {total:>5} words  {len(examples):>5} examples "
          f"({len(examples) / total * 100:.0f}%) -> {OUT}")


if __name__ == "__main__":
    main()
