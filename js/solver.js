// スキルシミュレータ 探索エンジン（UI非依存・Web Worker / Node 両対応）
// サンブレイク・ワイルズ共通
//
// input = {
//   parts: { weapon:[item], head:[item], body:[item], arm:[item], waist:[item], leg:[item], charm:[item] },
//     item = { key, name, slots:[size...]（防具用スロット）, wslots:[size...]（武器用スロット）, skills:{skill:pts}, def, res:[5], pref }
//   decos: [{ name, size, type:"A"|"W", skills:{skill:lv}, count }]   count: 所持数 (null/Infinity = 無制限)
//   conds: [{ skill, level, required }]   level はポイント換算済み。配列順 = 優先度（先頭が最優先）
//   skillMax: { skill: 上限ポイント }
//   opts: { limit, pruneDominated, onlyFullSoft, onProgress }
// }
// スロット種別: "A" = 防具用（サンブレイクは全スロットこちら）、"W" = 武器用（ワイルズ）

export const PART_ORDER = ["weapon", "head", "body", "arm", "waist", "leg", "charm"];
const DECO_NODE_LIMIT = 4000;
const TYPES = ["A", "W"];

// ---- 汎用 ----
function slotsVec(slots) {
  const v = [0, 0, 0, 0, 0];
  for (const s of slots || []) if (s > 0) v[Math.min(4, s)]++;
  return v;
}
// サイズ k 以上の装飾品個数 <= サイズ k 以上のスロット数 （k=1..4）
function fits(use, avail) {
  let u = 0, a = 0;
  for (let k = 4; k >= 1; k--) {
    u += use[k];
    a += avail[k];
    if (u > a) return false;
  }
  return true;
}
function sortedDesc(slots) {
  return (slots || []).filter((s) => s > 0).sort((a, b) => b - a);
}
function slotDominates(a, b) {
  const A = sortedDesc(a), B = sortedDesc(b);
  for (let i = 0; i < B.length; i++) if ((A[i] || 0) < B[i]) return false;
  return true;
}
// a の方が「楽」(サイズk以上の使用数がすべて以下)
function easierOrEqual(a, b) {
  let ua = 0, ub = 0;
  for (let k = 4; k >= 1; k--) {
    ua += a[k]; ub += b[k];
    if (ua > ub) return false;
  }
  return true;
}

// ---- 部位ごとの候補整理 ----
function buildGroups(items, targets, pruneDominated) {
  const map = new Map();
  for (const it of items) {
    const pts = targets.map((t) => Math.min(it.skills[t.skill] || 0, t.level));
    const slots = sortedDesc(it.slots);
    const wslots = sortedDesc(it.wslots);
    const sig = pts.join(",") + "|" + slots.join(",") + "|" + wslots.join(",");
    let g = map.get(sig);
    if (!g) {
      g = { pts, slots, wslots, svec: { A: slotsVec(slots), W: slotsVec(wslots) }, items: [] };
      map.set(sig, g);
    }
    g.items.push(it);
  }
  let groups = [...map.values()];
  // 代表装備: 所持優先度(pref) → 防御力 の順
  for (const g of groups) g.items.sort((a, b) => (b.pref || 0) - (a.pref || 0) || (b.def || 0) - (a.def || 0));
  if (pruneDominated) {
    const dom = (h, g) => h.pts.every((p, i) => p >= g.pts[i]) && slotDominates(h.slots, g.slots) && slotDominates(h.wslots, g.wslots);
    groups = groups.filter((g) => !groups.some((h) => h !== g && dom(h, g) && !dom(g, h)));
  }
  const score = (g) => g.pts.reduce((a, b) => a + b, 0) * 3 + g.slots.reduce((a, b) => a + b, 0) + g.wslots.reduce((a, b) => a + b, 0);
  groups.sort((a, b) => score(b) - score(a));
  return groups;
}

// ---- 装飾品クラス（条件スキルへの寄与が同じ装飾品をまとめる） ----
function buildDecoClasses(decos, targets) {
  const map = new Map();
  decos.forEach((d, idx) => {
    const cnt = d.count == null ? Infinity : d.count;
    if (cnt <= 0) return;
    const vec = targets.map((t) => Math.min((d.skills || {})[t.skill] || 0, t.level));
    if (vec.every((v) => v === 0)) return;
    const key = d.type + "|" + d.size + "|" + vec.join(",");
    let c = map.get(key);
    if (!c) {
      c = { type: d.type || "A", size: d.size, vec, members: [], count: 0 };
      map.set(key, c);
    }
    c.members.push(idx);
    c.count += cnt;
  });
  const classes = [...map.values()];
  // 実際に使う装飾品: 単独スキルの珠を優先
  for (const c of classes) c.members.sort((a, b) => Object.keys(decos[a].skills).length - Object.keys(decos[b].skills).length);
  return classes;
}

// スキル k について、ポイント p ごとの「最小」な装飾品の組み合わせを列挙
function decoCombos(classes, k, maxPts) {
  const res = [];
  for (let p = 0; p <= maxPts; p++) res.push([]);
  const list = classes.map((c, ci) => ({ c, ci })).filter((x) => x.c.vec[k] > 0)
    .sort((a, b) => b.c.vec[k] - a.c.vec[k] || a.c.size - b.c.size);
  if (!list.length || maxPts <= 0) return res;
  const T = classes[0].vec.length;
  const cur = new Array(list.length).fill(0);
  let produced = 0;
  function rec(i, pts) {
    if (produced > 20000) return;
    if (pts >= maxPts || i === list.length) {
      if (pts > 0) { emit(pts); produced++; }
      return;
    }
    const v = list[i].c.vec[k];
    const lim = Math.min(list[i].c.count, Math.ceil((maxPts - pts) / v));
    for (let n = 0; n <= lim; n++) {
      cur[i] = n;
      rec(i + 1, pts + n * v);
    }
    cur[i] = 0;
  }
  function emit(total) {
    const p = Math.min(total, maxPts);
    for (let i = 0; i < list.length; i++) {
      if (cur[i] > 0 && Math.min(total - list[i].c.vec[k], maxPts) >= p) return; // 冗長
    }
    const use = { A: [0, 0, 0, 0, 0], W: [0, 0, 0, 0, 0] };
    const add = new Array(T).fill(0);
    const cnt = [];
    let limited = false;
    for (let i = 0; i < list.length; i++) {
      const n = cur[i];
      if (!n) continue;
      const c = list[i].c;
      use[c.type][c.size] += n;
      for (let j = 0; j < T; j++) add[j] += c.vec[j] * n;
      cnt.push([list[i].ci, n]);
      if (Number.isFinite(c.count)) limited = true;
    }
    const useNz = [];
    for (const t of TYPES) for (let z = 1; z <= 4; z++) if (use[t][z]) useNz.push(t, z, use[t][z]);
    const addNz = [];
    for (let j = 0; j < T; j++) if (add[j]) addNz.push(j, add[j]);
    res[p].push({ use, add, cnt, useNz, addNz, hasW: use.W.some((x) => x), p, limited, cost: use.A.reduce((s, n, z) => s + n * z, 0) + use.W.reduce((s, n, z) => s + n * z, 0) });
  }
  rec(0, 0);
  // 支配される組み合わせを除外（他スキルへの寄与が同等以上で、スロット的にも楽なものがあれば不要）
  for (let p = 1; p <= maxPts; p++) {
    const arr = res[p];
    const dominates = (a, b) => !a.limited && !b.limited &&
      a.add.every((v, j) => j === k || v >= b.add[j]) && easierOrEqual(a.use.A, b.use.A) && easierOrEqual(a.use.W, b.use.W);
    res[p] = arr.filter((c, i) => !arr.some((o, j) => j !== i && dominates(o, c) && (!dominates(c, o) || j < i)));
    res[p].sort((a, b) => a.cost - b.cost);
  }
  return res;
}

// ---- 装飾品割り当て（1組み合わせ分） ----
// order: 条件スキルの処理順（必須 → 希望(優先度順)）
function solveDecos(ctx, pts0, avail) {
  const { targets, order, combos, classes, hasCross } = ctx;
  const T = targets.length;
  const cur = pts0.slice();
  const used = { A: [0, 0, 0, 0, 0], W: [0, 0, 0, 0, 0] };
  const usedCls = new Array(classes.length).fill(0);
  const picks = [];
  const softOrder = order.filter((k) => !targets[k].required);
  let best = null;
  let nodes = 0;
  const cache = ctx.cache;
  function atLeast(k, d) {
    const key = k * 1000 + d;
    let r = cache.get(key);
    if (!r) {
      r = [];
      for (let p = d; p < combos[k].length; p++) r.push(...combos[k][p]);
      cache.set(key, r);
    }
    return r;
  }
  function canUse(c) {
    for (const [ci, n] of c.cnt) if (usedCls[ci] + n > classes[ci].count) return false;
    return true;
  }
  function apply(c, s) {
    const u = c.useNz;
    for (let i = 0; i < u.length; i += 3) used[u[i]][u[i + 1]] += s * u[i + 2];
    const cn = c.cnt;
    for (let i = 0; i < cn.length; i++) usedCls[cn[i][0]] += s * cn[i][1];
    const a = c.addNz;
    for (let i = 0; i < a.length; i += 2) cur[a[i]] += s * a[i + 1];
    if (s > 0) for (let i = 0; i < cn.length; i++) picks.push(cn[i]);
    else picks.length -= cn.length;
  }
  const ok = () => fits(used.A, avail.A) && fits(used.W, avail.W);
  function freeCap() {
    let s = 0;
    for (const t of TYPES) for (let z = 1; z <= 4; z++) s += (avail[t][z] - used[t][z]) * z;
    return s;
  }
  function leaf() {
    for (const k of order) if (targets[k].required && cur[k] < targets[k].level) return;
    const soft = softOrder.map((k) => Math.min(cur[k], targets[k].level));
    const fc = freeCap();
    if (best) {
      let c = 0;
      for (let i = 0; i < soft.length && c === 0; i++) c = soft[i] - best.soft[i];
      if (c < 0 || (c === 0 && fc <= best.freeCap)) return;
    }
    best = { soft, freeCap: fc, picks: picks.slice() };
  }
  // 希望スキルの上限見積もりによる枝刈り（複合珠が絡む場合は無効）
  function hopeless(si) {
    if (!best || hasCross) return false;
    for (let i = 0; i < softOrder.length; i++) {
      const k = softOrder[i];
      const v = i < si ? Math.min(cur[k], targets[k].level) : targets[k].level;
      if (v !== best.soft[i]) return v < best.soft[i];
    }
    return false;
  }
  function rec(i, si) {
    if (++nodes > DECO_NODE_LIMIT && best) return;
    if (i === order.length) { leaf(); return; }
    const k = order[i];
    const t = targets[k];
    const d = t.level - cur[k];
    if (d <= 0) { rec(i + 1, t.required ? si : si + 1); return; }
    if (t.required) {
      for (const c of atLeast(k, d)) {
        if (!canUse(c)) continue;
        apply(c, 1);
        if (ok()) rec(i + 1, si);
        apply(c, -1);
        if (nodes > DECO_NODE_LIMIT && best) return;
      }
      return;
    }
    if (hopeless(si)) return;
    for (let p = d; p >= 1; p--) {
      for (const c of (p === d ? atLeast(k, p) : combos[k][p])) {
        if (!canUse(c)) continue;
        apply(c, 1);
        if (ok()) rec(i + 1, si + 1);
        apply(c, -1);
        if (nodes > DECO_NODE_LIMIT && best) return;
      }
    }
    rec(i + 1, si + 1);
  }
  rec(0, 0);
  return best;
}

// クラス単位の選択を実際の装飾品に展開
function expandPicks(picks, classes, decos, decoLeft) {
  const out = [];
  for (const [ci, n] of picks) {
    let rest = n;
    for (const idx of classes[ci].members) {
      if (!rest) break;
      const take = Math.min(rest, decoLeft[idx]);
      for (let i = 0; i < take; i++) out.push(idx);
      decoLeft[idx] -= take;
      rest -= take;
    }
  }
  return out;
}

// 装飾品を実スロットに配置（大きい装飾品から、同種別で入る中で最小のスロットへ）
function placeDecos(list, decos, slotList) {
  list.sort((a, b) => decos[b].size - decos[a].size);
  const free = slotList.map((s) => ({ ...s, deco: null }));
  for (const idx of list) {
    const d = decos[idx];
    let pick = null;
    for (const s of free) {
      if (s.deco === null && s.type === (d.type || "A") && s.size >= d.size && (!pick || s.size < pick.size)) pick = s;
    }
    if (pick) pick.deco = idx;
  }
  return free;
}

// ---- メイン ----
export function simulate(input) {
  const { parts, decos, conds, skillMax } = input;
  const opts = Object.assign({ limit: 1000, pruneDominated: true, onlyFullSoft: false }, input.opts || {});
  const t0 = Date.now();

  const targets = conds
    .filter((c) => c.skill && c.level > 0)
    .map((c) => ({ skill: c.skill, level: Math.min(c.level, skillMax[c.skill] || c.level), required: !!c.required }));
  const T = targets.length;
  const decoCount = decos.map((d) => (d.count == null ? Infinity : d.count));
  const allUnlimited = decoCount.every((c) => c === Infinity);
  const classes = buildDecoClasses(decos.map((d, i) => ({ ...d, count: decoCount[i] })), targets);
  const hasCross = classes.some((c) => c.vec.filter((v) => v > 0).length >= 2);
  const combos = targets.map((t, k) => decoCombos(classes, k, t.level));
  const reqIdx = targets.map((t, i) => (t.required ? i : -1)).filter((i) => i >= 0);
  const softIdx = targets.map((t, i) => (t.required ? -1 : i)).filter((i) => i >= 0);
  const ctx = { targets, order: [...reqIdx, ...softIdx], combos, classes, hasCross, cache: new Map() };

  // 枝刈り用: スキルごとの装飾品情報
  const bound = targets.map((t, k) => {
    const cl = classes.filter((c) => c.vec[k] > 0);
    const types = new Set(cl.map((c) => c.type));
    return {
      type: types.size === 1 ? [...types][0] : types.size ? "mixed" : null,
      minSize: cl.length ? Math.min(...cl.map((c) => c.size)) : 99,
      maxLv: cl.length ? Math.max(...cl.map((c) => c.vec[k])) : 0,
      maxPts: cl.reduce((s, c) => s + c.vec[k] * Math.min(c.count, 99), 0),
    };
  });

  const order = PART_ORDER.filter((p) => parts[p]);
  const groupsByPart = order.map((p) => {
    const items = parts[p].length ? parts[p] : [{ key: "none:" + p, name: "（なし）", slots: [], wslots: [], skills: {}, def: 0, res: [0, 0, 0, 0, 0], none: true }];
    return buildGroups(items, targets, opts.pruneDominated);
  });
  const P = order.length;

  const sufPts = [], sufSlots = [];
  for (let i = P; i >= 0; i--) {
    if (i === P) { sufPts[i] = new Array(T).fill(0); sufSlots[i] = { A: [0, 0, 0, 0, 0], W: [0, 0, 0, 0, 0] }; continue; }
    const mp = new Array(T).fill(0);
    const ms = { A: [0, 0, 0], W: [0, 0, 0] };
    for (const g of groupsByPart[i]) {
      g.pts.forEach((p, k) => { if (p > mp[k]) mp[k] = p; });
      g.slots.forEach((s, k) => { if (k < 3 && s > ms.A[k]) ms.A[k] = s; });
      g.wslots.forEach((s, k) => { if (k < 3 && s > ms.W[k]) ms.W[k] = s; });
    }
    sufPts[i] = sufPts[i + 1].map((v, k) => v + mp[k]);
    const sa = slotsVec(ms.A), sw = slotsVec(ms.W);
    sufSlots[i] = { A: sufSlots[i + 1].A.map((v, k) => v + sa[k]), W: sufSlots[i + 1].W.map((v, k) => v + sw[k]) };
  }

  const results = [];
  let truncated = false;
  let leaves = 0, checked = 0;
  const pts = new Array(T).fill(0);
  const avail = { A: [0, 0, 0, 0, 0], W: [0, 0, 0, 0, 0] };
  const chosen = new Array(P);

  function feasibleBound(i) {
    const cap = { A: avail.A.map((v, k) => v + sufSlots[i].A[k]), W: avail.W.map((v, k) => v + sufSlots[i].W[k]) };
    const demand = { A: [0, 0, 0, 0, 0], W: [0, 0, 0, 0, 0] };
    for (const k of reqIdx) {
      const d = targets[k].level - pts[k] - sufPts[i][k];
      if (d <= 0) continue;
      const b = bound[k];
      if (d > b.maxPts) return false;
      if (b.type === "mixed") continue;
      const n = Math.ceil(d / b.maxLv);
      if (hasCross) {
        const one = [0, 0, 0, 0, 0];
        one[Math.min(4, b.minSize)] = n;
        if (!fits(one, cap[b.type])) return false;
      } else {
        demand[b.type][Math.min(4, b.minSize)] += n;
      }
    }
    return hasCross || (fits(demand.A, cap.A) && fits(demand.W, cap.W));
  }

  let lastReport = 0;
  function leaf() {
    leaves++;
    const sol = solveDecos(ctx, pts, avail);
    if (!sol) return;
    if (opts.onlyFullSoft && softIdx.some((k, i) => sol.soft[i] < targets[k].level)) return;
    results.push(makeResult(sol));
    if (results.length >= opts.limit) truncated = true;
  }

  function makeResult(sol) {
    const pieces = order.map((p, i) => ({ part: p, group: chosen[i] }));
    const slotList = [];
    pieces.forEach((pc, pi) => {
      pc.group.wslots.forEach((s) => slotList.push({ piece: pi, size: s, type: "W" }));
      pc.group.slots.forEach((s) => slotList.push({ piece: pi, size: s, type: "A" }));
    });
    const decoLeft = allUnlimited ? decoCount : decoCount.slice();
    const placed = placeDecos(expandPicks(sol.picks, classes, decos, decoLeft), decos, slotList);
    const skills = {};
    let def = 0;
    const res = [0, 0, 0, 0, 0];
    for (const pc of pieces) {
      const it = pc.group.items[0];
      for (const [s, v] of Object.entries(it.skills)) skills[s] = (skills[s] || 0) + v;
      def += it.def || 0;
      (it.res || []).forEach((v, k) => (res[k] += v));
    }
    for (const s of placed) if (s.deco !== null) {
      for (const [sk, lv] of Object.entries(decos[s.deco].skills)) skills[sk] = (skills[sk] || 0) + lv;
    }
    for (const s of Object.keys(skills)) if (skillMax[s]) skills[s] = Math.min(skills[s], skillMax[s]);
    const free = [0, 0, 0, 0, 0], freeW = [0, 0, 0, 0, 0];
    for (const s of placed) if (s.deco === null) (s.type === "W" ? freeW : free)[s.size]++;
    const all = free.map((n, k) => n + freeW[k]);
    return {
      pieces: pieces.map((pc) => ({ part: pc.part, items: pc.group.items.map((it) => it.key), slots: pc.group.slots, wslots: pc.group.wslots })),
      decos: placed.map((s) => ({ piece: s.piece, size: s.size, type: s.type, deco: s.deco === null ? null : decos[s.deco].name })),
      skills, def, res,
      free: all, freeA: free, freeW,
      freeCount: all.reduce((a, b) => a + b, 0),
      freeCap: all.reduce((a, n, k) => a + n * k, 0),
      softScore: sol.soft,
      softMet: softIdx.filter((k, i) => sol.soft[i] >= targets[k].level).length,
    };
  }

  function dfs(i) {
    if (truncated) return;
    if (i === P) { leaf(); return; }
    for (const g of groupsByPart[i]) {
      if (truncated) return;
      checked++;
      for (let k = 0; k < T; k++) pts[k] += g.pts[k];
      for (let z = 1; z <= 4; z++) { avail.A[z] += g.svec.A[z]; avail.W[z] += g.svec.W[z]; }
      chosen[i] = g;
      if (feasibleBound(i + 1)) dfs(i + 1);
      for (let k = 0; k < T; k++) pts[k] -= g.pts[k];
      for (let z = 1; z <= 4; z++) { avail.A[z] -= g.svec.A[z]; avail.W[z] -= g.svec.W[z]; }
      if (opts.onProgress && (checked & 4095) === 0) {
        const now = Date.now();
        if (now - lastReport > 300) { lastReport = now; opts.onProgress({ checked, leaves, found: results.length }); }
      }
    }
  }

  if (feasibleBound(0)) dfs(0);

  results.sort((a, b) => {
    for (let i = 0; i < a.softScore.length; i++) if (a.softScore[i] !== b.softScore[i]) return b.softScore[i] - a.softScore[i];
    return b.freeCap - a.freeCap || b.def - a.def;
  });

  return {
    results,
    truncated,
    stats: { ms: Date.now() - t0, leaves, checked, groups: Object.fromEntries(order.map((p, i) => [p, groupsByPart[i].length])) },
    targets,
  };
}

export const _internal = { fits, decoCombos, buildDecoClasses, buildGroups };
