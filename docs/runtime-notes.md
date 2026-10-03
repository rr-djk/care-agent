# Runtime notes (step 1 latency gate)

Fill after running `make smoke` (raw data: `tools/smoke/out/results.json`).

| Item | Value |
| --- | --- |
| Runtime and version | TODO |
| Exact model tag | TODO |
| Image input works (y/n) | TODO |
| JSON-schema output works (y/n) | TODO |
| Logprobs returned (y/n) | TODO |
| Visual token budget mechanism | TODO |
| RAM (RSS before/after, MB) | TODO |

## Timings (one zone)

| Budget | Cold total (s) | Cold TTFT (s) | Warm total (s, median of 3) | Warm TTFT (s) | tokens/s | Valid JSON |
| --- | --- | --- | --- | --- | --- | --- |
| 560 | TODO | TODO | TODO | TODO | TODO | TODO |
| 1120 | TODO | TODO | TODO | TODO | TODO | TODO |

## Decision rule

GO if one zone takes <= ~30 s warm AND a full page (~15 zones) takes <= ~3 minutes.

Otherwise apply the fallback ladder, in order:

1. Fewer/larger crops
2. Visual token budget 560
3. Crop + prompt hash cache
4. Gemma 4 E2B

Decision: TODO
