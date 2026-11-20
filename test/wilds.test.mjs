import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { simulate } from "../js/solver.js";

const M = JSON.parse(readFileSync(new URL("../data/wilds/master.json", import.meta.url)));
const SK = Object.fromEntries(M.skills.map((s) => [s.name, s]));
const skillMax = Object.fromEntries(M.skills.map((s) => [s.name, s.thresholds ? s.thresholds.at(-1) : s.max]));
const pointsOf = (name, lv) => (SK[name].thresholds ? SK[name].thresholds[lv - 1] : lv);
const decos = M.decos.map((d) => ({ ...d, count: null }));
const DECO = Object.fromEntries(M.decos.map((d) => [d.name, d]));
function parts(weapons, charms = []) {
  const p = { weapon: weapons, charm: charms };
  for (const part of ["head", "body", "arm", "waist", "leg"]) p[part] = M.armors.filter((a) => a.part === part).map((a) => ({ ...a, key: a.id }));
  return p;
}
const tachi = M.weapons.filter((w) => w.type === "太刀").map((w) => ({ key: w.id, name: w.name, slots: [], wslots: w.slots, skills: w.skills, def: 0 }));
function verify(out, conds) {
  for (const r of out.results) {
    for (const c of conds.filter((c) => c.required)) assert.ok((r.skills[c.skill] || 0) >= c.level, `${c.skill}: ${r.skills[c.skill]} < ${c.level}`);
    for (const d of r.decos) if (d.deco) {
      const x = DECO[d.deco];
      assert.equal(x.type, d.type, `${d.deco} は ${x.type} スロット用`);
      assert.ok(x.size <= d.size);
    }
  }
}
const c = (skill, lv, required = true) => ({ skill, level: pointsOf(skill, lv), required });

// 1) 武器スキル＋防具スキル＋シリーズスキル
let conds = [c("攻撃", 3), c("見切り", 3), c("弱点特効", 4), c("闢獣の力", 2)];
let out = simulate({ parts: parts(tachi), decos, conds, skillMax, opts: { limit: 200 } });
console.log("w1", out.results.length, out.truncated, out.stats.ms + "ms", JSON.stringify(out.stats.groups));
assert.ok(out.results.length > 0);
verify(out, conds);
// 闢獣の力 Lv2 = 4部位分のポイント
for (const r of out.results) assert.ok(r.skills["闢獣の力"] >= 4);

// 2) 複合珠: 武器スロット1つで 攻撃1 と 砥石使用高速化2 を同時に満たせるのは「研磨・攻撃珠【３】」のみ
const one3 = { key: "w3", name: "w", slots: [], wslots: [3], skills: {} };
const empty = (k) => [{ key: k, slots: [], skills: {} }];
const p2 = { weapon: [one3], charm: [], head: empty("h"), body: empty("b"), arm: empty("a"), waist: empty("w"), leg: empty("l") };
conds = [c("攻撃", 1), c("砥石使用高速化", 2)];
out = simulate({ parts: p2, decos, conds, skillMax });
assert.equal(out.results.length, 1);
assert.equal(out.results[0].decos[0].deco, "研磨・攻撃珠【３】");
// 希望スキル（優先度）でも複合珠を使う
conds = [c("攻撃", 1, false), c("砥石使用高速化", 2, false)];
out = simulate({ parts: p2, decos, conds, skillMax });
assert.deepEqual(out.results[0].softScore, [1, 2]);
// 現実的な条件
conds = [c("攻撃", 3), c("見切り", 2), c("弱点特効", 3), c("業物", 2, false), c("砥石使用高速化", 1, false)];
out = simulate({ parts: parts(tachi), decos, conds, skillMax, opts: { limit: 300 } });
console.log("w2", out.results.length, out.stats.ms + "ms", out.results[0]?.softScore);
verify(out, conds);
assert.ok(out.results.length > 0);

// 3) アーティア武器（グループ＋シリーズ各1pt）＋光るお守り（武器スロット付き）
const artian = { key: "ar1", name: "アーティア", slots: [], wslots: [3, 3, 3], skills: { "護竜の脈動": 1, "闢獣の力": 1 } };
const charm = { key: "c1", name: "光るお守り", slots: [1], wslots: [1], skills: { "攻撃": 1, "弱点特効": 1 } };
conds = [c("攻撃", 5), c("見切り", 5), c("弱点特効", 5), c("護竜の脈動", 1), c("闢獣の力", 2)];
out = simulate({ parts: parts([artian], [charm]), decos, conds, skillMax, opts: { limit: 100 } });
console.log("w3", out.results.length, out.stats.ms + "ms");
verify(out, conds);

// 4) 防具スキルの装飾品は武器スロットに付かない: 武器スロットだけ大量でも防具スキルは満たせない
const bigW = { key: "wb", name: "w", slots: [], wslots: [3, 3, 3], skills: {} };
const p4 = { weapon: [bigW], charm: [], head: [{ key: "h", slots: [], skills: {} }], body: [{ key: "b", slots: [], skills: {} }], arm: [{ key: "a", slots: [], skills: {} }], waist: [{ key: "w", slots: [], skills: {} }], leg: [{ key: "l", slots: [], skills: {} }] };
out = simulate({ parts: p4, decos, conds: [c("弱点特効", 1)], skillMax });
assert.equal(out.results.length, 0);
out = simulate({ parts: p4, decos, conds: [c("攻撃", 3)], skillMax });
assert.ok(out.results.length === 1);

console.log("wilds ok");
