// スキルシミュレータ 探索エンジン（UI非依存・Web Worker / Node 両対応）
//
// input = {
//   parts: { weapon:[item], head:[item], body:[item], arm:[item], waist:[item], leg:[item], charm:[item] },
//     item = { key, name, slots:[size...], skills:{skill:pts}, def, res:[5] }
//   decos: [{ name, size, skill, lv, count }]   count: 所持数 (Infinity = 無制限)
//   conds: [{ skill, level, required }]          配列順 = 優先度（先頭が最優先）
//   skillMax: { skill: maxLevel }
//   opts: { limit, pruneDominated, onlyFullSoft, onProgress }
// }

export const PART_ORDER = ["weapon", "head", "body", "arm", "waist", "leg", "charm"];
const DECO_NODE_LIMIT = 4000;

// ---- 汎用 ----
function slotsVec(slots) {
  // サイズ別個数 [_, n1, n2, n3, n4]
  const v = [0, 0, 0, 0, 0];
  for (const s of slots) if (s > 0) v[Math.min(4, s)]++;
  return v;
}

// サイズ k 以上の装飾品個数 <= サイズ k 以上のスロット数 （k=1..4）を満たせば配置可能
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
  return slots.filter((s) => s > 0).sort((a, b) => b - a);
}

function slotDominates(a, b) {
  // a のスロットが b 以上（降順で要素ごとに比較）
  const A = sortedDesc(a), B = sortedDesc(b);
  for (let i = 0; i < B.length; i++) if ((A[i] || 0) < B[i]) return false;
  return true;
}

// ---- 部位ごとの候補整理 ----
// 対象スキルのポイント＋スロット構成が同一の装備は1グループにまとめる（代替装備として保持）
function buildGroups(items, targets, pruneDominated) {
  const map = new Map();
  for (const it of items) {
    const pts = targets.map((t) => Math.min(it.skills[t.skill] || 0, t.level));
    const slots = sortedDesc(it.slots || []);
    const sig = pts.join(",") + "|" + slots.join(",");
    let g = map.get(sig);
    if (!g) {
      g = { pts, slots, svec: slotsVec(slots), items: [] };
      map.set(sig, g);
    }
    g.items.push(it);
  }
  let groups = [...map.values()];
  // 代表装備: 所持優先度(pref) → 防御力 の順
  for (const g of groups) g.items.sort((a, b) => (b.pref || 0) - (a.pref || 0) || (b.def || 0) - (a.def || 0));
  if (pruneDominated) {
    groups = groups.filter((g) => !groups.some((h) =>
      h !== g && h.pts.every((p, i) => p >= g.pts[i]) && slotDominates(h.slots, g.slots) &&
      (h.pts.some((p, i) => p > g.pts[i]) || !slotDominates(g.slots, h.slots))));
  }
  // 有望なものから探索（結果上限に達した場合でも良い組み合わせが先に出るように）
  const score = (g) => g.pts.reduce((a, b) => a + b, 0) * 3 + g.slots.reduce((a, b) => a + b, 0);
  groups.sort((a, b) => score(b) - score(a));
  return groups;
}

// ---- 装飾品の組み合わせ候補（スキルごと） ----
// points 毎に「最小」な装飾品の組み合わせを列挙する
function decoCombos(decos, maxPts) {
  // decos: このスキルの装飾品 [{idx,size,lv,count}]
  const res = []; // res[p] = [{use:[0..4], cnt: Map(idx->n), p}]
  for (let p = 0; p <= maxPts; p++) res.push([]);
  if (!decos.length || maxPts <= 0) return res;
  const list = decos.slice().sort((a, b) => b.lv - a.lv || a.size - b.size);
  const cur = new Array(list.length).fill(0);
  const out = [];
  function rec(i, pts) {
    if (pts >= maxPts || i === list.length) {
      if (pts > 0) out.push({ counts: cur.slice(), pts: Math.min(pts, maxPts) });
      return;
    }
    const d = list[i];
    const lim = Math.min(d.count, Math.ceil((maxPts - pts) / d.lv));
    for (let n = 0; n <= lim; n++) {
      cur[i] = n;
      rec(i + 1, pts + n * d.lv);
    }
    cur[i] = 0;
  }
  rec(0, 0);
  for (const c of out) {
    // 最小性: どれか1個外しても同じポイントになるなら冗長
    let minimal = true;
    let total = 0;
    for (let i = 0; i < list.length; i++) total += c.counts[i] * list[i].lv;
    for (let i = 0; i < list.length && minimal; i++) {
      if (c.counts[i] > 0 && Math.min(total - list[i].lv, maxPts) >= c.pts) minimal = false;
    }
    if (!minimal) continue;
    const use = [0, 0, 0, 0, 0];
    const cnt = [];
    for (let i = 0; i < list.length; i++) {
      if (c.counts[i]) {
        use[list[i].size] += c.counts[i];
        cnt.push([list[i].idx, c.counts[i]]);
      }
    }
    res[c.pts].push({ use, cnt, p: c.pts });
  }
  // 同ポイントで「より楽な」(サイズk以上の使用数がすべて以下) 組み合わせがあれば除外
  for (let p = 1; p <= maxPts; p++) {
    const arr = res[p];
    const easier = (a, b) => {
      let ua = 0, ub = 0, strict = false;
      for (let k = 4; k >= 1; k--) {
        ua += a.use[k]; ub += b.use[k];
        if (ua > ub) return false;
        if (ua < ub) strict = true;
      }
      return strict;
    };
    const limited = (c) => c.cnt.some(([idx]) => Number.isFinite(decos.find((d) => d.idx === idx).count));
    res[p] = arr.filter((c) => limited(c) || !arr.some((o) => o !== c && !limited(o) && easier(o, c)));
    res[p].sort((a, b) => a.use.reduce((s, n, k) => s + n * k, 0) - b.use.reduce((s, n, k) => s + n * k, 0));
  }
  return res;
}

// ---- 装飾品割り当て（1組み合わせ分） ----
// needs: [{ti, d, required}]  （required が先、その後 優先度順の希望スキル）
// 戻り値: null（必須を満たせない） or { soft:[達成pt], use, picks:[[decoIdx,n]] }
function solveDecos(needs, combosByTi, avail, decoCount) {
  const used = [0, 0, 0, 0, 0];
  const usedDeco = new Map();
  const picks = [];
  let best = null;
  let nodes = 0;
  const softNeeds = needs.filter((n) => !n.required);
  const softVals = [];
  const cache = new Map();
  function atLeast(ti, d) {
    const key = ti * 100 + d;
    let r = cache.get(key);
    if (!r) {
      r = [];
      for (let p = d; p < combosByTi[ti].length; p++) r.push(...combosByTi[ti][p]);
      cache.set(key, r);
    }
    return r;
  }

  function better(vals, freeCap) {
    if (!best) return true;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] !== best.soft[i]) return vals[i] > best.soft[i];
    }
    return freeCap > best.freeCap;
  }
  function canUse(c) {
    for (const [idx, n] of c.cnt) {
      if ((usedDeco.get(idx) || 0) + n > decoCount[idx]) return false;
    }
    return true;
  }
  function apply(c, sign) {
    for (let k = 1; k <= 4; k++) used[k] += sign * c.use[k];
    for (const [idx, n] of c.cnt) usedDeco.set(idx, (usedDeco.get(idx) || 0) + sign * n);
    if (sign > 0) picks.push(...c.cnt);
    else picks.length -= c.cnt.length;
  }
  function freeCapacity() {
    let s = 0;
    for (let k = 1; k <= 4; k++) s += (avail[k] - used[k]) * k;
    return s;
  }
  function rec(i) {
    if (++nodes > DECO_NODE_LIMIT && best) return;
    if (i === needs.length) {
      const fc = freeCapacity();
      if (better(softVals, fc)) best = { soft: softVals.slice(), freeCap: fc, use: used.slice(), picks: picks.slice() };
      return;
    }
    const n = needs[i];
    if (n.required) {
      for (const c of atLeast(n.ti, n.d)) {
        if (!canUse(c)) continue;
        apply(c, 1);
        if (fits(used, avail)) rec(i + 1);
        apply(c, -1);
        if (nodes > DECO_NODE_LIMIT && best) return;
      }
      return;
    }
    // 希望スキル: 上限見積もりで枝刈り
    if (best) {
      const si = softVals.length;
      let cmp = 0;
      for (let j = 0; j < si && cmp === 0; j++) cmp = softVals[j] - best.soft[j];
      if (cmp < 0) return;
      if (cmp === 0) {
        for (let j = si; j < softNeeds.length; j++) {
          const opt = softNeeds[j].d;
          if (opt !== best.soft[j]) { cmp = opt - best.soft[j]; break; }
        }
        if (cmp < 0) return;
      }
    }
    for (let p = n.d; p >= 1; p--) {
      for (const c of (p === n.d ? atLeast(n.ti, p) : combosByTi[n.ti][p])) {
        if (!canUse(c)) continue;
        apply(c, 1);
        if (fits(used, avail)) {
          softVals.push(p);
          rec(i + 1);
          softVals.pop();
        }
        apply(c, -1);
        if (nodes > DECO_NODE_LIMIT && best) return;
      }
    }
    softVals.push(0);
    rec(i + 1);
    softVals.pop();
  }
  rec(0);
  return best;
}

// 装飾品を実スロットに配置（大きい装飾品から、入る中で最小のスロットへ）
function placeDecos(picks, decos, slotList) {
  const list = [];
  for (const [idx, n] of picks) for (let i = 0; i < n; i++) list.push(idx);
  list.sort((a, b) => decos[b].size - decos[a].size);
  const free = slotList.map((s, i) => ({ ...s, i, deco: null }));
  for (const idx of list) {
    let pick = null;
    for (const s of free) {
      if (s.deco === null && s.size >= decos[idx].size && (!pick || s.size < pick.size)) pick = s;
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

  // スキル別装飾品
  const decoBySkill = targets.map((t) =>
    decos.map((d, idx) => ({ idx, size: d.size, lv: d.lv, count: decoCount[idx], skill: d.skill }))
      .filter((d) => d.skill === t.skill && d.count > 0));
  const combosByTi = targets.map((t, i) => decoCombos(decoBySkill[i], t.level));
  const minSize = decoBySkill.map((l) => (l.length ? Math.min(...l.map((d) => d.size)) : 99));
  const maxLv = decoBySkill.map((l) => (l.length ? Math.max(...l.map((d) => d.lv)) : 0));
  const maxDecoPts = decoBySkill.map((l) => l.reduce((s, d) => s + d.lv * Math.min(d.count, 99), 0));

  // 部位ごとのグループ
  const order = PART_ORDER.filter((p) => parts[p]);
  const groupsByPart = order.map((p) => {
    const items = parts[p].length ? parts[p] : [{ key: "none:" + p, name: "（なし）", slots: [], skills: {}, def: 0, res: [0, 0, 0, 0, 0], none: true }];
    return buildGroups(items, targets, opts.pruneDominated);
  });
  const P = order.length;

  // 残り部位で得られる最大値（枝刈り用）
  const sufPts = [], sufSlots = [];
  for (let i = P; i >= 0; i--) {
    if (i === P) { sufPts[i] = new Array(T).fill(0); sufSlots[i] = [0, 0, 0, 0, 0]; continue; }
    const mp = new Array(T).fill(0);
    const ms = [0, 0, 0];
    for (const g of groupsByPart[i]) {
      g.pts.forEach((p, k) => { if (p > mp[k]) mp[k] = p; });
      g.slots.forEach((s, k) => { if (k < 3 && s > ms[k]) ms[k] = s; });
    }
    sufPts[i] = sufPts[i + 1].map((v, k) => v + mp[k]);
    const sv = slotsVec(ms);
    sufSlots[i] = sufSlots[i + 1].map((v, k) => v + sv[k]);
  }

  const results = [];
  let truncated = false;
  let leaves = 0, checked = 0;
  const pts = new Array(T).fill(0);
  const avail = [0, 0, 0, 0, 0];
  const chosen = new Array(P);
  const reqIdx = targets.map((t, i) => (t.required ? i : -1)).filter((i) => i >= 0);
  const softIdx = targets.map((t, i) => (t.required ? -1 : i)).filter((i) => i >= 0);

  function feasibleBound(i) {
    const demand = [0, 0, 0, 0, 0];
    const cap = avail.map((v, k) => v + sufSlots[i][k]);
    for (const k of reqIdx) {
      const d = targets[k].level - pts[k] - sufPts[i][k];
      if (d <= 0) continue;
      if (d > maxDecoPts[k]) return false;
      demand[Math.min(4, minSize[k])] += Math.ceil(d / maxLv[k]);
    }
    return fits(demand, cap);
  }

  let lastReport = 0;
  function leaf() {
    leaves++;
    const needs = [];
    for (const k of reqIdx) {
      const d = targets[k].level - pts[k];
      if (d > 0) needs.push({ ti: k, d, required: true });
    }
    for (const k of softIdx) {
      const d = targets[k].level - pts[k];
      if (d > 0) needs.push({ ti: k, d, required: false });
    }
    const sol = solveDecos(needs, combosByTi, avail, decoCount);
    if (!sol) return;
    // 希望スキル達成度
    const softLv = [];
    let si = 0;
    for (const n of needs) if (!n.required) { softLv[n.ti] = pts[n.ti] + sol.soft[si++]; }
    for (const k of softIdx) if (softLv[k] == null) softLv[k] = Math.min(pts[k], targets[k].level);
    if (opts.onlyFullSoft && softIdx.some((k) => softLv[k] < targets[k].level)) return;
    results.push(makeResult(sol, softLv));
    if (results.length >= opts.limit) truncated = true;
  }

  function makeResult(sol, softLv) {
    const pieces = order.map((p, i) => ({ part: p, group: chosen[i] }));
    // スロット一覧
    const slotList = [];
    pieces.forEach((pc, pi) => pc.group.slots.forEach((s) => slotList.push({ piece: pi, size: s })));
    const placed = placeDecos(sol.picks, decos, slotList);
    // 合計スキル（代表装備の全スキル + 装飾品）
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
      const d = decos[s.deco];
      skills[d.skill] = (skills[d.skill] || 0) + d.lv;
    }
    for (const s of Object.keys(skills)) skills[s] = Math.min(skills[s], skillMax[s] || skills[s]);
    const free = [0, 0, 0, 0, 0];
    for (const s of placed) if (s.deco === null) free[s.size]++;
    // 優先度スコア（希望スキルを優先度順に辞書式比較するための配列）
    const softScore = softIdx.map((k) => softLv[k]);
    return {
      pieces: pieces.map((pc) => ({
        part: pc.part,
        items: pc.group.items.map((it) => it.key),
        slots: pc.group.slots,
      })),
      decos: placed.map((s) => ({ piece: s.piece, size: s.size, deco: s.deco === null ? null : decos[s.deco].name })),
      skills,
      def,
      res,
      free,
      freeCount: free.reduce((a, b) => a + b, 0),
      freeCap: free.reduce((a, n, k) => a + n * k, 0),
      softScore,
      softMet: softIdx.filter((k) => softLv[k] >= targets[k].level).length,
    };
  }

  function dfs(i) {
    if (truncated) return;
    if (i === P) { leaf(); return; }
    for (const g of groupsByPart[i]) {
      if (truncated) return;
      checked++;
      for (let k = 0; k < T; k++) pts[k] += g.pts[k];
      for (let k = 1; k <= 4; k++) avail[k] += g.svec[k];
      chosen[i] = g;
      if (feasibleBound(i + 1)) dfs(i + 1);
      for (let k = 0; k < T; k++) pts[k] -= g.pts[k];
      for (let k = 1; k <= 4; k++) avail[k] -= g.svec[k];
      if (opts.onProgress && (checked & 4095) === 0) {
        const now = Date.now();
        if (now - lastReport > 300) { lastReport = now; opts.onProgress({ checked, leaves, found: results.length }); }
      }
    }
  }

  if (feasibleBound(0)) dfs(0);

  // 初期並び: 希望スキル(優先度順) → 空きスロット → 防御力
  results.sort((a, b) => {
    for (let i = 0; i < a.softScore.length; i++) if (a.softScore[i] !== b.softScore[i]) return b.softScore[i] - a.softScore[i];
    return b.freeCap - a.freeCap || b.def - a.def;
  });

  return {
    results,
    truncated,
    stats: {
      ms: Date.now() - t0,
      leaves,
      checked,
      groups: Object.fromEntries(order.map((p, i) => [p, groupsByPart[i].length])),
    },
    targets,
  };
}

export const _internal = { fits, decoCombos, solveDecos, buildGroups };
