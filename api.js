// The page's calls to its backend. Every path is relative to the page, so the page also works
// under a path prefix. README.md, section "后端接口", describes each endpoint.

async function fail(r) {
  const body = await r.json().catch(() => ({ detail: r.statusText }));
  return new Error(typeof body.detail === "string" ? body.detail : r.statusText);
}

export async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw await fail(r);
  return r.json();
}

// The models, each { id, name, controls, ... }.
export function listModels() { return getJSON("api/models"); }

// Generation runs as jobs: the backend queues each one and generates them in order of priority,
// so the page never waits on a request. tts() returns a promise of the result; one poller asks
// for all open jobs together.
export const PRIORITY = { user: 20, anchor: 10, scene: 0 };  // a scene's lines also subtract their index
const watching = new Map();  // job id -> { resolve, reject, onState }
let pollTimer = null;

export async function tts(fields, { priority = PRIORITY.user, onState, onId } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") fd.append(k, v);
  fd.append("priority", priority);
  const r = await fetch("api/jobs", { method: "POST", body: fd });
  if (!r.ok) throw await fail(r);
  const body = await r.json();
  onId?.(body.id);
  onState?.(body);
  return new Promise((resolve, reject) => { watching.set(body.id, { resolve, reject, onState }); schedulePoll(); });
}

function schedulePoll() { if (!pollTimer && watching.size) pollTimer = setTimeout(pollJobs, 400); }
async function pollJobs() {
  pollTimer = null;
  try {
    const all = await getJSON(`api/jobs?ids=${[...watching.keys()].join(",")}`);
    for (const [id, w] of watching) {
      const st = all[id];
      if (!st) { watching.delete(id); w.reject(new Error("后端没有这个任务了，可能重启过，请重新生成")); }
      else if (st.state === "done") { watching.delete(id); w.resolve(st.result); }
      else if (st.state === "error" || st.state === "cancelled") {
        watching.delete(id);
        w.reject(Object.assign(new Error(st.error || st.state), { cancelled: st.state === "cancelled" }));
      } else w.onState?.(st);
    }
  } catch {}  // the backend did not answer: ask again next round
  schedulePoll();
}

export function cancelJob(id) { return fetch(`api/jobs/${id}`, { method: "DELETE" }).catch(() => {}); }

// "排队中" or "生成中…" for a job status from the backend.
export function jobText(st, running = "生成中…") {
  return st.state === "running" ? running : st.ahead ? `排队中，前面 ${st.ahead} 个` : "排队中";
}

// Mix generated lines into one file: { url, duration, starts }.
export async function concat(body) {
  const r = await fetch("api/concat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw await fail(r);
  return r.json();
}
