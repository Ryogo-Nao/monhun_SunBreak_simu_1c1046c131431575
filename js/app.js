import { getState, getGame, setGame, update, save, exportJSON, importJSON, resetAll, uid, setNormalizer } from "./store.js";
import { norm, match, matchAny, score, resolveByScore } from "./search.js";

// ======================================================================
// ゲームタイトル定義
// ======================================================================
const GAMES = {
  sb: {
    id: "sb", title: "モンスターハンターライズ：サンブレイク", short: "サンブレイク", data: "data/master.json",
    slotMax: 4, charmSkills: 2, typed: false, aug: "傀異錬成",
  },
  wilds: {
    id: "wilds", title: "モンスターハンターワイルズ", short: "ワイルズ", data: "data/wilds/master.json",
    slotMax: 3, charmSkills: 3, typed: true, aug: "アーティア",
  },
};
const G = () => GAMES[getGame()];
const isW = () => getGame() === "wilds";

const PARTS = ["head", "body", "arm", "waist", "leg"];
const PART_LABEL = { weapon: "武器", head: "頭", body: "胴", arm: "腕", waist: "腰", leg: "脚", charm: "護石" };
const SB_WEAPON_TYPES = ["大剣", "太刀", "片手剣", "双剣", "ハンマー", "狩猟笛", "ランス", "ガンランス", "スラッシュアックス", "チャージアックス", "操虫棍", "ライトボウガン", "ヘビィボウガン", "弓"];
const RES_LABEL = ["火", "水", "雷", "氷", "龍"];

let M = null;            // master.json
let SKILL = {};          // name -> skill
let ARMOR = {};          // id -> armor
let WEAPON = {};         // id -> weapon (ワイルズ)
let FCHARM = {};         // id -> 固定護石 (ワイルズ)
let CATS = [];           // スキルカテゴリ一覧

const S = () => getState();
const view = document.getElementById("view");
const modalRoot = document.getElementById("modal-root");

let last = null;         // 検索結果（メモリのみ） { out, keyMap, conds, targets, at }
let worker = null;
let tab = "search";
let equipTab = "armor";
let resultShown = 30;

// ======================================================================
// ユーティリティ
// ======================================================================
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICON_STAR = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3.5 2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/></svg>';
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3500); // 読み切れるよう3〜5秒の範囲で表示
}
const weaponTypes = () => (isW() ? M.weaponTypes : SB_WEAPON_TYPES);

// ---- スキルLv ⇔ ポイント（ワイルズのシリーズ/グループスキルは部位数の閾値で発動） ----
const thr = (name) => SKILL[name]?.thresholds || null;
function lvToPts(name, lv) { const t = thr(name); return t ? (t[lv - 1] ?? t[t.length - 1]) : lv; }
function ptsToLv(name, pts) { const t = thr(name); if (!t) return pts; let l = 0; t.forEach((x, i) => { if (pts >= x) l = i + 1; }); return l; }
function maxPts(name) { const s = SKILL[name]; return s ? (s.thresholds ? s.thresholds[s.thresholds.length - 1] : s.max) : 0; }
function lvLabel(name, lv) {
  const s = SKILL[name];
  if (s?.thresholds) return `Lv${lv} ${s.names[lv - 1]}（${s.thresholds[lv - 1]}pt）`;
  return `Lv${lv}${s && lv === s.max ? "(最大)" : ""}`;
}
function condText(c) {
  const s = SKILL[c.skill];
  return s?.thresholds ? `${c.skill} ${s.names[c.level - 1]}` : `${c.skill}Lv${c.level}`;
}

function slotsHTML(slots, opt = {}) {
  const ws = (opt.wslots || []).filter((s) => s > 0).sort((a, b) => b - a);
  const arr = (slots || []).filter((s) => s > 0).sort((a, b) => b - a);
  const n = opt.pad ? Math.max(3 - ws.length, arr.length) : arr.length;
  let h = '<span class="slots">';
  for (const s of ws) h += `<span class="slot w s${s}" title="武器用スロット">${s}</span>`;
  for (let i = 0; i < n; i++) {
    const s = arr[i];
    h += s ? `<span class="slot s${s}">${s}</span>` : '<span class="slot empty">-</span>';
  }
  if (!n && !ws.length) h += '<span class="muted small">なし</span>';
  return h + "</span>";
}
function slotTag(size, type, free) {
  return `<span class="slot${type === "W" && isW() ? " w" : ""}${free ? " free" : ""} s${size}">${size}</span>`;
}
// opt: { targets(pt), result, delta }
function skillChips(skills, opt = {}) {
  // 結果表示では、条件外で未発動のシリーズ/グループスキルは省略
  const ent = Object.entries(skills || {}).filter(([k, v]) => v !== 0 &&
    !(opt.result && thr(k) && ptsToLv(k, v) === 0 && (opt.targets || {})[k] == null));
  if (!ent.length) return '<span class="muted small">スキルなし</span>';
  const tg = opt.targets || {};
  return ent.map(([k, v]) => {
    let cls = "chip";
    if (v < 0) cls += " minus";
    else if (tg[k] != null) cls += v >= tg[k] ? " ok" : " ng";
    let txt;
    const t = thr(k);
    if (opt.delta) txt = `${k}${v > 0 ? "+" : ""}${v}`;
    else if (t) {
      if (opt.result) {
        const lv = ptsToLv(k, v);
        txt = `${k} ${v}pt` + (lv ? `→${SKILL[k].names[lv - 1]}` : "（未発動）");
        if (!lv && tg[k] == null) cls += " dim";
      } else txt = `${k}+${v}`;
    } else txt = `${k}Lv${v}`;
    return `<span class="${cls}">${esc(txt)}</span>`;
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
function sortBar(id, options, defKey, defDir) {
  const st = sortState(id, defKey, defDir);
  const opts = options.slice();
  if (st.key.startsWith("skill:") && !opts.some((o) => o[0] === st.key)) opts.push([st.key, "スキル: " + st.key.slice(6)]);
  return `<div class="sortbar" data-sort="${id}">
    <span class="lbl">並び替え</span>
    <select data-act="sort-key">${opts.map(([k, l]) => `<option value="${esc(k)}" ${k === st.key ? "selected" : ""}>${esc(l)}</option>`).join("")}
      <option value="__pick">スキルLvで並べる…</option></select>
    <button class="btn sm" data-act="sort-dir">${st.dir === "asc" ? "▲ 昇順" : "▼ 降順"}</button>
  </div>`;
}

// ---- 登録番号: 登録した装備（傀異錬成・護石・アーティア・登録武器）を画面間で特定するための番号 ----
const REG_LISTS = ["qurious", "charms", "artians", "weapons"];
function ensureRegNos(st) {
  for (const key of REG_LISTS) {
    const list = st[key] || [];
    const seen = new Set();
    const order = list.map((x, i) => [x, i]).sort((a, b) => (a[0].createdAt || 0) - (b[0].createdAt || 0) || a[1] - b[1]).map((x) => x[0]);
    const todo = [];
    for (const x of order) {
      if (Number.isInteger(x.no) && x.no > 0 && !seen.has(x.no)) seen.add(x.no); // 複製などで重複した番号は振り直す
      else todo.push(x);
    }
    // 削除された番号も再利用しない（保存済みマイセットとの対応が崩れないように）
    st.regSeq = st.regSeq || {};
    let next = Math.max(0, ...seen, st.regSeq[key] || 0) + 1;
    for (const x of todo) x.no = next++;
    st.regSeq[key] = Math.max(st.regSeq[key] || 0, next - 1);
  }
}
setNormalizer(ensureRegNos);
const regNoHTML = (no) => (no ? ` <span class="regno">No.${no}</span>` : "");
// 装備1つ分のスキルを短く表記（例: 攻撃Lv3・見切りLv1 / シリーズは +pt）
function skillText(skills) {
  const ent = Object.entries(skills || {}).filter(([, v]) => v > 0);
  if (!ent.length) return "";
  return ent.map(([k, v]) => `${esc(k)}${thr(k) ? "+" + v : "Lv" + v}`).join("・");
}
// 結果・マイセット共通: 部位1行（装備名＋登録番号＋メモ、その装備のスキル、装着する装飾品）
function pieceRowHTML({ part, tag = "", name, no, note, skills, decos, extra = "" }) {
  const decoTxt = (decos || []).map((d) => d.deco ? `${slotTag(d.size, d.type)}${esc(d.deco)}` : `${slotTag(d.size, d.type, true)}空き`).join(" ");
  const st = skillText(skills);
  return `<tr><td class="p">${PART_LABEL[part]}</td><td class="n">
    <div class="pname">${tag}${esc(name)}${regNoHTML(no)}${note ? ` <span class="pnote">${esc(note)}</span>` : ""} ${extra}</div>
    ${st ? `<div class="pskills">${st}</div>` : ""}
    ${decoTxt ? `<div class="decos">${decoTxt}</div>` : ""}</td></tr>`;
}

// ---- 装備アイテム化 ----
function quriousItem(q) {
  const base = ARMOR[q.base];
  if (!base) return null;
  const skills = { ...base.skills };
  for (const [k, v] of Object.entries(q.delta || {})) {
    skills[k] = (skills[k] || 0) + v;
    if (skills[k] <= 0) delete skills[k];
  }
  return {
    key: "q:" + q.id, q, base, part: base.part, name: base.name, note: q.note || "", no: q.no,
    slots: (q.slots || []).filter((s) => s > 0).sort((a, b) => b - a),
    skills, def: base.def + (q.defDelta || 0),
    res: base.res.map((v, i) => v + ((q.resDelta || [])[i] || 0)),
    rarity: base.rarity,
  };
}
function charmItem(c) {
  const skills = {};
  for (const [k, v] of c.skills || []) if (k && v) skills[k] = (skills[k] || 0) + v;
  const label = isW() ? "光るお守り" : "護石";
  return {
    key: "c:" + c.id, c, name: label, note: c.note || "", no: c.no,
    slots: (c.slots || []).filter((s) => s > 0).sort((a, b) => b - a),
    wslots: (c.wslots || []).filter((s) => s > 0).sort((a, b) => b - a),
    skills, def: 0, res: [0, 0, 0, 0, 0],
  };
}
function weaponItem(w) { // SB 登録武器
  return { key: "w:" + w.id, w, no: w.no, note: w.note || "", name: w.name || "武器", slots: (w.slots || []).filter((s) => s > 0).sort((a, b) => b - a), skills: {}, def: 0, res: [0, 0, 0, 0, 0] };
}
function wildsWeaponItem(w) {
  return { key: w.id, name: w.name, type: w.type, wslots: w.slots, slots: [], skills: w.skills, def: w.def || 0, res: [0, 0, 0, 0, 0], attack: w.attack, pref: S().ownedWeapons[w.id] ? 1 : 0 };
}
function artianItem(a) {
  return { key: "ar:" + a.id, a, no: a.no, name: a.name || `アーティア（${a.type}）`, type: a.type, note: a.note || "", wslots: (a.wslots || [3, 3, 3]).filter((s) => s > 0).sort((x, y) => y - x), slots: [], skills: { ...(a.skills || {}) }, def: 0, res: [0, 0, 0, 0, 0], pref: 2 };
}
function fixedCharmItem(c) {
  return { key: c.id, name: c.name, slots: [], wslots: [], skills: c.skills, def: 0, res: [0, 0, 0, 0, 0], pref: S().ownedCharms[c.id] ? 1 : 0 };
}
function sexOk(a) {
  const sx = S().settings.sex;
  return isW() || !a.sex || !sx || a.sex === sx;
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
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" tabindex="-1" aria-label="${esc(title)}" ${wide ? 'style="max-width:860px"' : ""}>
    <div class="mh"><h3>${esc(title)}</h3><button class="btn sm" data-close>閉じる</button></div>
    <div class="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ""}</div>`;
  const opener = document.activeElement; // 閉じたらここへフォーカスを戻す（キーボード操作用）
  const close = () => {
    back.remove();
    if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
  };
  // 登録・編集など保存ボタンのある画面は、入力を変えた後に外側をうっかり押しても閉じない（確認する）
  const hasSave = !!back.querySelector("[data-save], [data-go]");
  let dirty = false;
  const markDirty = (e) => { if (!e.target.closest || !e.target.closest(".modal .mf")) dirty = true; };
  back.addEventListener("input", markDirty);
  back.addEventListener("change", markDirty);
  const closeSafely = () => {
    if (hasSave && dirty && !confirm("入力内容を破棄して閉じますか？")) return;
    close();
  };
  back.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) close();
    else if (e.target === back) closeSafely();
    else if (e.target.closest(".mb button")) dirty = true; // スキル追加・✕などのボタン操作も変更とみなす
  });
  back._closeSafely = closeSafely; // Esc キーで閉じる用
  modalRoot.appendChild(back);
  const modal = back.querySelector(".modal");
  onMount && onMount(modal, close);
  // 開いたらフォーカスを画面（シート）自体へ移す。入力欄には移さない（スマホでキーボードが勝手に出ないように）
  if (!modal.contains(document.activeElement)) modal.focus({ preventScroll: true });
  return close;
}

// キーボード操作: Esc で一番上の画面（シート）を閉じる／Tab のフォーカスを画面内に留める
document.addEventListener("keydown", (e) => {
  const top = modalRoot.lastElementChild;
  if (!top) return;
  if (e.key === "Escape") { e.preventDefault(); top._closeSafely ? top._closeSafely() : top.remove(); return; }
  if (e.key !== "Tab") return;
  const items = [...top.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea, [href], label.btn')].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], lastEl = items[items.length - 1];
  if (!top.contains(document.activeElement) || (e.shiftKey ? document.activeElement === first || document.activeElement === top.querySelector(".modal") : document.activeElement === lastEl)) {
    e.preventDefault();
    (e.shiftKey ? lastEl : first).focus();
  }
});

// スキル選択モーダル  filter: (skill) => boolean
function pickSkill({ title = "スキルを選択", onPick, multi = false, selected = [], filter = null, query = "" }) {
  let q = query, cat = "";
  const sel = new Set(selected);
  const base = M.skills.filter((s) => s.cat !== "汎用錬成スキル" && (!filter || filter(s)));
  const cats = CATS.filter((c) => base.some((s) => s.cat === c));
  openModal({
    title,
    body: `<input type="search" placeholder="スキル名の一部・読み（例: 弱特、こうげき）" data-q value="${esc(q)}" style="width:100%">
      <div class="chips" style="margin:8px 0" data-cats>
        <button class="chip on" data-cat="">すべて</button>${cats.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}
      </div>
      <div class="pick-list" data-list></div>`,
    foot: multi ? '<button class="btn primary" data-close>完了</button>' : "",
    onMount(m, close) {
      const list = m.querySelector("[data-list]");
      const render = () => {
        let h = "", lastCat = null;
        let arr = base.filter((s) => (!cat || s.cat === cat) && (match(s.name, q) || (s.names || []).some((n) => match(n, q))));
        if (norm(q)) arr = arr.map((s, i) => [s, Math.min(score(s.name, q), ...(s.names || []).map((n) => score(n, q))), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
        for (const s of arr) {
          if (!norm(q) && s.cat !== lastCat) { h += `<div class="cat">${esc(s.cat)}</div>`; lastCat = s.cat; }
          const info = s.thresholds ? s.names.map((n, i) => `${n}(${s.thresholds[i]}pt)`).join(" / ") : `最大Lv${s.max}`;
          h += `<button data-skill="${esc(s.name)}" class="${sel.has(s.name) ? "sel" : ""}">${sel.has(s.name) ? "✓ " : ""}${esc(s.name)} <span class="muted small">${norm(q) ? esc(s.cat) + " / " : ""}${esc(info)}</span></button>`;
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

// 防具選択モーダル（傀異錬成のベース）
function pickArmor({ onPick, part = "head", query = "" }) {
  let q = query, p = part;
  openModal({
    title: "ベース防具を選択",
    body: `<div class="seg" data-parts>${PARTS.map((x) => `<button data-p="${x}" class="${x === p ? "on" : ""}">${PART_LABEL[x]}</button>`).join("")}</div>
      <input type="search" placeholder="防具名・スキル名で検索" data-q value="${esc(q)}" style="width:100%;margin-top:8px">
      <div class="pick-list" data-list style="margin-top:6px"></div>`,
    onMount(m, close) {
      const list = m.querySelector("[data-list]");
      const render = () => {
        const arr = M.armors.filter((a) => a.part === p && matchAny([a.name, ...Object.keys(a.skills)], q));
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

// ---- フォーム部品（ラベルは上・入力欄は全幅、の統一レイアウト） ----
const fld = (label, ctl) => `<div class="field"><div class="field-lbl">${label}</div><div class="field-ctl">${ctl}</div></div>`;
const fsec = (title, body) => `<section class="fsec">${title ? `<h4>${title}</h4>` : ""}${body}</section>`;
// 数値のプルダウンは「上ほど大きい値」（降順）で統一
function lvOptions(max, cur, label = (v) => "Lv" + v) {
  let h = "";
  for (let v = max; v >= 1; v--) h += `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(label(v))}</option>`;
  return h;
}
function slotOptions(max, cur) {
  return lvOptions(max, cur) + `<option value="0" ${!cur ? "selected" : ""}>なし</option>`;
}
function slotSelects(slots, name = "slot", max = G().slotMax) {
  const arr = (slots || []).slice().sort((a, b) => b - a);
  return `<div class="g3">${[0, 1, 2].map((i) => `<select data-${name}="${i}" aria-label="スロット${i + 1}">${slotOptions(max, arr[i] || 0)}</select>`).join("")}</div>`;
}
function readSlots(m, name = "slot") {
  return [...m.querySelectorAll(`[data-${name}]`)].map((s) => +s.value).filter((v) => v > 0).sort((a, b) => b - a);
}
// 種別付きスロット入力（ワイルズの光るお守り）
function typedSlotRows(slots, wslots) {
  const list = [...(wslots || []).map((s) => [s, "W"]), ...(slots || []).map((s) => [s, "A"])];
  return [0, 1, 2].map((i) => {
    const [sz, ty] = list[i] || [0, "A"];
    return `<div class="g2"><select data-tsize="${i}" aria-label="スロット${i + 1}">${slotOptions(3, sz)}</select>
      <select data-ttype="${i}" aria-label="スロット${i + 1}の種別"><option value="A" ${ty === "A" ? "selected" : ""}>防具用</option><option value="W" ${ty === "W" ? "selected" : ""}>武器用</option></select></div>`;
  }).join("");
}
function readTypedSlots(m) {
  const slots = [], wslots = [];
  for (let i = 0; i < 3; i++) {
    const sz = +m.querySelector(`[data-tsize="${i}"]`).value;
    if (!sz) continue;
    (m.querySelector(`[data-ttype="${i}"]`).value === "W" ? wslots : slots).push(sz);
  }
  return { slots: slots.sort((a, b) => b - a), wslots: wslots.sort((a, b) => b - a) };
}

// ======================================================================
// 画面: 検索
// ======================================================================
function renderSearch() {
  const st = S();
  const o = st.simOpts;
  const conds = st.conds;
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
        <select data-act="cond-lv" aria-label="${esc(c.skill)}のLv">${lvOptions(max, c.level, (v) => lvLabel(c.skill, v))}</select>
        <label class="inline"><input type="checkbox" class="mini-switch" data-act="cond-req" ${c.required ? "checked" : ""}> 必須</label>
      </span></div>`;
  }).join("") : '<p class="muted">スキル未選択</p>';

  const w = isW();
  const augCount = w ? st.artians.filter((a) => a.enabled !== false).length : st.qurious.filter((q) => q.enabled !== false).length;

  view.innerHTML = `
  <div class="grid2">
  <div>
    <h2><span class="grow">スキル条件</span>
      <button class="btn sm" data-act="cond-clear" ${conds.length ? "" : "disabled"}>クリア</button>
      <button class="btn sm primary" data-act="cond-add">＋スキル追加</button></h2>
    <div class="card">${condHTML}</div>
  </div>
  <div>
    ${w ? wildsWeaponSection() : sbWeaponSection()}
    <h2>検索対象</h2>
    <div class="card">
      <label class="switch"><span class="txt">未所持の装備も使う</span><input type="checkbox" data-opt="includeUnowned" ${o.includeUnowned ? "checked" : ""}></label>
      <label class="switch"><span class="txt">${w ? "アーティアを使う" : "傀異錬成防具を使う"} <span class="muted small">${augCount}件</span></span><input type="checkbox" data-opt="includeQurious" ${o.includeQurious ? "checked" : ""}></label>
      <label class="switch"><span class="txt">装飾品の所持数を反映</span><input type="checkbox" data-opt="useDecoCount" ${o.useDecoCount ? "checked" : ""}></label>
      <label class="switch"><span class="txt">下位互換を除外（高速）</span><input type="checkbox" data-opt="pruneDominated" ${o.pruneDominated ? "checked" : ""}></label>
      <label class="switch"><span class="txt">希望スキル全達成のみ</span><input type="checkbox" data-opt="onlyFullSoft" ${o.onlyFullSoft ? "checked" : ""}></label>
      ${fld("最大件数", `<select data-act="limit">${[100000, 20000, 5000, 1000, 500].map((v) => `<option value="${v}" ${o.limit === v ? "selected" : ""}>${v.toLocaleString()}件</option>`).join("")}</select>`)}
    </div>
  </div>
  </div>
  <div class="runbar">
    <button class="btn primary block" data-act="run" ${conds.length ? "" : "disabled"}>検索</button>
    <button class="btn hide" data-act="cancel">中止</button>
  </div>
  <div class="progress" id="progress"></div>`;
}

function sbWeaponSection() {
  const o = S().simOpts;
  const weapons = S().weapons;
  return `<h2>武器</h2>
    <div class="card">
      <div class="field"><select data-act="weapon-sel" aria-label="武器">
        <option value="manual" ${o.weapon === "manual" ? "selected" : ""}>スロット指定</option>
        ${weapons.length ? `<option value="all" ${o.weapon === "all" ? "selected" : ""}>登録武器すべて（${weapons.filter((w) => w.enabled !== false).length}）</option>` : ""}
        ${weapons.map((w) => `<option value="${w.id}" ${o.weapon === w.id ? "selected" : ""}>No.${w.no} ${esc(w.name)}（${(w.slots || []).join("-") || "スロなし"}）</option>`).join("")}
      </select></div>
      <div class="${o.weapon === "manual" ? "" : "hide"}">${fld("スロット", slotSelects(o.weaponSlots, "wslot"))}</div>
    </div>`;
}

function wildsWeaponSection() {
  const st = S();
  const o = st.simOpts;
  const type = o.weaponType || M.weaponTypes[0];
  const arts = st.artians.filter((a) => a.type === type);
  const owned = M.weapons.filter((w) => w.type === type && st.ownedWeapons[w.id]);
  const all = M.weapons.filter((w) => w.type === type);
  const wsel = ["manual", "type"].includes(o.weapon) || o.weapon.startsWith("ar:") || WEAPON[o.weapon] ? o.weapon : "type";
  const opt = (v, l) => `<option value="${esc(v)}" ${wsel === v ? "selected" : ""}>${esc(l)}</option>`;
  const wlabel = (w) => `${w.name}（${w.slots.join("-") || "スロなし"}${Object.keys(w.skills).length ? " / " + Object.entries(w.skills).map(([k, v]) => k + v).join(" ") : ""}）`;
  return `<h2>武器</h2>
    <div class="card">
      ${fld("武器種", `<select data-act="wtype">${M.weaponTypes.map((t) => `<option ${t === type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`)}
      <div class="field"><div class="field-lbl">武器</div><select data-act="weapon-sel">
        ${opt("type", `${type}すべて（${(o.includeUnowned ? all.length : owned.length) + (o.includeQurious ? arts.filter((a) => a.enabled !== false).length : 0)}）`)}
        ${opt("manual", "スロット指定")}
        ${arts.length ? `<optgroup label="アーティア">${arts.map((a) => opt("ar:" + a.id, `No.${a.no} ${artianItem(a).name}（${Object.keys(a.skills || {}).join("・") || "スキルなし"}）`)).join("")}</optgroup>` : ""}
        ${owned.length ? `<optgroup label="所持武器">${owned.map((w) => opt(w.id, wlabel(w))).join("")}</optgroup>` : ""}
        <optgroup label="すべての武器">${all.map((w) => opt(w.id, wlabel(w))).join("")}</optgroup>
      </select></div>
      <div class="${wsel === "manual" ? "" : "hide"}">${fld("スロット", slotSelects(o.weaponSlots, "wslot", 3))}</div>
    </div>`;
}

function buildInput() {
  const st = S();
  const o = st.simOpts;
  const w = isW();
  const parts = {};
  const keyMap = {};
  const pack = (it) => ({ key: it.key, name: it.name, slots: it.slots || [], wslots: it.wslots || [], skills: it.skills, def: it.def || 0, res: it.res || [0, 0, 0, 0, 0], pref: it.pref || 0 });
  for (const p of PARTS) {
    const arr = [];
    for (const a of M.armors) {
      if (a.part !== p || !sexOk(a) || st.excludedArmor[a.id]) continue;
      if (!o.includeUnowned && !st.ownedArmor[a.id]) continue;
      const it = { key: a.id, name: a.name, slots: a.slots, skills: a.skills, def: a.def, res: a.res, pref: st.ownedArmor[a.id] ? 1 : 0 };
      arr.push(pack(it));
      keyMap[it.key] = { ...it, kind: "armor", rarity: a.rarity };
    }
    if (!w && o.includeQurious) {
      for (const q of st.qurious) {
        if (q.enabled === false) continue;
        const it = quriousItem(q);
        if (!it || it.part !== p || !sexOk(it.base)) continue;
        arr.push(pack({ ...it, pref: 2 }));
        keyMap[it.key] = { ...it, kind: "qurious" };
      }
    }
    parts[p] = arr;
  }
  // 護石
  const charms = st.charms.filter((c) => c.enabled !== false).map((c) => { const it = charmItem(c); keyMap[it.key] = { ...it, kind: "charm" }; return pack({ ...it, pref: 2 }); });
  if (w) {
    for (const c of M.charms) {
      if (!o.includeUnowned && !st.ownedCharms[c.id]) continue;
      const it = fixedCharmItem(c);
      keyMap[it.key] = { ...it, kind: "fcharm" };
      charms.push(pack(it));
    }
  }
  parts.charm = charms;
  // 武器
  let ws = [];
  const manual = { key: "w:manual", name: "武器（スロット指定）", slots: [], wslots: [], skills: {}, def: 0 };
  if (w) {
    manual.wslots = o.weaponSlots.filter((s) => s > 0);
    const type = o.weaponType || M.weaponTypes[0];
    if (o.weapon === "manual") ws = [manual];
    else if (o.weapon.startsWith("ar:")) { const a = st.artians.find((x) => "ar:" + x.id === o.weapon); ws = a ? [{ ...artianItem(a), kind: "artian" }] : []; }
    else if (WEAPON[o.weapon]) ws = [{ ...wildsWeaponItem(WEAPON[o.weapon]), kind: "weapon" }];
    else {
      ws = M.weapons.filter((x) => x.type === type && (o.includeUnowned || st.ownedWeapons[x.id])).map((x) => ({ ...wildsWeaponItem(x), kind: "weapon" }));
      if (o.includeQurious) ws.push(...st.artians.filter((a) => a.type === type && a.enabled !== false).map((a) => ({ ...artianItem(a), kind: "artian" })));
    }
  } else {
    manual.slots = o.weaponSlots.filter((s) => s > 0);
    if (o.weapon === "manual" || !st.weapons.length) ws = [manual];
    else if (o.weapon === "all") ws = st.weapons.filter((x) => x.enabled !== false).map(weaponItem);
    else { const x = st.weapons.find((y) => y.id === o.weapon); ws = x ? [weaponItem(x)] : [manual]; }
  }
  if (!ws.length) ws = [manual];
  for (const x of ws) keyMap[x.key] = { kind: "weapon", ...x };
  parts.weapon = ws.map(pack);

  const decos = M.decos.map((d) => ({
    name: d.name, size: d.size, type: d.type || "A", skills: d.skills,
    count: o.useDecoCount ? (st.decoCount[d.name] == null ? null : st.decoCount[d.name]) : null,
  }));
  const skillMax = Object.fromEntries(M.skills.map((s) => [s.name, maxPts(s.name)]));
  const conds = st.conds.map((c) => ({ ...c }));
  return {
    input: { parts, decos, conds: conds.map((c) => ({ ...c, level: lvToPts(c.skill, c.level) })), skillMax, opts: { limit: o.limit, pruneDominated: o.pruneDominated, onlyFullSoft: o.onlyFullSoft } },
    keyMap, conds,
  };
}

function runSearch() {
  const { input, keyMap, conds } = buildInput();
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
    runBtn.textContent = "検索";
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
      last = { out: m.out, keyMap, conds, targets: Object.fromEntries(input.conds.map((c) => [c.skill, c.level])), at: new Date() };
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
function isOwnedItem(it) {
  if (!it) return false;
  const st = S();
  return it.kind === "qurious" || it.kind === "charm" || it.kind === "artian" ||
    (it.kind === "armor" && st.ownedArmor[it.key]) || (it.kind === "weapon" && st.ownedWeapons[it.key]) || (it.kind === "fcharm" && st.ownedCharms[it.key]);
}
function resultKeyFns() {
  const capOf = (arr) => (arr || []).reduce((a, n, k) => a + n * k, 0);
  return {
    priority: (r) => r._i,
    freeCount: (r) => r.freeCount,
    freeCap: (r) => r.freeCap,
    freeCapA: (r) => capOf(r.freeA),
    freeCapW: (r) => capOf(r.freeW),
    free4: (r) => r.free[4],
    free3: (r) => r.free[3] + r.free[4],
    free2: (r) => r.free[2] + r.free[3] + r.free[4],
    def: (r) => r.def,
    res0: (r) => r.res[0], res1: (r) => r.res[1], res2: (r) => r.res[2], res3: (r) => r.res[3], res4: (r) => r.res[4],
    softMet: (r) => r.softMet,
    owned: (r) => r.pieces.filter((p) => isOwnedItem(last.keyMap[p.items[0]])).length,
    skillTotal: (r) => Object.values(r.skills).reduce((a, b) => a + b, 0),
    __skill: (name) => (r) => r.skills[name] || 0,
  };
}
const RESULT_SORTS = () => [
  ["priority", "優先度順"],
  ["freeCount", "空きスロット数"],
  ["freeCap", "空きスロット合計Lv"],
  ...(isW() ? [["freeCapW", "空き武器スロット合計Lv"], ["freeCapA", "空き防具スロット合計Lv"]] : [["free4", "空きLv4スロット数"]]),
  ["free3", isW() ? "空きLv3スロット数" : "空きLv3以上スロット数"],
  ["free2", "空きLv2以上スロット数"],
  ["def", "防御力"],
  ...RES_LABEL.map((l, i) => ["res" + i, l + "耐性"]),
  ["softMet", "希望スキル達成数"],
  ["owned", "所持装備の数"],
  ["skillTotal", "スキルLv合計"],
  ...(last ? last.conds.map((c) => ["skill:" + c.skill, "スキル: " + c.skill]) : []),
];

function freeHTML(free, freeW) {
  let h = "";
  if (isW() && freeW) {
    const fa = free.map((n, k) => n - (freeW[k] || 0));
    h += freeW.map((n, k) => (k && n ? `${slotTag(k, "W", true)}×${n}` : "")).join(" ");
    h += " " + fa.map((n, k) => (k && n ? `${slotTag(k, "A", true)}×${n}` : "")).join(" ");
  } else {
    h = free.map((n, k) => (k && n ? `${slotTag(k, "A", true)}×${n}` : "")).join(" ");
  }
  return h.trim() || "なし";
}

function renderResults() {
  if (!last) {
    view.innerHTML = '<h2>検索結果</h2><div class="card"><p class="muted">まだ検索していません</p></div>';
    return;
  }
  const { out } = last;
  out.results.forEach((r, i) => (r._i = i));
  const st = sortState("results", "priority", "asc");
  const filter = S().ui.resFilter || "";
  let list = out.results;
  if (filter) list = list.filter((r) => matchAny([...r.pieces.flatMap((p) => p.items.flatMap((k) => { const it = last.keyMap[k]; return it ? [it.name, it.note, it.no ? "No." + it.no : ""] : []; })), ...Object.keys(r.skills)], filter));
  list = sorted(list, st.key, st.dir, resultKeyFns());
  const shown = list.slice(0, resultShown);
  view.innerHTML = `
    <h2><span class="grow">検索結果 ${out.results.length.toLocaleString()}件</span><span class="muted small">${G().short} / ${(out.stats.ms / 1000).toFixed(2)}秒</span></h2>
    ${out.truncated ? `<div class="notice">最大件数で打ち切り</div>` : ""}
    ${!out.results.length ? `<div class="notice">該当なし</div>` : ""}
    <div class="card">
      <div class="muted small">条件: ${last.conds.map((c) => `${esc(condText(c))}${c.required ? "(必須)" : ""}`).join(" / ")}</div>
      ${sortBar("results", RESULT_SORTS(), "priority", "asc")}
      <input type="search" placeholder="絞り込み" data-act="res-filter" value="${esc(filter)}" style="width:100%">
    </div>
    <div class="list cols" style="margin-top:10px">${shown.map((r) => resultCard(r, last.targets)).join("")}</div>
    ${list.length > resultShown ? `<button class="btn block" style="margin-top:10px" data-act="more">さらに表示（残り ${(list.length - resultShown).toLocaleString()}件）</button>` : ""}
  `;
}

function itemTag(it) {
  if (!it) return "";
  if (it.kind === "qurious") return '<span class="tag q">傀異</span> ';
  if (it.kind === "artian") return '<span class="tag q">アーティア</span> ';
  if (it.kind === "charm" && isW()) return '<span class="tag q">光</span> ';
  return isOwnedItem(it) && it.kind !== "charm" ? '<span class="tag own">所持</span> ' : "";
}
function itemName(it) {
  return it ? it.name : "（なし）";
}

function resultCard(r, targets) {
  const km = last.keyMap;
  const rows = r.pieces.map((p, pi) => {
    const main = km[p.items[0]];
    const alts = p.items.length > 1 ? `<button class="alt" data-act="alts" data-k="${esc(p.items.join("\n"))}">同等+${p.items.length - 1}</button>` : "";
    return pieceRowHTML({
      part: p.part, tag: itemTag(main), name: itemName(main), no: main?.no, note: main?.note,
      skills: main?.skills, decos: r.decos.filter((d) => d.piece === pi), extra: alts,
    });
  }).join("");
  const skills = Object.fromEntries(Object.entries(r.skills).sort((a, b) => (targets[b[0]] != null) - (targets[a[0]] != null) || b[1] - a[1]));
  return `<div class="item">
    <div class="res-head"><span class="no">#${r._i + 1}</span>
      <span class="muted small">防御 <b>${r.def}</b></span>
      <span class="muted small">空き ${freeHTML(r.free, r.freeW)}</span>
      <button class="btn sm right" data-act="save-set" data-i="${r._i}">${ICON_STAR}保存</button></div>
    <table class="pieces">${rows}</table>
    <div class="chips" style="margin-top:6px">${skillChips(skills, { targets, result: true })}</div>
    <div class="muted small" style="margin-top:4px">耐性 ${RES_LABEL.map((l, i) => l + r.res[i]).join(" ")}</div>
  </div>`;
}

function snapshot(r) {
  const km = last.keyMap;
  return {
    id: uid(),
    savedAt: Date.now(),
    conds: last.conds,
    targets: last.targets,
    pieces: r.pieces.map((p, pi) => {
      const it = km[p.items[0]];
      return {
        part: p.part,
        key: it?.key || "",
        name: it?.name || "（なし）",
        kind: it?.kind,
        no: it?.no,
        note: it?.note || "",
        skills: { ...(it?.skills || {}) },
        slots: (it?.slots || []).slice(),
        wslots: (it?.wslots || []).slice(),
        decos: r.decos.filter((d) => d.piece === pi).map((d) => ({ size: d.size, type: d.type, deco: d.deco })),
      };
    }),
    skills: r.skills, def: r.def, res: r.res, free: r.free, freeW: r.freeW, freeCount: r.freeCount, freeCap: r.freeCap, memo: "",
  };
}

// ======================================================================
// 画面: 装備
// ======================================================================
function equipTabs() {
  return isW()
    ? [["armor", "防具"], ["artian", "アーティア"], ["charm", "護石"], ["weapon", "武器"], ["deco", "装飾品"]]
    : [["armor", "防具"], ["qurious", "傀異錬成"], ["charm", "護石"], ["weapon", "武器"], ["deco", "装飾品"]];
}
function renderEquip() {
  const tabs = equipTabs();
  if (!tabs.some((t) => t[0] === equipTab)) equipTab = "armor";
  view.innerHTML = `<div class="seg" data-equip-tabs>${tabs.map(([k, l]) => `<button data-et="${k}" class="${equipTab === k ? "on" : ""}">${l}</button>`).join("")}</div><div id="equip-body"></div>`;
  renderEquipBody();
}
function renderEquipBody() {
  const el = document.getElementById("equip-body");
  if (!el) return;
  if (equipTab === "armor") el.innerHTML = armorView();
  else if (equipTab === "qurious") el.innerHTML = quriousView();
  else if (equipTab === "artian") el.innerHTML = artianView();
  else if (equipTab === "charm") el.innerHTML = charmView();
  else if (equipTab === "weapon") el.innerHTML = isW() ? wildsWeaponView() : weaponView();
  else el.innerHTML = decoView();
}

// ---- 防具 ----
const armorKeyFns = {
  name: (a) => a.name, rarity: (a) => a.rarity, def: (a) => a.def, no: (a) => a.no,
  slotSum: (a) => slotSum(a.slots), slot4: (a) => slotCount(a.slots, 4), slot3: (a) => slotCount(a.slots, 3), slotCount: (a) => slotCount(a.slots),
  skillTotal: (a) => Object.values(a.skills).reduce((x, y) => x + y, 0),
  owned: (a) => (S().ownedArmor[a.id] ? 1 : 0),
  __skill: (n) => (a) => a.skills[n] || 0,
};
const ARMOR_SORTS = () => [["no", "標準（データ順）"], ["name", "名前"], ["rarity", "レア度"], ["def", "防御力"], ["slotSum", "スロット合計Lv"], ["slotCount", "スロット数"], isW() ? ["slot3", "Lv3スロット数"] : ["slot4", "Lv4スロット数"], ["skillTotal", "スキルLv合計"], ["owned", "所持"]];

function armorFilterList() {
  const st = S();
  const ui = st.ui;
  const part = ui.armorPart || "head";
  let arr = M.armors.filter((a) => a.part === part && sexOk(a));
  if (ui.armorOwned) arr = arr.filter((a) => st.ownedArmor[a.id]);
  if (ui.armorQ) arr = arr.filter((a) => matchAny([a.name, ...Object.keys(a.skills)], ui.armorQ));
  const ss = sortState("armor", "no", "asc");
  return sorted(arr, ss.key, ss.dir, armorKeyFns);
}
function armorView() {
  const st = S();
  const ui = st.ui;
  const part = ui.armorPart || "head";
  const arr = armorFilterList();
  return `
    <h2><span class="grow">防具（所持 ${Object.keys(st.ownedArmor).length}件）</span></h2>
    <div class="card">
      <div class="seg" data-armor-parts>${PARTS.map((p) => `<button data-ap="${p}" class="${p === part ? "on" : ""}">${PART_LABEL[p]}</button>`).join("")}</div>
      <div class="row" style="margin-top:8px"><input type="search" class="grow" placeholder="防具名・スキル名" data-act="armor-q" value="${esc(ui.armorQ || "")}"></div>
      <label class="switch"><span class="txt">所持のみ表示</span><input type="checkbox" data-ui="armorOwned" ${ui.armorOwned ? "checked" : ""}></label>
      ${sortBar("armor", ARMOR_SORTS(), "no", "asc")}
      <div class="row"><button class="btn sm" data-act="own-all">表示中を所持に</button><button class="btn sm" data-act="own-none">表示中の所持を解除</button></div>
    </div>
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
        ${isW() ? "" : '<button class="btn sm right" data-act="q-new-from">＋傀異錬成</button>'}
      </div></div>`).join("") || '<p class="muted">該当する防具がありません</p>';
}

// ---- 傀異錬成（SB） ----
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
      return `<div class="item ${x.q.enabled === false ? "off" : ""}" data-qid="${x.q.id}">
        <div class="ttl"><span class="tag part">${PART_LABEL[x.part]}</span><span class="grow">${esc(x.name)}${regNoHTML(x.no)}${x.note ? ` <span class="pnote">${esc(x.note)}</span>` : ""}</span>${slotsHTML(x.slots, { pad: true })}</div>
        <div class="meta"><span>防御${x.def}</span><span>${RES_LABEL.map((l, i) => l + x.res[i]).join(" ")}</span></div>
        <div class="chips">${skillChips(x.skills)}</div>
        <div class="acts">
          <label class="inline"><input type="checkbox" class="mini-switch" data-act="q-enable" ${x.q.enabled !== false ? "checked" : ""}>検索対象</label>
          <span class="right"></span>
          <button class="btn sm" data-act="q-copy">複製</button>
          <button class="btn sm" data-act="q-edit">編集</button>
          <button class="btn sm danger" data-act="q-del">削除</button>
        </div></div>`;
    }).join("") || '<p class="muted">未登録</p>'}</div>`;
}

// 傀異錬成防具の登録・編集。入力は「錬成後の実際の値」（ゲーム画面に表示される値）で行い、
// 保存時にベース防具との差分（delta）へ変換する
function quriousForm(q, base, asCopy = false) {
  const src = q ? JSON.parse(JSON.stringify(q)) : null;
  const id = src ? src.id : uid();
  const createdAt = src?.createdAt || Date.now();
  const enabled = src ? src.enabled !== false : true;
  const isNew = !q || asCopy;
  // 編集用の状態（スロット・スキルは錬成後の値、防御・耐性はゲーム画面の表示どおり増減で持つ）
  const cur = { base: src ? src.base : base?.id, slots: [], skills: {}, defDelta: 0, resDelta: [0, 0, 0, 0, 0], note: src?.note || "" };
  const loadFromBase = (keepSkills) => {
    const b = ARMOR[cur.base];
    if (!b) return;
    if (!keepSkills) {
      cur.slots = b.slots.slice();
      cur.skills = { ...b.skills };
      cur.defDelta = 0;
      cur.resDelta = [0, 0, 0, 0, 0];
    }
  };
  if (src && ARMOR[src.base]) {
    const it = quriousItem(src);
    cur.slots = it.slots.slice();
    cur.skills = { ...it.skills };
    cur.defDelta = src.defDelta || 0;
    cur.resDelta = [0, 1, 2, 3, 4].map((i) => (src.resDelta || [])[i] || 0);
  } else loadFromBase(false);
  // 増減のプルダウン（上ほど大きい値）。iPhone の数字キーボードにはマイナスがないため選択式にする
  const signed = (v) => (v > 0 ? "+" + v : String(v));
  const deltaOptions = (hi, lo, v) => {
    const top = Math.max(hi, v), bottom = Math.min(lo, v);
    let h = "";
    for (let x = top; x >= bottom; x--) h += `<option value="${x}" ${x === v ? "selected" : ""}>${signed(x)}</option>`;
    return h;
  };
  const totalLine = (b) => `計 防御${b.def + cur.defDelta} ／ ${RES_LABEL.map((l, i) => l + (b.res[i] + cur.resDelta[i])).join(" ")}`;

  openModal({
    title: asCopy ? "傀異錬成防具を複製" : isNew ? "傀異錬成防具を登録" : "傀異錬成防具を編集",
    body: '<div data-form></div>',
    foot: '<button class="btn" data-close>キャンセル</button><button class="btn primary" data-save>保存</button>',
    onMount(m, close) {
      const f = m.querySelector("[data-form]");
      const render = () => {
        const b = ARMOR[cur.base];
        const baseSec = fsec("ベース防具", `<div class="pick-row"><span class="grow">${b
          ? `<b>${esc(b.name)}</b><br><span class="muted small">${PART_LABEL[b.part]}・防御${b.def}</span> ${slotsHTML(b.slots)}<div class="chips" style="margin-top:4px">${skillChips(b.skills)}</div>`
          : '<span class="muted">未選択</span>'}</span>
          <button class="btn sm" data-pick-base>${b ? "変更" : "選択"}</button></div>`);
        if (!b) { f.innerHTML = baseSec; return; }
        const skillRows = Object.entries(cur.skills).map(([k, v]) => {
          const max = Math.max(SKILL[k]?.max || 7, v);
          return `<div class="skill-row" data-sk="${esc(k)}"><span class="nm">${esc(k)}</span>
            <select data-sklv aria-label="${esc(k)}のLv">${lvOptions(max, v)}</select>
            <button class="btn sm icon danger" data-del-sk aria-label="${esc(k)}を外す">✕</button></div>`;
        }).join("") || '<p class="muted small" style="margin:4px 0">なし</p>';
        f.innerHTML = baseSec +
          fsec("スロット", slotSelects(cur.slots, "slot")) +
          fsec("スキル", `${skillRows}<button class="btn sm" data-add-sk style="margin-top:6px">＋スキル追加</button>`) +
          fsec("防御・耐性の増減", fld("防御力", `<select data-def>${deltaOptions(60, -30, cur.defDelta)}</select>`) +
            `<div class="g5">${RES_LABEL.map((l, i) => `<label class="cell"><span>${l}耐性</span><select data-res="${i}">${deltaOptions(10, -10, cur.resDelta[i])}</select></label>`).join("")}</div>
            <div class="muted small" style="margin-top:8px" data-total>${totalLine(b)}</div>`) +
          fsec("", fld("メモ", `<input type="text" data-note value="${esc(cur.note)}" placeholder="例: 攻撃特化">`));
      };
      const sync = () => {
        if (!ARMOR[cur.base]) return;
        cur.slots = readSlots(f, "slot");
        f.querySelectorAll("[data-sk]").forEach((row) => { cur.skills[row.dataset.sk] = +row.querySelector("[data-sklv]").value; });
        const num = (el) => (el && el.value !== "" ? +el.value : 0);
        cur.defDelta = num(f.querySelector("[data-def]"));
        cur.resDelta = [0, 1, 2, 3, 4].map((i) => num(f.querySelector(`[data-res="${i}"]`)));
        cur.note = f.querySelector("[data-note]")?.value || "";
      };
      render();
      if (!cur.base) setTimeout(() => f.querySelector("[data-pick-base]").click(), 0);
      f.addEventListener("change", (e) => { if (e.target.matches("select")) { sync(); render(); } });
      f.addEventListener("click", (e) => {
        if (e.target.closest("[data-pick-base]")) {
          sync();
          pickArmor({ part: ARMOR[cur.base]?.part || S().ui.armorPart || "head", onPick(a) { cur.base = a.id; loadFromBase(false); render(); } });
        } else if (e.target.closest("[data-add-sk]")) {
          sync();
          pickSkill({ title: "スキルを追加", onPick(n) { if (!cur.skills[n]) cur.skills[n] = 1; render(); } });
        } else if (e.target.closest("[data-del-sk]")) {
          sync();
          delete cur.skills[e.target.closest("[data-sk]").dataset.sk];
          render();
        }
      });
      m.querySelector("[data-save]").addEventListener("click", () => {
        sync();
        const b = ARMOR[cur.base];
        if (!b) { toast("ベース防具を選択してください"); return; }
        const delta = {};
        for (const k of new Set([...Object.keys(b.skills), ...Object.keys(cur.skills)])) {
          const d = (cur.skills[k] || 0) - (b.skills[k] || 0);
          if (d) delta[k] = d;
        }
        const rec = {
          id, no: asCopy ? undefined : src?.no, base: b.id, slots: cur.slots, delta, defDelta: cur.defDelta,
          resDelta: cur.resDelta.slice(), note: cur.note, enabled, createdAt,
        };
        if (!okToSave("qurious", rec)) return;
        update((st) => {
          const i = st.qurious.findIndex((x) => x.id === rec.id);
          if (i >= 0) st.qurious[i] = rec; else st.qurious.push(rec);
        });
        close();
        toast("保存しました");
        rerender();
      });
    },
  });
}

// ---- アーティア武器（ワイルズ） ----
const artianKeyFns = {
  added: (x) => x.a.createdAt || 0, name: (x) => x.name, type: (x) => M.weaponTypes.indexOf(x.type),
  slotSum: (x) => slotSum(x.wslots),
  __skill: (n) => (x) => x.skills[n] || 0,
};
function artianView() {
  const st = S();
  const ss = sortState("artian", "added", "desc");
  const ft = st.ui.artianType || "";
  let arr = st.artians.map(artianItem);
  if (ft) arr = arr.filter((x) => x.type === ft);
  arr = sorted(arr, ss.key, ss.dir, artianKeyFns);
  return `
    <h2><span class="grow">アーティア武器（${st.artians.length}件）</span><button class="btn sm primary" data-act="ar-new">＋登録</button></h2>
    <div class="card">
      <div class="field"><div class="field-lbl">武器種</div><select data-act="artian-type"><option value="">すべて</option>${M.weaponTypes.map((t) => `<option ${t === ft ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
      ${sortBar("artian", [["added", "登録順"], ["type", "武器種"], ["name", "名前"], ["slotSum", "スロット合計Lv"]], "added", "desc")}
    </div>
    <div class="list cols" style="margin-top:10px">${arr.map((x) => `<div class="item ${x.a.enabled === false ? "off" : ""}" data-arid="${x.a.id}">
        <div class="ttl"><span class="tag part">${esc(x.type)}</span><span class="grow">${esc(x.name)}${regNoHTML(x.no)}${x.note ? ` <span class="pnote">${esc(x.note)}</span>` : ""}</span>${slotsHTML([], { wslots: x.wslots })}</div>
        <div class="chips">${skillChips(x.skills)}</div>
        <div class="acts"><label class="inline"><input type="checkbox" class="mini-switch" data-act="ar-enable" ${x.a.enabled !== false ? "checked" : ""}>検索対象</label>
          <span class="right"></span><button class="btn sm" data-act="ar-copy">複製</button><button class="btn sm" data-act="ar-edit">編集</button><button class="btn sm danger" data-act="ar-del">削除</button></div></div>`).join("") || '<p class="muted">未登録</p>'}</div>`;
}
function artianForm(a, asCopy = false) {
  const cur = a ? JSON.parse(JSON.stringify(a)) : { id: uid(), type: S().ui.artianType || S().simOpts.weaponType || M.weaponTypes[0], name: "", skills: {}, wslots: [3, 3, 3], note: "", enabled: true, createdAt: Date.now() };
  const groups = M.skills.filter((s) => s.kind === "G" && s.artian);
  const series = M.skills.filter((s) => s.kind === "S" && s.artian);
  const curG = Object.keys(cur.skills).find((k) => SKILL[k]?.kind === "G") || "";
  const curS = Object.keys(cur.skills).find((k) => SKILL[k]?.kind === "S") || "";
  openModal({
    title: asCopy ? "アーティア武器を複製" : a ? "アーティア武器を編集" : "アーティア武器を登録",
    body: fsec("武器", fld("武器種", `<select data-type>${M.weaponTypes.map((t) => `<option ${t === cur.type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`) +
        fld("名前", `<input type="text" data-name value="${esc(cur.name)}" placeholder="例: アーティアセイバー 火会心">`)) +
      fsec("スキル", fld("グループスキル", `<select data-g><option value="">なし</option>${groups.map((s) => `<option value="${esc(s.name)}" ${s.name === curG ? "selected" : ""}>${esc(s.name)}（${esc(s.names[0])}）</option>`).join("")}</select>`) +
        fld("シリーズスキル", `<select data-s><option value="">なし</option>${series.map((s) => `<option value="${esc(s.name)}" ${s.name === curS ? "selected" : ""}>${esc(s.name)}（${esc(s.names.join("/"))}）</option>`).join("")}</select>`)) +
      fsec("スロット", slotSelects(cur.wslots, "slot", 3)) +
      fsec("", fld("メモ", `<input type="text" data-note value="${esc(cur.note || "")}" placeholder="例: 火属性 会心強化×3">`)),
    foot: '<button class="btn" data-close>キャンセル</button><button class="btn primary" data-save>保存</button>',
    onMount(m, close) {
      m.querySelector("[data-save]").addEventListener("click", () => {
        cur.type = m.querySelector("[data-type]").value;
        cur.name = m.querySelector("[data-name]").value.trim();
        cur.skills = {};
        const g = m.querySelector("[data-g]").value, s = m.querySelector("[data-s]").value;
        if (g) cur.skills[g] = 1;
        if (s) cur.skills[s] = 1;
        cur.wslots = readSlots(m, "slot");
        cur.note = m.querySelector("[data-note]").value;
        if (!okToSave("artians", cur)) return;
        update((st) => {
          const i = st.artians.findIndex((x) => x.id === cur.id);
          if (i >= 0) st.artians[i] = cur; else st.artians.push(cur);
        });
        close();
        toast("保存しました");
        rerender();
      });
    },
  });
}

// ---- 護石 ----
const charmKeyFns = {
  added: (x) => x.c.createdAt || 0, slotSum: (x) => slotSum(x.slots) + slotSum(x.wslots), slot4: (x) => slotCount(x.slots, 4), slotCount: (x) => slotCount(x.slots) + slotCount(x.wslots),
  wslot: (x) => slotSum(x.wslots),
  skillTotal: (x) => Object.values(x.skills).reduce((a, b) => a + b, 0),
  skill1: (x) => (x.c.skills?.[0]?.[0] || ""),
  __skill: (n) => (x) => x.skills[n] || 0,
};
const CHARM_SORTS = () => [["added", "登録順"], ["skill1", "第1スキル名"], ["skillTotal", "スキルLv合計"], ["slotSum", "スロット合計Lv"], ["slotCount", "スロット数"], isW() ? ["wslot", "武器スロット合計Lv"] : ["slot4", "Lv4スロット数"]];
function charmView() {
  const st = S();
  if (isW() && (st.ui.charmSeg || "shining") === "fixed") return fixedCharmView();
  const ss = sortState("charm", "added", "desc");
  let arr = st.charms.map(charmItem);
  if (st.ui.charmQ) arr = arr.filter((x) => matchAny([...Object.keys(x.skills), x.c.note], st.ui.charmQ));
  arr = sorted(arr, ss.key, ss.dir, charmKeyFns);
  return `
    ${isW() ? charmSeg() : ""}
    <h2><span class="grow">${isW() ? "光るお守り" : "護石"}（${st.charms.length}件）</span>
      <button class="btn sm" data-act="c-import">インポート</button>
      <button class="btn sm primary" data-act="c-new">＋登録</button></h2>
    <div class="card">
      <input type="search" placeholder="スキル名" data-act="charm-q" value="${esc(st.ui.charmQ || "")}" style="width:100%">
      ${sortBar("charm", CHARM_SORTS(), "added", "desc")}
    </div>
    <div class="list cols" style="margin-top:10px" id="charm-list">${arr.map((x) => `<div class="item ${x.c.enabled === false ? "off" : ""}" data-cid="${x.c.id}">
        <div class="ttl"><span class="grow">${esc(x.name)}${regNoHTML(x.no)}${x.note ? ` <span class="pnote">${esc(x.note)}</span>` : ""}</span>${slotsHTML(x.slots, { pad: true, wslots: x.wslots })}</div>
        <div class="chips">${skillChips(x.skills)}</div>
        <div class="acts"><label class="inline"><input type="checkbox" class="mini-switch" data-act="c-enable" ${x.c.enabled !== false ? "checked" : ""}>検索対象</label>
        <span class="right"></span><button class="btn sm" data-act="c-edit">編集</button><button class="btn sm danger" data-act="c-del">削除</button></div></div>`).join("") || `<p class="muted">未登録</p>`}</div>`;
}
function charmSeg() {
  const seg = S().ui.charmSeg || "shining";
  return `<div class="seg" style="margin-top:10px" data-charm-seg><button data-cs="shining" class="${seg === "shining" ? "on" : ""}">光るお守り</button><button data-cs="fixed" class="${seg === "fixed" ? "on" : ""}">固定護石</button></div>`;
}
const fcharmKeyFns = {
  no: (c) => c.no, name: (c) => c.name, rarity: (c) => c.rarity, owned: (c) => (S().ownedCharms[c.id] ? 1 : 0),
  skillTotal: (c) => Object.values(c.skills).reduce((a, b) => a + b, 0),
  __skill: (n) => (c) => c.skills[n] || 0,
};
function fixedCharmList() {
  const st = S();
  let arr = M.charms;
  if (st.ui.fcharmOwned) arr = arr.filter((c) => st.ownedCharms[c.id]);
  if (st.ui.fcharmQ) arr = arr.filter((c) => matchAny([c.name, ...Object.keys(c.skills)], st.ui.fcharmQ));
  const ss = sortState("fcharm", "no", "asc");
  return sorted(arr, ss.key, ss.dir, fcharmKeyFns);
}
function fixedCharmView() {
  const st = S();
  const arr = fixedCharmList();
  return `${charmSeg()}
    <h2>固定護石（所持 ${Object.keys(st.ownedCharms).length}件）</h2>
    <div class="card">
      <input type="search" placeholder="護石名・スキル名" data-act="fcharm-q" value="${esc(st.ui.fcharmQ || "")}" style="width:100%">
      <label class="switch"><span class="txt">所持のみ表示</span><input type="checkbox" data-ui="fcharmOwned" ${st.ui.fcharmOwned ? "checked" : ""}></label>
      ${sortBar("fcharm", [["no", "標準（データ順）"], ["name", "名前"], ["rarity", "レア度"], ["skillTotal", "スキルLv合計"], ["owned", "所持"]], "no", "asc")}
      <div class="row"><button class="btn sm" data-act="fc-own-all">表示中を所持に</button><button class="btn sm" data-act="fc-own-none">表示中の所持を解除</button></div>
    </div>
    <div class="list cols" style="margin-top:10px" id="fcharm-list">${fixedCharmRows(arr)}</div>`;
}
function fixedCharmRows(arr) {
  const st = S();
  return arr.map((c) => `<div class="item" data-fcid="${esc(c.id)}"><div class="ttl"><span class="grow">${esc(c.name)}</span>
      <label class="inline small"><input type="checkbox" class="mini-switch" data-act="fc-own" ${st.ownedCharms[c.id] ? "checked" : ""}>所持</label></div>
      <div class="chips">${skillChips(c.skills)}</div></div>`).join("") || '<p class="muted">該当なし</p>';
}
function charmForm(c) {
  const N = G().charmSkills;
  const cur = c ? JSON.parse(JSON.stringify(c)) : { id: uid(), skills: [], slots: [], wslots: [], note: "", enabled: true, createdAt: Date.now() };
  while (cur.skills.length < N) cur.skills.push(["", 1]);
  const label = isW() ? "光るお守り" : "護石";
  openModal({
    title: c ? `${label}を編集` : `${label}を登録`,
    body: '<div data-form></div>',
    foot: `${c ? "" : '<label class="inline small" style="margin-right:auto"><input type="checkbox" data-cont> 続けて登録</label>'}<button class="btn" data-close>キャンセル</button><button class="btn primary" data-save>保存</button>`,
    onMount(m, close) {
      const f = m.querySelector("[data-form]");
      const render = () => {
        f.innerHTML = fsec("スキル", cur.skills.map(([n, v], i) => {
          const max = SKILL[n] ? (isW() && M.charmSkillMax?.[n]) || SKILL[n].max : 7;
          return `<div class="skill-row"><button class="btn pick" data-pick="${i}">${n ? esc(n) : '<span class="muted">スキル' + (i + 1) + 'を選択</span>'}</button>
            <select data-lv="${i}" ${n ? "" : "disabled"} aria-label="スキル${i + 1}のLv">${lvOptions(Math.max(max, v || 1), v)}</select>
            ${n ? `<button class="btn sm icon danger" data-clear="${i}" aria-label="スキル${i + 1}を外す">✕</button>` : '<span></span>'}</div>`;
        }).join("")) +
          fsec(isW() ? "スロット（サイズ・種別）" : "スロット", isW() ? typedSlotRows(cur.slots, cur.wslots) : slotSelects(cur.slots, "slot")) +
          fsec("", fld("メモ", `<input type="text" data-note value="${esc(cur.note || "")}">`));
      };
      const sync = () => {
        cur.skills.forEach((s, i) => { const el = f.querySelector(`[data-lv="${i}"]`); if (el && s[0]) s[1] = +el.value; });
        if (isW()) Object.assign(cur, readTypedSlots(f)); else cur.slots = readSlots(f, "slot");
        cur.note = f.querySelector("[data-note]").value;
      };
      render();
      f.addEventListener("click", (e) => {
        const p = e.target.closest("[data-pick]");
        const cl = e.target.closest("[data-clear]");
        if (p) {
          sync();
          const i = +p.dataset.pick;
          pickSkill({
            filter: isW() && M.charmSkillMax ? (s) => M.charmSkillMax[s.name] != null || s.kind === "A" || s.kind === "W" : null,
            onPick(n) { cur.skills[i] = [n, Math.min(cur.skills[i][1] || 1, SKILL[n].max)]; render(); },
          });
        }
        if (cl) { sync(); cur.skills[+cl.dataset.clear] = ["", 1]; render(); }
      });
      f.addEventListener("change", sync);
      m.querySelector("[data-save]").addEventListener("click", () => {
        sync();
        const out = { ...cur, skills: cur.skills.filter((s) => s[0]) };
        if (!out.skills.length && !out.slots.length && !(out.wslots || []).length) { toast("スキルかスロットを入力してください"); return; }
        if (!okToSave("charms", out)) return;
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

// ---- 武器（SB: 登録制） ----
const weaponKeyFns = {
  added: (w) => w.createdAt || 0, name: (w) => w.name, type: (w) => SB_WEAPON_TYPES.indexOf(w.type),
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
</div>
    <div class="list cols" style="margin-top:10px">${arr.map((w) => `<div class="item ${w.enabled === false ? "off" : ""}" data-wid="${w.id}">
      <div class="ttl"><span class="grow">${esc(w.name)}${regNoHTML(w.no)}${w.note ? ` <span class="pnote">${esc(w.note)}</span>` : ""}</span>${slotsHTML(w.slots, { pad: true })}</div>
      <div class="meta"><span>${esc(w.type || "")}</span></div>
      <div class="acts"><label class="inline"><input type="checkbox" class="mini-switch" data-act="w-enable" ${w.enabled !== false ? "checked" : ""}>検索対象</label>
      <span class="right"></span><button class="btn sm" data-act="w-edit">編集</button><button class="btn sm danger" data-act="w-del">削除</button></div></div>`).join("") || '<p class="muted">未登録</p>'}</div>`;
}
function weaponForm(w) {
  const cur = w ? JSON.parse(JSON.stringify(w)) : { id: uid(), name: "", type: SB_WEAPON_TYPES[0], slots: [], note: "", enabled: true, createdAt: Date.now() };
  openModal({
    title: w ? "武器を編集" : "武器を登録",
    body: fsec("武器", fld("名前", `<input type="text" data-name value="${esc(cur.name)}" placeholder="例: 天上天下天地無双刀">`) +
        fld("武器種", `<select data-type>${SB_WEAPON_TYPES.map((t) => `<option ${t === cur.type ? "selected" : ""}>${t}</option>`).join("")}</select>`)) +
      fsec("スロット", slotSelects(cur.slots, "slot")) +
      fsec("", fld("メモ", `<input type="text" data-note value="${esc(cur.note || "")}">`)),
    foot: '<button class="btn" data-close>キャンセル</button><button class="btn primary" data-save>保存</button>',
    onMount(m, close) {
      m.querySelector("[data-save]").addEventListener("click", () => {
        cur.name = m.querySelector("[data-name]").value.trim() || cur.type;
        cur.type = m.querySelector("[data-type]").value;
        cur.slots = readSlots(m, "slot");
        cur.note = m.querySelector("[data-note]").value;
        if (!okToSave("weapons", cur)) return;
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

// ---- 武器（ワイルズ: マスタから所持登録） ----
const wweaponKeyFns = {
  no: (w) => w.no, name: (w) => w.name, rarity: (w) => w.rarity, attack: (w) => w.attack,
  slotSum: (w) => slotSum(w.slots), slotCount: (w) => slotCount(w.slots), slot3: (w) => slotCount(w.slots, 3),
  owned: (w) => (S().ownedWeapons[w.id] ? 1 : 0),
  skillTotal: (w) => Object.values(w.skills).reduce((a, b) => a + b, 0),
  __skill: (n) => (w) => w.skills[n] || 0,
};
function wildsWeaponList() {
  const st = S();
  const type = st.ui.wwType || st.simOpts.weaponType || M.weaponTypes[0];
  let arr = M.weapons.filter((w) => w.type === type);
  if (st.ui.wwOwned) arr = arr.filter((w) => st.ownedWeapons[w.id]);
  if (st.ui.wwQ) arr = arr.filter((w) => matchAny([w.name, ...Object.keys(w.skills)], st.ui.wwQ));
  const ss = sortState("wweapon", "no", "asc");
  return sorted(arr, ss.key, ss.dir, wweaponKeyFns);
}
function wildsWeaponView() {
  const st = S();
  const type = st.ui.wwType || st.simOpts.weaponType || M.weaponTypes[0];
  return `
    <h2>武器（所持 ${Object.keys(st.ownedWeapons).length}件）</h2>
    <div class="card">
      <div class="field"><div class="field-lbl">武器種</div><select data-act="ww-type">${M.weaponTypes.map((t) => `<option ${t === type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
      <input type="search" placeholder="武器名・スキル名" data-act="ww-q" value="${esc(st.ui.wwQ || "")}" style="width:100%">
      <label class="switch"><span class="txt">所持のみ表示</span><input type="checkbox" data-ui="wwOwned" ${st.ui.wwOwned ? "checked" : ""}></label>
      ${sortBar("wweapon", [["no", "標準（データ順）"], ["name", "名前"], ["rarity", "レア度"], ["attack", "攻撃力"], ["slotSum", "スロット合計Lv"], ["slotCount", "スロット数"], ["slot3", "Lv3スロット数"], ["skillTotal", "スキルLv合計"], ["owned", "所持"]], "no", "asc")}
      <div class="row"><button class="btn sm" data-act="ww-own-all">表示中を所持に</button><button class="btn sm" data-act="ww-own-none">表示中の所持を解除</button></div>
    </div>
    <div class="list cols" style="margin-top:10px" id="ww-list">${wildsWeaponRows(wildsWeaponList())}</div>`;
}
function wildsWeaponRows(arr) {
  const st = S();
  return arr.map((w) => `<div class="item" data-wwid="${esc(w.id)}">
      <div class="ttl"><span class="grow">${esc(w.name)}</span>${slotsHTML([], { wslots: w.slots })}</div>
      <div class="meta"><span>R${w.rarity}</span><span>攻撃${w.attack}</span>${w.def ? `<span>防御+${w.def}</span>` : ""}</div>
      <div class="chips">${skillChips(w.skills)}</div>
      <div class="acts"><label class="inline"><input type="checkbox" class="mini-switch" data-act="ww-own" ${st.ownedWeapons[w.id] ? "checked" : ""}>所持</label></div></div>`).join("") || '<p class="muted">該当なし</p>';
}

// ---- 装飾品 ----
const firstSkill = (d) => Object.keys(d.skills)[0] || "";
const decoKeyFns = {
  name: (d) => d.name, size: (d) => d.size, skill: firstSkill, lv: (d) => d.skills[firstSkill(d)] || 0, type: (d) => d.type,
  count: (d) => { const c = S().decoCount[d.name]; return c == null ? 9999 : c; },
  __skill: (n) => (d) => d.skills[n] || 0,
};
function decoView() {
  const st = S();
  const ss = sortState("deco", "skill", "asc");
  let arr = M.decos;
  if (st.ui.decoQ) arr = arr.filter((d) => matchAny([d.name, ...Object.keys(d.skills)], st.ui.decoQ));
  if (st.ui.decoSize) arr = arr.filter((d) => d.size === st.ui.decoSize);
  if (isW() && st.ui.decoType) arr = arr.filter((d) => d.type === st.ui.decoType);
  arr = sorted(arr, ss.key, ss.dir, decoKeyFns);
  const sizes = Array.from({ length: G().slotMax }, (_, i) => i + 1);
  return `
    <h2><span class="grow">装飾品（${M.decos.length}種）</span></h2>
    <div class="card">
      <input type="search" placeholder="装飾品名・スキル名" data-act="deco-q" value="${esc(st.ui.decoQ || "")}" style="width:100%">
      <div class="seg" style="margin-top:8px" data-deco-size><button data-ds="0" class="${!st.ui.decoSize ? "on" : ""}">すべて</button>${sizes.map((s) => `<button data-ds="${s}" class="${st.ui.decoSize === s ? "on" : ""}">Lv${s}</button>`).join("")}</div>
      ${isW() ? `<div class="seg" style="margin-top:6px" data-deco-type>${[["", "すべて"], ["W", "武器用"], ["A", "防具用"]].map(([k, l]) => `<button data-dt="${k}" class="${(st.ui.decoType || "") === k ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
      ${sortBar("deco", [["skill", "スキル名"], ["name", "名前"], ["size", "スロットLv"], ["lv", "スキルLv"], ["count", "所持数"], ...(isW() ? [["type", "種別（武器/防具）"]] : [])], "skill", "asc")}
      <div class="row"><button class="btn sm" data-act="deco-unlimited">全て無制限</button><button class="btn sm" data-act="deco-zero">表示中を0個に</button></div>
      <p class="muted small" style="margin:6px 0 0">所持数: 空欄（∞）＝無制限</p>
    </div>
    <div class="list cols" style="margin-top:10px" id="deco-list">${arr.map((d) => {
      const c = st.decoCount[d.name];
      return `<div class="item" data-dn="${esc(d.name)}"><div class="ttl">${slotTag(d.size, d.type)}<span class="grow">${esc(d.name)}</span>
        <input type="number" min="0" inputmode="numeric" data-act="deco-count" value="${c == null ? "" : c}" placeholder="∞" aria-label="${esc(d.name)}の所持数（空欄で無制限）" style="width:72px"></div>
        <div class="meta">${isW() ? `<span class="tag">${d.type === "W" ? "武器用" : "防具用"}</span>` : ""}${Object.entries(d.skills).map(([k, v]) => `${esc(k)} +${v}`).join(" ／ ")}</div></div>`;
    }).join("")}</div>`;
}

// ---- 名前のあいまい解決（インポート用） ----
// 完全一致、または候補が1件に決まるときだけ自動で決める（resolveByScore は search.js）。候補が複数・0件のときはユーザーに選び直してもらう
function resolveSkill(text, filter) {
  const q = String(text || "").trim();
  if (!norm(q)) return { pick: null, count: 0 };
  if (SKILL[q] && (!filter || filter(SKILL[q]))) return { pick: q, count: 1 };
  // 「汎用錬成スキル」（c3 など内部用）は完全一致のときだけ使い、あいまいな候補には出さない
  const pool = M.skills.filter((x) => x.cat !== "汎用錬成スキル" && (!filter || filter(x)));
  const r = resolveByScore(pool, q, (x) => Math.min(score(x.name, q), ...(x.names || []).map((n) => score(n, q))));
  return { pick: r.pick ? r.pick.name : null, count: r.count };
}
function resolveArmor(text) {
  const q = String(text || "").trim();
  const n = norm(q);
  if (!n) return { pick: null, count: 0 };
  const exact = M.armors.filter((a) => norm(a.name) === n && sexOk(a));
  if (exact.length === 1) return { pick: exact[0].id, count: 1 };
  const r = resolveByScore(M.armors.filter(sexOk), q, (a) => score(a.name, q));
  return { pick: r.pick ? r.pick.id : null, count: r.count };
}
// ワイルズの光るお守りに付くスキル（登録画面の選択肢と同じ条件）
const charmSkillFilter = () => (isW() && M.charmSkillMax ? (x) => M.charmSkillMax[x.name] != null || x.kind === "A" || x.kind === "W" : null);

// ---- 重複チェック: メモなどを除いた「中身」が同じものを重複とみなす ----
const descJoin = (a) => (a || []).filter((v) => v > 0).slice().sort((x, y) => y - x).join(".");
const DUP_SIG = {
  qurious: (q) => [q.base, descJoin(q.slots), Object.entries(q.delta || {}).filter(([, v]) => v).map(([k, v]) => k + ":" + v).sort().join("|"), q.defDelta || 0, (q.resDelta || []).map((v) => v || 0).join(".")].join("/"),
  charms: (c) => [(c.skills || []).filter((x) => x[0]).map(([k, v]) => k + ":" + v).sort().join("|"), descJoin(c.slots), descJoin(c.wslots)].join("/"),
  artians: (a) => [a.type, Object.keys(a.skills || {}).sort().join("|"), descJoin(a.wslots)].join("/"),
  weapons: (w) => [w.name, w.type, descJoin(w.slots)].join("/"),
  mysets: (x) => (x.pieces || []).map((p) => [p.part, p.name, p.note, (p.decos || []).map((d) => d.deco || "-").join(".")].join(":")).join("/"),
};
const DUP_LABEL = { qurious: "傀異錬成防具", artians: "アーティア武器", weapons: "武器", mysets: "マイセット" };
function findDup(kind, rec, list = S()[kind]) {
  const sig = DUP_SIG[kind](rec);
  return list.find((x) => x.id !== rec.id && DUP_SIG[kind](x) === sig) || null;
}
// 保存前の確認。重複がなければ true。重複があれば確認し、保存してよければ true
function okToSave(kind, rec) {
  if (!findDup(kind, rec)) return true;
  const label = DUP_LABEL[kind] || (isW() ? "光るお守り" : "護石");
  return confirm(`同じ内容の${label}が既に登録されています。それでも保存しますか？`);
}

// ---- インポート（泣きシミュ等のCSV形式） ----
function parseCSVLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/[,\t]/).map((x) => x.trim()));
}
function importDialog(kind) {
  const isQ = kind === "q";
  const w = isW();
  const listKey = isQ ? "qurious" : "charms";
  const sf = isQ ? null : charmSkillFilter();
  const help = isQ
    ? "<code>ベース防具名,防御力増減,火,水,雷,氷,龍,スロット1増加,スロット2増加,スロット3増加,スキル名,増減,スキル名,増減,…</code>"
    : w ? "<code>スキル1,Lv,スキル2,Lv,スキル3,Lv,武器スロ1,武器スロ2,武器スロ3,防具スロ1,防具スロ2,防具スロ3</code>"
      : "<code>スキル1,Lv,スキル2,Lv,スロット1,スロット2,スロット3</code>";
  const ph = isQ ? "ゴアヘルムＳ,0,0,0,0,0,0,1,0,0,攻撃,1" : w ? "攻撃,1,弱点特効,1,,,1,0,0,2,0,0" : "攻撃,2,見切り,1,2,1,0";
  // ユーザーが選び直した名前（入力された文字 → 正式名 / 防具ID）。同じ入力は1回選べば全行に使う
  const fixSkill = new Map(), fixArmor = new Map();
  let reviewed = false; // 確認画面を一度出したか
  const skillOf = (raw) => fixSkill.get(raw) || resolveSkill(raw, sf).pick;
  const armorOf = (raw) => fixArmor.get(raw) || resolveArmor(raw).pick;

  // 1行を登録データにする。名前が決まらないときは unresolved に入れて null を返す
  const build = (cols, unresolved) => {
    const n = (i) => +(cols[i] || 0) || 0;
    let ok = true;
    const needSkill = (raw) => { const nm = skillOf(raw); if (!nm) { unresolved.push(["skill", raw]); ok = false; } return nm; };
    if (isQ) {
      const aid = armorOf(cols[0]);
      if (!aid) { unresolved.push(["armor", cols[0] || ""]); ok = false; }
      const delta = {};
      for (let i = 10; i + 1 < cols.length; i += 2) {
        if (!cols[i]) continue;
        const nm = needSkill(cols[i]);
        if (nm) delta[nm] = (delta[nm] || 0) + n(i + 1);
      }
      if (!ok) return null;
      const a = ARMOR[aid];
      const base = a.slots.slice().sort((x, y) => y - x);
      const slots = [0, 1, 2].map((i) => Math.min(4, (base[i] || 0) + n(7 + i))).filter((v) => v > 0);
      return { id: uid(), base: a.id, slots, delta, defDelta: n(1), resDelta: [n(2), n(3), n(4), n(5), n(6)], note: "", enabled: true };
    }
    const skills = [];
    const nsk = w ? 3 : 2;
    for (let j = 0; j < nsk; j++) {
      const raw = cols[j * 2];
      if (!raw) continue;
      const nm = needSkill(raw);
      if (nm) skills.push([nm, +cols[j * 2 + 1] || 1]);
    }
    if (!ok) return null;
    const o = nsk * 2;
    const desc = (a) => a.filter((v) => v > 0).sort((x, y) => y - x);
    const rec = w
      ? { wslots: desc([n(o), n(o + 1), n(o + 2)]), slots: desc([n(o + 3), n(o + 4), n(o + 5)]) }
      : { slots: desc([n(o), n(o + 1), n(o + 2)]), wslots: [] };
    return { id: uid(), skills, ...rec, note: "", enabled: true };
  };

  openModal({
    title: isQ ? "傀異錬成防具のインポート" : w ? "光るお守りのインポート" : "護石のインポート",
    body: `<p class="muted small">1行1件: ${help}</p>
      <textarea data-text placeholder="${esc(ph)}"></textarea>
      <div data-review></div>`,
    foot: '<button class="btn" data-close>キャンセル</button><button class="btn primary" data-go>取り込む</button>',
    onMount(m, close) {
      const review = m.querySelector("[data-review]");
      const goBtn = m.querySelector("[data-go]");
      const ta = m.querySelector("[data-text]");
      ta.addEventListener("input", () => { reviewed = false; review.innerHTML = ""; goBtn.textContent = "取り込む"; });

      // 全行を解析: 取り込める行・名前待ちの行・重複（登録済み、または貼り付けた中で同じ内容）
      const analyze = () => {
        const recs = [], pending = [], need = new Map(), dups = [], batch = [];
        const existing = S()[listKey];
        for (const cols of parseCSVLines(ta.value)) {
          const un = [];
          const rec = build(cols, un);
          if (!rec) {
            pending.push(cols);
            for (const [k, raw] of un) need.set(k + "\u0000" + raw, [k, raw]);
            continue;
          }
          const dup = !!(findDup(listKey, rec, existing) || findDup(listKey, rec, batch));
          batch.push(rec);
          recs.push({ rec, dup });
          if (dup) dups.push(cols);
        }
        return { recs, pending, need: [...need.values()], dups };
      };

      const renderReview = (a) => {
        const keep = review.querySelector("[data-dup-ok]")?.checked;
        let h = "";
        if (a.need.length) {
          h += `<div class="fsec" style="margin-top:10px"><h4>名前を選び直す（${a.need.length}件）</h4>` + a.need.map(([k, raw]) => {
            const r = k === "skill" ? resolveSkill(raw, sf) : resolveArmor(raw);
            return `<div class="skill-row"><span class="nm">「${esc(raw)}」<span class="muted small"> ${k === "armor" ? "防具 " : ""}${r.count ? `候補${r.count}件` : "該当なし"}</span></span>
              <span></span><button class="btn sm" data-fix="${k}" data-raw="${esc(raw)}">選ぶ</button></div>`;
          }).join("") + "</div>";
        }
        const fixed = [...[...fixSkill], ...[...fixArmor].map(([raw, id]) => [raw, ARMOR[id]?.name || id])];
        if (fixed.length) h += `<p class="muted small" style="margin:8px 0 0">選んだ名前: ${fixed.map(([raw, nm]) => `${esc(raw)}→${esc(nm)}`).join("、")}</p>`;
        if (a.dups.length) {
          h += `<div class="fsec" style="margin-top:10px"><h4>登録済みと同じ内容（${a.dups.length}件）</h4>
            <p class="muted small" style="margin:0 0 4px">${a.dups.map((c) => esc(c.join(","))).join("<br>")}</p>
            <label class="inline small"><input type="checkbox" class="mini-switch" data-dup-ok ${keep ? "checked" : ""}> 重複も取り込む</label></div>`;
        }
        review.innerHTML = h;
        goBtn.textContent = a.need.length || a.dups.length ? "この内容で取り込む" : "取り込む";
      };

      review.addEventListener("click", (e) => {
        const b = e.target.closest("[data-fix]");
        if (!b) return;
        const raw = b.dataset.raw;
        const after = () => renderReview(analyze());
        if (b.dataset.fix === "skill") {
          pickSkill({ title: `「${raw}」のスキルを選択`, query: raw, filter: sf, onPick(nm) { fixSkill.set(raw, nm); after(); } });
        } else {
          // 候補の多い部位を最初に開く
          const hit = M.armors.filter(sexOk).find((x) => score(x.name, raw) < 9);
          pickArmor({ query: raw, part: hit?.part || "head", onPick(a) { fixArmor.set(raw, a.id); after(); } });
        }
      });

      goBtn.addEventListener("click", () => {
        const a = analyze();
        if (!a.recs.length && !a.pending.length) { toast("取り込む行がありません"); return; }
        // 名前が決まらない行や重複があれば、まず確認画面を出す（あいまいなまま取り込まない）
        if (!reviewed && (a.need.length || a.dups.length)) { reviewed = true; renderReview(a); return; }
        if (a.need.length && !confirm(`名前が決まっていない行（${a.pending.length}行）は取り込みません。よろしいですか？`)) { renderReview(a); return; }
        const dupOk = review.querySelector("[data-dup-ok]")?.checked;
        const take = a.recs.filter((x) => dupOk || !x.dup).map((x, i) => ({ ...x.rec, createdAt: Date.now() + i }));
        if (take.length) update((st) => { st[listKey].push(...take); });
        rerender();
        const skipped = a.recs.length - take.length;
        toast(`${take.length}件取り込みました${skipped ? `（重複${skipped}件は除外）` : ""}${a.pending.length ? `（未取り込み${a.pending.length}行）` : ""}`);
        close();
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
// マイセットの装備が、いまの登録内容と同じか（傀異錬成・護石などは後から編集・削除されうる）
function currentRegItem(key) {
  const st = S();
  const [k, id] = [key.split(":")[0], key.slice(key.indexOf(":") + 1)];
  // 見つからない（削除済み）は null、マスタ装備は undefined
  if (k === "q") { const q = st.qurious.find((x) => x.id === id); return q ? quriousItem(q) : null; }
  if (k === "c") { const c = st.charms.find((x) => x.id === id); return c ? charmItem(c) : null; }
  if (k === "ar") { const a = st.artians.find((x) => x.id === id); return a ? artianItem(a) : null; }
  if (k === "w" && id !== "manual") { const w = st.weapons.find((x) => x.id === id); return w ? weaponItem(w) : null; }
  return undefined; // マスタ装備（変化しない）
}
function regStatusHTML(p) {
  if (!p.key || !p.skills) return "";
  const cur = currentRegItem(p.key);
  if (cur === undefined) return "";
  if (!cur) return '<span class="tag warn">削除済み</span>';
  const sig = (it) => JSON.stringify([Object.entries(it.skills || {}).filter(([, v]) => v > 0).sort(), (it.slots || []).slice().sort(), (it.wslots || []).slice().sort()]);
  return sig(cur) !== sig(p) ? '<span class="tag warn">登録変更あり</span>' : "";
}

function renderMysets() {
  const st = S();
  const ss = sortState("mysets", "savedAt", "desc");
  const arr = sorted(st.mysets.slice(), ss.key, ss.dir, setKeyFns);
  view.innerHTML = `
    <h2>マイセット（${G().short} ${st.mysets.length}件）</h2>
    <div class="card">${sortBar("mysets", [["savedAt", "保存日時"], ["def", "防御力"], ["freeCount", "空きスロット数"], ["freeCap", "空きスロット合計Lv"]], "savedAt", "desc")}</div>
    <div class="list cols" style="margin-top:10px">${arr.map((x) => {
      const targets = x.targets || Object.fromEntries((x.conds || []).map((c) => [c.skill, lvToPts(c.skill, c.level)]));
      return `<div class="item" data-sid="${x.id}">
        <div class="res-head"><input type="text" class="grow" data-act="set-memo" value="${esc(x.memo || "")}" placeholder="メモ（例: 太刀 火力）">
          <button class="btn sm danger" data-act="set-del">削除</button></div>
        <div class="muted small" style="margin-top:4px">${new Date(x.savedAt).toLocaleString("ja-JP")} ／ 防御 <b>${x.def}</b> ／ 空き ${freeHTML(x.free, x.freeW)}</div>
        <table class="pieces">${x.pieces.map((p) => pieceRowHTML({
          part: p.part, tag: itemTag({ kind: p.kind, key: p.key }), name: p.name, no: p.no, note: p.note,
          skills: p.skills, decos: p.decos, extra: regStatusHTML(p),
        })).join("")}</table>
        <div class="chips" style="margin-top:6px">${skillChips(x.skills, { targets, result: true })}</div></div>`;
    }).join("") || '<p class="muted">未保存</p>'}</div>`;
}

// ======================================================================
// 画面: 設定
// ======================================================================
function renderSettings() {
  const st = S();
  const w = isW();
  view.innerHTML = `
    <h2>ゲームタイトル</h2>
    <div class="card">
      <div class="seg" data-game>${Object.values(GAMES).map((g) => `<button data-gm="${g.id}" class="${g.id === getGame() ? "on" : ""}">${g.short}</button>`).join("")}</div>
    </div>
    <h2>基本設定</h2>
    <div class="card">
      ${w ? "" : `<div class="field"><div class="field-lbl">性別</div><div class="seg" data-sex>${["指定なし", "男性", "女性"].map((l, i) => `<button data-sx="${i}" class="${st.settings.sex === i ? "on" : ""}">${l}</button>`).join("")}</div></div>`}
      <div class="field"><div class="field-lbl">テーマ</div><div class="seg" data-theme>${[["", "自動"], ["light", "ライト"], ["dark", "ダーク"]].map(([k, l]) => `<button data-th="${k}" class="${(st.settings.theme || "") === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    </div>
    <h2>バックアップ（${G().short}）</h2>
    <div class="card">
      <div class="row"><button class="btn" data-act="export">ファイルに保存</button><button class="btn" data-act="export-copy">コピー</button></div>
      <div class="row" style="margin-top:8px"><label class="btn">ファイルから復元<input type="file" accept="application/json,.json,.txt" data-act="import-file" hidden></label><button class="btn" data-act="import-text">貼り付けて復元</button></div>
      <div class="row" style="margin-top:8px"><button class="btn danger" data-act="reset">全データ削除</button></div>
    </div>
    <h2>データ</h2>
    <div class="card small">
      <dl class="kv">
        <dt>データ</dt><dd>${esc(M.version)}<br>防具 ${M.armors.length} ／ スキル ${M.skills.length} ／ 装飾品 ${M.decos.length}${w ? ` ／ 武器 ${M.weapons.length} ／ 固定護石 ${M.charms.length}` : ""}</dd>
        <dt>登録数</dt><dd>${w
          ? `所持防具 ${Object.keys(st.ownedArmor).length} ／ 所持武器 ${Object.keys(st.ownedWeapons).length} ／ アーティア ${st.artians.length} ／ 光るお守り ${st.charms.length}`
          : `所持防具 ${Object.keys(st.ownedArmor).length} ／ 傀異錬成 ${st.qurious.length} ／ 護石 ${st.charms.length} ／ 武器 ${st.weapons.length}`}</dd>
      </dl>
      <p class="muted" style="margin:6px 0 0">出典: ${w
        ? '<a href="https://github.com/EXXXI/WildsSim" target="_blank" rel="noopener">WildsSim</a>（MIT, © 2025 EXXXI）'
        : '<a href="https://github.com/EXXXI/RiseSim" target="_blank" rel="noopener">RiseSim</a>（MIT, © 2022 EXXXI）'}</p>
    </div>`;
}

// ======================================================================
// 画面: 説明（ヘッダーの「？」から開く）
// ======================================================================
let helpKey = "search";
let helpBack = null;   // { tab, equipTab, scroll }

function helpTopics() {
  const w = isW();
  return [
    ["search", "検索"], ["results", "結果"], ["armor", "防具"],
    w ? ["artian", "アーティア"] : ["qurious", "傀異錬成"],
    ["charm", "護石"], ["weapon", "武器"], ["deco", "装飾品"], ["mysets", "マイセット"], ["settings", "設定"],
  ];
}

function helpBody(key) {
  const w = isW();
  const ex = (html) => `<span class="ex">${html}</span>`;
  switch (key) {
    case "search": return `
      <h3>スキル条件</h3>
      <ul>
        <li><b>＋スキル追加</b>: 発動させたいスキルを選びます。名前の一部・読み（例:「弱特」「こうげき」）でも探せます。</li>
        <li><b>並び順＝優先度</b>: 上ほど優先。<b>↑↓</b>で入れ替え、<b>✕</b>で削除。</li>
        <li><b>Lv</b>: 必要なスキルLvを選びます。${w ? "シリーズ／グループスキルは発動段階（例: 力自慢Ⅱ＝4部位）を選びます。" : ""}</li>
        <li><b>必須 ON</b>: 必ず満たす組み合わせだけを表示します。数の制限はありません。</li>
        <li><b>必須 OFF（希望）</b>: 満たせなくても表示し、優先度の高いスキルから順にできるだけ満たすよう装飾品を割り当てます。</li>
      </ul>
      <h3>武器</h3>
      ${w ? `<ul>
        <li><b>武器種</b>: 検索する武器種を選びます。</li>
        <li><b>（武器種）すべて</b>: その武器種の武器とアーティアから探します。「未所持の装備も使う」がOFFなら所持登録した武器だけが対象です。</li>
        <li><b>アーティア／個別の武器</b>: その武器に固定して探します。</li>
        <li><b>スロット指定</b>: 武器スキルなしで、武器スロットだけを指定します。</li>
      </ul>` : `<ul>
        <li><b>スロット指定</b>: 武器のスロットだけを指定します（武器の登録は不要）。</li>
        <li><b>登録武器すべて</b>: 装備タブで登録した武器すべてから探します。</li>
        <li><b>個別の武器</b>: その武器に固定して探します。</li>
      </ul>`}
      <h3>検索対象</h3>
      <dl>
        <dt>未所持の装備も使う</dt><dd>OFFにすると、所持登録した${w ? "防具・武器・固定護石" : "防具"}と、登録した${w ? "アーティア・光るお守り" : "傀異錬成防具・護石"}だけで探します。</dd>
        <dt>${w ? "アーティアを使う" : "傀異錬成防具を使う"}</dt><dd>登録した${w ? "アーティア武器" : "傀異錬成防具"}を候補に入れます。</dd>
        <dt>装飾品の所持数を反映</dt><dd>装飾品タブの所持数を上限にします。OFFならすべて無制限です。</dd>
        <dt>下位互換を除外</dt><dd>条件スキルとスロットが完全に劣る装備を省きます。速くなり、結果も見やすくなります。</dd>
        <dt>希望スキル全達成のみ</dt><dd>希望スキルも全部満たす組み合わせだけを表示します。</dd>
        <dt>最大件数</dt><dd>見つかった件数がここに達すると探索を打ち切ります。</dd>
      </dl>
      <p>護石は、登録した${w ? "光るお守りと固定護石（未所持OFF時は所持登録したもの）" : "護石すべて"}が候補です。${w ? "" : "性別は設定タブで指定します。"}</p>
      <h3>検索</h3>
      <p>結果タブに切り替わります。時間がかかるときは<b>中止</b>できます。</p>`;
    case "results": return `
      <h3>見方</h3>
      <ul>
        <li>部位ごとに、装備名・その装備のスキル・付ける装飾品が表示されます。${ex(slotTag(2, "A", true))} は空きスロットです。</li>
        <li><span class="regno">No.3</span> は登録番号です。装備タブの一覧と同じ番号で、どの${w ? "アーティア・光るお守り" : "傀異錬成防具・護石・武器"}が選ばれたか分かります（メモも表示）。</li>
        ${w ? `<li>${ex(slotTag(3, "W"))} 丸は武器用スロット、${ex(slotTag(3, "A"))} 四角は防具用スロットです。武器用の装飾品は武器用スロットにだけ付きます。</li>` : ""}
        <li>スキルの色: <span class="chip ok">緑</span> 条件を達成、<span class="chip ng">赤</span> 未達（希望スキル）。</li>
        ${w ? "<li>シリーズ／グループスキルは「4pt→力自慢Ⅱ」のようにポイントと発動スキルを表示します。</li>" : ""}
        <li><b>同等+N</b>: 条件スキルとスロットが同じ装備が他にN件あります。押すと一覧を表示します。</li>
        <li><b>${ICON_STAR}保存</b>: マイセットに保存します。同じ組み合わせが保存済みなら確認します。</li>
      </ul>
      <h3>並び替え・絞り込み</h3>
      <ul>
        <li><b>優先度順</b>: 希望スキルを優先度の高い順に多く満たすもの → 空きスロットが多いもの → 防御力の順です。</li>
        <li>空きスロット数・合計Lv${w ? "（武器用/防具用別）" : ""}、防御力、耐性、条件スキルなどで並べ替えられます。「スキルLvで並べる…」で任意のスキルも選べます。▲▼で昇順/降順。</li>
        <li><b>絞り込み</b>: 装備名・スキル名を含む結果だけを表示します。</li>
      </ul>
      <h3>打ち切り・該当なし</h3>
      <ul>
        <li><b>最大件数で打ち切り</b>: 検索タブで最大件数を増やすか、条件を絞ってください。打ち切った場合、有望な組み合わせから順に探していますが全体の上位とは限りません。</li>
        <li><b>該当なし</b>: 必須スキルを減らす、Lvを下げる、「未所持の装備も使う」をONにする${w ? "、武器の選び方を変える" : ""}などを試してください。</li>
      </ul>`;
    case "armor": return `
      <ul>
        <li>部位を切り替え、名前やスキル名で探せます。</li>
        <li><b>所持</b>: 持っている防具に付けます。「未所持の装備も使う」をOFFにしたときの候補になります。</li>
        <li><b>除外</b>: 常に検索に使いません。</li>
        <li><b>表示中を所持に／所持を解除</b>: いま一覧に出ている防具をまとめて切り替えます。</li>
        ${w ? "" : "<li><b>＋傀異錬成</b>: その防具をベースに傀異錬成防具を登録します。</li>"}
        <li>スロット: ${ex(slotTag(3, "A") + '<span class="slot empty">-</span>')} 数字はスロットLv、「-」は空きなしです。</li>
      </ul>`;
    case "qurious": return `
      <ul>
        <li><b>＋登録</b>: ベース防具を選ぶと、そのスロット・スキル・防御・耐性が入った状態で始まります。スロット・スキルは<b>錬成後の値</b>に書き換えてください。</li>
        <li><b>防御・耐性の増減</b>: ゲーム画面に表示される増減（例: 防御+12、火-2）をそのまま選びます。下の「計」に合計値が出ます。</li>
        <li><b>スキル</b>: Lvを変える／<b>✕</b>で外す（錬成で消えたスキル）／<b>＋スキル追加</b>で追加します。</li>
        <li><b>インポート</b>: 泣きシミュ形式のCSVを貼り付けて一括登録します。<br><code>ベース防具名,防御,火,水,雷,氷,龍,スロ1増,スロ2増,スロ3増,スキル,増減,…</code></li>
        <li>インポートの防具名・スキル名は、一部や読みでも構いません（例: 弱特、こうげき）。1つに決まらない名前は、取り込む前に<b>選ぶ</b>で選び直します。</li>
        <li><b>重複</b>: 登録済みと同じ内容（メモ以外が同じ）は取り込みません。<b>重複も取り込む</b>をONにすると取り込みます。手で登録するときも、同じ内容があれば確認します。</li>
        <li><b>検索対象</b>: OFFにすると検索に使いません。</li>
        <li><b>複製</b>: 似た錬成結果をコピーして登録できます。</li>
      </ul>`;
    case "artian": return `
      <ul>
        <li>付与スキルやスロットが個体ごとに違うアーティア武器を登録します（サンブレイクの傀異錬成に相当）。</li>
        <li><b>＋登録</b>: 武器種、グループスキル、シリーズスキル、武器スロットを選びます。</li>
        <li>付与スキルは<b>それぞれ1部位分</b>として数えます（例: 防具3部位＋アーティアでシリーズスキル4部位）。</li>
        <li><b>検索対象</b>: OFFにすると検索に使いません。</li>
      </ul>`;
    case "charm": return w ? `
      <h3>光るお守り</h3>
      <ul>
        <li>鑑定で入手したランダムスキルの護石を登録します。</li>
        <li><b>＋登録</b>: スキルを3つまで、スロットは「武器用／防具用」を選んで入力します。「続けて登録」で連続入力できます。</li>
        <li><b>インポート</b>: 泣きシミュ形式のCSVを貼り付けて一括登録します。<br><code>スキル1,Lv,スキル2,Lv,スキル3,Lv,武器スロ1,武器スロ2,武器スロ3,防具スロ1,防具スロ2,防具スロ3</code></li>
        <li>インポートのスキル名は、一部や読みでも構いません（例: 弱特、こうげき）。1つに決まらない名前は、取り込む前に<b>選ぶ</b>で選び直します。</li>
        <li><b>重複</b>: 登録済みと同じ内容（メモ以外が同じ）は取り込みません。<b>重複も取り込む</b>をONにすると取り込みます。手で登録するときも、同じ内容があれば確認します。</li>
      </ul>
      <h3>固定護石</h3>
      <ul><li><b>所持</b>: 持っている護石に付けます。「未所持の装備も使う」がOFFのときは所持した固定護石だけが候補です。</li></ul>` : `
      <ul>
        <li><b>＋登録</b>: スキル2つとスロットを入力します。「続けて登録」で連続入力できます。</li>
        <li><b>インポート</b>: 泣きシミュ形式のCSVを貼り付けて一括登録します。<br><code>スキル1,Lv,スキル2,Lv,スロ1,スロ2,スロ3</code></li>
        <li>インポートのスキル名は、一部や読みでも構いません（例: 弱特、こうげき）。1つに決まらない名前は、取り込む前に<b>選ぶ</b>で選び直します。</li>
        <li><b>重複</b>: 登録済みと同じ内容（メモ以外が同じ）は取り込みません。<b>重複も取り込む</b>をONにすると取り込みます。手で登録するときも、同じ内容があれば確認します。</li>
        <li><b>検索対象</b>: OFFにすると検索に使いません。護石が1つもなければ「護石なし」で検索します。</li>
      </ul>`;
    case "weapon": return w ? `
      <ul>
        <li>武器種を選び、持っている武器の<b>所持</b>をONにします。「未所持の装備も使う」がOFFのとき、所持した武器だけが候補です。</li>
        <li>武器スキルと武器用スロット ${ex(slotTag(3, "W"))} は武器ごとのデータで計算します。</li>
        <li>アーティア武器は「アーティア」タブで登録します。</li>
      </ul>` : `
      <ul>
        <li>武器はスキル計算ではスロットとして扱います。</li>
        <li><b>＋登録</b>: 名前・武器種・スロットを入力します。スロットは錬成後の値を入れます。</li>
        <li><b>検索対象</b>: 検索タブの「登録武器すべて」に含めるかどうかです。</li>
        <li>登録しなくても、検索タブの「スロット指定」で探せます。</li>
      </ul>`;
    case "deco": return `
      <ul>
        <li>所持数を入力します。<b>空欄＝無制限</b>です。</li>
        <li>所持数は、検索タブの「装飾品の所持数を反映」がONのときだけ使います。</li>
        <li><b>全て無制限</b>: すべての所持数を空欄に戻します。<b>表示中を0個に</b>: 一覧に出ている装飾品を0個にします。</li>
        ${w ? `<li>${ex(slotTag(3, "W"))} 武器用、${ex(slotTag(3, "A"))} 防具用の装飾品です。</li>` : ""}
      </ul>`;
    case "mysets": return `
      <ul>
        <li>結果タブの<b>${ICON_STAR}保存</b>で追加されます。保存時の装備名・登録番号・スキル・装飾品が記録されます。</li>
        <li><span class="tag warn">登録変更あり</span>: 保存後に、その登録装備のスキルやスロットを編集しました。<span class="tag warn">削除済み</span>: その登録装備を削除しました。</li>
        <li>メモ欄に自由に名前を付けられます。並び替えもできます。</li>
      </ul>`;
    case "settings": return `
      <dl>
        <dt>ゲームタイトル</dt><dd>サンブレイク／ワイルズを切り替えます。手持ち装備・条件・マイセットはタイトルごとに別々に保存されます。</dd>
        ${w ? "" : "<dt>性別</dt><dd>男性専用・女性専用の防具を一覧と検索から外します。</dd>"}
        <dt>テーマ</dt><dd>画面の明るさを切り替えます。</dd>
        <dt>ファイルに保存／コピー</dt><dd>いま選んでいるタイトルの登録データをバックアップします。</dd>
        <dt>ファイルから復元／貼り付けて復元</dt><dd>バックアップを読み込みます。現在のデータは上書きされます。</dd>
        <dt>全データ削除</dt><dd>いま選んでいるタイトルの登録データを消します。</dd>
      </dl>
      <h3>データの保存について</h3>
      <p>登録データはこの端末のブラウザ内に保存されます（サーバーには送られません）。機種変更やブラウザのデータ削除に備え、定期的にバックアップしてください。PCとスマホでデータを移すときもバックアップを使います。</p>
      <h3>アプリとして使う</h3>
      <p>iPhone: Safariの共有ボタン →「ホーム画面に追加」。オフラインでも動きます。</p>
      <h3>データ出典</h3>
      <p>サンブレイク: <a href="https://github.com/EXXXI/RiseSim" target="_blank" rel="noopener">RiseSim</a>（MIT, © 2022 EXXXI）<br>ワイルズ: <a href="https://github.com/EXXXI/WildsSim" target="_blank" rel="noopener">WildsSim</a>（MIT, © 2025 EXXXI）</p>`;
  }
  return "";
}

function renderHelp() {
  const topics = helpTopics();
  if (!topics.some((t) => t[0] === helpKey)) helpKey = "search";
  view.innerHTML = `
    <h2><button class="btn sm" data-act="help-back">← 戻る</button><span class="grow">説明（${G().short}）</span></h2>
    <div class="seg" data-help-topics>${topics.map(([k, l]) => `<button data-hk="${k}" class="${k === helpKey ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="card help" style="margin-top:10px">${helpBody(helpKey)}</div>`;
  const on = view.querySelector("[data-hk].on");
  if (on) on.scrollIntoView({ block: "nearest", inline: "center" });
}

function openHelp() {
  if (tab === "help") { closeHelp(); return; }
  helpBack = { tab, scroll: window.scrollY };
  helpKey = tab === "equip" ? equipTab : tab;
  tab = "help";
  markTabs("help");
  renderHelp();
  window.scrollTo(0, 0);
}
function closeHelp() {
  const back = helpBack || { tab: "search", scroll: 0 };
  helpBack = null;
  tab = back.tab;
  markTabs(tab);
  rerender();
  window.scrollTo(0, back.scroll);
}
document.getElementById("help-btn").addEventListener("click", openHelp);

// ======================================================================
// ルーティング・イベント
// ======================================================================
// 下部タブの選択表示。見た目（on）に加え、読み上げ機能にも現在の画面を伝える（aria-current）
function markTabs(t) {
  document.querySelectorAll("#tabbar button").forEach((b) => {
    const on = b.dataset.tab === t;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  const hb = document.getElementById("help-btn");
  hb.classList.toggle("on", t === "help");
  hb.setAttribute("aria-pressed", t === "help" ? "true" : "false");
  // URL に画面名を反映（#results など）。ブックマークや共有でその画面を直接開ける。
  // 履歴は積まない（replaceState）: ホーム画面アプリには戻るボタンがなく、戻る操作で画面が行き来すると混乱するため
  if (TABS.includes(t) && location.hash !== "#" + t) history.replaceState(null, "", "#" + t);
}
const TABS = ["search", "results", "equip", "mysets", "settings"];
function setTab(t) {
  tab = t;
  helpBack = null;
  markTabs(t);
  rerender();
  window.scrollTo(0, 0);
}
function rerender() {
  if (!M) return;
  if (tab === "search") renderSearch();
  else if (tab === "results") renderResults();
  else if (tab === "equip") renderEquip();
  else if (tab === "mysets") renderMysets();
  else if (tab === "help") renderHelp();
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
function refocus(act, pos) {
  const el = view.querySelector(`[data-act="${act}"]`);
  if (el) { el.focus(); el.setSelectionRange(pos, pos); }
}

view.addEventListener("input", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  const pos = t.selectionStart;
  if (act === "armor-q") { S().ui.armorQ = t.value; save(); debounced(() => { document.getElementById("armor-list").innerHTML = armorRows(armorFilterList()); }); }
  else if (act === "ww-q") { S().ui.wwQ = t.value; save(); debounced(() => { document.getElementById("ww-list").innerHTML = wildsWeaponRows(wildsWeaponList()); }); }
  else if (act === "fcharm-q") { S().ui.fcharmQ = t.value; save(); debounced(() => { document.getElementById("fcharm-list").innerHTML = fixedCharmRows(fixedCharmList()); }); }
  else if (act === "res-filter") { S().ui.resFilter = t.value; debounced(() => { resultShown = 30; renderResults(); refocus(act, pos); }); }
  else if (act === "charm-q") { S().ui.charmQ = t.value; debounced(() => { renderEquipBody(); refocus(act, pos); }); }
  else if (act === "deco-q") { S().ui.decoQ = t.value; debounced(() => { renderEquipBody(); refocus(act, pos); }); }
  else if (act === "set-memo") {
    const id = t.closest("[data-sid]").dataset.sid;
    const s = S().mysets.find((x) => x.id === id);
    if (s) { s.memo = t.value; save(); }
  }
});

view.addEventListener("change", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (t.dataset.opt) { update((s) => { s.simOpts[t.dataset.opt] = t.checked; }); rerender(); return; }
  if (t.dataset.ui) { update((s) => { s.ui[t.dataset.ui] = t.checked; }); rerender(); return; }
  if (t.dataset.wslot != null) { update((s) => { s.simOpts.weaponSlots = readSlots(view, "wslot"); }); return; }
  const condEl = t.closest(".cond");
  if (act === "cond-lv") { update((s) => { s.conds[+condEl.dataset.i].level = +t.value; }); return; }
  if (act === "cond-req") { update((s) => { s.conds[+condEl.dataset.i].required = t.checked; }); rerender(); return; }
  if (act === "weapon-sel") { update((s) => { s.simOpts.weapon = t.value; }); rerender(); return; }
  if (act === "wtype") { update((s) => { s.simOpts.weaponType = t.value; s.simOpts.weapon = "type"; }); rerender(); return; }
  if (act === "ww-type") { update((s) => { s.ui.wwType = t.value; }); renderEquipBody(); return; }
  if (act === "artian-type") { update((s) => { s.ui.artianType = t.value; }); renderEquipBody(); return; }
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
  if (act === "ww-own") { const id = t.closest("[data-wwid]").dataset.wwid; update((s) => { if (t.checked) s.ownedWeapons[id] = true; else delete s.ownedWeapons[id]; }); return; }
  if (act === "fc-own") { const id = t.closest("[data-fcid]").dataset.fcid; update((s) => { if (t.checked) s.ownedCharms[id] = true; else delete s.ownedCharms[id]; }); return; }
  const toggle = (list, attr) => { const id = t.closest(`[${attr}]`).getAttribute(attr); update((s) => { s[list].find((x) => x.id === id).enabled = t.checked; }); t.closest(".item").classList.toggle("off", !t.checked); };
  if (act === "q-enable") return toggle("qurious", "data-qid");
  if (act === "c-enable") return toggle("charms", "data-cid");
  if (act === "w-enable") return toggle("weapons", "data-wid");
  if (act === "ar-enable") return toggle("artians", "data-arid");
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
});

view.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act],[data-et],[data-ap],[data-qp],[data-ds],[data-dt],[data-sx],[data-th],[data-gm],[data-cs],[data-hk]");
  if (!el || el.tagName === "SELECT" || (el.tagName === "INPUT" && el.type !== "button")) return;
  const st = S();
  if (el.dataset.hk) { helpKey = el.dataset.hk; renderHelp(); return; }
  if (el.dataset.et) { equipTab = el.dataset.et; renderEquip(); return; }
  if (el.dataset.gm) { switchGame(el.dataset.gm); return; }
  if (el.dataset.cs) { update((s) => { s.ui.charmSeg = el.dataset.cs; }); renderEquipBody(); return; }
  if (el.dataset.ap) { update((s) => { s.ui.armorPart = el.dataset.ap; }); renderEquipBody(); return; }
  if (el.dataset.qp != null && el.closest("[data-q-parts]")) { update((s) => { s.ui.qPart = el.dataset.qp; }); renderEquipBody(); return; }
  if (el.dataset.ds != null && el.closest("[data-deco-size]")) { update((s) => { s.ui.decoSize = +el.dataset.ds; }); renderEquipBody(); return; }
  if (el.dataset.dt != null && el.closest("[data-deco-type]")) { update((s) => { s.ui.decoType = el.dataset.dt; }); renderEquipBody(); return; }
  if (el.dataset.sx != null) { update((s) => { s.settings.sex = +el.dataset.sx; }); renderSettings(); return; }
  if (el.dataset.th != null && el.closest("[data-theme]")) { update((s) => { s.settings.theme = el.dataset.th; }); applyTheme(); renderSettings(); return; }
  const act = el.dataset.act;
  const condEl = el.closest(".cond");
  const byId = (list, attr) => st[list].find((x) => x.id === el.closest(`[${attr}]`).getAttribute(attr));
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
    case "help-back":
      closeHelp();
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
        title: "同等の装備",
        body: `<div class="list">${keys.map((k) => {
          const it = last.keyMap[k];
          if (!it) return "";
          return `<div class="item"><div class="ttl"><span class="grow">${itemTag(it)}${esc(itemName(it))}${regNoHTML(it.no)}${it.note ? ` <span class="pnote">${esc(it.note)}</span>` : ""}</span>${slotsHTML(it.slots, { wslots: it.wslots })}</div>
            <div class="meta">防御${it.def || 0}${it.attack ? " 攻撃" + it.attack : ""}</div><div class="chips">${skillChips(it.skills)}</div></div>`;
        }).join("")}</div>`,
      });
      break;
    }
    case "save-set": {
      const r = last.out.results[+el.dataset.i];
      const snap = snapshot(r);
      if (!okToSave("mysets", snap)) break;
      update((s) => { s.mysets.push(snap); });
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
    case "ww-own-all":
    case "ww-own-none": {
      const arr = wildsWeaponList();
      update((s) => { for (const w of arr) { if (act === "ww-own-all") s.ownedWeapons[w.id] = true; else delete s.ownedWeapons[w.id]; } });
      renderEquipBody();
      break;
    }
    case "fc-own-all":
    case "fc-own-none": {
      const arr = fixedCharmList();
      update((s) => { for (const c of arr) { if (act === "fc-own-all") s.ownedCharms[c.id] = true; else delete s.ownedCharms[c.id]; } });
      renderEquipBody();
      break;
    }
    case "q-new-from": quriousForm(null, ARMOR[el.closest("[data-id]").dataset.id]); break;
    case "q-new": quriousForm(null, null); break;
    case "q-edit": quriousForm(byId("qurious", "data-qid")); break;
    case "q-copy": quriousForm({ ...JSON.parse(JSON.stringify(byId("qurious", "data-qid"))), id: uid(), createdAt: Date.now() }, null, true); break;
    case "q-del":
      if (confirm("この傀異錬成防具を削除しますか？")) { const id = byId("qurious", "data-qid").id; update((s) => { s.qurious = s.qurious.filter((x) => x.id !== id); }); renderEquipBody(); }
      break;
    case "q-import": importDialog("q"); break;
    case "ar-new": artianForm(null); break;
    case "ar-edit": artianForm(byId("artians", "data-arid")); break;
    case "ar-copy": artianForm({ ...JSON.parse(JSON.stringify(byId("artians", "data-arid"))), id: uid(), createdAt: Date.now() }, true); break;
    case "ar-del":
      if (confirm("このアーティア武器を削除しますか？")) { const id = byId("artians", "data-arid").id; update((s) => { s.artians = s.artians.filter((x) => x.id !== id); }); renderEquipBody(); }
      break;
    case "c-new": charmForm(null); break;
    case "c-edit": charmForm(byId("charms", "data-cid")); break;
    case "c-del":
      if (confirm("この護石を削除しますか？")) { const id = byId("charms", "data-cid").id; update((s) => { s.charms = s.charms.filter((x) => x.id !== id); }); renderEquipBody(); }
      break;
    case "c-import": importDialog("c"); break;
    case "w-new": weaponForm(null); break;
    case "w-edit": weaponForm(byId("weapons", "data-wid")); break;
    case "w-del":
      if (confirm("この武器を削除しますか？")) { const id = byId("weapons", "data-wid").id; update((s) => { s.weapons = s.weapons.filter((x) => x.id !== id); }); renderEquipBody(); }
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
      if (confirm("このマイセットを削除しますか？")) { const id = el.closest("[data-sid]").dataset.sid; update((s) => { s.mysets = s.mysets.filter((x) => x.id !== id); }); renderMysets(); }
      break;
    case "export":
      download(`mh-sim-${getGame()}-backup-${new Date().toISOString().slice(0, 10)}.json`, exportJSON());
      break;
    case "export-copy":
      navigator.clipboard.writeText(exportJSON()).then(() => toast("コピーしました"), () => {
        openModal({ title: "バックアップ（テキスト）", body: `<textarea readonly style="min-height:50vh">${esc(exportJSON())}</textarea>` });
      });
      break;
    case "import-text":
      openModal({
        title: "貼り付けて復元",
        body: '<p class="muted small">現在のデータは上書きされます</p><textarea data-text></textarea>',
        foot: '<button class="btn" data-close>キャンセル</button><button class="btn primary" data-go>復元</button>',
        onMount(m, close) {
          m.querySelector("[data-go]").addEventListener("click", () => {
            try { importJSON(m.querySelector("[data-text]").value); applyTheme(); close(); toast("復元しました"); rerender(); } catch (err) { alert("復元に失敗しました: " + err.message); }
          });
        },
      });
      break;
    case "reset":
      if (confirm(`${G().short}の登録データをすべて削除します。よろしいですか？`) && confirm("本当に削除しますか？（元に戻せません）")) { resetAll(); applyTheme(); last = null; rerender(); toast("削除しました"); }
      break;
  }
});

// ======================================================================
// 起動・タイトル切り替え
// ======================================================================
const masterCache = {};
async function loadMaster() {
  const g = G();
  if (!masterCache[g.id]) {
    const res = await fetch(g.data, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status + " " + g.data);
    masterCache[g.id] = await res.json();
  }
  M = masterCache[g.id];
  SKILL = {}; ARMOR = {}; WEAPON = {}; FCHARM = {};
  for (const s of M.skills) SKILL[s.name] = s;
  for (const a of M.armors) ARMOR[a.id] = a;
  for (const w of M.weapons || []) WEAPON[w.id] = w;
  for (const c of M.charms || []) FCHARM[c.id] = c;
  CATS = [...new Set(M.skills.map((s) => s.cat))].filter((c) => c !== "汎用錬成スキル");
  document.getElementById("appbar-sub").textContent = g.short;
  document.title = `${g.short} 手持ち装備シミュ`;
  update((s) => {
    s.conds = s.conds.filter((c) => SKILL[c.skill]);
    if (isW() && !s.simOpts.weaponType) s.simOpts.weaponType = M.weaponTypes[0];
    if (isW() && s.simOpts.weapon === "manual" && !s._init) { s.simOpts.weapon = "type"; s._init = true; }
  });
}
async function switchGame(id) {
  if (id === getGame()) return;
  if (worker) { worker.terminate(); worker = null; }
  setGame(id);
  M = null;
  view.innerHTML = '<p class="loading">データ読み込み中…</p>';
  try {
    await loadMaster();
  } catch (e) {
    view.innerHTML = `<div class="notice">データの読み込みに失敗しました: ${esc(e.message)}</div>`;
    return;
  }
  last = null;
  equipTab = "armor";
  applyTheme();
  rerender();
  toast(`${G().short}に切り替えました`);
}

// ======================================================================
// ソフトウェアキーボード対応
//  iOS ではキーボード表示中も固定要素は画面全体基準のままなので、キーボードの裏に隠れる。
//  visualViewport（実際に見えている領域）の位置・高さを CSS 変数に流し、シートをその中に収める。
// ======================================================================
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  root.style.setProperty("--vv-h", vv.height + "px");
  root.style.setProperty("--vv-top", vv.offsetTop + "px");
  const kb = window.innerHeight - vv.height > 120; // キーボード（またはそれに相当する縮小）が出ている
  if (root.classList.contains("kb-open") !== kb) root.classList.toggle("kb-open", kb);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncViewport);
  window.visualViewport.addEventListener("scroll", syncViewport);
  syncViewport();
}
// 入力欄にフォーカスしたら、キーボードが出た後に入力欄を見える位置へ
document.addEventListener("focusin", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.matches("input[type=text], input[type=search], input[type=number], textarea")) return;
  setTimeout(() => {
    syncViewport();
    t.scrollIntoView({ block: "nearest" });
  }, 350);
});

async function init() {
  applyTheme();
  try {
    await loadMaster();
  } catch (e) {
    view.innerHTML = `<div class="notice">データの読み込みに失敗しました: ${esc(e.message)}</div>`;
    return;
  }
  const h = location.hash.slice(1);
  if (TABS.includes(h)) tab = h; // URL の #画面名 から開く
  markTabs(tab);
  rerender();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
init();
