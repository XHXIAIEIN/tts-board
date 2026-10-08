// The project's shared settings (title, text script, anchor sentence, defaults, tone presets,
// spaces, general lines) live in data/project.json; each script's roles, lines and scenes live in
// data/scripts/<file>. plan.js turns these settings into one plan per line, and api.js talks to
// the backend.
import { TAG_KEYS, DRY, NARRATOR, SCENE_TAG, GEN_PARAMS, BLOCK_GAP, PAUSE_RANGE, parseTag, formatTag, formatBlock, directionOf, roomKey, parseBeats, plainText, resolve, describe } from "./plan.js";
import { getJSON, listModels, tts, cancelJob, jobText, concat, PRIORITY } from "./api.js";

const DATA = await getJSON("data/project.json");
const SCRIPTS = await Promise.all((DATA.scripts || []).map(f => getJSON(`data/scripts/${f}`)));
DATA.defaults ||= {};
const ANCHOR_TEXT = DATA.anchor_text || "";
const TONES = DATA.tones || {};
const ROOMS = DATA.rooms || {};
const asPreset = l => ({ label: l.id, role: l.role, gloss: l.gloss, text: plainText(l.text || ""), voice: l.voice });
const PRESETS = (DATA.lines || []).map(asPreset);

// Page title; extra fonts go in front of the page's font list
const TITLE = DATA.title || "台词配音";
document.title = TITLE;
document.querySelector("h1").textContent = TITLE;
if (DATA.fonts?.length) {
  const families = DATA.fonts.map(f => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;600`).join("&");
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?${families}&display=swap` }));
  const base = getComputedStyle(document.documentElement).getPropertyValue("--font");
  document.documentElement.style.setProperty("--font", [...DATA.fonts.map(f => `"${f}"`), base].join(", "));
}

// A script line as editor rows (formatBlock): its direction, "role：gloss" and the text.
// The scene's entry for a line overrides the line's own tone, note and params.
// A room key is written as its label.
function scriptLine(l, entry) {
  const pick = k => entry[k] ?? l[k];
  const shown = (k, v) => k === "room" ? roomLabel(roomKey(v, ROOMS) ?? v) : v;
  const params = Object.fromEntries(TAG_KEYS.filter(k => pick(k) !== undefined).map(k => [k, shown(k, pick(k))]));
  return formatBlock({ role: l.role || NARRATOR, tone: pick("tone") || "", notes: [pick("note")].filter(Boolean), params,
    text: l.text || "", gloss: l.gloss });
}
// Line ids are unique within a script, and a scene only uses its own script's lines.
const SCENES = SCRIPTS.flatMap(sc => {
  const byId = Object.fromEntries(sc.lines.map(l => [l.id, l]));
  return (sc.scenes || []).map(s => ({
    label: s.label,
    roles: sc.roles || {},
    room: s.room ?? sc.room ?? "",
    gap: s.gap ?? DATA.defaults.gap ?? 0.35,
    pace: s.pace,
    jitter: s.jitter,
    script: s.lines.filter(entry => byId[entry.id]).map(entry => scriptLine(byId[entry.id], entry)).join(BLOCK_GAP),
  }));
});
let scenePace;  // the loaded scene's pace; its gap and space live in the script's settings row
let sceneJitter;  // the loaded scene's own jitter fields; strength and seed live in the settings row
// Default voice and personality of a role: the loaded scene's script first, then any script.
let sceneRoles = SCENES[0]?.roles || {};
const ALL_ROLES = Object.assign({}, ...SCRIPTS.map(sc => sc.roles || {}));
const roleDefaults = name => sceneRoles[name] || ALL_ROLES[name] || {};

// ---------- models ----------
// A model says what it accepts in `controls`. The page gives each role its own voice in one of
// three ways: a speaker id ("speaker"), or an anchor clip that every line of the role clones
// ("ref_audio", with "voice_prompt" to describe the voice), or not at all.
const can = (m, control) => !!m?.controls?.includes(control);
function voiceMode(m) {
  if (can(m, "speaker")) return "speaker";
  if (can(m, "ref_audio")) return "clone";
  return "single";
}

// ---------- shared helpers ----------
function field(labelText, input) {
  const wrap = document.createElement("div");
  const l = document.createElement("label"); l.textContent = labelText;
  wrap.append(l, input); return wrap;
}
function setStatus(el, kind, text) { el.className = "status " + kind; el.textContent = text; }

// File picker: a styled button and the chosen file name; the native input stays hidden.
function filePicker(onChange, initialName = "") {
  const wrap = document.createElement("div");
  wrap.className = "filepick";
  const input = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*", className: "visually-hidden" });
  const pick = Object.assign(document.createElement("button"), { type: "button", className: "plain small", textContent: "选择音频" });
  const name = Object.assign(document.createElement("span"), { className: "fname" });
  const clear = Object.assign(document.createElement("button"), { type: "button", className: "plain small", textContent: "移除" });
  let file = null;
  function show(n) {
    name.textContent = n || "未选择";
    name.title = n || "";
    wrap.classList.toggle("has", !!n);
    clear.hidden = !n;
  }
  pick.onclick = () => input.click();
  input.onchange = () => { file = input.files[0] || null; show(file?.name); onChange?.(file); };
  clear.onclick = () => { input.value = ""; file = null; show(""); onChange?.(null); };
  show(initialName);
  wrap.append(input, pick, name, clear);
  wrap.file = () => file;
  return wrap;
}

// Audio player: play/pause, a seek bar and the time. Starting one pauses the others.
const ICON_PLAY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
const ICON_REDO = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CANCEL = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5h3v11H4zm5 0h3v11H9z" fill="currentColor"/></svg>';
let activePlayer = null;
function fmtTime(s) { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function audioPlayer(url) {
  const el = document.createElement("div");
  el.className = "player";
  el.innerHTML = `<button type="button" class="pbtn" aria-label="播放">${ICON_PLAY}</button><div class="ptrack"><div class="pfill"></div></div><span class="ptime">0:00</span>`;
  const audio = new Audio(url);
  audio.preload = "metadata";
  const btn = el.querySelector(".pbtn"), track = el.querySelector(".ptrack"), fill = el.querySelector(".pfill"), time = el.querySelector(".ptime");
  const paint = () => {
    fill.style.width = audio.duration ? `${(audio.currentTime / audio.duration) * 100}%` : "0";
    time.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
  };
  const icon = playing => { btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY; btn.setAttribute("aria-label", playing ? "暂停" : "播放"); };
  btn.onclick = () => {
    if (audio.paused) {
      if (activePlayer && activePlayer !== audio) activePlayer.pause();
      player.pause();
      activePlayer = audio;
      audio.play();
    } else audio.pause();
  };
  track.onclick = e => {
    if (!audio.duration) return;
    const r = track.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
  };
  audio.onplay = () => icon(true);
  audio.onpause = () => icon(false);
  audio.onended = () => { icon(false); audio.currentTime = 0; paint(); };
  audio.ontimeupdate = paint;
  audio.onloadedmetadata = paint;
  return el;
}

// ---------- scene ----------
const roles = {};       // name -> { desc, personality, speaker, upload, anchor: {file, url, text} | null, anchorJob, ver }
let lines = [];         // { role, text, gloss, src, file, url, state, promise, el }
let models = [];
const sceneModel = document.getElementById("scene-model");
const scriptEl = document.getElementById("script");
const rolesEl = document.getElementById("roles");
const linesEl = document.getElementById("lines");
const sceneStatus = document.getElementById("scene-status");
const player = new Audio();
let playToken = 0;

function currentModel() { return models.find(m => m.id === sceneModel.value); }

// Text or gloss: with `text_script` (a Unicode script name such as "Thai"), a row in that script is
// text and any other plain row is an error; without it, a plain row right after a speaker row is
// the text and the speaker row holds its gloss.
function scriptPattern(name) {
  if (!name) return null;
  try { return new RegExp(`\\p{Script=${name}}`, "u"); }
  catch { console.warn(`text_script "${name}" is not a Unicode script name; using row order`); return null; }
}
const TEXT_SCRIPT = scriptPattern(DATA.text_script);
const inTextScript = t => !!TEXT_SCRIPT && TEXT_SCRIPT.test(t);

// Speaker row "role：rest"
const HEAD = /^([^：:\s[【]{1,24}?)\s*[：:]\s*(.*)$/;
// Kind of one editor row: blank, scene, direction, speaker, text, or bad (fits none)
function rowKind(t) {
  if (!t) return "blank";
  if (sceneItems(t)) return "scene";
  if (directionOf(t) !== null) return "direction";
  const head = t.match(HEAD);
  if (head && !inTextScript(head[1])) return "speaker";
  return !TEXT_SCRIPT || inTextScript(t) ? "text" : "bad";
}
// The script's lines. A line is a block of rows: direction, speaker, text. A blank row ends it, and so
// does a direction, speaker or text row after the text. A text row without a speaker is the narrator's.
// src: the line's first editor row; rows: its row count
// key: what changes the generated audio; other edits keep the line's take
function parseScript() {
  const out = [];
  let cur = null;
  const start = row => { cur = { role: NARRATOR, tone: "", notes: [], params: {}, text: "", gloss: "", src: row, rows: 1 }; out.push(cur); };
  scriptEl.value.split("\n").forEach((raw, row) => {
    const t = raw.trim();
    const kind = rowKind(t);
    if (kind === "blank" || kind === "scene") { cur = null; return; }
    if (kind === "bad") return;
    // Without a text script, the rest of a speaker row is the text until a text row follows it.
    const takesText = kind === "text" && cur?.headText;
    if (cur && ((cur.text && !takesText) || (kind === "speaker" && cur.named))) cur = null;
    if (!cur) start(row);
    if (kind === "direction") parseTag(directionOf(t), cur);
    else if (kind === "speaker") {
      const [, role, rest] = t.match(HEAD);
      const r = rest.trim();
      Object.assign(cur, { role: role.trim(), named: true, headRow: row });
      if (TEXT_SCRIPT && r && !inTextScript(r)) Object.assign(cur, { gloss: r, glossRow: row });
      else Object.assign(cur, { text: r, headText: !TEXT_SCRIPT && !!r });
    } else {
      if (cur.headText) Object.assign(cur, { gloss: cur.text, glossRow: cur.headRow, headText: false });
      cur.text = t;
    }
    cur.rows = row - cur.src + 1;
  });
  // A block with neither a speaker nor text is not a line (a direction on its own). A speaker
  // without text stays a line, so a new card can be written; generating it reports the missing text.
  const lines = out.filter(l => l.text || l.named);
  for (const l of lines) {
    for (const k of ["named", "headText", "headRow"]) delete l[k];
    l.key = formatTag({ tone: l.tone, notes: l.notes,
      params: Object.fromEntries(GEN_PARAMS.filter(k => l.params[k] !== undefined).map(k => [k, l.params[k]])) });
    l.tag = formatTag(l);
  }
  return lines;
}
// The coloured copy under the editor: role names in their colour, tones in the accent colour,
// glosses and directions muted, params marked. Each row keeps its exact characters, so the copy
// wraps like the textarea above it.
const scriptHl = document.getElementById("script-hl");
const esc = t => t.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
// A text row with its pause marks "<#0.5#>" marked like params
const escText = t => esc(t).replace(/&lt;#[^#]*#&gt;/g, m => `<span class="hl-kv">${m}</span>`);
function paintScript() {
  // A direction's first plain item is the tone; key=value items are params; the rest are notes.
  const items = (text, firstIsTone) => text.split(/(，)/).map((p, k) =>
    /^\s*[a-z_]+\s*=/.test(p) ? `<span class="hl-kv">${esc(p)}</span>`
      : (firstIsTone && k === 0) || TONES[p.trim()] ? `<span class="hl-tone">${esc(p)}</span>` : esc(p)).join("");
  const glossRows = new Set(parseScript().map(l => l.glossRow));
  scriptHl.innerHTML = scriptEl.value.split("\n").map((raw, row) => {
    const kind = rowKind(raw.trim());
    if (kind === "direction" || kind === "scene") {
      const dir = directionOf(raw), at = raw.indexOf(dir);
      return `<span class="hl-cont">${esc(raw.slice(0, at))}${items(dir, true)}${esc(raw.slice(at + dir.length))}</span>`;
    }
    if (kind === "speaker") {
      const [, lead, role, colon, rest] = raw.match(/^(\s*)(.+?)(\s*[：:])(.*)$/);
      return `${esc(lead)}<span class="hl-role" style="color:${roleColor(role.trim())}">${esc(role)}</span>${esc(colon)}` +
        (glossRows.has(row) ? `<span class="hl-gloss">${esc(rest)}</span>` : escText(rest));
    }
    if (kind === "bad") return `<span class="hl-bad">${esc(raw)}</span>`;
    return escText(raw);
  }).join("\n") + "\n";
  scriptHl.scrollTop = scriptEl.scrollTop;
}
function lineAtRow(row) { return lines.find(l => row >= l.src && row < l.src + (l.rows || 1)); }
// A take is the generated audio of a line
const takes = new Map();  // role|text|key -> take of a line that left the script, back on undo
const takeKey = l => `${l.role}|${l.text}|${l.key}`;
// Items of the scene's settings row "[场景，...]", or null for any other row
function sceneItems(t) {
  const d = directionOf(t);
  const items = d === null ? null : d.split("，").map(x => x.trim());
  return items && items[0] === SCENE_TAG ? items.slice(1) : null;
}
// The scene's settings: room for lines that name none, gap between lines, jitter strength (0 is off)
// and the jitter's random seed. Missing items keep the defaults.
function sceneSettings() {
  const out = { room: "", gap: DATA.defaults.gap ?? 0.35, jitter: 1, seed: DATA.defaults.jitter?.seed ?? 0 };
  for (const raw of scriptEl.value.split("\n")) {
    const items = sceneItems(raw.trim());
    if (!items) continue;
    for (const it of items) {
      const m = it.match(/^([a-z_]+)\s*=\s*(.+)$/);
      if (!m) continue;
      if (m[1] === "room") out.room = roomKey(m[2].trim(), ROOMS) ?? "";
      else if (m[1] in out && Number.isFinite(parseFloat(m[2]))) out[m[1]] = parseFloat(m[2]);
    }
    break;
  }
  return out;
}
function sceneGap() { return sceneSettings().gap; }
function planFor(l) {
  return resolve({ line: l, tones: TONES, defaults: DATA.defaults, rooms: ROOMS, role: roleDefaults(l.role),
    scene: { gap: sceneGap(), pace: scenePace, room: sceneSettings().room } });
}

// ---------- editing the script from the page ----------
// Edits go through insertText, so Ctrl+Z in the editor undoes them.
function rowStart(src) {
  const rows = scriptEl.value.split("\n");
  return rows.slice(0, src).reduce((n, r) => n + r.length + 1, 0);
}
function replaceRange(start, end, text) {
  scriptEl.focus({ preventScroll: true });
  scriptEl.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, text)) scriptEl.setRangeText(text, start, end, "end");
}
// Rewrite the rows of the line under editor row `src`; change(tag) edits { tone, notes, params }
// in place. The line comes back in the rows of formatBlock.
function editTag(src, change) {
  const p = parseScript().find(l => src >= l.src && src < l.src + l.rows);
  if (!p) return null;
  const tag = { tone: p.tone, notes: [...p.notes], params: { ...p.params } };
  change(tag);
  const next = formatBlock({ ...tag, role: p.role, text: p.text, gloss: p.gloss });
  const rows = scriptEl.value.split("\n");
  const start = rowStart(p.src);
  const end = start + rows.slice(p.src, p.src + p.rows).join("\n").length;
  replaceRange(start, end, next);
  renderScene();
  return { start, text: next };
}
function caretRow() { return scriptEl.value.slice(0, scriptEl.selectionStart).split("\n").length - 1; }
function selectRow(src) {
  const start = rowStart(src);
  scriptEl.focus({ preventScroll: true });
  scriptEl.setSelectionRange(start, start);
  // Bring the row into the editor's own view without moving the page.
  const lineH = parseFloat(getComputedStyle(scriptEl).lineHeight) || 27;
  const top = src * lineH;
  if (top < scriptEl.scrollTop || top > scriptEl.scrollTop + scriptEl.clientHeight - lineH)
    scriptEl.scrollTop = Math.max(0, top - scriptEl.clientHeight / 3);
  markCurrent();
}

// ---------- dictionary ----------
// The reference beside the editor. Clicking an entry writes it into the line under the caret:
// tone, param and space go into the direction, beat marks go in at the caret.
const dictBody = document.getElementById("dict-body");
const dictTarget = document.getElementById("dict-target");
const dictQuery = document.getElementById("dict-q");
const EXAMPLE = { level_db: 2, pace: 0.9, pitch_st: 1, tail: 1.2, gap_before: 0.8, inhale: 0.4, exhale: 0.5 };
const sign = v => (v > 0 ? "+" : "") + v;
const DICT = [
  { title: "写法", rows: [
    { key: "[语气，细节，键=值]", desc: "导演指令，写在这句上面，可省略：第一个不带 = 的项是语气，键=值是参数，其余是交给模型的细节，用全角逗号分开" },
    { key: "角色：译文", desc: "谁在说；冒号后写译文，台词写在下一行。没有译文时写“角色：台词”" },
    { key: "台词", desc: `要念的那一行；前面没有角色行的归${NARRATOR}` },
    { key: "（空行）", desc: "空行隔开每一句" },
    { key: `[${SCENE_TAG}，room=街边，gap=0.35，jitter=1，seed=1]`, desc: "整段的设置，写在最前面：默认空间、句间停顿、抖动强度（0 关掉）和抖动的种子" },
  ] },
  { title: "语气词", note: "点一下设为这句的语气", rows: Object.entries(TONES).map(([w, t]) => ({
    key: w, side: t.level_db ? `${sign(t.level_db)} dB` : "", desc: t.instruction || "",
    act: { kind: "tone", value: w } })) },
  { title: "参数", note: "点一下加到这句，再改数值", rows: [
    { key: "level_db", side: "−10…8 dB", desc: "音量，在语气的音量上再加减", act: { kind: "param", value: "level_db" } },
    { key: "pace", side: "0.7…1.4", desc: "语速倍数", act: { kind: "param", value: "pace" } },
    { key: "pitch_st", side: "−3…3", desc: "音高，半音；改声音多于改情绪", act: { kind: "param", value: "pitch_st" } },
    { key: "tail", side: `1…2，默认 ${DATA.defaults.tail ?? 1}`, desc: "停顿前最后一个音节拖长的倍数，1 不拖：干脆的命令、冷笑取小，话音渐弱、没说完取大", act: { kind: "param", value: "tail" } },
    { key: "gap_before", side: "−1…3 秒", desc: "这句之前的停顿：抢话 0.1–0.3，接话 0.4–0.6，揭晓前 0.8–1.5；负数压着上一句开口，两句交叠", act: { kind: "param", value: "gap_before" } },
    { key: "inhale", side: "0…0.8 秒", desc: "开口前的吸气声，拼接整段时加入，可以和上一句的结尾交叠", act: { kind: "param", value: "inhale" } },
    { key: "exhale", side: "0…1.2 秒", desc: "说完后的呼气声，拼接整段时加入，可以和下一句交叠", act: { kind: "param", value: "exhale" } },
  ] },
  { title: "空间", note: "作用于播放和下载的整段；点一下设为这句的空间", rows: [
    { key: DRY, side: "", desc: "不加混响", act: { kind: "room", value: DRY } },
    ...Object.values(ROOMS).map(r => ({ key: r.label, side: r.rt60 ? `混响 ${r.rt60}s` : "", desc: `room=${r.label}`, act: { kind: "room", value: r.label } })),
  ] },
  { title: "停顿", note: "点一下插到光标处。停顿把一句分成几拍，后一拍接着前一拍的声音生成，语气连得上", rows: [
    { key: "<#0.5#>", side: `${PAUSE_RANGE[0]}…${PAUSE_RANGE[1]} 秒`, desc: "在这里停这么多秒，写在演员会停顿、换气的地方", act: { kind: "text", value: "<#0.5#>" } },
    { key: " / ", side: `${DATA.defaults.beat_gap ?? 0}s`, desc: "分拍，停 beat_gap 秒", act: { kind: "text", value: " / " } },
    { key: " // ", side: `${DATA.defaults.long_beat_gap ?? 0}s`, desc: "分拍并停得更久", act: { kind: "text", value: " // " } },
    { key: "［细节］", side: "", desc: "写在拍首，用全角方括号，只给这一拍加细节", act: { kind: "text", value: "［］" } },
  ] },
];
function renderDict() {
  const q = dictQuery.value.trim().toLowerCase();
  dictBody.innerHTML = "";
  for (const sec of DICT) {
    const rows = sec.rows.filter(r => !q || `${r.key} ${r.side || ""} ${r.desc}`.toLowerCase().includes(q));
    if (!rows.length) continue;
    const box = Object.assign(document.createElement("section"), { className: "dict-sec" });
    box.innerHTML = `<h4></h4>`;
    box.querySelector("h4").textContent = sec.title;
    if (sec.note) box.querySelector("h4").append(Object.assign(document.createElement("span"), { className: "hint", textContent: sec.note }));
    for (const r of rows) {
      const row = document.createElement(r.act ? "button" : "div");
      row.className = "dict-row" + (r.act ? " act" : " stack");
      if (r.act) row.type = "button";
      row.innerHTML = `<code class="dk"></code><span class="ds"></span><span class="dd"></span>`;
      row.querySelector(".dk").textContent = r.key;
      row.querySelector(".ds").textContent = r.side || "";
      row.querySelector(".dd").textContent = r.desc;
      if (r.act) row.onclick = () => applyDict(r.act);
      box.append(row);
    }
    dictBody.append(box);
  }
  if (!dictBody.children.length) dictBody.innerHTML = '<div class="hint dict-empty">没有匹配的条目</div>';
}
function applyDict(act) {
  if (!scriptEl.dataset.touched) { flashTarget("先点剧本里的一句"); return; }
  const src = caretRow();
  if (act.kind === "text") {
    replaceRange(scriptEl.selectionStart, scriptEl.selectionEnd, act.value);
    // The browser may move the caret to a character boundary, so measure from where the text went.
    const a = scriptEl.selectionEnd - act.value.length;
    if (act.value === "［］") scriptEl.setSelectionRange(a + 1, a + 1);
    // Select the seconds of a pause mark, so typing replaces them.
    const secs = act.value.match(/^<#(.*)#>$/);
    if (secs) scriptEl.setSelectionRange(a + 2, a + 2 + secs[1].length);
    renderScene();
    return;
  }
  const done = editTag(src, tag => {
    if (act.kind === "tone") tag.tone = act.value;
    else if (act.kind === "room") tag.params.room = act.value;
    else if (tag.params[act.value] === undefined) tag.params[act.value] = EXAMPLE[act.value];
  });
  if (!done) { flashTarget("光标所在行不是台词，先点剧本里的一句"); return; }
  // Select the new value, so typing replaces it.
  const key = act.kind === "param" ? act.value : act.kind === "room" ? "room" : null;
  const at = key ? done.text.indexOf(`${key}=`) : done.text.indexOf(act.value);  // the direction is the first row
  if (at >= 0) {
    const from = done.start + at + (key ? key.length + 1 : 0);
    const value = key ? done.text.slice(at + key.length + 1).match(/^[^，\]\n]*/)[0] : act.value;
    scriptEl.setSelectionRange(from, from + value.length);
  }
  markCurrent();
}
function flashTarget(text) {
  dictTarget.textContent = text;
  dictTarget.classList.add("warn");
  setTimeout(() => { dictTarget.classList.remove("warn"); markCurrent(); }, 2200);
}
dictQuery.addEventListener("input", renderDict);
renderDict();

// The splitter between editor and dictionary: drag, or arrow keys. Dragging past half the
// minimum width folds the dictionary away; dragging back or a double-click opens it again.
const workEl = document.getElementById("scene-work");
const splitter = document.getElementById("splitter");
const DICT_W = { min: 240, def: 380, key: "tts-board.dictWidth" };
let dictOpenWidth = DICT_W.def;  // the width to restore after folding
function dictFolded() { return workEl.classList.contains("dict-folded"); }
function setDictWidth(w) {
  const max = Math.max(DICT_W.min, workEl.clientWidth * 0.65);
  const fold = w < DICT_W.min / 2;
  if (!fold) dictOpenWidth = w = Math.round(Math.min(Math.max(w, DICT_W.min), max));
  workEl.classList.toggle("dict-folded", fold);
  workEl.style.setProperty("--dict-w", fold ? "0px" : w + "px");
  splitter.setAttribute("aria-valuenow", fold ? 0 : w);
  splitter.title = fold ? "向左拖或双击展开写法字典" : "拖动调整宽度，拖到最右收起，双击恢复";
  try { localStorage.setItem(DICT_W.key, fold ? 0 : w); } catch {}
}
try {
  const saved = localStorage.getItem(DICT_W.key);
  if (saved !== null) setDictWidth(+saved);
} catch {}
splitter.addEventListener("pointerdown", e => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  workEl.classList.add("dragging");
  // Passing the minimum on the way to folding must not change the width to restore.
  const startWidth = dictFolded() ? dictOpenWidth : document.getElementById("dict").offsetWidth;
  const right = workEl.getBoundingClientRect().right;
  const move = ev => setDictWidth(right - ev.clientX - splitter.offsetWidth / 2);
  const up = () => { if (dictFolded()) dictOpenWidth = startWidth; workEl.classList.remove("dragging"); splitter.removeEventListener("pointermove", move); splitter.removeEventListener("pointerup", up); };
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", up);
});
splitter.addEventListener("keydown", e => {
  const now = dictFolded() ? 0 : document.getElementById("dict").offsetWidth;
  if (e.key === "ArrowLeft") { setDictWidth(dictFolded() ? dictOpenWidth : now + 24); e.preventDefault(); }
  if (e.key === "ArrowRight") { setDictWidth(now - 24 < DICT_W.min ? 0 : now - 24); e.preventDefault(); }
});
splitter.addEventListener("dblclick", () => setDictWidth(dictFolded() ? dictOpenWidth : DICT_W.def));

// ---------- roles ----------
// One color per role, shared by its card and its lines.
const ROLE_COLORS = ["#d9822b", "#3b82c4", "#c4508a", "#4a9e6b", "#8a6bd1", "#c9a227", "#2fa3a3", "#b8584a"];
function roleColor(name) { return roles[name]?.color || "var(--muted)"; }
function ensureRoles(parsed) {
  const names = [...new Set(parsed.map(l => l.role))];
  for (const name of names) {
    if (roles[name]) continue;
    const n = Object.keys(roles).length;
    roles[name] = { desc: roleDefaults(name).voice || "", personality: roleDefaults(name).personality || "", speaker: n,
      upload: null, anchor: null, color: ROLE_COLORS[n % ROLE_COLORS.length] };
  }
  return names;
}
// A role's speaker id within the model's range.
function speakerOf(r, m) { return r.speaker % Math.max(1, m?.speakers || 1); }
function descGender(desc) {
  const d = desc.toLowerCase();
  if (/\b(woman|female|girl|lady|auntie|aunt|mother|grandmother)\b|女|妈|婆|姐|妹/.test(d)) return "f";
  if (/\b(man|male|boy|guy|uncle|father|grandfather)\b|男|爷|叔|哥|弟/.test(d)) return "m";
  return "";
}
// Median pitch in Hz: female voices sit mostly above 165, male voices below 160.
function pitchFits(gender, f0) {
  if (!gender || !f0) return true;
  return gender === "f" ? f0 >= 165 : f0 <= 160;
}
// Pitch range in semitones, at least anchor_min_f0_range; without the setting or a measurement it passes
function rangeFits(range) {
  const min = DATA.anchor_min_f0_range;
  return !min || range === undefined || range === null || range >= min;
}
function anchorPrompt(r) { return [r.desc, r.personality].filter(Boolean).join(", "); }

function renderRoles() {
  const parsed = parseScript();
  const names = ensureRoles(parsed);
  const m = currentModel();
  const mode = voiceMode(m);
  document.getElementById("roles-count").textContent = names.length ? `${names.length} 个` : "";
  rolesEl.innerHTML = "";
  if (!names.length) { rolesEl.innerHTML = '<div class="hint">剧本里还没有台词</div>'; return; }
  if (!m || mode === "single") {
    const text = m ? `${m.name} 只有一种声音，所有角色同声。` : "还没有读到模型列表。";
    rolesEl.append(Object.assign(document.createElement("div"), { className: "hint", textContent: text }));
    return;
  }
  for (const name of names) {
    const r = roles[name];
    const count = parsed.filter(l => l.role === name).length;
    const box = document.createElement("div");
    box.className = "role";
    box.style.setProperty("--role", roleColor(name));
    const head = document.createElement("div");
    head.className = "role-head";
    head.innerHTML = `<b></b><span class="hint"></span><span class="status"></span>`;
    head.querySelector("b").textContent = name;
    head.querySelector(".hint").textContent = `${count} 句`;
    const st = head.querySelector(".status");
    box.append(head);
    if (mode === "speaker") {
      const sel = document.createElement("select");
      for (let i = 0; i < (m.speakers || 1); i++) sel.append(new Option(`说话人 ${i}`, i));
      sel.value = speakerOf(r, m);
      sel.onchange = () => { r.speaker = +sel.value; markStale(name); setStatus(st, "ok", `说话人 ${r.speaker}`); };
      box.append(field("固定说话人", sel));
      setStatus(st, "ok", `说话人 ${speakerOf(r, m)}`);
    } else {
      if (can(m, "voice_prompt")) {
        const desc = Object.assign(document.createElement("input"), { type: "text", value: r.desc, placeholder: "例：A young man in his twenties" });
        desc.title = r.desc;
        desc.onchange = () => { r.desc = desc.value.trim(); resetVoice(name); };
        box.append(field("声音描述", desc));
        const pers = Object.assign(document.createElement("input"), { type: "text", value: r.personality, placeholder: "例：calm and steady, speaks few words slowly" });
        pers.title = r.personality;
        pers.onchange = () => { r.personality = pers.value.trim(); resetVoice(name); };
        box.append(field("性格", pers));
      }
      const up = filePicker(file => { r.upload = file; resetVoice(name); }, r.upload?.name);
      box.append(field(can(m, "voice_prompt") ? "参考音频（优先于描述）" : "参考音频", up));
      const acts = document.createElement("div");
      acts.className = "row";
      const listen = Object.assign(document.createElement("button"), { className: "plain small", textContent: "试听" });
      const reroll = Object.assign(document.createElement("button"), { className: "plain small", textContent: "换一个声音" });
      const listenTo = async () => {
        try { playOne((await ensureAnchor(name)).url); }
        catch (e) { r.error = e.cancelled ? "" : "失败：" + e.message; renderRoles(); }
      };
      listen.onclick = listenTo;
      reroll.onclick = () => { resetVoice(name); listenTo(); };
      listen.disabled = reroll.disabled = !!r.anchorJob || !!m?.missing;
      acts.append(listen, reroll);
      box.append(acts);
      if (r.anchorJob) setStatus(st, "busy", r.anchorState || "排队中");
      else if (r.error) setStatus(st, "err", r.error);
      else setStatus(st, r.anchor ? "ok" : "muted", r.anchor ? "已生成" : "未生成");
    }
    rolesEl.append(box);
  }
}

// Reset a role's voice: drop its anchor and mark its lines stale
function resetVoice(name) {
  const r = roles[name];
  r.ver = (r.ver || 0) + 1;
  Object.assign(r, { anchor: null, anchorJob: null, error: "" });
  markStale(name);
  renderRoles();
}
// The role's anchor, generating it once even when several lines ask at the same time.
function ensureAnchor(name, priority = PRIORITY.user) {
  const r = roles[name];
  if (r.anchor) return Promise.resolve(r.anchor);
  if (!r.anchorJob) {
    const ver = r.ver;
    const job = makeAnchor(name, priority, st => {
      if (r.anchorJob !== job) return;
      r.anchorState = jobText(st, "生成样本…");
      renderRoleStatus(name);
    }).then(anchor => {
      if (r.ver !== ver) throw Object.assign(new Error("声音已更换"), { cancelled: true });
      return (r.anchor = anchor);
    }).finally(() => { if (r.anchorJob === job) { r.anchorJob = null; renderRoles(); } });
    Object.assign(r, { anchorJob: job, anchorState: "排队中", error: "" });
    renderRoles();
  }
  return r.anchorJob;
}
function renderRoleStatus(name) {
  const box = [...rolesEl.querySelectorAll(".role")].find(b => b.querySelector("b")?.textContent === name);
  const st = box?.querySelector(".role-head .status");
  if (st) setStatus(st, "busy", roles[name].anchorState);
}

// A role's anchor: a sample of the anchor sentence in the role's voice, which every line of the
// role then clones. An uploaded clip is the voice itself; the sample is only for listening.
async function makeAnchor(name, priority, onState) {
  const r = roles[name];
  const m = currentModel();
  // A role with one steady mood can read its own anchor sentence in that mood,
  // because every cloned line inherits the anchor's delivery.
  const text = roleDefaults(name).anchor_text || ANCHOR_TEXT;
  if (!text) throw new Error("data/project.json 里没有 anchor_text");
  if (r.upload) {
    const body = await tts({ model: m.id, text, ref_audio: r.upload }, { priority, onState });
    return { file: body.ref_saved || body.file, url: body.url, text: "" };
  }
  // Draw again while the sample's pitch does not fit the gender that the description names, or its
  // pitch range is too narrow: every line of the role clones the sample, so a flat sample makes them flat.
  const prompt = can(m, "voice_prompt") ? anchorPrompt(r) : "";
  const gender = descGender(prompt);
  let body;
  for (let i = 0; i < 4; i++) {
    body = await tts({ model: m.id, text, voice_prompt: prompt, seed: Math.floor(Math.random() * 1e6) }, { priority, onState });
    if (pitchFits(gender, body.f0) && rangeFits(body.f0_range)) break;
  }
  return { file: body.file, url: body.url, text };
}

function markStale(roleName) {
  for (const l of lines) if (l.role === roleName && l.state === "done") { l.state = "stale"; paintLine(l); }
  paintSummary();
}

// ---------- lines ----------
function roomLabel(key) { return key ? ROOMS[key]?.label ?? key : DRY; }
// The text as it is read; beat marks show as thin separators, a beat's note as its tooltip.
function textView(text) {
  const frag = document.createDocumentFragment();
  const beats = parseBeats(text);
  beats.forEach((b, i) => {
    const s = Object.assign(document.createElement("span"), { textContent: b.text });
    if (b.note) { s.className = "beat-note"; s.title = `这一拍：${b.note}`; }
    frag.append(s);
    if (i < beats.length - 1) frag.append(Object.assign(document.createElement("span"), { className: "beat-sep", textContent: b.pause !== null ? `${b.pause}s` : b.long ? "//" : "/" }));
  });
  return frag;
}

function renderLines() {
  const parsed = parseScript();
  ensureRoles(parsed);
  // Keep audio of lines whose role, text and generation settings did not change; take the rest
  // (rows, gap, breath, space) from the editor.
  // A take whose line left the script is kept, so undoing the edit brings the take back.
  const old = lines;
  lines = parsed.map(p => {
    const prev = old.find(o => o.role === p.role && o.text === p.text && o.key === p.key && !o.used);
    if (prev) { prev.used = true; return Object.assign(prev, p); }
    const take = takes.get(takeKey(p));
    if (!take) return { ...p, state: "new" };
    const fresh = take.ver === (roles[p.role]?.ver || 0) && take.model === sceneModel.value;
    return { ...p, ...take, state: fresh ? "done" : "stale" };
  });
  for (const o of old) if (!o.used && (o.state === "done" || o.state === "stale"))
    takes.set(takeKey(o), { file: o.file, url: o.url, info: o.info, detail: o.detail, model: o.model, ver: roles[o.role]?.ver || 0 });
  lines.forEach(l => delete l.used);
  linesEl.innerHTML = "";
  const gap = sceneGap();
  lines.forEach((l, i) => {
    const plan = planFor(l);
    const row = document.createElement("div");
    row.className = "line";
    row.style.setProperty("--role", roleColor(l.role));
    row.innerHTML = `<div class="idx">${i + 1}</div>
      <div class="name"></div>
      <div class="text"><div class="spoken"></div><div class="gloss"></div><div class="tags"></div></div>
      <div class="st"></div>
      <div class="acts"><button class="icon play" title="播放这句" aria-label="播放这句">${ICON_PLAY}</button><button class="icon redo" title="重新生成这句" aria-label="重新生成这句">${ICON_REDO}</button></div>`;
    row.querySelector(".name").textContent = l.role;
    row.querySelector(".spoken").append(textView(l.text));
    row.querySelector(".gloss").textContent = l.gloss;
    const tags = row.querySelector(".tags");
    const tag = (text, cls = "") => tags.append(Object.assign(document.createElement("span"), { className: "ltag " + cls, textContent: text }));
    // How the line is performed, in one row: tone, then what differs from a plain line.
    if (l.tone) tag(l.tone, "tone");
    for (const bit of describe(plan, DATA.defaults)) tag(bit);
    // A pause that differs from the scene's ordinary gap.
    if (i && plan.gap_before !== gap) tag(`句前 ${plan.gap_before}s`, plan.gap_before > (gap ?? 0) ? "gap long" : "gap");
    if (l.notes.length) tag("细节", "note");
    if (plan.ownRoom) tag(roomLabel(plan.room));
    if (plan.badRoom) tag(`没有空间“${plan.badRoom}”`, "bad");
    tags.title = plan.beats
      ? plan.beats.map((b, k) => `第 ${k + 1} 拍：${k ? "接着上一拍" : b.instruction || "（无指令）"}`).join("\n")
      : plan.instruction ? `指令：${plan.instruction}` : "无指令";
    row.querySelector(".play").onclick = () => { if (l.url) { stopPlayback(); highlight(l); playOne(l.url, () => highlight(null)); } };
    row.querySelector(".redo").onclick = () => (l.state === "queued" ? cancelLine(l) : generateLine(l));
    // Clicking the line puts the editor's caret on it, so the dictionary writes into this line.
    row.onclick = e => { if (!e.target.closest("button, select")) selectRow(l.src); };
    l.el = row;
    paintLine(l);
    linesEl.append(row);
  });
  paintSummary();
  markCurrent();
}
function renderScene() { renderRoles(); renderLines(); paintScript(); }

// The editor row under the caret: marked in the timeline and named above the dictionary.
function markCurrent() {
  const src = document.activeElement === scriptEl || scriptEl.dataset.touched ? caretRow() : -1;
  const cur = lineAtRow(src);
  for (const l of lines) l.el?.classList.toggle("cur", l === cur);
  if (dictTarget.classList.contains("warn")) return;
  dictTarget.textContent = cur ? `写入第 ${lines.indexOf(cur) + 1} 句 · ${cur.role}` : "先点剧本里的一句";
}

function paintLine(l) {
  if (!l.el) return;
  const st = l.el.querySelector(".st");
  const waiting = l.state === "queued" || l.state === "busy";
  const map = { new: ["muted", "未生成"], queued: ["muted", l.ahead ? `排队 #${l.ahead + 1}` : "排队中"], busy: ["busy", "生成中…"], done: ["ok", l.info || "完成"], stale: ["busy", "需重新生成"], err: ["err", "失败"] };
  const [kind, text] = map[l.state];
  st.className = "st " + kind; st.textContent = text;
  st.title = l.state === "err" ? l.error : l.state === "done" ? l.detail || "" : l.state === "queued" && l.ahead ? `排队中，前面 ${l.ahead} 个` : "";
  l.el.dataset.state = l.state;
  l.el.querySelector(".play").disabled = !l.url;
  // While a line waits in the queue, its redo button takes it out again.
  const redo = l.el.querySelector(".redo");
  redo.disabled = l.state === "busy";
  redo.innerHTML = l.state === "queued" ? ICON_CANCEL : ICON_REDO;
  redo.title = redo.ariaLabel = l.state === "queued" ? "取消排队" : waiting ? "生成中" : "重新生成这句";
}
// How many lines are ready, shown in the head and as a thin bar under it.
function paintSummary() {
  const done = lines.filter(l => l.state === "done").length;
  const stale = lines.filter(l => l.state === "stale").length;
  const failed = lines.filter(l => l.state === "err").length;
  const queued = lines.filter(l => l.state === "queued" || l.state === "busy").length;
  const bits = [`${lines.length} 句`];
  if (lines.length) bits.push(`已生成 ${done}`);
  if (queued) bits.push(`${queued} 句在队列中`);
  if (stale) bits.push(`${stale} 句需重新生成`);
  if (failed) bits.push(`${failed} 句失败`);
  document.getElementById("lines-count").textContent = lines.length ? bits.join(" · ") : "";
  document.getElementById("scene-progress").style.width = lines.length ? `${(done / lines.length) * 100}%` : "0";
}

// The form fields of one line for the current model. A cloning role sends its anchor; a model that
// clones from audio plus its transcript reads an instruction as more text, so a line with an
// instruction or beats sends the reference audio without the transcript.
async function lineFields(l, m, plan, scene) {
  const fields = { model: m.id, text: plan.text, level_db: plan.level_db, pace: plan.pace, pitch_st: plan.pitch_st,
    tail: plan.tail, beats: plan.beats ? JSON.stringify(plan.beats) : "" };
  if (can(m, "voice_prompt") && plan.instruction) fields.voice_prompt = plan.instruction;
  const mode = voiceMode(m);
  if (mode === "speaker") fields.speaker = speakerOf(roles[l.role], m);
  if (mode === "clone") {
    const anchor = await ensureAnchor(l.role, scene ? PRIORITY.anchor : PRIORITY.user + 1);
    fields.ref_file = anchor.file;
    if (!fields.voice_prompt && !plan.beats && can(m, "ref_text")) fields.ref_text = anchor.text;
  }
  return fields;
}

// Queue one line. A scene's lines go after lines asked for one by one, in script order.
// l.run marks the current attempt: a cancel or a newer attempt makes an older result stale.
function generateLine(l, { scene = false } = {}) {
  const m = currentModel();
  if (!m || m.missing) return Promise.resolve();
  if (l.state === "queued" || l.state === "busy") return l.promise;
  if (!l.text.trim()) {
    Object.assign(l, { state: "err", error: "这句还没有台词" });
    paintLine(l); paintSummary();
    return Promise.resolve();
  }
  const run = l.run = { prev: l.url ? "stale" : "new" };
  Object.assign(l, { state: "queued", ahead: 0 });
  paintLine(l); paintSummary();
  l.promise = (async () => {
    try {
      const fields = await lineFields(l, m, planFor(l), scene);
      if (l.run !== run) return;
      const body = await tts(fields, {
        priority: scene ? PRIORITY.scene - lines.indexOf(l) : PRIORITY.user,
        onId: id => { run.job = id; },
        onState: st => {
          if (l.run !== run) return;
          Object.assign(l, { state: st.state === "running" ? "busy" : "queued", ahead: st.ahead || 0 });
          paintLine(l); paintSummary();
        },
      });
      if (l.run !== run) return;
      const took = body.seconds !== undefined ? `，生成耗时 ${body.seconds}s` : "";
      Object.assign(l, { file: body.file, url: body.url, state: "done", info: `${body.duration}s`, detail: `音频 ${body.duration}s${took}`, model: m.id });
    } catch (e) {
      if (l.run !== run) return;
      if (e.cancelled) l.state = run.prev;
      else Object.assign(l, { state: "err", error: "失败：" + e.message });
    }
    l.run = null;
    paintLine(l); paintSummary();
  })();
  return l.promise;
}
// Take a waiting line out of the queue. A line that already runs finishes.
function cancelLine(l) {
  const run = l.run;
  if (!run || l.state !== "queued") return;
  if (run.job) { cancelJob(run.job); return; }  // the poller reports it cancelled
  l.run = null;  // still waiting for its role's anchor
  l.state = run.prev;
  paintLine(l); paintSummary();
}

// The button queues every line that is not done; while they wait, it takes them out again.
let sceneRun = null;
const sceneGo = document.getElementById("scene-go");
async function generateScene() {
  if (sceneRun) {
    sceneRun.cancelled = true;
    for (const l of sceneRun.lines) cancelLine(l);
    setStatus(sceneStatus, "busy", "取消排队中…");
    return;
  }
  renderLines();
  if (!lines.length) { setStatus(sceneStatus, "err", "剧本里还没有台词"); return; }
  const m = currentModel();
  if (!m || m.missing) { setStatus(sceneStatus, "err", "没有可用的模型"); return; }
  const todo = lines.filter(l => l.state !== "queued" && l.state !== "busy" && (l.state !== "done" || l.model !== m.id));
  const open = lines.filter(l => l.state === "queued" || l.state === "busy");
  if (!todo.length && !open.length) { setStatus(sceneStatus, "ok", "全部已生成"); return; }
  const run = sceneRun = { lines: todo, cancelled: false };
  sceneGo.textContent = "取消排队";
  setStatus(sceneStatus, "busy", `已排队 ${todo.length} 句`);
  await Promise.all([...todo.map(l => generateLine(l, { scene: true })), ...open.map(l => l.promise)]);
  sceneRun = null;
  sceneGo.textContent = "生成整段";
  const failed = lines.filter(l => l.state === "err").length;
  const left = lines.filter(l => l.state !== "done").length;
  setStatus(sceneStatus, failed ? "err" : "ok", failed ? `${failed} 句失败` : run.cancelled && left ? `已取消，${left} 句未生成` : "完成");
}

function highlight(l) { for (const x of lines) x.el?.classList.toggle("now", x === l); }
function playOne(url, onend) {
  activePlayer?.pause(); player.src = url; player.onended = onend || null; player.play(); }
function stopPlayback() { playToken++; player.pause(); player.ontimeupdate = null; highlight(null); }

// Play the mixed scene after every queued line is generated
async function playAll() {
  stopPlayback();
  const token = playToken;
  for (const l of lines) {
    while (l.state === "queued" || l.state === "busy") {
      highlight(l);
      await (l.promise || new Promise(res => setTimeout(res, 300)));
      if (token !== playToken) return;
    }
  }
  let mix;
  try { mix = await mixScene(); } catch (e) { setStatus(sceneStatus, "err", "拼接失败：" + e.message); return; }
  if (!mix || token !== playToken) return;
  setStatus(sceneStatus, "ok", `播放整段，共 ${mix.body.duration}s`);
  player.ontimeupdate = () => {
    const k = (mix.body.starts || []).findLastIndex(t => player.currentTime >= t);
    const l = mix.ready[k];
    if (l && !l.el.classList.contains("now")) { highlight(l); l.el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  };
  playOne(mix.body.url, () => { player.ontimeupdate = null; highlight(null); });
}

// A space's settings as the backend takes them: every field of its entry in `rooms` except the label.
function roomParams(key) {
  const r = ROOMS[key];
  if (!r) return null;
  const { label, ...params } = r;
  return params;
}

// The jitter of the mix: defaults, then the scene, merged field by field per dimension.
// Role fields go separately, as the backend merges them per role.
// A wave given as {expr} or {curve} is one value, so it replaces instead of merging.
function mergeJitter(...specs) {
  const out = {};
  for (const spec of specs) for (const [k, v] of Object.entries(spec || {}))
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) && !("expr" in v) && !("curve" in v) ? { ...(out[k] || {}), ...v } : v;
  return out;
}

// Mix the generated lines into one file; null when no line is ready.
async function mixScene() {
  const ready = lines.filter(l => l.url && l.state !== "err");
  if (!ready.length) { setStatus(sceneStatus, "err", "还没有生成好的台词"); return null; }
  setStatus(sceneStatus, "busy", "拼接中…");
  const plans = ready.map(planFor);
  const settings = sceneSettings();
  const body = await concat({ files: ready.map(l => l.file), levels: plans.map(p => p.level_db),
    room: roomParams(settings.room), rooms: plans.map(p => roomParams(p.room)),
    gap: settings.gap || 0, gaps: plans.map(p => p.gap_before),
    inhales: plans.map(p => p.inhale), exhales: plans.map(p => p.exhale), speakers: ready.map(l => l.role || ""),
    jitter: { ...mergeJitter(DATA.defaults.jitter, sceneJitter), seed: Math.round(settings.seed) },
    role_jitter: Object.fromEntries([...new Set(ready.map(l => l.role))].filter(r => roleDefaults(r).jitter).map(r => [r, roleDefaults(r).jitter])),
    jitter_scale: Math.max(0, settings.jitter) });
  return { ready, body };
}

async function downloadScene() {
  try {
    const mix = await mixScene();
    if (!mix) return;
    const { ready, body } = mix;
    const a = Object.assign(document.createElement("a"), { href: body.url, download: body.url.split("/").pop() });
    document.body.append(a); a.click(); a.remove();
    const skipped = lines.length - ready.length;
    setStatus(sceneStatus, "ok", `已拼接 ${ready.length} 句，共 ${body.duration}s${skipped ? `（${skipped} 句未生成，已跳过）` : ""}`);
  } catch (e) { setStatus(sceneStatus, "err", "拼接失败：" + e.message); }
}

for (const s of SCENES) {
  const b = Object.assign(document.createElement("button"), { className: "chip", textContent: s.label });
  b.onclick = () => { loadScene(s); renderScene(); };
  document.getElementById("scene-presets").append(b);
}
// A loaded scene starts with its settings row, so the space, the pause and the jitter are edited in the script.
function loadScene(s) {
  sceneRoles = s.roles; scenePace = s.pace; sceneJitter = s.jitter;
  const head = `[${SCENE_TAG}，room=${roomLabel(roomKey(s.room, ROOMS) ?? "")}，gap=${s.gap}，jitter=1，seed=${DATA.defaults.jitter?.seed ?? 0}]`;
  scriptEl.value = head + BLOCK_GAP + s.script;
}
if (SCENES.length) loadScene(SCENES[0]);
// The timeline follows the editor while typing, after a short pause.
let typing;
scriptEl.addEventListener("input", () => { paintScript(); clearTimeout(typing); typing = setTimeout(renderScene, 400); });
scriptEl.addEventListener("scroll", () => { scriptHl.scrollTop = scriptEl.scrollTop; });
new ResizeObserver(paintScript).observe(scriptEl);
for (const ev of ["click", "keyup", "focus"]) scriptEl.addEventListener(ev, () => { scriptEl.dataset.touched = "1"; markCurrent(); });
sceneModel.onchange = () => {
  const m = currentModel();
  document.getElementById("scene-model-note").textContent = m?.note || "";
  for (const l of lines) if (l.state === "done" && l.model !== m?.id) { l.state = "stale"; paintLine(l); }
  paintSummary();
  renderRoles();
};
sceneGo.onclick = generateScene;
document.getElementById("scene-play").onclick = playAll;
document.getElementById("scene-stop").onclick = stopPlayback;
document.getElementById("scene-download").onclick = downloadScene;

// ---------- single-line comparison ----------
const textEl = document.getElementById("text");
const glossEl = document.getElementById("gloss");
textEl.value = PRESETS[0]?.text || SCRIPTS[0]?.lines?.[0]?.text && plainText(SCRIPTS[0].lines[0].text) || "";
const voiceInputs = [];
function addPresets(el, list) { for (const p of list) addPreset(el, p); }
function addPreset(presetsEl, p) {
  const b = document.createElement("button");
  b.className = "chip"; b.textContent = p.label; b.title = p.gloss ? `${p.gloss}\n${p.text}` : p.text;
  b.onclick = () => {
    textEl.value = p.text;
    glossEl.textContent = p.gloss ? "译文：" + p.gloss : "";
    if (p.voice) for (const v of voiceInputs) v.value = p.voice;
    textEl.focus();
  };
  presetsEl.append(b);
}
addPresets(document.getElementById("presets"), PRESETS);
for (const sc of SCRIPTS) {
  const label = Object.assign(document.createElement("label"), { textContent: `${sc.title}台词` });
  const row = Object.assign(document.createElement("div"), { className: "presets" });
  document.getElementById("script-presets").append(label, row);
  addPresets(row, sc.lines.map(asPreset));
}
textEl.addEventListener("input", () => { glossEl.textContent = ""; });

const cards = [];
function buildCard(m, grid) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `<h2><span class="mname"></span><span class="org"></span></h2><div class="tags"></div><p class="note"></p><div class="controls"></div>
    <div class="row"><button class="primary go">生成</button><span class="status"></span></div>
    <div class="results"></div>`;
  card.querySelector(".mname").textContent = m.name;
  card.querySelector(".org").textContent = m.org || "";
  const tags = card.querySelector(".tags");
  for (const t of [m.voices, m.license].filter(Boolean)) { const s = document.createElement("span"); s.className = "tag"; s.textContent = t; tags.append(s); }
  card.querySelector(".note").textContent = m.note || "";

  const controls = card.querySelector(".controls");
  const inputs = {};
  if (can(m, "voice_prompt")) {
    inputs.voice_prompt = Object.assign(document.createElement("input"), { type: "text", placeholder: "例：A young woman, gentle and sweet voice, slightly sad" });
    controls.append(field("声音描述（可选）", inputs.voice_prompt));
    voiceInputs.push(inputs.voice_prompt);
  }
  if (can(m, "ref_audio")) {
    inputs.ref_audio = filePicker();
    controls.append(field("参考音频（可选，5–15 秒人声）", inputs.ref_audio));
  }
  if (can(m, "ref_text")) {
    inputs.ref_text = Object.assign(document.createElement("input"), { type: "text", placeholder: "参考音频里说的原话" });
    controls.append(field("参考音频原文（可选，提高相似度）", inputs.ref_text));
  }
  if (can(m, "speaker")) {
    inputs.speaker = document.createElement("select");
    for (let i = 0; i < (m.speakers || 1); i++) inputs.speaker.append(new Option(`说话人 ${i}`, i));
    controls.append(field("说话人", inputs.speaker));
  }
  if (can(m, "seed")) {
    inputs.seed = Object.assign(document.createElement("input"), { type: "number", placeholder: "随机" });
    controls.append(field("随机种子", inputs.seed));
  }

  const btn = card.querySelector(".go");
  const status = card.querySelector(".status");
  const results = card.querySelector(".results");
  let firstUse = m.loaded === false;

  async function run() {
    const text = textEl.value.trim();
    if (!text) { setStatus(status, "err", "请先输入文本"); return; }
    const refFile = inputs.ref_audio?.file();
    btn.disabled = true;
    setStatus(status, "busy", "排队中");
    try {
      const body = await tts({
        model: m.id, text,
        voice_prompt: inputs.voice_prompt?.value, ref_text: inputs.ref_text?.value,
        speaker: inputs.speaker?.value, seed: inputs.seed?.value, ref_audio: refFile,
      }, { onState: st => setStatus(status, "busy", jobText(st, firstUse ? "加载模型并生成…" : "生成中…")) });
      firstUse = false;
      const took = body.seconds !== undefined ? `，耗时 ${body.seconds}s${body.first_load ? "（含加载）" : ""}` : "";
      setStatus(status, "ok", `完成：音频 ${body.duration}s${took}`);
      const item = document.createElement("div");
      item.className = "result";
      const desc = [
        inputs.speaker ? `说话人 ${inputs.speaker.value}` : "",
        inputs.voice_prompt?.value ? `描述：${inputs.voice_prompt.value}` : "",
        refFile ? `参考：${refFile.name}` : "",
        inputs.seed?.value ? `种子 ${inputs.seed.value}` : "",
      ].filter(Boolean).join(" · ");
      const meta = Object.assign(document.createElement("div"), { className: "meta" });
      item.append(audioPlayer(body.url), meta);
      meta.textContent = `${new Date().toLocaleTimeString()} · ${text}${desc ? " · " + desc : ""}`;
      meta.title = meta.textContent;
      results.prepend(item);
    } catch (e) {
      setStatus(status, "err", "失败：" + e.message);
    } finally {
      btn.disabled = false;
    }
  }
  btn.onclick = run;
  if (m.missing) {
    btn.disabled = true;
    setStatus(status, "busy", m.missing + "，就绪后刷新");
  }
  grid.append(card);
  return { run: m.missing ? async () => {} : run };
}

listModels().then(list => {
  models = list;
  const multi = list.filter(m => voiceMode(m) !== "single"), single = list.filter(m => voiceMode(m) === "single");
  for (const m of multi) cards.push(buildCard(m, document.getElementById("grid-multi")));
  for (const m of single) cards.push(buildCard(m, document.getElementById("grid-single")));
  const groups = [["支持多角色", multi], ["只有一种声音", single]].filter(([, ms]) => ms.length).map(([label, ms]) => {
    const g = Object.assign(document.createElement("optgroup"), { label });
    for (const m of ms) g.append(Object.assign(new Option(m.name + (m.missing ? "（未就绪）" : ""), m.id), { disabled: !!m.missing }));
    return g;
  });
  sceneModel.append(...groups);
  // The project's default model when it is ready, else the first ready model that gives roles their own voices.
  const ready = list.filter(m => !m.missing);
  const pick = ready.find(m => m.id === DATA.default_model) || ready.find(m => voiceMode(m) !== "single") || ready[0];
  if (pick) sceneModel.value = pick.id;
  sceneModel.onchange();
  renderLines();
}).catch(e => {
  setStatus(sceneStatus, "err", "读取模型列表失败：" + e.message);
  document.getElementById("grid-multi").textContent = "读取模型列表失败：" + e.message;
});

document.getElementById("all").onclick = async (ev) => {
  ev.target.disabled = true;
  // Every model goes into the queue at once; the backend runs them one by one.
  try { await Promise.all(cards.map(c => c.run())); } finally { ev.target.disabled = false; }
};

renderScene();
