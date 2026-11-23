#!/usr/bin/env python3
"""ゲーム内のスキル説明文（スキル内容・スキル詳細）を master.json に追加する。

使い方:
  python3 tools/skill_text.py sb    <MHRTextDump の Japanese フォルダ>
  python3 tools/skill_text.py wilds <mhdb-wilds-data の output/merged/Skill.json>

入力: サンブレイク = dtlnor/MHRTextDump（ゲームのテキストを書き出したもの）
      ワイルズ     = LartTyler/mhdb-wilds-data（GPL-3.0。ゲームファイルから生成したスキルデータ）
      テキストの著作権は CAPCOM に帰属する。リポジトリには抽出結果（master.json 内）だけを含める。
出力: data/master.json / data/wilds/master.json の各スキルに
      explain（スキル内容）と details（Lvごとのスキル詳細）を追加する。

テキストファイルにはキーが付いていないため、行の並びで対応付ける。
並びがずれていないことを、"#Rejected#" 行に残っているキーやシリーズスキルの発動名で検証し、
ずれていれば中断する。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REJ = re.compile(r"#Rejected#</COLOR>\s*(\S+)")


def read_entries(path):
    out = []
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("﻿"):
                line = line[1:]
            assert line.startswith("<string>"), (path, line[:40])
            out.append(line[len("<string>"):])
    return out


def rejected_key(s):
    m = REJ.search(s)
    return m.group(1) if m else None


def clean(s):
    s = re.sub(r"<COLOR [0-9A-Fa-f]+>|</COLOR>", "", s)
    s = s.replace("<lf>", "\n")
    s = re.sub(r"<[^>]+>", "", s)
    return s.strip()


def blocks8(names, details, prefix, id_base):
    """詳細ファイル: 先頭 prefix 行の後に、スキルごとに 8 行（Lv1〜Lv8）。
    #Rejected# 行のキー PlayerSkill_<id>_<lv>_Detail で位置を検証する。"""
    out = {}
    for i, name in enumerate(names):
        start = prefix + i * 8
        block = details[start:start + 8]
        assert len(block) == 8, (name, start)
        for lv, s in enumerate(block):
            k = rejected_key(s)
            if k:
                m = re.match(r"PlayerSkill_(.+)_(\d+)_Detail$", k)
                assert m, k
                assert int(m.group(2)) == lv, (name, k, lv)
                if id_base is not None:
                    assert m.group(1) == str(id_base + i), (name, k, id_base + i)
        out[name] = [None if rejected_key(s) else clean(s) for s in block]
    return out


def sb(src):
    f = lambda n: os.path.join(src, n + ".msg.539100710.txt")
    base_n, base_e, base_d = read_entries(f("PlayerSkill_Name")), read_entries(f("PlayerSkill_Explain")), read_entries(f("PlayerSkill_Detail"))
    mr_n, mr_e, mr_d = read_entries(f("PlayerSkill_Name_MR")), read_entries(f("PlayerSkill_Explain_MR")), read_entries(f("PlayerSkill_Detail_MR"))
    assert len(base_n) == len(base_e) and len(base_d) == len(base_n) * 8
    assert len(mr_e) >= len(mr_n)
    text = {}
    # 本編（ベースゲーム）: 名前・内容・詳細(8行ずつ)がそろっている
    det = blocks8(base_n, base_d, 0, None)
    for i, n in enumerate(base_n):
        if rejected_key(n) or not n.strip():
            continue
        text[clean(n)] = {"explain": clean(base_e[i]), "details": det[base_n[i]]}
    # サンブレイク: 詳細は先頭3行の後に 8 行ずつ。ID は 200 から連番（#Rejected# のキーで検証）
    det = blocks8(mr_n, mr_d, 3, 200)
    for i, n in enumerate(mr_n):
        text[clean(n)] = {"explain": clean(mr_e[i]), "details": det[mr_n[i]]}  # 同名は MR 版で上書き
    return text


def wilds(path):
    """mhdb-wilds-data の Skill.json: スキルごとに names/descriptions/ranks（Lvごとの説明）を持つ"""
    with open(path, encoding="utf-8") as fp:
        data = json.load(fp)
    out = {}
    for x in data:
        n = x["names"].get("ja", "").strip()
        if not n:
            continue
        ranks = sorted(x.get("ranks") or [], key=lambda r: r.get("level", 0))
        out[n] = {
            "explain": clean(x.get("descriptions", {}).get("ja", "").replace("\r\n", "<lf>")),
            "details": [clean(r.get("descriptions", {}).get("ja", "").replace("\r\n", "<lf>")) for r in ranks],
            "names": [clean((r.get("names") or {}).get("ja", "")) for r in ranks],
        }
    return out


def main():
    game, src = sys.argv[1], sys.argv[2]
    path = os.path.join(ROOT, "data", "master.json") if game == "sb" else os.path.join(ROOT, "data", "wilds", "master.json")
    with open(path, encoding="utf-8") as fp:
        M = json.load(fp)
    missing = []
    if game == "sb":
        text = sb(src)
        for s in M["skills"]:
            t = text.get(s["name"])
            if not t:
                missing.append(s["name"])
                continue
            s["explain"] = t["explain"]
            s["details"] = [d or "" for d in t["details"][: s["max"]]]
    else:
        text = wilds(src)
        for s in M["skills"]:
            t = text.get(s["name"])
            if not t:
                missing.append(s["name"])
                continue
            cnt = len(s["thresholds"]) if s.get("thresholds") else s["max"]
            # 段階数と、シリーズ/グループの発動名が一致することを確認（ずれていれば中断）
            assert len(t["details"]) == cnt, (s["name"], len(t["details"]), cnt)
            if s.get("names"):
                assert t["names"] == s["names"], (s["name"], t["names"], s["names"])
            s["explain"] = t["explain"]
            s["details"] = t["details"]
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(M, fp, ensure_ascii=False, separators=(",", ":"))
    print(game, "skills:", len(M["skills"]), "with text:", sum(1 for s in M["skills"] if s.get("explain")), "missing:", missing)


if __name__ == "__main__":
    main()
