import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { match, score, SKILL_YOMI } from "../js/search.js";

const M = JSON.parse(readFileSync(new URL("../data/master.json", import.meta.url)));
const names = M.skills.map((s) => s.name).filter((n) => !/^c\d+$/.test(n));
const hits = (q) => names.filter((n) => match(n, q));

// 全スキルに読みがある
assert.deepEqual(names.filter((n) => !SKILL_YOMI[n]), []);
// 漢字の部分一致
assert.ok(hits("特効").includes("弱点特効") && hits("特効").includes("弱点特効【属性】"));
assert.ok(hits("会心").includes("超会心"));
// 飛び飛びの一致
assert.ok(hits("弱特").includes("弱点特効"));
assert.ok(hits("火攻").includes("火属性攻撃強化"));
// 読み（ひらがな/カタカナ）
assert.ok(hits("こうげき").includes("攻撃"));
assert.ok(hits("みき").includes("見切り"));
assert.ok(hits("カイシン").includes("超会心"));
assert.ok(hits("ちゃーじ").includes("チャージマスター"));
// 記号を省いた入力・全角半角
assert.ok(hits("研磨術鋭").includes("研磨術【鋭】"));
assert.ok(hits("通常弾連射").includes("通常弾・連射矢強化"));
assert.ok(hits("ko").includes("ＫＯ術"));
// 複数語は AND
assert.deepEqual(hits("抜刀 力"), ["抜刀術【力】"]);
// 並び: 完全一致が先
assert.ok(score("攻撃", "攻撃") < score("火属性攻撃強化", "攻撃"));
console.log("search ok", hits("こうげき").length, "hits for こうげき");
