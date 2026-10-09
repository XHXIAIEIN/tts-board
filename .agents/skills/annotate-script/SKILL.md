---
name: annotate-script
description: Fill the performance parameters of a Khmer TTS script (tone, context notes, loudness, pace, pitch, pause marks, tail, space) from its plot, roles and scenes. Use when asked to annotate, direct, dub or add a script or scene in data/scripts/, or when a line sounds flat, too even or in the wrong emotion. Not for dubbing a video episode in episodes/ (that is dub-episode).
---

# Annotate a script

A script file in `data/scripts/` holds roles, lines and scenes. `plan.js` in the tts-board page (`web/` of tts-board, two folders up) turns its
settings into one plan per line, and the backend renders only from that plan. Your job is to read the plot and set each value
at the level where it belongs, so that the scene sounds performed, not read.

## Where each setting lives

The plan merges these levels in order: `defaults` in `data/project.json`, the tone preset, the scene, the role, the line, and
the scene's entry for that line. `level_db` and `pitch_st` add up, `pace` multiplies, notes join the tone's instruction, and
`gap_before`, `inhale`, `exhale` and `tail` are replaced by the last level that sets them; `gap_before` starts at the scene's `gap`.

| Setting | Meaning | Put it on |
|---------|---------|-----------|
| `tone` | A tone word from `tones` in `data/project.json`; it brings an English instruction and often a `level_db` | the scene entry |
| `note` | The line's context in English, appended to the tone's instruction: whom it is said to, what the speaker wants, how the feeling moves within the line | every line: the scene entry, or the line when every scene that uses it has the same context |
| `level_db` | Loudness offset from −20 LUFS, −10..8 | a role that is always loud or quiet; a line that breaks its tone's level |
| `pace` | Tempo factor after generation, 0.7..1.4 | a scene with a slow or rushed mood; a role who talks fast |
| `pitch_st` | Pitch shift in semitones after generation, −3..3 | rarely; it changes the voice more than the emotion |
| `tail` | Factor by which the end of each beat (or of a line without marks) is slowed, 1..2; `defaults` sets the usual one | a line or scene entry whose end differs: 1.1–1.2 for a clipped command or a sneer, 1.6–1.8 for a line that trails off |
| `gap_before` | Time from the previous line's end to this line's start, −1..3 s; negative overlaps the two | the scene entry: negative or near 0 for a quick or overlapping reply, long before a reveal or a turn |
| `inhale`, `exhale` | Seconds of synthesized breath before and after the line, 0..0.8 and 0..1.2, on the line's own track | a tone or role that breathes audibly (intimate, tired, crying); a scene entry for one moment |
| `jitter` | Random drift of level, gap, pace, pitch and breath (Construct 3 Sine parameters, see README "Mixing a scene") | `defaults` for all scenes; a role that is unsteady (nervous, drunk, crying) gets larger magnitudes; a scene that must stay exact gets smaller ones |
| `gap` | The scene's ordinary pause between lines | the scene |
| `room` | Space of the line in the downloaded scene: a key of `rooms` in `data/project.json`, or `""` for dry. Lines without one use the scene's space | the script or the scene; a scene entry whose line happens somewhere else, such as a voice from the next room or over the phone |
| `voice`, `personality` | English description that makes the role's anchor voice | the role |

A line's own `tone` and `note` are its default; a scene entry overrides them, so the same line can be played differently in
two scenes.

## What works with this model

These come from listening tests on VoxCPM2 with anchor cloning. Follow them unless a new test shows otherwise.

- The anchor fixes most of the prosody. A tone preset carries the emotion and the voice quality, and the line's
  context note moves its speed, pitch and range. By ear, an emotion-only preset with a context note carried more
  emotion than a preset with speed and pause words. With notes, the scenes' median pitch range rose from 5.05 to
  5.5 st (`../../../tts-board-out/khmer/.tmp/line-delivery/results/final.txt`).
- Give every line a note that names the listener, what the speaker wants and how the feeling moves within the line.
  Two examples, for different points: "to the customer, polite but firm about the price, then proud of the fresh
  meat she bought this morning" shows a feeling that changes halfway; "whispered at her ear, asking her to stay the
  night, a breath before the request" shows where the weight falls. When a tone word is too weak, write a stronger
  note instead of inventing a new tone word.
- Put a pause mark `<#seconds#>` in `text` where an actor would pause: before a hard word, after a first short
  sentence, between a no and its reason. The mark splits the line into beats, which the backend generates as a chain,
  so the emotion carries across the pause and the pause lasts exactly that long. Real Khmer pauses run 0.18/0.38/0.66 s
  (p25/p50/p75, `../../../tts-board-out/khmer/.tmp/khmer-ref/results/compare.txt`); most marks inside a line fall at 0.25–0.5 s, and 0.6 s or more
  is a dramatic stop. A line that is one breath gets no mark. A real phrase lasts about 1.9 s (median), so a 4 s
  line takes one or two marks.
- A beat must be a phrase of at least six characters, because single words generate unreliably. If a mark would
  leave a shorter piece, such as the scoff ហឹ or the "then" ចឹង, put no mark there. Join the piece to its neighbour
  with `...` for a hitch, or with a space for a light break.
- `...` does not give a dependable pause: the same line came out with none, 0.8–0.9 s or 2.1 s. Keep it for a line
  that trails off, and for a hitch inside a beat. `!` and `?` shape the line's melody and stay.
- Write every detail in the line's `note`, including how the feeling moves from one beat to the next. Later beats
  continue the first without an instruction, so `［…］` in `text` adds nothing, and the data check rejects it.
- `tail` lengthens the end of each beat, as speakers linger before a pause. Lower it for a clipped command or a
  sneer, and raise it for a line that fades out.
- Gaps between lines carry much of the drama: an interruption gets −0.3–0.1 s, a reply 0.1–0.4 s, a silence before a reveal or
  a decision 0.8–1.5 s. Long gaps everywhere sound mechanical; the 深夜 scene uses short, overlapping joins.
- The model does not breathe on request. Breath comes from `inhale` and `exhale`, which the scene mix synthesizes.
- `pace` and `pitch_st` are applied after generation with rubberband. They are not yet judged by ear; keep them at neutral
  unless the user asks or a test supports them.
- A voice description that names a gender gets redrawn until the anchor's pitch fits that gender, so name the gender in each
  role's `voice`.

## Steps

1. Read the plot and list for each line: who speaks, to whom, what they want, and what changes in the scene at this line.
2. Pick a known tone word for each line, and write its context `note`. If no word fits and the feeling will recur, add
   a tone preset to `tones` with an English `instruction` that names the emotion and the voice quality only.
3. Add pause marks `<#seconds#>` to `text` where an actor would pause, and set `tail` where the line's end differs
   from the default. Do not change the words.
4. Set `gap_before` on the scene entries where the timing matters. Leave the rest to the scene's `gap`.
5. Run `python scripts/check_scripts.py` and fix every problem it prints.
6. Open the page (http://127.0.0.1:7861), load the scene, and check the tag row under each script line: hover it to read
   the line's instruction. A later beat shows 接着上一拍的声音，不带指令, because it continues the beat before it without an instruction.

Editing `data/` needs no restart, because the server sends these files with `Cache-Control: no-cache`. Do not restart or
edit `backend/` for an annotation; the user may be generating at the same time.

## Text form in the page

In the page's script box the first row holds the scene's settings, and each script line is a block of rows:

```
[场景，room=室内，gap=0.35，jitter=1，seed=1]

[惊慌，bursting into the room，gap_before=0.2，inhale=0.3]
管家：老板！不好了！……
លោកប្រធាន! មិនល្អហើយ! ...
```

The direction row holds the tone word first, then English notes and `key=value` params, separated by a full-width comma
`，`; an ASCII comma stays inside a note. Then come `role：Chinese` and the Khmer text. A line without Chinese is
`role：Khmer text`. A blank row separates lines.
