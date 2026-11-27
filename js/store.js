// 手持ちデータの保存（localStorage）とバックアップ。ゲームタイトルごとに別々に保存する
const GAME_KEY = "mh-sim-game";
const KEYS = { sb: "mhrsb-sim-v1", wilds: "mhwilds-sim-v1" };

export const defaultState = () => ({
  ownedArmor: {},     // armorId -> true  （所持している防具）
  excludedArmor: {},  // armorId -> true  （シミュ対象から除外）
  qurious: [],        // [SB] 傀異錬成防具 {id, base, slots:[], delta:{skill:+-}, defDelta, resDelta:[5], note, enabled}
  charms: [],         // 護石（SB）/ 光るお守り（ワイルズ） {id, skills:[[name,lv],...], slots:[], wslots:[], note, enabled}
  weapons: [],        // [SB] 武器 {id, name, type, slots:[], note, enabled}
  artians: [],        // [ワイルズ] アーティア武器 {id, type, name, skills:{skill:1}, wslots:[3,3,3], note, enabled}
  ownedWeapons: {},   // [ワイルズ] weaponId -> true
  ownedCharms: {},    // [ワイルズ] 固定護石 id -> true
  decoCount: {},      // 装飾品名 -> 所持数（未設定 = 無制限）
  conds: [],          // 検索条件 {skill, level, required}  level はスキルLv（シリーズ等は発動段階）
  simOpts: {
    includeUnowned: true,
    includeQurious: true,
    pruneDominated: true,
    onlyFullSoft: false,
    useDecoCount: false,
    weapon: "manual",       // manual | all | <id>   （ワイルズ: manual | type | <id>）
    weaponType: "",
    weaponSlots: [0, 0, 0],
    limit: 5000,
  },
  mysets: [],
  savedConds: [],     // 保存した検索条件 {id, no, name(ニックネーム。空なら「検索条件（No）」), cond:{conds, weapon, opts}, createdAt, updatedAt, usedAt, useCount}
  activeCondId: null, // 呼び出し中の保存条件
  settings: { sex: 0 },
  ui: {},
});

let normalizer = null; // 状態の整合（登録番号の付与など）をアプリ側から差し込む
export function setNormalizer(fn) { normalizer = fn; if (fn) fn(state); }
let game = readGame();
let state = load();
const listeners = new Set();

function readGame() {
  try {
    const g = localStorage.getItem(GAME_KEY);
    return KEYS[g] ? g : "sb";
  } catch (e) {
    return "sb";
  }
}

function load() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(KEYS[game]);
    if (!raw) return base;
    return merge(base, JSON.parse(raw));
  } catch (e) {
    console.warn("load failed", e);
    return base;
  }
}

function merge(base, obj) {
  const out = { ...base, ...obj };
  out.simOpts = { ...base.simOpts, ...(obj.simOpts || {}) };
  out.settings = { ...base.settings, ...(obj.settings || {}) };
  out.ui = { ...(obj.ui || {}) };
  return out;
}

let saveTimer = null;
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(KEYS[game], JSON.stringify(state));
  } catch (e) {
    console.warn("save failed", e);
  }
}
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 150);
  listeners.forEach((f) => f());
}

export function getState() {
  return state;
}
export function getGame() {
  return game;
}
export function setGame(g) {
  if (!KEYS[g] || g === game) return;
  if (saveTimer) flush();
  game = g;
  try { localStorage.setItem(GAME_KEY, g); } catch (e) { /* noop */ }
  state = load();
  if (normalizer) normalizer(state);
}

export function update(fn) {
  fn(state);
  if (normalizer) normalizer(state);
  save();
}

export function onChange(f) {
  listeners.add(f);
}

export function exportJSON() {
  return JSON.stringify({ app: "mhrsb-sim", game, version: 2, exportedAt: new Date().toISOString(), data: state }, null, 1);
}

export function importJSON(text) {
  const obj = JSON.parse(text);
  const data = obj && obj.app === "mhrsb-sim" ? obj.data : obj;
  if (!data || typeof data !== "object") throw new Error("形式が正しくありません");
  const g = obj && obj.app === "mhrsb-sim" ? obj.game || "sb" : game;
  if (g !== game) throw new Error(`このバックアップは「${g === "wilds" ? "ワイルズ" : "サンブレイク"}」のデータです。設定でゲームタイトルを切り替えてから復元してください`);
  state = merge(defaultState(), data);
  if (normalizer) normalizer(state);
  save();
}

export function resetAll() {
  state = defaultState();
  save();
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

try {
  navigator.storage && navigator.storage.persist && navigator.storage.persist();
} catch (e) { /* noop */ }
