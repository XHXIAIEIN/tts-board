// How a line is performed: its direction row, its beats and its plan.
// Plan layers in order: defaults, tone preset, scene, role, line.
// level_db and pitch_st add up, pace multiplies, instruction parts join.
// gap_before, inhale, exhale, tail and room: the last layer that sets one wins.

export const PARAMS = ["level_db", "pace", "pitch_st", "tail", "gap_before", "inhale", "exhale"];
const REPLACED = ["gap_before", "inhale", "exhale", "tail"];
export const TAG_KEYS = [...PARAMS, "room"];
export const DRY = "干声";       // the room value and label for no space
export const NARRATOR = "旁白";  // the role of a text row without a speaker row
export const SCENE_TAG = "场景"; // the first item of the scene's settings row

// The items of a line's direction "[...]", separated by a full-width comma "，", added to `out`:
// the first plain item is the tone word, key=value items are params, other items are notes.
// room=<space> names a space by its label or key. An ASCII comma stays inside a note, so a note
// can list several cues.
export function parseTag(tag, out = { tone: "", notes: [], params: {} }) {
  for (const raw of (tag || "").split("，")) {
    const item = raw.trim();
    if (!item) continue;
    const kv = item.match(/^([a-z_]+)\s*=\s*(-?[\d.]+)$/);
    const room = item.match(/^room\s*=\s*(\S+)$/);
    if (kv && PARAMS.includes(kv[1])) out.params[kv[1]] = parseFloat(kv[2]);
    else if (room) out.params.room = room[1];
    else if (!out.tone && !out.notes.length) out.tone = item;
    else out.notes.push(item);
  }
  return out;
}

// A line as editor rows, like a screenplay: a direction row "[tone，note，key=value]" (left out
// when empty), "role：gloss", then the text that is read. A line without a gloss is "role：text".
// Lines are separated by a blank row (BLOCK_GAP).
export const BLOCK_GAP = "\n\n";
export const GEN_PARAMS = ["level_db", "pace", "pitch_st", "tail"];  // the params that change the generated audio
export function formatBlock({ role, tone = "", notes = [], params = {}, text, gloss = "" }) {
  const rows = [];
  const tag = formatTag({ tone, notes, params });
  if (tag) rows.push(`[${tag}]`);
  if (gloss) rows.push(`${role}：${gloss}`, text);
  else rows.push(`${role}：${text}`);
  return rows.join("\n");
}
// A direction row: the whole row in [ ] or 【 】; returns its items, or null.
export function directionOf(row) {
  const m = row.trim().match(/^[[【](.*)[\]】]$/);
  return m ? m[1] : null;
}

export function formatTag({ tone = "", notes = [], params = {} }) {
  const items = [tone, ...notes, ...TAG_KEYS.filter(k => params[k] !== undefined).map(k => `${k}=${params[k]}`)];
  return items.filter(Boolean).join("，");
}

// A pause mark splits a line into beats: "<#0.5#>" pauses that many seconds (PAUSE_RANGE),
// " / " pauses beat_gap and " // " long_beat_gap. "［note］" at the start of a beat adds to that
// beat's instruction. A beat's `pause` is the seconds of its own mark, or null for " / " and " // ".
export const PAUSE_RANGE = [0.05, 3];
const PAUSE_MARK = /\s*<#\s*(-?[\d.]+)\s*#>\s*|\s+(\/\/?)\s+/;
export function parseBeats(text) {
  const parts = text.split(PAUSE_MARK);
  const beats = [];
  for (let i = 0; i < parts.length; i += 3) {
    const raw = parts[i] || "";
    const m = raw.trim().match(/^［([^］]*)］\s*(.*)$/);
    const secs = parts[i + 1] !== undefined ? parseFloat(parts[i + 1]) : NaN;
    beats.push({ text: (m ? m[2] : raw).trim(), note: m ? m[1].trim() : "", long: parts[i + 2] === "//",
      pause: Number.isFinite(secs) ? Math.min(Math.max(secs, PAUSE_RANGE[0]), PAUSE_RANGE[1]) : null });
  }
  return beats.filter(b => b.text);
}

// The text as it is read, without beat marks: for display, matching and models without beats.
export function plainText(text) { return parseBeats(text).map(b => b.text).join(" "); }

function join(...parts) { return parts.filter(Boolean).join(", "); }

// The key of a space in `rooms`, from its key or its label; "" for dry, undefined if unknown.
export function roomKey(value, rooms) {
  if (value === undefined || value === null) return undefined;
  if (value === "" || value === DRY || value === "dry") return "";
  if (rooms[value]) return value;
  return Object.keys(rooms).find(k => rooms[k].label === value);
}

// tones: the presets from data/project.json; defaults: its `defaults`; rooms: its `rooms`;
// scene: { gap, pace, room }; role: the role's entry in the script; line: { tone, notes, params, text }.
export function resolve({ line, tones, defaults, rooms = {}, scene = {}, role = {} }) {
  const preset = tones[line.tone] || (line.tone ? { instruction: line.tone } : {});
  const layers = [defaults, preset, { pace: scene.pace }, role, line.params || {}];
  const plan = { level_db: 0, pace: 1, pitch_st: 0, tail: 1, gap_before: scene.gap ?? defaults.gap ?? 0, inhale: 0, exhale: 0,
    room: roomKey(scene.room, rooms) ?? "", ownRoom: false };
  for (const layer of layers) {
    if (layer.level_db !== undefined) plan.level_db += layer.level_db;
    if (layer.pitch_st !== undefined) plan.pitch_st += layer.pitch_st;
    if (layer.pace !== undefined) plan.pace *= layer.pace;
    for (const k of REPLACED) if (layer[k] !== undefined) plan[k] = layer[k];
    if (layer.room !== undefined) {
      const key = roomKey(layer.room, rooms);
      if (key === undefined) plan.badRoom = layer.room;
      else Object.assign(plan, { room: key, ownRoom: true });
    }
  }
  plan.pace = Math.round(plan.pace * 100) / 100;
  plan.instruction = join(preset.instruction, ...(line.notes || []));
  plan.text = plainText(line.text);
  // The backend generates the beats as a chain: the first beat takes the instruction, and each
  // later beat continues the audio of the one before it.
  const beats = parseBeats(line.text);
  plan.beats = beats.length > 1
    ? beats.map((b, i) => ({
        text: b.text,
        instruction: join(plan.instruction, b.note),
        note: b.note,
        gap_after: i < beats.length - 1 ? b.pause ?? (b.long ? defaults.long_beat_gap : defaults.beat_gap) ?? 0 : 0,
      }))
    : null;
  return plan;
}

// The values that differ from a plain line, one tag each; `defaults` gives the usual tail
export function describe(plan, defaults = {}) {
  const sign = v => (v > 0 ? "+" : "") + v;
  const bits = [];
  if (plan.level_db) bits.push(`音量 ${sign(plan.level_db)} dB`);
  if (plan.pace !== 1) bits.push(`语速 ×${plan.pace}`);
  if (plan.pitch_st) bits.push(`音高 ${sign(plan.pitch_st)}`);
  if (plan.tail !== (defaults.tail ?? 1)) bits.push(`尾音 ×${plan.tail}`);
  if (plan.beats) bits.push(`${plan.beats.length} 拍`);
  if (plan.inhale) bits.push(`吸气 ${plan.inhale}s`);
  if (plan.exhale) bits.push(`呼气 ${plan.exhale}s`);
  return bits;
}
