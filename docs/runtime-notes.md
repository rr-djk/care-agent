# Runtime notes (step 1 latency gate)

Measured on Oct 3, 2026, on the team laptop: Intel Core 7 150U, 15 GB RAM, no discrete GPU (CPU inference).
Test input: `tools/smoke/out/p03_crop.png` (706×512), rows "Rendez-vous" to "État des conjonctives", visits 1–3 of specimen patient 1, page 3. Only visit 2 is filled in this specimen.

| Item | Value |
| --- | --- |
| Runtime and version | Ollama 0.35.1 |
| Exact model tag | `gemma4:e4b` (6.6 GB on disk) |
| Image input works | Yes, on both the native API (`/api/chat`, `images`) and the OpenAI-compatible API (`/v1/chat/completions`, `image_url`) |
| Thinking control | Native API: `"think": false` works (0 thinking characters). OpenAI-compatible API: `think` is ignored; use `"reasoning_effort": "none"` |
| JSON-schema output works | Yes, native API `format: <JSON schema>` → valid JSON |
| Logprobs returned | Yes, native API `logprobs: true, top_logprobs: 1` |
| Visual token budget mechanism | Not found in Ollama. Prompt is ~200 tokens per crop whatever we ask, so the image costs a roughly fixed number of tokens. Unverified whether it can be changed; to see small handwriting, make the crop smaller rather than raising a budget |
| RAM | ~10 GB available while the model ran; not measured precisely (the runner process is not named `ollama`, so `RUNTIME_PROC=ollama` only caught the server) |

## Timings (one zone, warm model)

| Request | Prompt tokens / time | Output tokens / time | Total |
| --- | --- | --- | --- |
| `/v1`, default (probe), thinking likely on | n/a | n/a | 141 s cold, ~88 s warm |
| `/v1`, `reasoning_effort: none` | 205 / n/a | 20 / n/a | 25.8 s |
| Native, `think: false`, free JSON | 217 / 22.7 s | 122 / 17.3 s | 40.1 s |
| Native, `think: false`, JSON schema + logprobs, one entry per row × visit (24 entries) | 197 / 21.5 s | 889 / 132.9 s | 154.4 s |

Observations:

- **Reading the image costs ~21–23 s per crop**, roughly constant.
- **Writing costs ~7 output tokens/s.** The verbose schema (row name repeated for every cell, empty cells included) took 889 tokens; that is where most of the time goes.
- **Quality was good when the schema listed every row × visit:** all 8 visit-2 values were read correctly (17/08/2025, 20/07/2025, Oui, 12 SA, 58.8, 104/74, RAS, Normales) and empty cells were marked illegible/empty. With a free JSON format, the model read only one value.
- Logprobs under a JSON schema reflect the unconstrained distribution for structural tokens (the forced `{` had logprob −11.6); only the logprobs of value tokens are meaningful for confidence.

## Decision rule

GO if one zone takes <= ~30 s warm AND a full page (~15 zones) takes <= ~3 minutes.

Otherwise apply the fallback ladder, in order:

1. Fewer/larger crops
2. Visual token budget 560
3. Crop + prompt hash cache
4. Gemma 4 E2B

## Result

**Strict rule: NO-GO.** No configuration with usable quality meets 30 s per zone.

Proposed adjustment (to be validated by the team):

- Use the **native API** with `think: false`, `format` (JSON schema) and `logprobs`.
- Make the output **compact**: the schema already knows the rows and visits, so ask only for the values in a fixed order (no repeated row names, short keys). Estimate: ~100–150 output tokens instead of 889 → ~20 s of writing + ~22 s of reading ≈ **40 s per zone of ~24 cells**.
- At that rate, page 3 (the densest page, ~25 rows × 9 visits) would take several minutes; a full 8-page record roughly 15–25 minutes of CPU time. This is compatible with the design, because analysis already runs asynchronously (`PENDING_AI` queue) and results are cached by crop hash, but it is not interactive.
- Ladder step 2 (budget 560) does not apply: Ollama exposes no visual-token budget.
- Keep Gemma 4 E2B as a fallback to measure if the compact format is still too slow.
