#!/usr/bin/env python3
"""WildsSim (MIT License, (c) 2025 EXXXI) の CSV を data/wilds/master.json に変換する。

使い方:  python3 tools/convert_wilds.py
入力:    data/wilds/source/MHWilds_*.csv
出力:    data/wilds/master.json

※ 拡張コンテンツ等でデータが追加された場合は、WildsSim の最新 CSV を
   data/wilds/source/ に上書きしてこのスクリプトを再実行してください。
"""
import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "wilds", "source")
OUT = os.path.join(ROOT, "data", "wilds", "master.json")

PARTS = [("head", "MHWilds_EQUIP_HEAD.csv"), ("body", "MHWilds_EQUIP_BODY.csv"),
         ("arm", "MHWilds_EQUIP_ARM.csv"), ("waist", "MHWilds_EQUIP_WST.csv"), ("leg", "MHWilds_EQUIP_LEG.csv")]


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


def skill_map(r, header, skills):
    n = sum(1 for h in header if h.startswith("スキル系統"))
    sk = {}
    for i in range(1, n + 1):
        s = r.get("スキル系統%d" % i, "").strip()
        if not s:
            continue
        if s not in skills:
            raise SystemExit("unknown skill %s in %s" % (s, r.get("名前")))
        sk[s] = sk.get(s, 0) + num(r["スキル値%d" % i])
    return sk


def main():
    # ---- skills ----
    rows, _ = read("MHWilds_SKILL.csv")
    skills, order = {}, []
    for r in rows:
        name = r["スキル系統"].strip()
        cat = r["カテゴリ"].strip()
        if name not in skills:
            kind = "W" if cat.startswith("武器スキル") else "S" if cat == "シリーズスキル" else "G" if cat == "グループスキル" else "A"
            skills[name] = {"name": name, "max": 0, "cat": cat, "kind": kind, "artian": False}
            order.append(name)
        sk = skills[name]
        if r.get("アーティア対応", "").strip() == "1":
            sk["artian"] = True
        if sk["kind"] in ("S", "G"):
            # シリーズ/グループ: 発動スキル毎に必要ポイント（閾値）がある
            sk.setdefault("thresholds", []).append(num(r["必要ポイント"]))
            sk.setdefault("names", []).append(r["発動スキル"].strip())
            sk["max"] = len(sk["thresholds"])
        else:
            sk["max"] = num(r["必要ポイント"])

    # ---- armors ----
    armors = []
    for part, fn in PARTS:
        rows, header = read(fn)
        for r in rows:
            slots = sorted([num(r["スロット1"]), num(r["スロット2"]), num(r["スロット3"])], reverse=True)
            armors.append({
                "id": "%s:%s" % (part, r["名前"]),
                "name": r["名前"],
                "part": part,
                "sex": 0,
                "rarity": num(r["レア度"]),
                "slots": [s for s in slots if s > 0],
                "def": max(num(r["初期防御力"]), num(r["最終防御力"])),
                "res": [num(r["火耐性"]), num(r["水耐性"]), num(r["雷耐性"]), num(r["氷耐性"]), num(r["龍耐性"])],
                "skills": skill_map(r, header, skills),
                "no": num(r.get("仮番号", ""), 0),
            })

    # ---- weapons ----
    rows, header = read("MHWilds_WEAPON.csv")
    weapons = []
    for i, r in enumerate(rows):
        slots = sorted([num(r["スロット1"]), num(r["スロット2"]), num(r["スロット3"])], reverse=True)
        weapons.append({
            "id": "wp:%s:%s" % (r["武器種"], r["名前"]),
            "type": r["武器種"],
            "name": r["名前"],
            "rarity": num(r["レア度"]),
            "slots": [s for s in slots if s > 0],
            "attack": num(r["表示攻撃力"]),
            "def": num(r["防御ボーナス"]),
            "skills": skill_map(r, header, skills),
            "no": i,
        })

    # ---- 固定護石 ----
    rows, header = read("MHWilds_CHARM.csv")
    charms = []
    for i, r in enumerate(rows):
        charms.append({"id": "ch:" + r["名前"], "name": r["名前"], "rarity": num(r["レア度"]),
                       "skills": skill_map(r, header, skills), "slots": [], "no": i})

    # ---- 装飾品 ----
    rows, header = read("MHWilds_DECO.csv")
    decos = []
    for r in rows:
        sk = {}
        for i in (1, 2):
            s = r.get("スキル系統%d" % i, "").strip()
            if s:
                if s not in skills:
                    raise SystemExit("unknown deco skill " + s)
                sk[s] = num(r["スキル値%d" % i])
        if not sk:
            continue
        decos.append({"name": r["名前"], "size": num(r["スロットサイズ"]),
                      "type": "W" if num(r["スロットタイプ"]) == 1 else "A", "skills": sk, "rarity": num(r["レア度"])})

    # ---- 光るお守り（鑑定護石）のスキル候補 ----
    rows, _ = read("MHWilds_GROUP_SHININGCHARM.csv")
    groups = {}
    for r in rows:
        groups.setdefault(r["グループ"], {})[r["スキル名"]] = max(groups.get(r["グループ"], {}).get(r["スキル名"], 0), num(r["レベル"]))
    charm_skill_max = {}
    for g in groups.values():
        for s, lv in g.items():
            charm_skill_max[s] = max(charm_skill_max.get(s, 0), lv)

    data = {
        "game": "wilds",
        "version": "Wilds TU (WildsSim CSV 2026/3/4)",
        "skills": [skills[n] for n in order],
        "armors": armors,
        "weapons": weapons,
        "charms": charms,
        "decos": decos,
        "charmSkillMax": charm_skill_max,
        "weaponTypes": list(dict.fromkeys(w["type"] for w in weapons)),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("skills", len(order), "armors", len(armors), "weapons", len(weapons), "charms", len(charms),
          "decos", len(decos), "->", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
