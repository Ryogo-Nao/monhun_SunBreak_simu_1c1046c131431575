// インポート時の名前のあいまい解決: 1つに決まるものだけ自動で決め、候補が複数・0件なら選び直しにする
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { score, resolveByScore } from "../js/search.js";

const M = JSON.parse(readFileSync(new URL("../data/master.json", import.meta.url)));
const skill = (q) => resolveByScore(M.skills, q, (x) => score(x.name, q));
const armor = (q) => resolveByScore(M.armors, q, (x) => score(x.name, q));

// 完全一致は、部分一致する候補が他にあっても決まる（「攻撃」は「火属性攻撃強化」などにも含まれる）
assert.equal(skill("攻撃").pick?.name, "攻撃");
assert.ok(skill("攻撃").count > 1);
// 記号・全角半角の違いは完全一致として扱う
assert.equal(skill("研磨術鋭").pick?.name, "研磨術【鋭】");
assert.equal(skill("KO術").pick?.name, "ＫＯ術");
// 読みで完全一致
assert.equal(skill("みきり").pick?.name, "見切り");
// 前方一致が1件だけなら決まる
assert.equal(skill("見切").pick?.name, "見切り");
// 候補が複数なら決めない（選び直し）
assert.equal(skill("弱特").pick, null);       // 弱点特効 / 弱点特効【属性】
assert.ok(skill("弱特").count >= 2);
assert.equal(skill("ガード").pick, null);     // ガード性能 / ガード強化
// 候補0件
assert.deepEqual(skill("存在しないスキル"), { pick: null, count: 0 });
// 防具名
const a0 = M.armors[0];
assert.equal(armor(a0.name).pick?.id, a0.id);
assert.equal(armor("ゴア").pick, null);
console.log("resolve ok", "弱特 candidates:", skill("弱特").count);
