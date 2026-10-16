# Addita

Addita is an MCP server that runs an [Ollaya](https://github.com/ollaya-dev/ollaya) decision model in a loop with an Ollama LLM as its teacher, and keeps a searchable log of every transmission in [Lume](https://github.com/DeepBlueDynamics/lume).

On every call:

0. **Lume supplies context.** It searches the log for related recent traffic (same callsigns, same words, last 24 h) and adds it to the state.
1. **Ollaya answers first** (the student). This is fast and local, and it always runs.
2. **If Ollama is online, it answers the same typed questions** (the teacher). It gets a JSON schema so it can only pick valid labels.
3. **Both answers are saved.** That pair is a training row for the decision model.
4. **The teacher's answer is returned** while Ollama is up. When Ollama is down you get Ollaya's answer, and the row waits for `training_backfill`.
5. **Deterministic guards override both.** MAYDAY → `priority: distress`, `action: alert_operator`. Guards read only the new transmission, never the context, so an old MAYDAY in the log can't re-trigger.
6. **The decision is written to Lume.** It becomes one Markdown file and is indexed incrementally a few seconds later.

```
transcript ─► Lume search ─► context ─┬─► Ollaya (laya)  ─► student answer ─┐
                                      └─► Ollama (qwen3) ─► teacher answer ─┼─► guards ─► answer
                                                                            ├─► decisions.jsonl / teacher.jsonl
                                                                            └─► Lume doc ─► lume index
            you, via comms_label ─► labels.jsonl + Lume doc rewritten
```

## When Ollama is offline

Lume doesn't need Ollama for anything Addita uses. Keyword search (BM25), frontmatter filters and the callsign graph run with no model, and optional dense vectors come from Shivvr, not Ollama. Addita never passes Lume's `-o` (Ollama entity extraction) flag. So with Ollama down:

| | Ollama online | Ollama offline |
|---|---|---|
| Answer comes from | Ollama (teacher) | Ollaya (student) |
| Context from Lume | yes | **yes** |
| Logged to Lume | yes, `teacher: answered` | **yes**, `teacher: pending` |
| `comms_search` | works | **works** |
| Training row | complete pair | student half; `training_backfill` adds the teacher later |

When Ollama comes back, `training_backfill` answers the pending rows, and each one's Lume document is rewritten to `teacher: answered` with the teacher's reasons. `comms_search "teacher:pending"` shows what's still waiting. Lume's own `lume answer` / `lume agent` / Ask tab do need a model; they're separate from Addita.

Over time the student's agreement with the teacher (and with your corrections) tells you when Ollaya alone is good enough, so Ollama can be switched off.

## Install (Pi or any box with Node 20+)

```sh
# Ollaya: 64-bit OS with glibc ≥ 2.38 (Pi OS Trixie / Debian 13, or Ubuntu 24.04+)
curl -fsSL https://ollaya.dev/install.sh | sh
ollaya pull laya

# Lume (prebuilt arm64 binary; or: npm install -g @deepbluedynamics/lume)
curl -fsSL https://github.com/DeepBlueDynamics/lume/releases/latest/download/install.sh | sh

# Addita
cd addita
npm install          # also builds dist/
npm test             # optional: end-to-end test against mock backends
```

Ollama can run on the Pi or anywhere else on the network (the 12 GB GPU box is a good spot). Point `OLLAMA_URL` at it. Small encoder models (laya, nli, decima) are the right student on a Pi CPU.

## Hook it up

Claude Code:

```sh
claude mcp add addita \
  -e OLLAMA_URL=http://gpu-box:11434 -e OLLAMA_MODEL=qwen3:8b \
  -- node /home/pi/addita/dist/index.js
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.addita]
command = "node"
args = ["/home/pi/addita/dist/index.js"]
env = { OLLAMA_URL = "http://gpu-box:11434", OLLAMA_MODEL = "qwen3:8b" }
```

## Tools

| Tool | What it does |
|---|---|
| `comms_decide` | Runs the loop above. Takes `state` (string or JSON), optional `context` (e.g. recent traffic from Lume), `preset` or ad-hoc `questions`, and `teacher` (`auto` / `skip` / `require`). Returns `id`, `answers`, `source`, `guards`, both models' answers, and per-question `agreement`. |
| `comms_label` | Correct a past decision by `id`. These are the only gold labels. |
| `comms_search` | Search the radio log in Lume. Lume syntax works: `-term`, `NOT term`, and filters on any logged field (`channel:16`, `priority:distress`, `action:draft_reply`, `teacher:pending`, `labelled:true`, `own_callsign:"Charlie Bravo"`). `since_hours` limits it to recent traffic. Filters alone are a valid query. |
| `lume_sync` | Rewrite every stored decision as a Lume doc and reindex. Use it when you install Lume on a box that already has data, or after editing the callsign dictionary. |
| `training_stats` | Counts, guard hits, and per-question agreement: student vs teacher, and both vs your labels. |
| `training_disagreements` | Unlabelled rows where student and teacher disagree, with the teacher's reasons. Label these first. |
| `training_backfill` | Ollama is back: answer the rows it missed. |
| `training_export` | Writes `train.jsonl` and `eval.jsonl` under `exports/<time>/`. |
| `training_calibrate` | Temperature-scales the student's stored probabilities against labels; can bake the result into a new Ollaya model. |
| `ollama_chat` | Plain pass-through to Ollama `/api/chat`, e.g. to draft a reply. Not logged. |
| `backends_status`, `ollaya_pull`, `presets_show` | Housekeeping. |

A comms call looks like:

```json
{
  "state": {
    "own_callsign": "Charlie Bravo",
    "channel": 16,
    "duration_s": 2.2,
    "transcript": "Charlie Bravo, I need a wind check."
  },
  "context": "12:40 Alpha Tango (Capt. Torwick) hailed Charlie Bravo on 16"
}
```

## The Lume log

Each decision is one file, `lume-docs/<day>/<id>.md`, indexed into its own database (`lume-db`), so it never mixes with your manuals index. A file looks like this:

```markdown
---
id: "3f2a9c1e-…"
epoch: 1792172756
day: "2026-10-16"
own_callsign: "Charlie Bravo"
channel: 16
duration_s: 2.2
source: "student"
teacher: "pending"
labelled: false
priority: "routine"
intent: "hail"
action: "log"
addressed_to_us: true
---
# ch16 17:45:56Z routine

> Charlie Bravo, I need a wind check.

Decision: priority routine, intent hail, action log, addressed_to_us yes. Source: student.
Ollama teacher: pending (offline or skipped at the time).
```

- **Fields.** Every scalar field of the state you pass in (`channel`, `duration_s`, `frequency`, …) and every answer becomes a frontmatter field you can filter and facet on. The files are plain Markdown, so `lume sql`, the Signal K plugin and anything else that reads the index see them too.
- **Callsigns.** `presets/callsigns.csv` is a Lume tag dictionary (`phrase,action`). Callsigns listed there become graph entities with no model, so searching "Alpha Tango" also boosts traffic that co-occurs with Alpha Tango. Add your fleet, then run `lume_sync`.
- **Embeddings.** If Shivvr runs on the Pi, set `LUME_INDEX_ARGS=-s` to add dense vectors.

## Presets

A preset is a JSON file in `presets/` with `questions` (TypeSafe format), an optional `model`, `text_field` (the field guards read), and `guards` (regex → forced answers). `presets/comms.json` asks:

- `addressed_to_us`: yes/no
- `priority`: distress, urgency, safety, routine, chatter or noise
- `intent`: hail, info_request, instruction, report, acknowledgement or other
- `action`: ignore, log, draft_reply or alert_operator
- `transcript_quality`: unusable, partial or clear

Copy it to make more presets.

## The training loop

1. **Run with the teacher on.** Use the stack normally; every transmission becomes a row.
2. **Label the disagreements.** Each day, `training_disagreements` → `comms_label`. A few minutes covers it.
3. **Watch `training_stats`.** When `student_accuracy_vs_human` on a question matches `teacher_accuracy_vs_human`, the student can own that question.
4. **Calibrate.** Run `training_calibrate`, with human labels only by default. It needs about 30 labels per bucket.
   - It returns a multiplier per bucket. To get absolute temperatures, pass the model's current `temperature_by_options` as `base_temperatures`.
   - Add `create_model` to bake the result into a new Ollaya model along with the preset's questions.
5. **Fine-tune if calibration isn't enough.** `training_export` gives you `train.jsonl`, built from human labels first and teacher labels second; the student never labels itself. Fine-tune Laya upstream on it, then package the result into Ollaya. Ollaya has no training code, so this step happens outside it. Score the result only on `eval.jsonl`, which contains real human-labelled transmissions only.

## Things to know

- **The teacher is not the truth.** Distillation caps the student at roughly the teacher's quality, including its mistakes. Your labels are what measure real accuracy, so evaluation uses them alone.
- **The teacher answers blind by default.** It doesn't see the student's answer, so it can't anchor on it. Set `ADDITA_TEACHER_SEES_STUDENT=1` to turn that "correct the student" mode on.
- **Guards are forced answers, not labels.** A guard's output is never written as training data. Keep safety-critical rules in guards rather than trusting either model with them.
- **Nothing here transmits.** `action: draft_reply` means a person reviews the draft and keys the mic.
- **Context is part of the training row.** The state the models saw (context included) is what's stored, so a fine-tuned model learns to use context the same way it gets it at run time.
- **Your data stays local.** Transcripts are stored in plain JSONL under `ADDITA_DATA_DIR`.

## Configuration

| Variable | Default | |
|---|---|---|
| `OLLAYA_URL` | `http://127.0.0.1:11435` | |
| `OLLAYA_API_KEY` | unset | Sent as a Bearer token if set |
| `OLLAYA_MODEL` | `laya` | Used when the preset names no model |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | |
| `OLLAMA_MODEL` | `qwen3:8b` | Teacher model; any model that handles JSON-schema `format` well |
| `OLLAMA_THINK` | unset | `0`/`1`: passes `think` to Ollama when set |
| `OLLAMA_TIMEOUT_MS` | `120000` | |
| `OLLAMA_PROBE_TTL_MS` | `10000` | How long an online/offline check is cached |
| `ADDITA_TEACHER` | `auto` | `auto`, `off` or `always` |
| `ADDITA_TEACHER_SEES_STUDENT` | `0` | |
| `ADDITA_DATA_DIR` | `~/.addita` | `decisions.jsonl`, `teacher.jsonl`, `labels.jsonl`, `exports/` |
| `ADDITA_PRESETS_DIR` | `./presets` | |
| `ADDITA_PRESET` | `comms` | |
| `ADDITA_LUME` | `auto` | `auto` uses Lume if the binary runs; `off` disables it |
| `LUME_BIN` | `lume` | |
| `LUME_DOCS_DIR` | `$ADDITA_DATA_DIR/lume-docs` | Where the Markdown log goes |
| `LUME_DB` | `$ADDITA_DATA_DIR/lume-db` | Dedicated index for the log |
| `LUME_TAG_DICT` | `presets/callsigns.csv` | Callsign dictionary for the graph |
| `LUME_INDEX_ARGS` | unset | Extra `lume index` flags, e.g. `-s` with Shivvr (`-o` is always dropped) |
| `LUME_REINDEX_DEBOUNCE_MS` | `3000` | Writes within this window share one reindex |
| `LUME_CONTEXT_HITS` | `3` | Past transmissions added as context; `0` turns it off |
| `LUME_CONTEXT_HOURS` | `24` | How far back context looks |
