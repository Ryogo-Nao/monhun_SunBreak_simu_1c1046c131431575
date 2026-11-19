// 手持ちデータの保存（localStorage）とバックアップ
const KEY = "mhrsb-sim-v1";

export const defaultState = () => ({
  ownedArmor: {},     // armorId -> true  （所持している防具）
  excludedArmor: {},  // armorId -> true  （シミュ対象から除外）
  qurious: [],        // 傀異錬成防具 {id, base, slots:[], delta:{skill:+-}, defDelta, resDelta:[5], note, enabled}
  charms: [],         // 護石 {id, skills:[[name,lv],...], slots:[], note, enabled}
  weapons: [],        // 武器 {id, name, type, slots:[], note, enabled}
  decoCount: {},      // 装飾品名 -> 所持数（未設定 = 無制限）
  conds: [],          // 検索条件 {skill, level, required}
  simOpts: {
    includeUnowned: true,
    includeQurious: true,
    pruneDominated: true,
    onlyFullSoft: false,
    useDecoCount: false,
    weapon: "manual",
    weaponSlots: [0, 0, 0],
    limit: 5000,
  },
  mysets: [],
  settings: { sex: 0 },
  ui: {},
});

let state = load();
const listeners = new Set();

function load() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(KEY);
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
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("save failed", e);
    }
  }, 150);
  listeners.forEach((f) => f());
}

export function getState() {
  return state;
}

export function update(fn) {
  fn(state);
  save();
}

export function onChange(f) {
  listeners.add(f);
}

export function exportJSON() {
  return JSON.stringify({ app: "mhrsb-sim", version: 1, exportedAt: new Date().toISOString(), data: state }, null, 1);
}

export function importJSON(text) {
  const obj = JSON.parse(text);
  const data = obj && obj.app === "mhrsb-sim" ? obj.data : obj;
  if (!data || typeof data !== "object") throw new Error("形式が正しくありません");
  state = merge(defaultState(), data);
  save();
}

export function resetAll() {
  state = defaultState();
  save();
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// iOS Safari で保存領域が消されにくくする
try {
  navigator.storage && navigator.storage.persist && navigator.storage.persist();
} catch (e) { /* noop */ }
