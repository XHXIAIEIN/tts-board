"""A stand-in backend for tts-board: it serves the page and answers its API with synthetic speech.

Run:  python server/mock_server.py [port] [--data DIR]      (Python 3.8+, standard library only)
Then open http://127.0.0.1:8765/. --data serves another project's data folder, such as a plugin's,
at data/ instead of the repo's example.

The "speech" is a buzzing vowel per syllable at a pitch per voice, so the queue, the role voices,
cancelling and the scene mix can be tried without a TTS model. It honours level_db, pace, pitch_st,
beats, gaps and breaths, and ignores instructions, the line-end tail, spaces and jitter. A real backend implements the
same endpoints; README.md describes them.
"""

import argparse
import array
import hashlib
import heapq
import itertools
import json
import math
import random
import re
import sys
import threading
import time
import uuid
import wave
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

HERE = Path(__file__).resolve().parent
OUT = HERE / "outputs"  # generated audio
# URL prefix -> folder served there: the generated audio, the project's data, and the page at the root
MOUNTS = [("outputs/", OUT), ("data/", HERE.parent / "data"), ("", HERE.parent / "web")]
(OUT / "refs").mkdir(parents=True, exist_ok=True)
SR = 16000
LOAD_SECONDS = 1.0  # the first job of a model waits this long, like loading weights
JOB_SECONDS = 0.4   # every job waits this long, so the queue can be watched

SPEAKER_F0 = [215, 118, 250, 96]
MODELS = [
    {"id": "mock-design", "name": "模拟 · 声音描述", "org": "tts-board", "voices": "描述 / 克隆", "license": "MIT",
     "note": "描述里的性别词决定样本音高，每句克隆样本的音高。", "controls": ["voice_prompt", "ref_audio", "ref_text", "seed"]},
    {"id": "mock-speakers", "name": "模拟 · 多说话人", "org": "tts-board", "voices": f"{len(SPEAKER_F0)} 个说话人",
     "license": "MIT", "note": "每个角色固定一个说话人。", "controls": ["speaker", "seed"], "speakers": len(SPEAKER_F0)},
    {"id": "mock-single", "name": "模拟 · 单一声音", "org": "tts-board", "voices": "1 个声音", "license": "MIT",
     "note": "所有角色同一个声音。", "controls": []},
]
VOICES = {}  # output file -> median pitch, so a clone keeps the pitch of its reference


# ---------- synthesis ----------

VOWELS = [(730, 1090), (270, 2290), (570, 840), (300, 870), (530, 1840)]  # F1, F2 of a i o u e
PAUSES = [(re.compile(r"\.\.\.|…+|—"), 0.4), (re.compile(r"[.!?。！？]"), 0.3), (re.compile(r"[,;:，；：、]"), 0.15)]
TOKEN = re.compile(r"\.\.\.|…+|—|[.!?。！？,;:，；：、]|\s+|[^\s.!?。！？,;:，；：、…—]+")


def events(text):
    """The text as a list of ("syl", n) and ("pause", seconds): one syllable per vowel group of a
    Latin word and per character of Indic, Southeast Asian and CJK text; any other word counts as one."""
    out = []
    for tok in TOKEN.findall(text):
        if tok.isspace():
            continue
        pause = next((s for p, s in PAUSES if p.fullmatch(tok)), None)
        if pause is not None:
            out.append(("pause", pause))
            continue
        latin = re.sub(r"[^A-Za-z]", "", tok)
        n = len(re.findall(r"[aeiouyAEIOUY]+", latin)) or (1 if latin else 0)
        n += sum(1 for c in tok if ord(c) > 0x2E7F or (0x0900 <= ord(c) < 0x2000))
        out.append(("syl", max(n, 1)))
    return out


def speak(text, f0, pace, depth):
    """Float samples of one stretch of text; the pitch falls by `depth` (a fraction of f0) over it."""
    evs = events(text)
    total = sum(n for kind, n in evs if kind == "syl") or 1
    rising = text.rstrip().endswith(("?", "？"))
    samples, k = [], 0
    for kind, n in evs:
        if kind == "pause":
            samples.extend([0.0] * int(n * SR / pace))
            continue
        for _ in range(n):
            pos = k / max(total - 1, 1)
            f = f0 * (1 + depth / 2 - depth * pos) * (1.18 if rising and k >= total - 2 else 1.0)
            samples.extend(vowel(f, VOWELS[k % len(VOWELS)], random.uniform(0.15, 0.22) / pace))
            k += 1
    return samples


def vowel(f0, formants, dur):
    """A sung vowel: harmonics of f0 weighted by two formant peaks, under a smooth envelope."""
    f1, f2 = formants
    count = max(1, min(14, int(3800 / f0)))
    amps = [math.exp(-((h * f0 - f1) / 160) ** 2) + 0.6 * math.exp(-((h * f0 - f2) / 220) ** 2) + 0.12 / h
            for h in range(1, count + 1)]
    n = int(dur * SR)
    step = 2 * math.pi * f0 / SR
    out = []
    for j in range(n):
        env = math.sin(math.pi * j / n) ** 0.6
        ph = step * j
        out.append(env * (sum(a * math.sin(h * ph) for h, a in enumerate(amps, 1)) + random.uniform(-0.03, 0.03)))
    out.extend([0.0] * int(0.03 * SR))
    return out


def level(samples, level_db):
    """Scale to -20 dBFS RMS plus level_db, with peaks held under -1 dBFS."""
    voiced = [s for s in samples if s] or [1.0]
    rms = math.sqrt(sum(s * s for s in voiced) / len(voiced))
    gain = 10 ** ((-20 + level_db) / 20) / (rms or 1)
    peak = max((abs(s) for s in samples), default=0) * gain
    if peak > 0.89:
        gain *= 0.89 / peak
    return [s * gain for s in samples]


def write_wav(path, samples):
    pcm = array.array("h", (max(-32767, min(32767, int(s * 32767))) for s in samples))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError(f"{path.name} 不是 16 位单声道 WAV")
        pcm = array.array("h")
        pcm.frombytes(w.readframes(w.getnframes()))
    return [s / 32767 for s in pcm]


def hashed(key, lo, hi):
    return lo + int(hashlib.sha1(str(key).encode()).hexdigest(), 16) % (hi - lo)


def voice_f0(p):
    """The pitch of the voice a job asks for."""
    model = p["model"]
    if model == "mock-single":
        return 150
    if model == "mock-speakers":
        return SPEAKER_F0[p["speaker"] % len(SPEAKER_F0)]
    if p["ref_file"]:
        return VOICES.get(p["ref_file"]) or hashed(p["ref_file"], 100, 240)
    prompt = p["voice_prompt"].lower()
    base = 205 if re.search(r"\b(woman|female|girl|lady|mother)\b|女|妈|姐", prompt) else \
        115 if re.search(r"\b(man|male|boy|guy|father)\b|男|爸|哥", prompt) else 160
    return base + (p["seed"] % 51 - 25 if p["seed"] is not None else 0)


def generate(p):
    """Synthesize one job and save it to outputs/; return the job's result."""
    f0 = voice_f0(p) * 2 ** (p["pitch_st"] / 12)
    depth = random.uniform(0.06, 0.3)  # each draw speaks a little flatter or livelier
    if p["beats"]:
        samples = []
        for b in p["beats"]:
            samples += speak(str(b.get("text", "")), f0, p["pace"], depth)
            samples += [0.0] * int(float(b.get("gap_after", 0) or 0) * SR)
    else:
        samples = speak(p["text"], f0, p["pace"], depth)
    samples = level(samples, p["level_db"])
    name = f"{p['model']}__{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}.wav"
    write_wav(OUT / name, samples)
    VOICES[name] = round(f0, 1)
    return {"url": f"outputs/{name}", "file": name, "ref_saved": p["ref_saved"], "f0": round(f0, 1),
            "f0_range": round(12 * math.log2((1 + depth / 2) / (1 - depth / 2)), 2),
            "duration": round(len(samples) / SR, 2), "sample_rate": SR}


def breath(seconds, gain):
    """Low-passed noise under a rise-and-fall envelope."""
    n, y, out = int(seconds * SR), 0.0, []
    for j in range(n):
        y += 0.15 * (random.uniform(-1, 1) - y)
        out.append(y * gain * math.sin(math.pi * j / n))
    return out


def concat(req):
    """Mix lines on one timeline: gaps[i] seconds after the previous line ends (negative overlaps),
    with an inhale before and an exhale after each line. Returns the result body."""
    files = req.get("files") or []
    if not files:
        raise ValueError("没有可拼接的音频")
    pick = lambda key, i, default: (req.get(key) or [])[i] if i < len(req.get(key) or []) else default
    pad = 0.3
    placed, cursor, starts = [], pad, []
    for i, rel in enumerate(files):
        clip = read_wav(output_path(rel))
        inhale = min(max(pick("inhales", i, 0) or 0, 0), 0.8)
        exhale = min(max(pick("exhales", i, 0) or 0, 0), 1.2)
        gap = 0 if i == 0 else min(max(pick("gaps", i, req.get("gap", 0.35)) or 0, -1), 5)
        start = max(cursor + gap, inhale) if i else cursor + inhale
        if inhale:
            placed.append((start - inhale, breath(inhale, 0.03)))
        placed.append((start, clip))
        end = start + len(clip) / SR
        if exhale:
            placed.append((end, breath(exhale, 0.025)))
        starts.append(round(start - inhale, 3))
        cursor = end
    length = int((max(t + len(s) / SR for t, s in placed) + pad) * SR)
    mix = [0.0] * length
    for t, s in placed:
        at = int(t * SR)
        for j, v in enumerate(s):
            mix[at + j] += v
    name = f"scene__{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}.wav"
    write_wav(OUT / name, mix)
    return {"url": f"outputs/{name}", "duration": round(length / SR, 2), "starts": starts}


def output_path(rel):
    path = (OUT / rel).resolve()
    if OUT.resolve() not in path.parents or not path.is_file():
        raise ValueError(f"找不到音频 {rel}")
    return path


# ---------- jobs ----------

class Jobs:
    """A priority queue of generation jobs run by one worker thread, highest priority first."""

    def __init__(self):
        self.cv = threading.Condition()
        self.jobs, self.heap, self.seq = {}, [], itertools.count()
        self.running, self.loaded = None, set()
        threading.Thread(target=self.work, daemon=True).start()

    def submit(self, params, priority):
        with self.cv:
            job_id = uuid.uuid4().hex[:12]
            key = (-priority, next(self.seq))
            self.jobs[job_id] = {"state": "queued", "params": params, "key": key}
            heapq.heappush(self.heap, (key, job_id))
            self.cv.notify()
        return job_id

    def status(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return None
        out = {"id": job_id, "state": job["state"]}
        if job["state"] == "queued":
            with self.cv:
                out["ahead"] = sum(1 for k, i in self.heap if k < job["key"] and self.jobs[i]["state"] == "queued") \
                    + (1 if self.running else 0)
        for k in ("result", "error"):
            if k in job:
                out[k] = job[k]
        return out

    def cancel(self, job_id):
        with self.cv:
            job = self.jobs.get(job_id)
            if job and job["state"] == "queued":
                job.update(state="cancelled", error="已取消")
                return True
        return False

    def work(self):
        while True:
            with self.cv:
                while not self.heap:
                    self.cv.wait()
                _, job_id = heapq.heappop(self.heap)
                job = self.jobs[job_id]
                if job["state"] != "queued":
                    continue
                job["state"], self.running = "running", job_id
            started = time.time()
            p = job["params"]
            try:
                first = p["model"] not in self.loaded
                time.sleep(JOB_SECONDS + (LOAD_SECONDS if first else 0))
                self.loaded.add(p["model"])
                result = generate(p)
                result.update(seconds=round(time.time() - started, 2), first_load=first)
                job.update(state="done", result=result)
            except Exception as e:  # report any failure to the page instead of stopping the worker
                job.update(state="error", error=str(e))
            with self.cv:
                self.running = None


jobs = Jobs()


def job_params(fields, files):
    """Check one job's form fields; raises ValueError with a message for the page."""
    model = fields.get("model", "")
    if model not in {m["id"] for m in MODELS}:
        raise ValueError(f"没有这个模型：{model}")
    text = fields.get("text", "").strip()
    if not text:
        raise ValueError("文本为空")
    ref_file, ref_saved = fields.get("ref_file", "").strip(), None
    if "ref_audio" in files:
        filename, data = files["ref_audio"]
        ref_saved = f"refs/{uuid.uuid4().hex[:8]}{Path(filename).suffix or '.wav'}"
        (OUT / ref_saved).write_bytes(data)
        VOICES[ref_saved] = hashed(hashlib.sha1(data).hexdigest(), 100, 240)
        ref_file = ref_saved
    elif ref_file:
        output_path(ref_file)
    num = lambda k, d: float(fields[k]) if fields.get(k, "").strip() else d
    beats = json.loads(fields["beats"]) if fields.get("beats", "").strip() else []
    return {"model": model, "text": text, "speaker": int(num("speaker", 0)), "voice_prompt": fields.get("voice_prompt", ""),
            "seed": int(num("seed", 0)) if fields.get("seed", "").strip() else None, "ref_file": ref_file,
            "ref_saved": ref_saved, "level_db": min(max(num("level_db", 0), -20), 10),
            "pace": min(max(num("pace", 1), 0.5), 2), "pitch_st": min(max(num("pitch_st", 0), -6), 6), "beats": beats}


# ---------- HTTP ----------

TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json; charset=utf-8", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
         ".webm": "audio/webm", ".flac": "audio/flac", ".m4a": "audio/mp4", ".svg": "image/svg+xml", ".png": "image/png"}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def fail(self, status, message):
        self.send_json({"detail": message}, status)

    def do_GET(self, head=False):
        url = urlsplit(self.path)
        if url.path == "/api/models":
            return self.send_json([{**m, "loaded": m["id"] in jobs.loaded} for m in MODELS])
        if url.path == "/api/jobs":
            ids = filter(None, parse_qs(url.query).get("ids", [""])[0].split(","))
            return self.send_json({i: st for i in ids if (st := jobs.status(i))})
        self.static(url.path, head)

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_POST(self):
        path = urlsplit(self.path).path
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            if path == "/api/jobs":
                fields, files = parse_form(self.headers.get("Content-Type", ""), body)
                priority = min(max(float(fields.get("priority") or 0), -1000), 1000)
                return self.send_json(jobs.status(jobs.submit(job_params(fields, files), priority)))
            if path == "/api/concat":
                return self.send_json(concat(json.loads(body or b"{}")))
        except (ValueError, KeyError) as e:
            return self.fail(400, str(e))
        self.fail(404, "没有这个接口")

    def do_DELETE(self):
        m = re.fullmatch(r"/api/jobs/(\w+)", urlsplit(self.path).path)
        if not m:
            return self.fail(404, "没有这个接口")
        self.send_json({"cancelled": jobs.cancel(m.group(1))})

    def static(self, path, head):
        """A file of one of the MOUNTS, nothing hidden. Supports one byte range, so audio can seek."""
        rel = unquote(path).lstrip("/") or "index.html"
        prefix, base = next((p, b) for p, b in MOUNTS if rel.startswith(p))
        target = (base / rel[len(prefix):]).resolve()
        if (base not in target.parents or not target.is_file() or target.suffix not in TYPES
                or any(part.startswith(".") for part in target.relative_to(base).parts)):
            return self.fail(404, "没有这个文件")
        generated = base == OUT
        data = target.read_bytes()
        status, lo, hi = 200, 0, len(data) - 1
        rng = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if rng and data:
            if rng.group(1):
                lo, hi = int(rng.group(1)), min(int(rng.group(2) or hi), hi)
            else:
                lo = max(0, len(data) - int(rng.group(2)))
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", TYPES[target.suffix])
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(hi - lo + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {lo}-{hi}/{len(data)}")
        if not generated:
            self.send_header("Cache-Control", "no-cache")  # the page and data change while the server runs
        self.end_headers()
        if not head:
            self.wfile.write(data[lo:hi + 1])

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/jobs?"):  # the page polls this several times a second
            sys.stderr.write(f"{self.log_date_time_string()} {fmt % args}\n")


def parse_form(content_type, body):
    """Fields and files of a multipart/form-data or urlencoded body."""
    if content_type.startswith("application/x-www-form-urlencoded"):
        return {k: v[0] for k, v in parse_qs(body.decode()).items()}, {}
    msg = BytesParser(policy=policy.HTTP).parsebytes(b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body)
    fields, files = {}, {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        data = part.get_payload(decode=True) or b""
        if part.get_filename() is not None:
            if data:
                files[name] = (part.get_filename(), data)
        else:
            fields[name] = data.decode("utf-8")
    return fields, files


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="tts-board mock backend")
    ap.add_argument("port", nargs="?", type=int, default=8765)
    ap.add_argument("--data", type=Path, help="project data folder served at data/ (default: the repo's data/)")
    args = ap.parse_args()
    if args.data:
        data = args.data.resolve()
        if not (data / "project.json").is_file():
            sys.exit(f"{data} 里没有 project.json")
        MOUNTS[1] = ("data/", data)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"tts-board mock: http://127.0.0.1:{args.port}/  data: {MOUNTS[1][1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
