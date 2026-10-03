// Ollama native client (docs/runtime-notes.md: `think:false` only works on /api/chat).

export interface TokenLogprob {
  token: string;
  logprob: number;
}

export interface ModelTimings {
  prompt_tokens: number;
  prefill_s: number;
  output_tokens: number;
  gen_s: number;
}

export interface ModelResponse {
  content: string;
  logprobs: TokenLogprob[];
  timings: ModelTimings;
}

export interface ModelRequest {
  prompt: string;
  image: Buffer; // PNG
  format: object; // JSON schema
}

export type ModelFn = (req: ModelRequest) => Promise<ModelResponse>;

export class ModelError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'http' | 'timeout',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface ModelConfig {
  url: string;
  model: string;
  timeoutMs: number;
  fetch: typeof fetch;
}

export const modelConfig = (): ModelConfig => ({
  url: (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, ''),
  model: process.env.MODEL ?? 'gemma4:e4b',
  timeoutMs: 300_000,
  fetch,
});

export function ollamaModel(cfg: ModelConfig = modelConfig()): ModelFn {
  return async ({ prompt, image, format }) => {
    let res: Response;
    let text: string; // the abort signal also covers reading the body
    try {
      res = await cfg.fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(cfg.timeoutMs),
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: prompt, images: [image.toString('base64')] }],
          stream: false,
          think: false,
          format,
          logprobs: true,
          top_logprobs: 1,
          options: { temperature: 0 },
          keep_alive: '30m',
        }),
      });
      text = await res.text();
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') throw new ModelError('timeout', `no answer after ${cfg.timeoutMs / 1000} s`);
      throw new ModelError('unreachable', `cannot reach Ollama at ${cfg.url}: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) throw new ModelError('http', `Ollama answered HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    const body = JSON.parse(text);
    return {
      content: body.message?.content ?? '',
      logprobs: (body.logprobs ?? []).map((l: TokenLogprob) => ({ token: l.token, logprob: l.logprob })),
      timings: {
        prompt_tokens: body.prompt_eval_count ?? 0,
        prefill_s: (body.prompt_eval_duration ?? 0) / 1e9,
        output_tokens: body.eval_count ?? 0,
        gen_s: (body.eval_duration ?? 0) / 1e9,
      },
    };
  };
}
