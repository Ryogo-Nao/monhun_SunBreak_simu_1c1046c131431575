import { getState, update, save, exportJSON, importJSON, resetAll, uid } from "./store.js";

// ======================================================================
// マスタデータ
// ======================================================================
const PARTS = ["head", "body", "arm", "waist", "leg"];
const PART_LABEL = { weapon: "武器", head: "頭", body: "胴", arm: "腕", waist: "腰", leg: "脚", charm: "護石" };
const WEAPON_TYPES = ["大剣", "太刀", "片手剣", "双剣", "ハンマー", "狩猟笛", "ランス", "ガンランス", "スラッシュアックス", "チャージアックス", "操虫棍", "ライトボウガン", "ヘビィボウガン", "弓"];
const RES_LABEL = ["火", "水", "雷", "氷", "龍"];

let M = null;            // master.json
let SKILL = {};          // name -> skill
let ARMOR = {};          // id -> armor
let DECO = {};           // name -> deco
let CATS = [];           // スキルカテゴリ一覧

const S = () => getState();
const view = document.getElementById("view");
const modalRoot = document.getElementById("modal-root");

// 検索結果（メモリのみ）
let last = null;         // { out, keyMap, conds, at }
let worker = null;
let tab = "search";
let equipTab = "armor";
let resultShown = 30;

// ======================================================================
// ユーティリティ
// ======================================================================
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function norm(s) {
  return String(s || "").normalize("NFKC").toLowerCase().replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}
function slotsHTML(slots, opt = {}) {
  const arr = (slots || []).filter((s) => s > 0).sort((a, b) => b - a);
  const n = opt.pad ? Math.max(3, arr.length) : arr.length;
  let h = '<span class="slots">';
  for (let i = 0; i < n; i++) {
    const s = arr[i];
    h += s ? `<span class="slot s${s}">${s}</span>` : '<span class="slot empty">-</span>';
  }
  if (!n) h += '<span class="muted small">なし</span>';
  return h + "</span>";
}
function skillChips(skills, opt = {}) {
  const ent = Object.entries(skills || {}).filter(([, v]) => v !== 0);
  if (!ent.length) return opt.empty === false ? "" : '<span class="muted small">スキルなし</span>';
  const tg = opt.targets || {};
  return ent.map(([k, v]) => {
    let cls = "chip";
    if (v < 0) cls += " minus";
    else if (tg[k] != null) cls += v >= tg[k] ? " ok" : " ng";
    return `<span class="${cls}">${esc(k)}${opt.delta && v > 0 ? "+" : opt.delta ? "" : "Lv"}${v}</span>`;
  }).join("");
}
function slotSum(slots) { return (slots || []).reduce((a, b) => a + b, 0); }
function slotCount(slots, min = 1) { return (slots || []).filter((s) => s >= min).length; }
function cmp(a, b) {
  if (typeof a === "string" || typeof b === "string") return String(a ?? "").localeCompare(String(b ?? ""), "ja");
  return (a ?? 0) - (b ?? 0);
}
function sorted(list, key, dir, keyFns) {
  const fn = keyFns[key] || (key.startsWith("skill:") ? keyFns.__skill(key.slice(6)) : null);
  if (!fn) return list;
  const d = dir === "asc" ? 1 : -1;
  return list.map((x, i) => [x, fn(x), i]).sort((a, b) => cmp(a[1], b[1]) * d || a[2] - b[2]).map((x) => x[0]);
}
function sortState(id, defKey, defDir = "desc") {
  const ui = S().ui;
  ui.sort = ui.sort || {};
  if (!ui.sort[id]) ui.sort[id] = { key: defKey, dir: defDir };
  return ui.sort[id];
}
// ソートバー: options = [[key,label],...]  スキル指定ソートを含む
function sortBar(id, options, defKey, defDir) {
  const st = sortState(id, defKey, defDir);
  let opts = options.slice();
  if (st.key.startsWith("skill:") && !opts.some((o) => o[0] === st.key)) opts.push([st.key, "スキル: " + st.key.slice(6)]);
  return `<div class="sortbar" data-sort="${id}">
    <span class="lbl">並び替え</span>
    <select data-act="sort-key">${opts.map(([k, l]) => `<option value="${esc(k)}" ${k === st.key ? "selected" : ""}>${esc(l)}</option>`).join("")}
      <option value="__pick">スキルLvで並べる…</option></select>
    <button class="btn sm" data-act="sort-dir">${st.dir === "asc" ? "▲ 昇順" : "▼ 降順"}</button>
  </div>`;
}
function armorSkills(a) { return a.skills; }
function quriousItem(q) {
  const base = ARMOR[q.base];
  if (!base) return null;
  const skills = { ...base.skills };
  for (const [k, v] of Object.entries(q.delta || {})) {
    skills[k] = (skills[k] || 0) + v;
    if (skills[k] <= 0) delete skills[k];
  }
  return {
    key: "q:" + q.id, q, base, part: base.part, name: base.name, note: q.note || "",
    slots: (q.slots || []).filter((s) => s > 0).sort((a, b) => b - a),
    skills, def: base.def + (q.defDelta || 0),
    res: base.res.map((v, i) => v + ((q.resDelta || [])[i] || 0)),
    rarity: base.rarity,
  };
}
function charmItem(c) {
  const skills = {};
  for (const [k, v] of c.skills || []) if (k && v) skills[k] = (skills[k] || 0) + v;
  return { key: "c:" + c.id, c, name: "護石" + (c.note ? "（" + c.note + "）" : ""), slots: (c.slots || []).filter((s) => s > 0).sort((a, b) => b - a), skills, def: 0, res: [0, 0, 0, 0, 0] };
}
function weaponItem(w) {
  return { key: "w:" + w.id, w, name: w.name || "武器", slots: (w.slots || []).filter((s) => s > 0).sort((a, b) => b - a), skills: {}, def: 0, res: [0, 0, 0, 0, 0] };
}
function sexOk(a) {
  const sx = S().settings.sex;
  return !a.sex || !sx || a.sex === sx;
}
function download(name, text) {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ======================================================================
// モーダル
// ======================================================================
function openModal({ title, body, foot = "", onMount, wide }) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${wide ? 'style="max-width:860px"' : ""}>
    <div class="mh"><h3>${esc(title)}</h3><button class="btn sm" data-close>閉じる</button></div>
    <div class="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ""}</div>`;
  const close = () => back.remove();
  back.addEventListener("click", (e) => {
    if (e.target === back || e.target.closest("[data-close]")) close();
  });
  modalRoot.appendChild(back);
  onMount && onMount(back.querySelector(".modal"), close);
  return close;
}

// スキル選択モーダル
function pickSkill({ title = "スキルを選択", onPick, multi = false, selected = [] }) {
  let q = "", cat = "";
  const sel = new Set(selected);
  openModal({
    title,
    body: `<input type="search" placeholder="スキル名で検索" data-q style="width:100%">
      <div class="chips" style="margin:8px 0" data-cats>
        <button class="chip on" data-cat="">すべて</button>${CATS.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}
      </div>
      <div class="pick-list" data-list></div>`,
    foot: multi ? '<button class="btn primary" data-close>完了</button>' : "",
    onMount(m, close) {
      const list = m.querySelector("[data-list]");
      const render = () => {
        const nq = norm(q);
        let h = "", lastCat = null;
        for (const s of M.skills) {
          if (cat && s.cat !== cat) continue;
          if (nq && !norm(s.name).includes(nq)) continue;
          if (s.cat !== lastCat) { h += `<div class="cat">${esc(s.cat)}</div>`; lastCat = s.cat; }
          h += `<button data-skill="${esc(s.name)}" class="${sel.has(s.name) ? "sel" : ""}">${sel.has(s.name) ? "✓ " : ""}${esc(s.name)} <span class="muted small">最大Lv${s.max}</span></button>`;
        }
        list.innerHTML = h || '<p class="muted">該当なし</p>';
      };
      render();
      m.querySelector("[data-q]").addEventListener("input", (e) => { q = e.target.value; render(); });
      m.querySelector("[data-cats]").addEventListener("click", (e) => {
        const b = e.target.closest("[data-cat]");
        if (!b) return;
        cat = b.dataset.cat;
        m.querySelectorAll("[data-cat]").forEach((x) => x.classList.toggle("on", x === b));
        render();
      });
      list.addEventListener("click", (e) => {
        const b = e.target.closest("[data-skill]");
        if (!b) return;
        const name = b.dataset.skill;
        if (multi) {
          if (sel.has(name)) return;
          sel.add(name);
          onPick(name);
          render();
        } else {
          close();
          onPick(name);
        }
      });
    },
  });
}

// 防具選択モーダル
function pickArmor({ onPick, part = "head" }) {
  let q = "", p = part;
  openModal({
    title: "ベース防具を選択",
    body: `<div class="seg" data-parts>${PARTS.map((x) => `<button data-p="${x}" class="${x === p ? "on" : ""}">${PART_LABEL[x]}</button>`).join("")}</div>
      <input type="search" placeholder="防具名・スキル名で検索" data-q style="width:100%;margin-top:8px">
      <div class="pick-list" data-list style="margin-top:6px"></div>`,
    onMount(m, close) {
      const list = m.querySelector("[data-list]");
      const render = () => {
        const nq = norm(q);
        const arr = M.armors.filter((a) => a.part === p && (!nq || norm(a.name).includes(nq) || Object.keys(a.skills).some((s) => norm(s).includes(nq))));
        list.innerHTML = arr.slice(0, 300).map((a) => `<button data-id="${esc(a.id)}"><span class="grow"><b>${esc(a.name)}</b><br><span class="muted small">R${a.rarity} 防${a.def} ${Object.entries(a.skills).map(([k, v]) => esc(k) + v).join(" ")}</span></span>${slotsHTML(a.slots)}</button>`).join("") || '<p class="muted">該当なし</p>';
      };
      render();
      m.querySelector("[data-q]").addEventListener("input", (e) => { q = e.target.value; render(); });
      m.querySelector("[data-parts]").addEventListener("click", (e) => {
        const b = e.target.closest("[data-p]");
        if (!b) return;
        p = b.dataset.p;
        m.querySelectorAll("[data-p]").forEach((x) => x.classList.toggle("on", x === b));
        render();
      });
      list.addEventListener("click", (e) => {
        const b = e.target.closest("[data-id]");
        if (!b) return;
        close();
        onPick(ARMOR[b.dataset.id]);
      });
    },
  });
}

function slotSelects(slots, name = "slot") {
  const arr = (slots || []).slice().sort((a, b) => b - a);
  return [0, 1, 2].map((i) => `<select data-${name}="${i}">${[0, 1, 2, 3, 4].map((v) => `<option value="${v}" ${(arr[i] || 0) === v ? "selected" : ""}>${v ? "Lv" + v : "なし"}</option>`).join("")}</select>`).join("");
}
function readSlots(m, name = "slot") {
  return [...m.querySelectorAll(`[data-${name}]`)].map((s) => +s.value).filter((v) => v > 0).sort((a, b) => b - a);
}

// ======================================================================
// 画面: 検索
// ======================================================================
function renderSearch() {
  const st = S();
  const o = st.simOpts;
  const conds = st.conds;
  const weapons = st.weapons;
  const condHTML = conds.length ? conds.map((c, i) => {
    const sk = SKILL[c.skill];
    const max = sk ? sk.max : 7;
    return `<div class="cond ${c.required ? "req" : ""}" data-i="${i}">
      <span class="pri" title="優先度">${i + 1}</span>
      <span class="nm">${esc(c.skill)}</span>
      <span class="ctl">
        <button class="btn sm icon" data-act="cond-up" ${i === 0 ? "disabled" : ""} aria-label="優先度を上げる">↑</button>
        <button class="btn sm icon" data-act="cond-down" ${i === conds.length - 1 ? "disabled" : ""} aria-label="優先度を下げる">↓</button>
        <button class="btn sm icon danger" data-act="cond-del" aria-label="削除">✕</button>
      </span>
      <span class="ctl2">
        <select data-act="cond-lv">${Array.from({ length: max }, (_, k) => k + 1).map((v) => `<option value="${v}" ${v === c.level ? "selected" : ""}>Lv${v}${v === max ? "(最大)" : ""}</option>`).join("")}</select>
        <label class="inline"><input type="checkbox" class="mini-switch" data-act="cond-req" ${c.required ? "checked" : ""}> 必須</label>
        ${!c.required ? '<span class="muted small">希望（優先度順に満たす）</span>' : ""}
      </span></div>`;
  }).join("") : '<p class="muted">「＋スキル追加」から発動させたいスキルを選んでください。</p>';

  const qCount = st.qurious.filter((q) => q.enabled !== false).length;
  const ownCount = Object.keys(st.ownedArmor).length;
  const charmCount = st.charms.filter((c) => c.enabled !== false).length;

  view.innerHTML = `
  <div class="grid2">
  <div>
    <h2><span class="grow">スキル条件</span>
      <button class="btn sm" data-act="cond-clear" ${conds.length ? "" : "disabled"}>クリア</button>
      <button class="btn sm primary" data-act="cond-add">＋スキル追加</button></h2>
    <div class="card">${condHTML}</div>
    <p class="muted small">上から順に優先度が高くなります。<b>必須</b>スキルは必ず満たす組み合わせのみを表示し、必須でない（希望）スキルは優先度の高いものから順に、できるだけ満たすように装飾品を割り当てます。</p>
  </div>
  <div>
    <h2>武器スロット</h2>
    <div class="card">
      <div class="form-row"><select data-act="weapon-sel" class="grow">
        <option value="manual" ${o.weapon === "manual" ? "selected" : ""}>スロットを直接指定</option>
        ${weapons.length ? `<option value="all" ${o.weapon === "all" ? "selected" : ""}>登録武器すべてから探す（${weapons.filter((w) => w.enabled !== false).length}件）</option>` : ""}
        ${weapons.map((w) => `<option value="${w.id}" ${o.weapon === w.id ? "selected" : ""}>${esc(w.name)}（${(w.slots || []).join("-") || "スロなし"}）</option>`).join("")}
      </select></div>
      <div class="form-row ${o.weapon === "manual" ? "" : "hide"}"><span class="lbl">スロット</span>${slotSelects(o.weaponSlots, "wslot")}</div>
    </div>
    <h2>検索対象</h2>
    <div class="card">
      <label class="switch"><span class="txt">所持していない防具も対象にする<small>OFF: 所持登録した防具（${ownCount}件）と傀異錬成防具のみ</small></span><input type="checkbox" data-opt="includeUnowned" ${o.includeUnowned ? "checked" : ""}></label>
      <label class="switch"><span class="txt">傀異錬成防具を対象にする<small>登録済み ${qCount}件</small></span><input type="checkbox" data-opt="includeQurious" ${o.includeQurious ? "checked" : ""}></label>
      <label class="switch"><span class="txt">装飾品の所持数を考慮する<small>OFF: すべての装飾品を無制限に使える前提</small></span><input type="checkbox" data-opt="useDecoCount" ${o.useDecoCount ? "checked" : ""}></label>
      <label class="switch"><span class="txt">下位互換の防具を除外する（推奨）<small>条件スキルとスロットが完全に劣る防具を省いて高速化</small></span><input type="checkbox" data-opt="pruneDominated" ${o.pruneDominated ? "checked" : ""}></label>
      <label class="switch"><span class="txt">希望スキルもすべて満たすものだけ表示</span><input type="checkbox" data-opt="onlyFullSoft" ${o.onlyFullSoft ? "checked" : ""}></label>
      <div class="form-row"><span class="lbl">最大件数</span><select data-act="limit">${[500, 1000, 5000, 20000, 100000].map((v) => `<option value="${v}" ${o.limit === v ? "selected" : ""}>${v.toLocaleString()}件</option>`).join("")}</select></div>
      <p class="muted small" style="margin:4px 0 0">護石: ${charmCount}件登録済み（${charmCount ? "すべて候補" : "護石なしで検索"}）／ 性別: ${["指定なし", "男性", "女性"][st.settings.sex]}（設定で変更）</p>
    </div>
  </div>
  </div>
  <div class="runbar">
    <button class="btn primary block" data-act="run" ${conds.length ? "" : "disabled"}>この条件で検索</button>
    <button class="btn hide" data-act="cancel">中止</button>
  </div>
  <div class="progress" id="progress"></div>`;
}

function buildInput() {
  const st = S();
  const o = st.simOpts;
  const parts = {};
  const keyMap = {};
  for (const p of PARTS) {
    const arr = [];
    for (const a of M.armors) {
      if (a.part !== p || !sexOk(a) || st.excludedArmor[a.id]) continue;
      if (!o.includeUnowned && !st.ownedArmor[a.id]) continue;
      const it = { key: a.id, name: a.name, slots: a.slots, skills: a.skills, def: a.def, res: a.res, pref: st.ownedArmor[a.id] ? 1 : 0 };
      arr.push(it);
      keyMap[it.key] = { ...it, kind: "armor", rarity: a.rarity };
    }
    if (o.includeQurious) {
      for (const q of st.qurious) {
        if (q.enabled === false) continue;
        const it = quriousItem(q);
        if (!it || it.part !== p || !sexOk(it.base)) continue;
        arr.push({ key: it.key, name: it.name, slots: it.slots, skills: it.skills, def: it.def, res: it.res, pref: 2 });
        keyMap[it.key] = { ...it, kind: "qurious" };
      }
    }
    parts[p] = arr;
  }
  parts.charm = st.charms.filter((c) => c.enabled !== false).map((c) => {
    const it = charmItem(c);
    keyMap[it.key] = { ...it, kind: "charm" };
    return { key: it.key, name: it.name, slots: it.slots, skills: it.skills, def: 0, res: it.res };
  });
  let ws;
  if (o.weapon === "manual" || !st.weapons.length) {
    ws = [{ key: "w:manual", name: "武器（スロット指定）", slots: o.weaponSlots.filter((s) => s > 0), skills: {}, def: 0, res: [0, 0, 0, 0, 0] }];
  } else if (o.weapon === "all") {
    ws = st.weapons.filter((w) => w.enabled !== false).map(weaponItem);
  } else {
    const w = st.weapons.find((x) => x.id === o.weapon);
    ws = w ? [weaponItem(w)] : [{ key: "w:manual", name: "武器（スロット指定）", slots: o.weaponSlots.filter((s) => s > 0), skills: {}, def: 0 }];
  }
  if (!ws.length) ws = [{ key: "w:manual", name: "武器", slots: [], skills: {}, def: 0 }];
  for (const w of ws) keyMap[w.key] = { ...w, kind: "weapon" };
  parts.weapon = ws.map((w) => ({ key: w.key, name: w.name, slots: w.slots, skills: {}, def: 0, res: [0, 0, 0, 0, 0] }));

  const decos = M.decos.map((d) => ({
    name: d.name, size: d.size, skill: d.skill, lv: d.lv,
    count: o.useDecoCount ? (st.decoCount[d.name] == null ? null : st.decoCount[d.name]) : null,
  }));
  const skillMax = Object.fromEntries(M.skills.map((s) => [s.name, s.max]));
  return {
    input: { parts, decos, conds: st.conds.map((c) => ({ ...c })), skillMax, opts: { limit: o.limit, pruneDominated: o.pruneDominated, onlyFullSoft: o.onlyFullSoft } },
    keyMap,
  };
}

function runSearch() {
  const { input, keyMap } = buildInput();
  const prog = document.getElementById("progress");
  const runBtn = view.querySelector('[data-act="run"]');
  const cancelBtn = view.querySelector('[data-act="cancel"]');
  if (worker) worker.terminate();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  runBtn.disabled = true;
  runBtn.textContent = "検索中…";
  cancelBtn.classList.remove("hide");
  prog.textContent = "探索を開始しました…";
  const t0 = Date.now();
  const finish = () => {
    runBtn.disabled = false;
    runBtn.textContent = "この条件で検索";
    cancelBtn.classList.add("hide");
  };
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") {
      prog.textContent = `探索中… ${m.found.toLocaleString()}件見つかりました（${((Date.now() - t0) / 1000).toFixed(1)}秒）`;
    } else if (m.type === "done") {
      worker.terminate();
      worker = null;
      finish();
      last = { out: m.out, keyMap, conds: input.conds, at: new Date() };
      resultShown = 30;
      prog.textContent = "";
      toast(`${m.out.results.length.toLocaleString()}件見つかりました`);
      setTab("results");
    } else if (m.type === "error") {
      worker.terminate();
      worker = null;
      finish();
      prog.textContent = "エラー: " + m.message;
    }
  };
  worker.onerror = (e) => {
    finish();
    prog.textContent = "エラー: " + (e.message || "Worker の起動に失敗しました");
  };
  worker.postMessage(input);
  cancelBtn.onclick = () => {
    if (worker) worker.terminate();
    worker = null;
    finish();
    prog.textContent = "中止しました";
  };
}

// ======================================================================
// 画面: 結果
// ======================================================================
function resultKeyFns() {
  return {
    priority: (r) => r._i,
    freeCount: (r) => r.freeCount,
    freeCap: (r) => r.freeCap,
    free4: (r) => r.free[4],
    free3: (r) => r.free[3] + r.free[4],
    free2: (r) => r.free[2] + r.free[3] + r.free[4],
    def: (r) => r.def,
    res0: (r) => r.res[0], res1: (r) => r.res[1], res2: (r) => r.res[2], res3: (r) => r.res[3], res4: (r) => r.res[4],
    softMet: (r) => r.softMet,
    owned: (r) => r.pieces.filter((p) => { const it = last.keyMap[p.items[0]]; return it && (it.kind === "qurious" || it.kind === "charm" || (it.kind === "armor" && S().ownedArmor[it.key])); }).length,
    skillTotal: (r) => Object.values(r.skills).reduce((a, b) => a + b, 0),
    __skill: (name) => (r) => r.skills[name] || 0,
  };
}
const RESULT_SORTS = () => [
  ["priority", "優先度順（希望スキル達成度）"],
  ["freeCount", "空きスロット数"],
  ["freeCap", "空きスロット合計Lv"],
  ["free4", "空きLv4スロット数"],
  ["free3", "空きLv3以上スロット数"],
  ["free2", "空きLv2以上スロット数"],
  ["def", "防御力"],
  ...RES_LABEL.map((l, i) => ["res" + i, l + "耐性"]),
  ["softMet", "希望スキル達成数"],
  ["owned", "所持装備（所持防具・傀異・護石）の数"],
  ["skillTotal", "スキルLv合計"],
  ...(last ? last.conds.map((c) => ["skill:" + c.skill, "スキル: " + c.skill]) : []),
];

function renderResults() {
  if (!last) {
    view.innerHTML = '<h2>検索結果</h2><div class="card"><p class="muted">まだ検索していません。「検索」タブで条件を設定して検索してください。</p></div>';
    return;
  }
  const { out } = last;
  out.results.forEach((r, i) => (r._i = i));
  const st = sortState("results", "priority", "asc");
  const filter = S().ui.resFilter || "";
  let list = out.results;
  if (filter) {
    const nq = norm(filter);
    list = list.filter((r) => r.pieces.some((p) => p.items.some((k) => norm(last.keyMap[k]?.name).includes(nq))) || Object.keys(r.skills).some((s) => norm(s).includes(nq)));
  }
  list = sorted(list, st.key, st.dir, resultKeyFns());
  const targets = Object.fromEntries(last.conds.map((c) => [c.skill, c.level]));
  const shown = list.slice(0, resultShown);
  const g = out.stats.groups;
  view.innerHTML = `
    <h2><span class="grow">検索結果 ${out.results.length.toLocaleString()}件</span><span class="muted small">${(out.stats.ms / 1000).toFixed(2)}秒</span></h2>
    ${out.truncated ? `<div class="notice">最大件数（${out.results.length.toLocaleString()}件）に達したため探索を打ち切りました。すべての組み合わせを見るには検索タブで最大件数を増やすか、条件を絞ってください。</div>` : ""}
    ${!out.results.length ? '<div class="notice">条件を満たす組み合わせが見つかりませんでした。必須スキルを減らす・Lvを下げる・「所持していない防具も対象にする」をONにする などを試してください。</div>' : ""}
    <div class="card">
      <div class="muted small">条件: ${last.conds.map((c) => `${esc(c.skill)}Lv${c.level}${c.required ? "(必須)" : ""}`).join(" / ")}</div>
      <div class="muted small">候補数（同等装備をまとめた後）: ${Object.entries(g).map(([p, n]) => PART_LABEL[p] + n).join(" ")}</div>
      ${sortBar("results", RESULT_SORTS(), "priority", "asc")}
      <input type="search" placeholder="防具名・スキル名で絞り込み" data-act="res-filter" value="${esc(filter)}" style="width:100%">
    </div>
    <div class="list cols" style="margin-top:10px">${shown.map((r) => resultCard(r, targets)).join("")}</div>
    ${list.length > resultShown ? `<button class="btn block" style="margin-top:10px" data-act="more">さらに表示（残り ${(list.length - resultShown).toLocaleString()}件）</button>` : ""}
  `;
}

function resultCard(r, targets) {
  const km = last.keyMap;
  const rows = r.pieces.map((p, pi) => {
    const main = km[p.items[0]];
    const decos = r.decos.filter((d) => d.piece === pi);
    const decoTxt = decos.map((d) => d.deco ? `<span class="slot s${d.size}">${d.size}</span>${esc(d.deco)}` : `<span class="slot free s${d.size}">${d.size}</span>空き`).join(" ");
    const tag = main?.kind === "qurious" ? '<span class="tag q">傀異</span> ' : main?.kind === "armor" && S().ownedArmor[main.key] ? '<span class="tag own">所持</span> ' : "";
    const alts = p.items.length > 1 ? `<button class="alt" data-act="alts" data-k="${esc(p.items.join("\n"))}">他${p.items.length - 1}件の同等装備</button>` : "";
    const name = main ? main.name + (main.kind === "qurious" && main.note ? `（${main.note}）` : "") : "（なし）";
    return `<tr><td class="p">${PART_LABEL[p.part]}</td><td class="n">${tag}${esc(name)} ${alts}
      ${decos.length ? `<div class="decos">${decoTxt}</div>` : ""}</td></tr>`;
  }).join("");
  const skills = Object.fromEntries(Object.entries(r.skills).sort((a, b) => (targets[b[0]] != null) - (targets[a[0]] != null) || b[1] - a[1]));
  return `<div class="item">
    <div class="res-head"><span class="no">#${r._i + 1}</span>
      <span class="muted small">防御 <b>${r.def}</b></span>
      <span class="muted small">空き ${r.freeCount ? r.free.map((n, k) => (k && n ? `<span class="slot free s${k}">${k}</span>×${n}` : "")).join(" ") : "なし"}</span>
      <button class="btn sm right" data-act="save-set" data-i="${r._i}">⭐保存</button></div>
    <table class="pieces">${rows}</table>
    <div class="chips" style="margin-top:6px">${skillChips(skills, { targets })}</div>
    <div class="muted small" style="margin-top:4px">耐性 ${RES_LABEL.map((l, i) => l + r.res[i]).join(" ")}</div>
  </div>`;
}

function snapshot(r) {
  const km = last.keyMap;
  return {
    id: uid(),
    savedAt: Date.now(),
    conds: last.conds,
    pieces: r.pieces.map((p, pi) => ({
      part: p.part,
      name: km[p.items[0]]?.name || "（なし）",
      kind: km[p.items[0]]?.kind,
      note: km[p.items[0]]?.note || "",
      decos: r.decos.filter((d) => d.piece === pi).map((d) => ({ size: d.size, deco: d.deco })),
    })),
    skills: r.skills, def: r.def, res: r.res, free: r.free, freeCount: r.freeCount, freeCap: r.freeCap, memo: "",
  };
}

// ======================================================================
// 画面: 装備
// ======================================================================
function renderEquip() {
  const tabs = [["armor", "防具"], ["qurious", "傀異錬成"], ["charm", "護石"], ["weapon", "武器"], ["deco", "装飾品"]];
  view.innerHTML = `<div class="seg" data-equip-tabs>${tabs.map(([k, l]) => `<button data-et="${k}" class="${equipTab === k ? "on" : ""}">${l}</button>`).join("")}</div><div id="equip-body"></div>`;
  renderEquipBody();
}
function renderEquipBody() {
  const el = document.getElementById("equip-body");
  if (!el) return;
  if (equipTab === "armor") el.innerHTML = armorView();
  else if (equipTab === "qurious") el.innerHTML = quriousView();
  else if (equipTab === "charm") el.innerHTML = charmView();
  else if (equipTab === "weapon") el.innerHTML = weaponView();
  else el.innerHTML = decoView();
}

const armorKeyFns = {
  name: (a) => a.name, rarity: (a) => a.rarity, def: (a) => a.def, no: (a) => a.no,
  slotSum: (a) => slotSum(a.slots), slot4: (a) => slotCount(a.slots, 4), slotCount: (a) => slotCount(a.slots),
  skillTotal: (a) => Object.values(a.skills).reduce((x, y) => x + y, 0),
  owned: (a) => (S().ownedArmor[a.id] ? 1 : 0),
  __skill: (n) => (a) => a.skills[n] || 0,
};
const ARMOR_SORTS = [["no", "標準（データ順）"], ["name", "名前"], ["rarity", "レア度"], ["def", "防御力"], ["slotSum", "スロット合計Lv"], ["slotCount", "スロット数"], ["slot4", "Lv4スロット数"], ["skillTotal", "スキルLv合計"], ["owned", "所持"]];

function armorFilterList() {
  const st = S();
  const ui = st.ui;
  const part = ui.armorPart || "head";
  const nq = norm(ui.armorQ || "");
  let arr = M.armors.filter((a) => a.part === part && sexOk(a));
  if (ui.armorOwned) arr = arr.filter((a) => st.ownedArmor[a.id]);
  if (nq) arr = arr.filter((a) => norm(a.name).includes(nq) || Object.keys(a.skills).some((s) => norm(s).includes(nq)));
  const ss = sortState("armor", "no", "asc");
  return sorted(arr, ss.key, ss.dir, armorKeyFns);
}
function armorView() {
  const st = S();
  const ui = st.ui;
  const part = ui.armorPart || "head";
  const arr = armorFilterList();
  const ownN = Object.keys(st.ownedArmor).length;
  return `
    <h2><span class="grow">防具（所持 ${ownN}件）</span></h2>
    <div class="card">
      <div class="seg" data-armor-parts>${PARTS.map((p) => `<button data-ap="${p}" class="${p === part ? "on" : ""}">${PART_LABEL[p]}</button>`).join("")}</div>
      <div class="row" style="margin-top:8px"><input type="search" class="grow" placeholder="防具名・スキル名で検索" data-act="armor-q" value="${esc(ui.armorQ || "")}"></div>
      <label class="switch"><span class="txt">所持している防具のみ表示</span><input type="checkbox" data-ui="armorOwned" ${ui.armorOwned ? "checked" : ""}></label>
      ${sortBar("armor", ARMOR_SORTS, "no", "asc")}
      <div class="row"><button class="btn sm" data-act="own-all">表示中をすべて所持にする</button><button class="btn sm" data-act="own-none">表示中の所持を解除</button></div>
    </div>
    <p class="muted small">「所持」にチェックした防具は、検索タブの「所持していない防具も対象にする」をOFFにしたときの候補になります。「除外」をONにすると常に検索対象外です。</p>
    <div class="list cols" id="armor-list">${armorRows(arr)}</div>`;
}
function armorRows(arr) {
  const st = S();
  const qByBase = {};
  for (const q of st.qurious) qByBase[q.base] = (qByBase[q.base] || 0) + 1;
  return arr.map((a) => `<div class="item ${st.excludedArmor[a.id] ? "off" : ""}" data-id="${esc(a.id)}">
      <div class="ttl"><span class="grow">${esc(a.name)}</span>${slotsHTML(a.slots, { pad: true })}</div>
      <div class="meta"><span>R${a.rarity}</span><span>防御${a.def}</span><span>${RES_LABEL.map((l, i) => l + a.res[i]).join(" ")}</span>${a.sex ? `<span>${a.sex === 1 ? "男性用" : "女性用"}</span>` : ""}${qByBase[a.id] ? `<span class="tag q">傀異 ${qByBase[a.id]}件</span>` : ""}</div>
      <div class="chips">${skillChips(a.skills)}</div>
      <div class="acts">
        <label class="inline"><input type="checkbox" class="mini-switch" data-act="own" ${st.ownedArmor[a.id] ? "checked" : ""}>所持</label>
        <label class="inline"><input type="checkbox" class="mini-switch" data-act="exclude" ${st.excludedArmor[a.id] ? "checked" : ""}>除外</label>
        <button class="btn sm right" data-act="q-new-from">＋傀異錬成として登録</button>
      </div></div>`).join("") || '<p class="muted">該当する防具がありません</p>';
}

const qKeyFns = {
  added: (x) => x.q.createdAt || 0, name: (x) => x.name, part: (x) => PARTS.indexOf(x.part), def: (x) => x.def,
  slotSum: (x) => slotSum(x.slots), slot4: (x) => slotCount(x.slots, 4), slotCount: (x) => slotCount(x.slots),
  skillTotal: (x) => Object.values(x.skills).reduce((a, b) => a + b, 0),
  __skill: (n) => (x) => x.skills[n] || 0,
};
const Q_SORTS = [["added", "登録順"], ["part", "部位"], ["name", "名前"], ["def", "防御力"], ["slotSum", "スロット合計Lv"], ["slotCount", "スロット数"], ["slot4", "Lv4スロット数"], ["skillTotal", "スキルLv合計"]];
function quriousView() {
  const st = S();
  const ss = sortState("qurious", "added", "desc");
  const fp = st.ui.qPart || "";
  let arr = st.qurious.map(quriousItem).filter(Boolean);
  if (fp) arr = arr.filter((x) => x.part === fp);
  arr = sorted(arr, ss.key, ss.dir, qKeyFns);
  return `
    <h2><span class="grow">傀異錬成防具（${st.qurious.length}件）</span>
      <button class="btn sm" data-act="q-import">インポート</button>
      <button class="btn sm primary" data-act="q-new">＋登録</button></h2>
    <div class="card">
      <div class="seg" data-q-parts><button data-qp="" class="${!fp ? "on" : ""}">すべて</button>${PARTS.map((p) => `<button data-qp="${p}" class="${p === fp ? "on" : ""}">${PART_LABEL[p]}</button>`).join("")}</div>
      ${sortBar("qurious", Q_SORTS, "added", "desc")}
    </div>
    <div class="list cols" style="margin-top:10px">${arr.map((x) => {
      const delta = x.q.delta || {};
      return `<div class="item ${x.q.enabled === false ? "off" : ""}" data-qid="${x.q.id}">
        <div class="ttl"><span class="tag part">${PART_LABEL[x.part]}</span><span class="grow">${esc(x.name)}${x.note ? ` <span class="muted small">${esc(x.note)}</span>` : ""}</span>${slotsHTML(x.slots, { pad: true })}</div>
        <div class="meta"><span>防御${x.def}${x.q.defDelta ? `（${x.q.defDelta > 0 ? "+" : ""}${x.q.defDelta}）` : ""}</span><span>${RES_LABEL.map((l, i) => l + x.res[i]).join(" ")}</span></div>
        <div class="chips">${skillChips(x.skills)}</div>
        ${Object.keys(delta).length ? `<div class="chips" style="margin-top:4px"><span class="muted small">錬成:</span>${skillChips(delta, { delta: true })}</div>` : ""}
        <div class="acts">
          <label class="inline"><input type="checkbox" class="mini-switch" data-act="q-enable" ${x.q.enabled !== false ? "checked" : ""}>検索対象</label>
          <span class="right"></span>
          <button class="btn sm" data-act="q-copy">複製</button>
          <button class="btn sm" data-act="q-edit">編集</button>
          <button class="btn sm danger" data-act="q-del">削除</button>
        </div></div>`;
    }).join("") || '<p class="muted">登録された傀異錬成防具はありません。「＋登録」または防具一覧の「＋傀異錬成として登録」から追加できます。</p>'}</div>`;
}

function quriousForm(q, base, asCopy = false) {
  // q: 既存 or null（asCopy: 複製として新規登録）
  const cur = q ? JSON.parse(JSON.stringify(q)) : { id: uid(), base: base?.id, slots: base ? base.slots.slice() : [], delta: {}, defDelta: 0, resDelta: [0, 0, 0, 0, 0], note: "", enabled: true, createdAt: Date.now() };
  const isNew = !q || asCopy;
  openModal({
    title: asCopy ? "傀異錬成防具を複製" : isNew ? "傀異錬成防具を登録" : "傀異錬成防具を編集",
    body: '<div data-form></div>',
    foot: '<button class="btn" data-close>キャンセル</button><button class="btn primary" data-save>保存</button>',
    onMount(m, close) {
      const f = m.querySelector("[data-form]");
      const render = () => {
        const b = ARMOR[cur.base];
        const it = b ? quriousItem(cur) : null;
        f.innerHTML = `
          <div class="form-row"><span class="lbl">ベース防具</span><span class="grow"><b>${b ? esc(b.name) : "未選択"}</b>${b ? `<br><span class="muted small">${PART_LABEL[b.part]} / 防御${b.def} / </span>${slotsHTML(b.slots)} <span class="muted small">${Object.entries(b.skills).map(([k, v]) => esc(k) + v).join(" ")}</span>` : ""}</span>
            <button class="btn sm" data-pick-base>${b ? "変更" : "選択"}</button></div>
          ${b ? `
          <div class="form-row"><span class="lbl">錬成後スロット</span>${slotSelects(cur.slots, "slot")}</div>
          <div class="form-row"><span class="lbl">スキル変化</span><span class="grow">
            ${Object.entries(cur.delta).map(([k, v]) => `<div class="row" style="margin-bottom:4px" data-dk="${esc(k)}"><span class="grow">${esc(k)}</span>
              <select data-delta>${[-3, -2, -1, 1, 2, 3, 4].map((n) => `<option value="${n}" ${n === v ? "selected" : ""}>${n > 0 ? "+" + n : n}</option>`).join("")}</select>
              <button class="btn sm icon danger" data-del-delta>✕</button></div>`).join("") || '<span class="muted small">なし</span>'}
            <div class="row"><button class="btn sm" data-add-delta>＋スキル追加/削減</button>
            ${Object.keys(b.skills).map((k) => cur.delta[k] == null ? `<button class="btn sm" data-minus="${esc(k)}">${esc(k)} −1</button>` : "").join("")}</div>
          </span></div>
          <div class="form-row"><span class="lbl">防御力増減</span><input type="number" data-def value="${cur.defDelta || 0}"></div>
          <div class="form-row"><span class="lbl">耐性増減</span>${RES_LABEL.map((l, i) => `<label class="inline small">${l}<input type="number" data-res="${i}" value="${cur.resDelta?.[i] || 0}" style="width:56px"></label>`).join("")}</div>
          <div class="form-row"><span class="lbl">メモ</span><input type="text" class="grow" data-note value="${esc(cur.note || "")}" placeholder="任意（例: 攻撃特化）"></div>
          <div class="card" style="margin-top:8px"><div class="muted small">錬成後</div>
            <div class="row">${slotsHTML(it.slots, { pad: true })}<span class="muted small">防御${it.def}</span></div>
            <div class="chips" style="margin-top:4px">${skillChips(it.skills)}</div></div>` : ""}`;
      };
      const sync = () => {
        if (!ARMOR[cur.base]) return;
        cur.slots = readSlots(f, "slot");
        f.querySelectorAll("[data-dk]").forEach((row) => { cur.delta[row.dataset.dk] = +row.querySelector("[data-delta]").value; });
        cur.defDelta = +(f.querySelector("[data-def]")?.value || 0);
        cur.resDelta = [0, 1, 2, 3, 4].map((i) => +(f.querySelector(`[data-res="${i}"]`)?.value || 0));
        cur.note = f.querySelector("[data-note]")?.value || "";
      };
      render();
      if (!cur.base) setTimeout(() => f.querySelector("[data-pick-base]").click(), 0);
      f.addEventListener("change", () => { sync(); render(); });
      f.addEventListener("click", (e) => {
        if (e.target.closest("[data-pick-base]")) {
          sync();
          pickArmor({ part: ARMOR[cur.base]?.part || S().ui.armorPart || "head", onPick(a) { cur.base = a.id; cur.slots = a.slots.slice(); cur.delta = {}; render(); } });
        } else if (e.target.closest("[data-add-delta]")) {
          sync();
          pickSkill({ title: "錬成で変化したスキル", onPick(n) { cur.delta[n] = cur.delta[n] || 1; render(); } });
        } else if (e.target.closest("[data-del-delta]")) {
          sync();
          delete cur.delta[e.target.closest("[data-dk]").dataset.dk];
          render();
        } else if (e.target.closest("[data-minus]")) {
          sync();
          cur.delta[e.target.closest("[data-minus]").dataset.minus] = -1;
          render();
        }
      });
      m.querySelector("[data-save]").addEventListener("click", () => {
        sync();
        if (!ARMOR[cur.base]) { toast("ベース防具を選択してください"); return; }
        update((st) => {
          const i = st.qurious.findIndex((x) => x.id === cur.id);
          if (i >= 0) st.qurious[i] = cur; else st.qurious.push(cur);
        });
        close();
        toast("保存しました");
        rerender();
      });
    },
  });
}

const charmKeyFns = {
  added: (x) => x.c.createdAt || 0, slotSum: (x) => slotSum(x.slots), slot4: (x) => slotCount(x.slots, 4), slotCount: (x) => slotCount(x.slots),
  skillTotal: (x) => Object.values(x.skills).reduce((a, b) => a + b, 0),
  skill1: (x) => (x.c.skills?.[0]?.[0] || ""),
  __skill: (n) => (x) => x.skills[n] || 0,
};
const CHARM_SORTS = [["added", "登録順"], ["skill1", "第1スキル名"], ["skillTotal", "スキルLv合計"], ["slotSum", "スロット合計Lv"], ["slotCount", "スロット数"], ["slot4", "Lv4スロット数"]];
function charmView() {
  const st = S();
  const ss = sortState("charm", "added", "desc");
  const nq = norm(st.ui.charmQ || "");
  let arr = st.charms.map(charmItem);
  if (nq) arr = arr.filter((x) => Object.keys(x.skills).some((s) => norm(s).includes(nq)) || norm(x.c.note).includes(nq));
  arr = sorted(arr, ss.key, ss.dir, charmKeyFns);
  return `
    <h2><span class="grow">護石（${st.charms.length}件）</span>
      <button class="btn sm" data-act="c-import">インポート</button>
      <button class="btn sm primary" data-act="c-new">＋登録</button></h2>
    <div class="card">
      <input type="search" placeholder="スキル名で絞り込み" data-act="charm-q" value="${esc(st.ui.charmQ || "")}" style="width:100%">
      ${sortBar("charm", CHARM_SORTS, "added", "desc")}
    </div>
    <div class="list cols" style="margin-top:10px" id="charm-list">${arr.map((x) => `<div class="item ${x.c.enabled === false ? "off" : ""}" data-cid="${x.c.id}">
        <div class="ttl"><span class="grow chips">${skillChips(x.skills)}</span>${slotsHTML(x.slots, { pad: true })}</div>
        ${x.c.note ? `<div class="meta">${esc(x.c.note)}</div>` : ""}
        <div class="acts"><label class="inline"><input type="checkbox" class="mini-switch" data-act="c-enable" ${x.c.enabled !== false ? "checked" : ""}>検索対象</label>
        <span class="right"></span><button class="btn sm" data-act="c-edit">編集</button><button class="btn sm danger" data-act="c-del">削除</button></div></div>`).join("") || '<p class="muted">護石が登録されていません。</p>'}</div>`;
}
function charmForm(c) {
  const cur = c ? JSON.parse(JSON.stringify(c)) : { id: uid(), skills: [["", 1], ["", 1]], slots: [], note: "", enabled: true, createdAt: Date.now() };
  while (cur.skills.length < 2) cur.skills.push(["", 1]);
  openModal({
    title: c ? "護石を編集" : "護石を登録",
    body: '<div data-form></div>',
    foot: `${c ? "" : '<label class="inline small" style="margin-right:auto"><input type="checkbox" data-cont> 続けて登録</label>'}<button class="btn" data-close>キャンセル</button><button class="btn primary" data-save>保存</button>`,
    onMount(m, close) {
      const f = m.querySelector("[data-form]");
      const render = () => {
        f.innerHTML = cur.skills.map(([n, v], i) => {
          const max = SKILL[n]?.max || 7;
          return `<div class="form-row"><span class="lbl">スキル${i + 1}</span><button class="btn grow" data-pick="${i}" style="justify-content:flex-start">${n ? esc(n) : '<span class="muted">選択…</span>'}</button>
            <select data-lv="${i}" ${n ? "" : "disabled"}>${Array.from({ length: max }, (_, k) => k + 1).map((x) => `<option value="${x}" ${x === v ? "selected" : ""}>Lv${x}</option>`).join("")}</select>
            ${n ? `<button class="btn sm icon danger" data-clear="${i}">✕</button>` : ""}</div>`;
        }).join("") + `<div class="form-row"><span class="lbl">スロット</span>${slotSelects(cur.slots, "slot")}</div>
          <div class="form-row"><span class="lbl">メモ</span><input type="text" class="grow" data-note value="${esc(cur.note || "")}"></div>`;
      };
      const sync = () => {
        cur.skills.forEach((s, i) => { const el = f.querySelector(`[data-lv="${i}"]`); if (el && s[0]) s[1] = +el.value; });
        cur.slots = readSlots(f, "slot");
        cur.note = f.querySelector("[data-note]").value;
      };
      render();
      f.addEventListener("click", (e) => {
        const p = e.target.closest("[data-pick]");
        const cl = e.target.closest("[data-clear]");
        if (p) { sync(); pickSkill({ onPick(n) { cur.skills[+p.dataset.pick] = [n, Math.min(cur.skills[+p.dataset.pick][1] || 1, SKILL[n].max)]; render(); } }); }
        if (cl) { sync(); cur.skills[+cl.dataset.clear] = ["", 1]; render(); }
      });
      f.addEventListener("change", sync);
      m.querySelector("[data-save]").addEventListener("click", () => {
        sync();
        const out = { ...cur, skills: cur.skills.filter((s) => s[0]) };
        if (!out.skills.length && !out.slots.length) { toast("スキルかスロットを入力してください"); return; }
        update((st) => {
          const i = st.charms.findIndex((x) => x.id === out.id);
          if (i >= 0) st.charms[i] = out; else st.charms.push(out);
        });
        toast("保存しました");
        rerender();
        const cont = m.querySelector("[data-cont]")?.checked;
        close();
        if (cont) charmForm(null);
      });
    },
  });
}

const weaponKeyFns = {
  added: (w) => w.createdAt || 0, name: (w) => w.name, type: (w) => WEAPON_TYPES.indexOf(w.type),
  slotSum: (w) => slotSum(w.slots), slotCount: (w) => slotCount(w.slots), slot4: (w) => slotCount(w.slots, 4),
  __skill: () => () => 0,
};
const WEAPON_SORTS = [["added", "登録順"], ["name", "名前"], ["type", "武器種"], ["slotSum", "スロット合計Lv"], ["slotCount", "スロット数"], ["slot4", "Lv4スロット数"]];
function weaponView() {
  const st = S();
  const ss = sortState("weapon", "added", "desc");
  const arr = sorted(st.weapons.slice(), ss.key, ss.dir, weaponKeyFns);
  return `
    <h2><span class="grow">武器（${st.weapons.length}件）</span><button class="btn sm primary" data-act="w-new">＋登録</button></h2>
    <div class="card">${sortBar("weapon", WEAPON_SORTS, "added", "desc")}
      <p class="muted small" style="margin:0">武器はスキルシミュレーションでは装飾品スロットとして扱います（傀異錬成でスロットを拡張した場合は錬成後のスロットを登録してください）。</p></div>
    <div class="list cols" style="margin-top:10px">${arr.map((w) => `<div class="item ${w.enabled === false ? "off" : ""}" data-wid="${w.id}">
      <div class="ttl"><span class="grow">${esc(w.name)}</span>${slotsHTML(w.slots, { pad: true })}</div>
      <div class="meta"><span>${esc(w.type || "")}</span>${w.note ? `<span>${esc(w.note)}</span>` : ""}</div>
      <div class="acts"><label class="inline"><input type="checkbox" class="mini-switch" data-act="w-enable" ${w.enabled !== false ? "checked" : ""}>「すべてから探す」の対象</label>
      <span class="right"></span><button class="btn sm" data-act="w-edit">編集</button><button class="btn sm danger" data-act="w-del">削除</button></div></div>`).join("") || '<p class="muted">武器が登録されていません。登録しなくても検索タブでスロットを直接指定できます。</p>'}</div>`;
}
function weaponForm(w) {
  const cur = w ? JSON.parse(JSON.stringify(w)) : { id: uid(), name: "", type: WEAPON_TYPES[0], slots: [], note: "", enabled: true, createdAt: Date.now() };
  openModal({
    title: w ? "武器を編集" : "武器を登録",
    body: `<div class="form-row"><span class="lbl">名前</span><input type="text" class="grow" data-name value="${esc(cur.name)}" placeholder="例: 天上天下天地無双刀"></div>
      <div class="form-row"><span class="lbl">武器種</span><select data-type>${WEAPON_TYPES.map((t) => `<option ${t === cur.type ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div class="form-row"><span class="lbl">スロット</span>${slotSelects(cur.slots, "slot")}</div>
      <div class="form-row"><span class="lbl">メモ</span><input type="text" class="grow" data-note value="${esc(cur.note || "")}"></div>`,
    foot: '<button class="btn" data-close>キャンセル</button><button class="btn primary" data-save>保存</button>',
    onMount(m, close) {
      m.querySelector("[data-save]").addEventListener("click", () => {
        cur.name = m.querySelector("[data-name]").value.trim() || cur.type;
        cur.type = m.querySelector("[data-type]").value;
        cur.slots = readSlots(m, "slot");
        cur.note = m.querySelector("[data-note]").value;
        update((st) => {
          const i = st.weapons.findIndex((x) => x.id === cur.id);
          if (i >= 0) st.weapons[i] = cur; else st.weapons.push(cur);
        });
        close();
        toast("保存しました");
        rerender();
      });
    },
  });
}

const decoKeyFns = {
  name: (d) => d.name, size: (d) => d.size, skill: (d) => d.skill, lv: (d) => d.lv,
  count: (d) => { const c = S().decoCount[d.name]; return c == null ? 9999 : c; },
  __skill: (n) => (d) => (d.skill === n ? d.lv : 0),
};
const DECO_SORTS = [["skill", "スキル名"], ["name", "名前"], ["size", "スロットLv"], ["lv", "スキルLv"], ["count", "所持数"]];
function decoView() {
  const st = S();
  const ss = sortState("deco", "skill", "asc");
  const nq = norm(st.ui.decoQ || "");
  let arr = M.decos;
  if (nq) arr = arr.filter((d) => norm(d.name).includes(nq) || norm(d.skill).includes(nq));
  if (st.ui.decoSize) arr = arr.filter((d) => d.size === st.ui.decoSize);
  arr = sorted(arr, ss.key, ss.dir, decoKeyFns);
  return `
    <h2><span class="grow">装飾品（${M.decos.length}種）</span></h2>
    <div class="card">
      <input type="search" placeholder="装飾品名・スキル名で絞り込み" data-act="deco-q" value="${esc(st.ui.decoQ || "")}" style="width:100%">
      <div class="seg" style="margin-top:8px" data-deco-size><button data-ds="0" class="${!st.ui.decoSize ? "on" : ""}">すべて</button>${[1, 2, 3, 4].map((s) => `<button data-ds="${s}" class="${st.ui.decoSize === s ? "on" : ""}">Lv${s}</button>`).join("")}</div>
      ${sortBar("deco", DECO_SORTS, "skill", "asc")}
      <div class="row"><button class="btn sm" data-act="deco-unlimited">すべて無制限に戻す</button><button class="btn sm" data-act="deco-zero">表示中を0個にする</button></div>
      <p class="muted small" style="margin:6px 0 0">所持数を空欄にすると無制限として扱います。検索タブで「装飾品の所持数を考慮する」をONにしたときだけ反映されます。</p>
    </div>
    <div class="list cols" style="margin-top:10px" id="deco-list">${arr.map((d) => {
      const c = st.decoCount[d.name];
      return `<div class="item" data-dn="${esc(d.name)}"><div class="ttl"><span class="slot s${d.size}">${d.size}</span><span class="grow">${esc(d.name)}</span>
        <input type="number" min="0" inputmode="numeric" data-act="deco-count" value="${c == null ? "" : c}" placeholder="∞" style="width:72px"></div>
        <div class="meta">${esc(d.skill)} +${d.lv}</div></div>`;
    }).join("")}</div>`;
}

// ---- インポート（泣シミュ等のCSV形式） ----
function parseCSVLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/[,\t]/).map((x) => x.trim()));
}
function findArmorByName(name) {
  const n = norm(name);
  return M.armors.find((a) => norm(a.name) === n);
}
function importDialog(kind) {
  const isQ = kind === "q";
  openModal({
    title: isQ ? "傀異錬成防具のインポート" : "護石のインポート",
    body: `<p class="muted small">${isQ
      ? "1行1件のCSV形式で貼り付けてください（泣きシミュのエクスポート形式に対応）。<br><code>ベース防具名,防御力増減,火,水,雷,氷,龍,スロット1増加,スロット2増加,スロット3増加,スキル名,増減,スキル名,増減,…</code>"
      : "1行1件のCSV形式で貼り付けてください（泣きシミュのエクスポート形式に対応）。<br><code>スキル1,Lv,スキル2,Lv,スロット1,スロット2,スロット3</code>"}</p>
      <textarea data-text placeholder="${isQ ? "ゴアヘルムＳ,0,0,0,0,0,0,1,0,0,攻撃,1" : "攻撃,2,見切り,1,2,1,0"}"></textarea>
      <div data-msg class="muted small"></div>`,
    foot: '<button class="btn" data-close>キャンセル</button><button class="btn primary" data-go>取り込む</button>',
    onMount(m, close) {
      m.querySelector("[data-go]").addEventListener("click", () => {
        const lines = parseCSVLines(m.querySelector("[data-text]").value);
        const ok = [], ng = [];
        for (const cols of lines) {
          try {
            if (isQ) {
              const a = findArmorByName(cols[0]);
              if (!a) throw new Error("防具が見つかりません: " + cols[0]);
              const n = (i) => +(cols[i] || 0) || 0;
              const base = a.slots.slice().sort((x, y) => y - x);
              const slots = [0, 1, 2].map((i) => Math.min(4, (base[i] || 0) + n(7 + i))).filter((s) => s > 0);
              const delta = {};
              for (let i = 10; i + 1 < cols.length; i += 2) {
                if (!cols[i]) continue;
                if (!SKILL[cols[i]]) throw new Error("スキル名が不明: " + cols[i]);
                delta[cols[i]] = (delta[cols[i]] || 0) + n(i + 1);
              }
              ok.push({ id: uid(), base: a.id, slots, delta, defDelta: n(1), resDelta: [n(2), n(3), n(4), n(5), n(6)], note: "", enabled: true, createdAt: Date.now() + ok.length });
            } else {
              const skills = [];
              for (const i of [0, 2]) {
                if (!cols[i]) continue;
                if (!SKILL[cols[i]]) throw new Error("スキル名が不明: " + cols[i]);
                skills.push([cols[i], +cols[i + 1] || 1]);
              }
              const slots = [4, 5, 6].map((i) => +(cols[i] || 0)).filter((s) => s > 0).sort((a, b) => b - a);
              ok.push({ id: uid(), skills, slots, note: "", enabled: true, createdAt: Date.now() + ok.length });
            }
          } catch (e) {
            ng.push(cols.join(",") + " → " + e.message);
          }
        }
        if (ok.length) update((st) => { (isQ ? st.qurious : st.charms).push(...ok); });
        rerender();
        if (ng.length) {
          m.querySelector("[data-msg]").innerHTML = `${ok.length}件取り込みました。<br>取り込めなかった行（${ng.length}件）:<br>` + ng.map(esc).join("<br>");
        } else {
          close();
          toast(`${ok.length}件取り込みました`);
        }
      });
    },
  });
}

// ======================================================================
// 画面: マイセット
// ======================================================================
const setKeyFns = {
  savedAt: (x) => x.savedAt, def: (x) => x.def, freeCount: (x) => x.freeCount, freeCap: (x) => x.freeCap,
  __skill: (n) => (x) => x.skills[n] || 0,
};
function renderMysets() {
  const st = S();
  const ss = sortState("mysets", "savedAt", "desc");
  const arr = sorted(st.mysets.slice(), ss.key, ss.dir, setKeyFns);
  view.innerHTML = `
    <h2>マイセット（${st.mysets.length}件）</h2>
    <div class="card">${sortBar("mysets", [["savedAt", "保存日時"], ["def", "防御力"], ["freeCount", "空きスロット数"], ["freeCap", "空きスロット合計Lv"]], "savedAt", "desc")}</div>
    <div class="list cols" style="margin-top:10px">${arr.map((x) => {
      const targets = Object.fromEntries((x.conds || []).map((c) => [c.skill, c.level]));
      return `<div class="item" data-sid="${x.id}">
        <div class="res-head"><input type="text" class="grow" data-act="set-memo" value="${esc(x.memo || "")}" placeholder="メモ（例: 太刀 火力）">
          <button class="btn sm danger" data-act="set-del">削除</button></div>
        <div class="muted small" style="margin-top:4px">${new Date(x.savedAt).toLocaleString("ja-JP")} ／ 防御 <b>${x.def}</b> ／ 空き ${x.free.map((n, k) => (k && n ? `<span class="slot free s${k}">${k}</span>×${n}` : "")).join(" ") || "なし"}</div>
        <table class="pieces">${x.pieces.map((p) => `<tr><td class="p">${PART_LABEL[p.part]}</td><td class="n">${p.kind === "qurious" ? '<span class="tag q">傀異</span> ' : ""}${esc(p.name)}${p.note ? `（${esc(p.note)}）` : ""}
          ${p.decos.length ? `<div class="decos">${p.decos.map((d) => d.deco ? `<span class="slot s${d.size}">${d.size}</span>${esc(d.deco)}` : `<span class="slot free s${d.size}">${d.size}</span>空き`).join(" ")}</div>` : ""}</td></tr>`).join("")}</table>
        <div class="chips" style="margin-top:6px">${skillChips(x.skills, { targets })}</div></div>`;
    }).join("") || '<p class="muted">検索結果の「⭐保存」でここに保存できます。</p>'}</div>`;
}

// ======================================================================
// 画面: 設定
// ======================================================================
function renderSettings() {
  const st = S();
  view.innerHTML = `
    <h2>基本設定</h2>
    <div class="card">
      <div class="form-row"><span class="lbl">性別</span><div class="seg grow" data-sex>${["指定なし", "男性", "女性"].map((l, i) => `<button data-sx="${i}" class="${st.settings.sex === i ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <p class="muted small" style="margin:0">男性専用・女性専用の防具を検索・一覧から除外します。</p>
      <div class="form-row"><span class="lbl">テーマ</span><div class="seg grow" data-theme>${[["", "自動"], ["light", "ライト"], ["dark", "ダーク"]].map(([k, l]) => `<button data-th="${k}" class="${(st.settings.theme || "") === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    </div>
    <h2>データのバックアップ</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">登録データはこの端末のブラウザ内に保存されます。機種変更・ブラウザのデータ削除に備えて定期的にバックアップしてください。PCとスマホでデータを移すときもこの機能を使います。</p>
      <div class="row"><button class="btn" data-act="export">バックアップを保存（JSON）</button><button class="btn" data-act="export-copy">テキストでコピー</button></div>
      <div class="row" style="margin-top:8px"><label class="btn">ファイルから復元<input type="file" accept="application/json,.json,.txt" data-act="import-file" hidden></label><button class="btn" data-act="import-text">テキストから復元</button></div>
      <div class="row" style="margin-top:8px"><button class="btn danger" data-act="reset">すべてのデータを削除</button></div>
    </div>
    <h2>このアプリについて</h2>
    <div class="card small">
      <dl class="kv">
        <dt>データ</dt><dd>${esc(M.version)}<br>防具 ${M.armors.length} ／ スキル ${M.skills.length} ／ 装飾品 ${M.decos.length}</dd>
        <dt>登録数</dt><dd>所持防具 ${Object.keys(st.ownedArmor).length} ／ 傀異錬成 ${st.qurious.length} ／ 護石 ${st.charms.length} ／ 武器 ${st.weapons.length}</dd>
      </dl>
      <p class="muted">防具・スキル・装飾品データは <a href="https://github.com/EXXXI/RiseSim" target="_blank" rel="noopener">RiseSim</a>（MIT License, © 2022 EXXXI）のCSVを変換して利用しています。ホーム画面に追加するとアプリのように使えます（iPhone: Safariの共有ボタン →「ホーム画面に追加」）。</p>
    </div>`;
}

// ======================================================================
// ルーティング・イベント
// ======================================================================
function setTab(t) {
  tab = t;
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  rerender();
  window.scrollTo(0, 0);
}
function rerender() {
  if (tab === "search") renderSearch();
  else if (tab === "results") renderResults();
  else if (tab === "equip") renderEquip();
  else if (tab === "mysets") renderMysets();
  else renderSettings();
}

document.getElementById("tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) setTab(b.dataset.tab);
});

function applyTheme() {
  const th = S().settings.theme || "";
  if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
}

let qTimer = null;
function debounced(fn) {
  clearTimeout(qTimer);
  qTimer = setTimeout(fn, 180);
}

view.addEventListener("input", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (act === "armor-q") { S().ui.armorQ = t.value; save(); debounced(() => { document.getElementById("armor-list").innerHTML = armorRows(armorFilterList()); }); }
  else if (act === "res-filter") { S().ui.resFilter = t.value; debounced(() => { resultShown = 30; const pos = t.selectionStart; renderResults(); const el = view.querySelector('[data-act="res-filter"]'); el.focus(); el.setSelectionRange(pos, pos); }); }
  else if (act === "charm-q") { S().ui.charmQ = t.value; debounced(() => { const pos = t.selectionStart; renderEquipBody(); const el = view.querySelector('[data-act="charm-q"]'); el.focus(); el.setSelectionRange(pos, pos); }); }
  else if (act === "deco-q") { S().ui.decoQ = t.value; debounced(() => { const pos = t.selectionStart; renderEquipBody(); const el = view.querySelector('[data-act="deco-q"]'); el.focus(); el.setSelectionRange(pos, pos); }); }
  else if (act === "set-memo") {
    const id = t.closest("[data-sid]").dataset.sid;
    const s = S().mysets.find((x) => x.id === id);
    if (s) { s.memo = t.value; save(); }
  }
});

view.addEventListener("change", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  const st = S();
  if (t.dataset.opt) { update((s) => { s.simOpts[t.dataset.opt] = t.checked; }); rerender(); return; }
  if (t.dataset.ui) { update((s) => { s.ui[t.dataset.ui] = t.checked; }); rerender(); return; }
  if (t.dataset.wslot != null) { update((s) => { s.simOpts.weaponSlots = readSlots(view, "wslot"); }); return; }
  const condEl = t.closest(".cond");
  if (act === "cond-lv") { update((s) => { s.conds[+condEl.dataset.i].level = +t.value; }); return; }
  if (act === "cond-req") { update((s) => { s.conds[+condEl.dataset.i].required = t.checked; }); rerender(); return; }
  if (act === "weapon-sel") { update((s) => { s.simOpts.weapon = t.value; }); rerender(); return; }
  if (act === "limit") { update((s) => { s.simOpts.limit = +t.value; }); return; }
  if (act === "sort-key") {
    const id = t.closest("[data-sort]").dataset.sort;
    if (t.value === "__pick") {
      pickSkill({ title: "並び替えに使うスキル", onPick(n) { sortState(id).key = "skill:" + n; sortState(id).dir = "desc"; save(); rerender(); } });
      t.value = sortState(id).key;
      return;
    }
    sortState(id).key = t.value;
    save();
    rerender();
    return;
  }
  if (act === "own" || act === "exclude") {
    const id = t.closest("[data-id]").dataset.id;
    update((s) => {
      const m = act === "own" ? s.ownedArmor : s.excludedArmor;
      if (t.checked) m[id] = true; else delete m[id];
    });
    if (act === "exclude") t.closest(".item").classList.toggle("off", t.checked);
    return;
  }
  if (act === "q-enable") { const id = t.closest("[data-qid]").dataset.qid; update((s) => { s.qurious.find((x) => x.id === id).enabled = t.checked; }); t.closest(".item").classList.toggle("off", !t.checked); return; }
  if (act === "c-enable") { const id = t.closest("[data-cid]").dataset.cid; update((s) => { s.charms.find((x) => x.id === id).enabled = t.checked; }); t.closest(".item").classList.toggle("off", !t.checked); return; }
  if (act === "w-enable") { const id = t.closest("[data-wid]").dataset.wid; update((s) => { s.weapons.find((x) => x.id === id).enabled = t.checked; }); t.closest(".item").classList.toggle("off", !t.checked); return; }
  if (act === "deco-count") {
    const name = t.closest("[data-dn]").dataset.dn;
    update((s) => { if (t.value === "") delete s.decoCount[name]; else s.decoCount[name] = Math.max(0, +t.value | 0); });
    return;
  }
  if (act === "import-file") {
    const file = t.files[0];
    if (!file) return;
    file.text().then((txt) => {
      try { importJSON(txt); applyTheme(); toast("復元しました"); rerender(); } catch (err) { alert("復元に失敗しました: " + err.message); }
    });
  }
  void st;
});

view.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act],[data-et],[data-ap],[data-qp],[data-ds],[data-sx],[data-th]");
  if (!el || el.tagName === "SELECT" || (el.tagName === "INPUT" && el.type !== "button")) return;
  const st = S();
  if (el.dataset.et) { equipTab = el.dataset.et; renderEquip(); return; }
  if (el.dataset.ap) { update((s) => { s.ui.armorPart = el.dataset.ap; }); renderEquipBody(); return; }
  if (el.dataset.qp != null && el.closest("[data-q-parts]")) { update((s) => { s.ui.qPart = el.dataset.qp; }); renderEquipBody(); return; }
  if (el.dataset.ds != null && el.closest("[data-deco-size]")) { update((s) => { s.ui.decoSize = +el.dataset.ds; }); renderEquipBody(); return; }
  if (el.dataset.sx != null) { update((s) => { s.settings.sex = +el.dataset.sx; }); renderSettings(); return; }
  if (el.dataset.th != null && el.closest("[data-theme]")) { update((s) => { s.settings.theme = el.dataset.th; }); applyTheme(); renderSettings(); return; }
  const act = el.dataset.act;
  const condEl = el.closest(".cond");
  switch (act) {
    case "cond-add":
      pickSkill({
        title: "条件に追加するスキル", multi: true, selected: st.conds.map((c) => c.skill),
        onPick(n) { update((s) => { s.conds.push({ skill: n, level: SKILL[n].max, required: true }); }); rerender(); },
      });
      break;
    case "cond-clear":
      if (confirm("スキル条件をすべて削除しますか？")) { update((s) => { s.conds = []; }); rerender(); }
      break;
    case "cond-up":
    case "cond-down": {
      const i = +condEl.dataset.i;
      const j = act === "cond-up" ? i - 1 : i + 1;
      update((s) => { [s.conds[i], s.conds[j]] = [s.conds[j], s.conds[i]]; });
      rerender();
      break;
    }
    case "cond-del":
      update((s) => { s.conds.splice(+condEl.dataset.i, 1); });
      rerender();
      break;
    case "run":
      runSearch();
      break;
    case "sort-dir": {
      const id = el.closest("[data-sort]").dataset.sort;
      const ss = sortState(id);
      ss.dir = ss.dir === "asc" ? "desc" : "asc";
      save();
      rerender();
      break;
    }
    case "more":
      resultShown += 50;
      renderResults();
      break;
    case "alts": {
      const keys = el.dataset.k.split("\n");
      openModal({
        title: "同等の装備（条件スキル・スロットが同じ）",
        body: `<div class="list">${keys.map((k) => {
          const it = last.keyMap[k];
          if (!it) return "";
          return `<div class="item"><div class="ttl"><span class="grow">${it.kind === "qurious" ? '<span class="tag q">傀異</span> ' : ""}${esc(it.name)}${it.note ? `（${esc(it.note)}）` : ""}</span>${slotsHTML(it.slots)}</div>
            <div class="meta">防御${it.def || 0}</div><div class="chips">${skillChips(it.skills)}</div></div>`;
        }).join("")}</div>`,
      });
      break;
    }
    case "save-set": {
      const r = last.out.results[+el.dataset.i];
      update((s) => { s.mysets.push(snapshot(r)); });
      toast("マイセットに保存しました");
      break;
    }
    case "own-all":
    case "own-none": {
      const arr = armorFilterList();
      update((s) => { for (const a of arr) { if (act === "own-all") s.ownedArmor[a.id] = true; else delete s.ownedArmor[a.id]; } });
      renderEquipBody();
      break;
    }
    case "q-new-from":
      quriousForm(null, ARMOR[el.closest("[data-id]").dataset.id]);
      break;
    case "q-new":
      quriousForm(null, null);
      break;
    case "q-edit":
      quriousForm(st.qurious.find((x) => x.id === el.closest("[data-qid]").dataset.qid));
      break;
    case "q-copy": {
      const q = st.qurious.find((x) => x.id === el.closest("[data-qid]").dataset.qid);
      quriousForm({ ...JSON.parse(JSON.stringify(q)), id: uid(), createdAt: Date.now() }, null, true);
      break;
    }
    case "q-del":
      if (confirm("この傀異錬成防具を削除しますか？")) { update((s) => { s.qurious = s.qurious.filter((x) => x.id !== el.closest("[data-qid]").dataset.qid); }); renderEquipBody(); }
      break;
    case "q-import":
      importDialog("q");
      break;
    case "c-new":
      charmForm(null);
      break;
    case "c-edit":
      charmForm(st.charms.find((x) => x.id === el.closest("[data-cid]").dataset.cid));
      break;
    case "c-del":
      if (confirm("この護石を削除しますか？")) { update((s) => { s.charms = s.charms.filter((x) => x.id !== el.closest("[data-cid]").dataset.cid); }); renderEquipBody(); }
      break;
    case "c-import":
      importDialog("c");
      break;
    case "w-new":
      weaponForm(null);
      break;
    case "w-edit":
      weaponForm(st.weapons.find((x) => x.id === el.closest("[data-wid]").dataset.wid));
      break;
    case "w-del":
      if (confirm("この武器を削除しますか？")) { update((s) => { s.weapons = s.weapons.filter((x) => x.id !== el.closest("[data-wid]").dataset.wid); }); renderEquipBody(); }
      break;
    case "deco-unlimited":
      if (confirm("すべての装飾品の所持数を無制限に戻しますか？")) { update((s) => { s.decoCount = {}; }); renderEquipBody(); }
      break;
    case "deco-zero":
      view.querySelectorAll("[data-dn]").forEach((x) => { st.decoCount[x.dataset.dn] = 0; });
      save();
      renderEquipBody();
      break;
    case "set-del":
      if (confirm("このマイセットを削除しますか？")) { update((s) => { s.mysets = s.mysets.filter((x) => x.id !== el.closest("[data-sid]").dataset.sid); }); renderMysets(); }
      break;
    case "export":
      download(`mhrsb-sim-backup-${new Date().toISOString().slice(0, 10)}.json`, exportJSON());
      break;
    case "export-copy":
      navigator.clipboard.writeText(exportJSON()).then(() => toast("コピーしました"), () => {
        openModal({ title: "バックアップ（テキスト）", body: `<textarea readonly style="min-height:50vh">${esc(exportJSON())}</textarea>` });
      });
      break;
    case "import-text":
      openModal({
        title: "テキストから復元",
        body: '<p class="muted small">「テキストでコピー」したバックアップを貼り付けてください。現在のデータは上書きされます。</p><textarea data-text></textarea>',
        foot: '<button class="btn" data-close>キャンセル</button><button class="btn primary" data-go>復元</button>',
        onMount(m, close) {
          m.querySelector("[data-go]").addEventListener("click", () => {
            try { importJSON(m.querySelector("[data-text]").value); applyTheme(); close(); toast("復元しました"); rerender(); } catch (err) { alert("復元に失敗しました: " + err.message); }
          });
        },
      });
      break;
    case "reset":
      if (confirm("登録したすべてのデータを削除します。よろしいですか？") && confirm("本当に削除しますか？（元に戻せません）")) { resetAll(); applyTheme(); last = null; rerender(); toast("削除しました"); }
      break;
  }
});

// ======================================================================
// 起動
// ======================================================================
async function init() {
  applyTheme();
  try {
    const res = await fetch("data/master.json", { cache: "no-cache" });
    M = await res.json();
  } catch (e) {
    view.innerHTML = `<div class="notice">データの読み込みに失敗しました: ${esc(e.message)}</div>`;
    return;
  }
  for (const s of M.skills) SKILL[s.name] = s;
  for (const a of M.armors) ARMOR[a.id] = a;
  for (const d of M.decos) DECO[d.name] = d;
  CATS = [...new Set(M.skills.map((s) => s.cat))];
  document.getElementById("appbar-sub").textContent = "Ver.16対応";
  // 存在しなくなったスキルを条件から除去
  update((s) => { s.conds = s.conds.filter((c) => SKILL[c.skill]); });
  rerender();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
init();
