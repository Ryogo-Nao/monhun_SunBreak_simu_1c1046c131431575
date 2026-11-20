#!/usr/bin/env python3
"""RiseSim (MIT License, (c) 2022 EXXXI) の CSV を本アプリ用の data/master.json に変換する。

使い方:  python3 tools/convert.py
入力:    data/source/MHR_*.csv
出力:    data/master.json
"""
import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "source")
OUT = os.path.join(ROOT, "data", "master.json")

PARTS = [("head", "MHR_EQUIP_HEAD.csv"), ("body", "MHR_EQUIP_BODY.csv"),
         ("arm", "MHR_EQUIP_ARM.csv"), ("waist", "MHR_EQUIP_WST.csv"), ("leg", "MHR_EQUIP_LEG.csv")]


def read(name):
    with open(os.path.join(SRC, name), encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    header = [h.lstrip("#") for h in rows[0]]
    out = []
    for r in rows[1:]:
        if not r or not r[0].strip() or r[0].startswith("#"):
            continue
        r = r + [""] * (len(header) - len(r))
        out.append(dict(zip(header, r)))
    return out, header


def num(v, default=0):
    try:
        return int(str(v).strip())
    except ValueError:
        return default


def main():
    # ---- skills ----
    rows, _ = read("MHR_SKILL.csv")
    skills = {}
    order = []
    for r in rows:
        name = r["スキル系統"]
        if r["カテゴリ"] == "汎用スロットスキル":
            continue
        if name not in skills:
            skills[name] = {"name": name, "max": 0, "cat": r["カテゴリ"], "levels": []}
            order.append(name)
        lv = num(r["必要ポイント"])
        skills[name]["max"] = max(skills[name]["max"], lv)
        skills[name]["levels"].append(r["効果"])

    # ---- armors ----
    armors = []
    for part, fn in PARTS:
        rows, header = read(fn)
        nskill = sum(1 for h in header if h.startswith("スキル系統"))
        for r in rows:
            sk = {}
            for i in range(1, nskill + 1):
                s = r.get("スキル系統%d" % i, "").strip()
                if s:
                    if s not in skills:
                        raise SystemExit("unknown skill %s in %s" % (s, r["名前"]))
                    sk[s] = sk.get(s, 0) + num(r["スキル値%d" % i])
            slots = sorted([num(r["スロット1"]), num(r["スロット2"]), num(r["スロット3"])], reverse=True)
            armors.append({
                "id": "%s:%s" % (part, r["名前"]),
                "name": r["名前"],
                "part": part,
                "sex": num(r["性別(0=両,1=男,2=女)"]),
                "rarity": num(r["レア度"]),
                "slots": [s for s in slots if s > 0],
                "def": num(r["最終防御力"]),
                "res": [num(r["火耐性"]), num(r["水耐性"]), num(r["雷耐性"]), num(r["氷耐性"]), num(r["龍耐性"])],
                "skills": sk,
                "table": num(r.get("錬成テーブル", ""), 0),
                "no": num(r.get("仮番号", ""), 0),
            })

    # ---- decorations ----
    rows, _ = read("MHR_DECO.csv")
    decos = []
    for r in rows:
        s = r["スキル系統1"].strip()
        if s not in skills:  # 「Nスロ珠」等の疑似装飾品は除外
            continue
        decos.append({"name": r["名前"], "size": num(r["スロットサイズ"]), "type": "A",
                      "skills": {s: num(r["スキル値1"])}, "rarity": num(r["レア度"])})

    data = {
        "game": "sb",
        "version": "Sunbreak Ver.16 (RiseSim CSV 2024/10/19)",
        "skills": [skills[n] for n in order],
        "armors": armors,
        "decos": decos,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("skills", len(order), "armors", len(armors), "decos", len(decos), "->", OUT,
          os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
