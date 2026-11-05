# Benchmark: gemma4:26b on Intel Arc 140V / 32 GB shared RAM

Run 2026-11-05. Ollama 0.40.13, Q4_K_M, llamacpp runner, 14%/86% CPU/GPU split.

## Numbers (single handwritten page, 636x900 PNG)

| Metric | Value |
|---|---|
| `load_duration` (cold) | 219.5 s |
| `prompt_eval` | 267 tokens / 44.9 s (~6 tok/s) |
| `eval` (generation) | 57 tokens / 5.4 s (10.5 tok/s) |
| total wall clock | 270.9 s |
| resident | 18 GB |
| free system RAM while loaded | 4.4 GB of 31.5 GB |

## Accuracy

Transcription was **correct** on the algebra sample:
`Q4. Solve for x: 2x^2 - 7x + 3 = 0. Hence find the sum and product of the roots.`

Handwriting understanding is not the problem.

## Conclusion

Generation throughput (10.5 tok/s) is usable. Two things are not:

1. **219 s cold load.** Paid on every first request after idle unload.
2. **18 GB resident.** Leaves 4.4 GB free; the machine thrashes and the UI hangs.
   Keeping it warm to avoid (1) is what causes (2). They cannot both be solved.

gemma4:26b is therefore **not viable as the interactive default on this hardware**.
It remains useful as an explicit, user-triggered "high accuracy, slow" mode.

`gemma3:4b` (3.3 GB, vision-capable) is **already pulled** on this machine - no new
download - and is the sensible interactive local default. Gemini stays as the
opt-in cloud fallback the spec already called for.

---

# Follow-up: the two-stage local pipeline

`gemma3:4b` (vision) + `qwen2.5:14b` (reasoning), both already on disk.

## Measured, warm

| Stage | Time |
|---|---|
| transcription, single pass | 2.5 - 20 s |
| transcription, with verification pass | 35 - 76 s |
| solve (10 steps, 74 typed events) | 164 s, first ink at 19.6 s |
| focused step explanation | 47 - 59 s |

## Three failures found by measuring rather than assuming

1. **Sending `think` to a model that does not advertise it kills the runner.**
   Ollama returns a 500 with a socket error rather than a clean rejection.
   `/api/show` is now queried and optional flags are gated on `capabilities`.

2. **The two models cannot be co-resident on a 16 GB shared GPU.** Individually
   they fit (3.1 GB + 10 GB); together, the vision encoder's image buffers push
   it over and the runner is killed mid-request. Stages are now exclusive: the
   other model is evicted before each stage runs. This costs a reload per stage
   and is why verified transcription takes a minute rather than seconds.
   Set `INKWISE_EXCLUSIVE_MODELS=0` if you have the VRAM to keep both warm.

3. **LaTeX cannot be carried in JSON from these models.** Asked for JSON, the
   model emitted `"\frac"`, which is a *valid* JSON escape (form feed + "rac"),
   so `json.loads` silently corrupted every formula. Switching to a delimited
   plain-text reply fixed the corruption **and** improved accuracy, because the
   model was no longer fighting a schema:

   | | transcription of the calculus sample |
   |---|---|
   | JSON schema | `\frac{x^2 \bullet e^{(3x)}}{}` (corrupt, wrong) |
   | delimited text | `$I = \int x^2 e^{3x} dx$` (correct) |

## Digit accuracy

`num_ctx` 2048 crashes (image tokens overflow); 4096 and 8192 are stable 6/6.
Upscaling the crop made crashes *more* frequent without improving reading, so
crops are sent at native size.

With the verification pass, `4x^2`, `2x^2 - 7x + 3 = 0` and `(8x^4)/(2x^2)` all
transcribe correctly and agree across both readings. When the two readings
disagree, confidence is capped at 0.45 and both are shown to the student.
