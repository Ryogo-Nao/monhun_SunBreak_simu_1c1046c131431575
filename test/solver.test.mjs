import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { simulate, _internal } from "../js/solver.js";

const M = JSON.parse(readFileSync(new URL("../data/master.json", import.meta.url)));
const skillMax = Object.fromEntries(M.skills.map((s) => [s.name, s.max]));
const decos = M.decos.map((d) => ({ ...d, count: Infinity }));
function parts(extra = {}) {
  const p = { weapon: [{ key: "w", name: "武器", slots: [3, 1], skills: {}, def: 0 }], charm: [] };
  for (const part of ["head", "body", "arm", "waist", "leg"]) p[part] = M.armors.filter((a) => a.part === part).map((a) => ({ ...a, key: a.id }));
  return Object.assign(p, extra);
}
// 検算: 結果のスキルが条件を満たし、装飾品がスロットに収まっているか
function verify(out, conds) {
  for (const r of out.results) {
    for (const c of conds.filter((c) => c.required)) assert.ok((r.skills[c.skill] || 0) >= c.level, `${c.skill} ${r.skills[c.skill]}`);
    for (const d of r.decos) if (d.deco) assert.ok(M.decos.find((x) => x.name === d.deco).size <= d.size);
  }
}
let t = Date.now();

// fits
assert.equal(_internal.fits([0, 2, 0, 0, 1], [0, 1, 1, 0, 1]), true);
assert.equal(_internal.fits([0, 0, 0, 0, 2], [0, 3, 3, 3, 1]), false);

// 1) 典型的な火力構成（必須）
let conds = [
  { skill: "攻撃", level: 7, required: true },
  { skill: "見切り", level: 7, required: true },
  { skill: "弱点特効", level: 3, required: true },
  { skill: "超会心", level: 3, required: true },
];
let out = simulate({ parts: parts(), decos, conds, skillMax, opts: { limit: 300 } });
console.log("case1", out.results.length, out.truncated, out.stats);
assert.ok(out.results.length > 0);
verify(out, conds);

// 2) 不可能条件
conds = [{ skill: "攻撃", level: 7, required: true }, { skill: "見切り", level: 7, required: true }, { skill: "弱点特効", level: 3, required: true },
  { skill: "超会心", level: 3, required: true }, { skill: "渾身", level: 3, required: true }, { skill: "挑戦者", level: 5, required: true },
  { skill: "連撃", level: 3, required: true }, { skill: "業物", level: 3, required: true }, { skill: "達人芸", level: 3, required: true }];
out = simulate({ parts: parts(), decos, conds, skillMax, opts: { limit: 100 } });
console.log("case2", out.results.length, out.truncated, out.stats.ms + "ms");
verify(out, conds);

// 3) 希望スキル（優先度）: 必須 + 希望
conds = [
  { skill: "攻撃", level: 7, required: true },
  { skill: "見切り", level: 7, required: false },
  { skill: "弱点特効", level: 3, required: false },
];
out = simulate({ parts: parts(), decos, conds, skillMax, opts: { limit: 200 } });
console.log("case3", out.results.length, out.truncated, out.stats.ms + "ms", out.results[0]?.softScore);
verify(out, conds);
for (let i = 1; i < out.results.length; i++) {
  const a = out.results[i - 1].softScore, b = out.results[i].softScore;
  assert.ok(a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]), "sorted by priority");
}

// 4) 装飾品の所持数制限
const limited = decos.map((d) => ({ ...d, count: d.skill === "攻撃" ? 0 : Infinity }));
conds = [{ skill: "攻撃", level: 7, required: true }];
out = simulate({ parts: parts(), decos: limited, conds, skillMax, opts: { limit: 50 } });
verify(out, conds);
for (const r of out.results) assert.ok(!r.decos.some((d) => d.deco && d.deco.startsWith("攻撃珠")));
console.log("case4", out.results.length, out.stats.ms + "ms");

// 5) 傀異錬成防具＋護石
const q = { key: "q1", name: "傀異テスト", part: "head", slots: [4, 4, 4], skills: { "攻撃": 7 }, def: 100 };
const p5 = parts({ charm: [{ key: "c1", name: "護石", slots: [4, 2], skills: { "見切り": 3 } }] });
p5.head = [q, ...p5.head];
conds = [{ skill: "攻撃", level: 7, required: true }, { skill: "見切り", level: 7, required: true }, { skill: "弱点特効", level: 3, required: true }, { skill: "超会心", level: 3, required: true }, { skill: "渾身", level: 3, required: true }];
out = simulate({ parts: p5, decos, conds, skillMax, opts: { limit: 50 } });
console.log("case5", out.results.length, out.stats.ms + "ms", out.results[0]?.pieces.map((p) => p.items[0]).join(" / "));
verify(out, conds);

console.log("all ok", Date.now() - t, "ms");
