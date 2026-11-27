---
title: "How to Run OpenCode with Ollama on a 12-16 GB GPU: Context Size and KV Cache for 12B-14B Dense vs MoE Models"
description: "OpenCode wants 64k tokens of context, but Ollama gives cards under 24 GiB only 4k by default. How to budget VRAM between weights and KV cache for qwen3:14b, gpt-oss:20b and qwen3-coder:30b, when q8_0 or q4_0 KV cache quantization pays off, and how to make OpenCode's limit.context match what Ollama actually allocated. OpenCode 2.4, Ollama 0.40."
pubDate: 2026-11-27
template: "how-to"
tags:
  - "ai-agents"
  - "llm"
  - "opencode"
  - "ollama"
  - "local-models"
  - "kv-cache"
---

**Short answer:** on a 12-16 GB card, Ollama 0.40.x defaults to a 4k context, which is useless for OpenCode 2.4 (Ollama's own integration page says OpenCode needs 64k or more). Do not just raise the context and hope: the KV cache grows linearly with it and competes with the weights for VRAM. Turn on `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`, bake the context into a model with a Modelfile (`PARAMETER num_ctx`), check `ollama ps` shows `100% GPU`, and tell OpenCode the same number in `limit.context`. On 16 GB the best fit is `gpt-oss:20b` at 64k (its sliding-window layers make the cache tiny). On 12 GB, `qwen3:14b` at 32k with a `q8_0` cache is the realistic ceiling, and its native window stops at 40,960 tokens anyway. `qwen3-coder:30b` (MoE) does not fit in 16 GB at all and runs split across CPU and GPU.

Versions in this post: OpenCode 2.4.2 (released 2026-11-26), Ollama 0.40.18 (2026-11-24), model tags `qwen3:14b`, `gpt-oss:20b` and `qwen3-coder:30b` from the Ollama library. The memory numbers below are computed from each model's published `config.json`, not measured on a GPU. No Ollama benchmark was run for this post.

## Why OpenCode on a small GPU fails quietly

An agent harness is a context hog. OpenCode's system prompt, tool schemas, the files it reads and every tool result go into each request. A few file reads and a `grep` blow past 4,096 tokens before the model writes a line of code.

Ollama's [context length docs](https://docs.ollama.com/context-length) are explicit about the default: under 24 GiB of VRAM you get 4k, 24-48 GiB gets 32k, 48 GiB and up gets 256k. The same page recommends at least 64,000 tokens for "agents, and coding tools", and the [OpenCode integration page](https://docs.ollama.com/integrations/opencode) says OpenCode requires 64k or higher.

The failure mode is not an error. OpenCode 2.x discovers Ollama models on its own: per the [OpenCode models docs](https://opencode.ai/docs/models/), it probes `http://127.0.0.1:11434` and "reads context, vision, and tool-use capabilities from Ollama". The model's metadata (`/api/show`, `model_info."<arch>.context_length"`) reports the context the model was trained for, 262,144 for `qwen3-coder:30b`. What the Ollama server actually allocates is a separate number. If the client plans for a window the server never allocated, Ollama truncates the prompt from the front and the model loses the instructions and early tool results. It looks like a model that cannot follow instructions or forgets which file it was editing.

So there are two numbers to align: what Ollama allocates (`num_ctx`), and what OpenCode believes (`limit.context`). And there is one budget to respect: VRAM.

## Where the VRAM goes: weights plus KV cache

For a quantized model, the VRAM bill is roughly:

- **Weights**: the download size of the tag. `qwen3:14b` is 9.3 GB, `gpt-oss:20b` is 14 GB, `qwen3-coder:30b` is 19 GB (all Q4_K_M or MXFP4, per the [Ollama library](https://ollama.com/library/qwen3-coder/tags) tag pages).
- **KV cache**: for every token in the window, every attention layer stores one key and one value vector per KV head. Bytes per token = `2 × layers × kv_heads × head_dim × bytes_per_element`.
- **Compute buffers**: scratch space for the forward pass, which also grows with context and batch size. Treat 1-1.5 GiB as headroom, plus whatever your desktop compositor already holds on the card.

The KV term is the one you control, and the architecture decides how big it is. These are the values from each model's `config.json` on Hugging Face:

| Model | Type | Attention layers | KV heads | head_dim | Native window |
|---|---|---|---|---|---|
| [Qwen3-14B](https://huggingface.co/Qwen/Qwen3-14B/blob/main/config.json) | dense 14B | 40 full | 8 | 128 | 40,960 |
| [Qwen3-Coder-30B-A3B](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/blob/main/config.json) | MoE, 128 experts, 8 active | 48 full | 4 | 128 | 262,144 |
| [gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b/blob/main/config.json) | MoE, 32 experts, 4 active | 12 full + 12 sliding (window 128) | 8 | 64 | 131,072 |

Three things fall out of this table before you compute anything:

1. **MoE does not make the KV cache smaller by itself.** Experts live in the feed-forward blocks. Attention is shared, so `qwen3-coder:30b` has a cache shaped like a mid-size dense model. It is small only because Qwen chose 4 KV heads.
2. **Sliding-window layers are almost free.** Half of gpt-oss's layers only ever attend to the last 128 tokens, so their cache stops growing at 128 tokens regardless of `num_ctx`.
3. **`qwen3:14b` cannot natively reach OpenCode's 64k.** Its trained window is 40,960 (the Ollama tag page lists it as 40K). Asking for 65,536 does not give you a model that understands 65,536 tokens.

## Compute the budget before you pull

This script reproduces the arithmetic. It ran on Python 3.9; the byte sizes for `q8_0` and `q4_0` are the GGML block sizes (34 and 18 bytes per 32 elements), which is why Ollama's FAQ describes them as "approximately" 1/2 and 1/4 of `f16`.

```python
# kv_budget.py - KV cache estimate from Hugging Face config.json values
# Model tags: Ollama library qwen3:14b, qwen3-coder:30b, gpt-oss:20b (Nov 2026)
BPE = {"f16": 2.0, "q8_0": 34 / 32, "q4_0": 18 / 32}  # bytes per element

MODELS = {
    # name: (full_layers, swa_layers, swa_window, kv_heads, head_dim, weights_gb)
    "qwen3:14b":       (40, 0,  0,   8, 128, 9.3),
    "qwen3-coder:30b": (48, 0,  0,   4, 128, 19.0),
    "gpt-oss:20b":     (12, 12, 128, 8, 64,  14.0),
}

def kv_gib(name: str, ctx: int, cache_type: str) -> float:
    full, swa, window, kv_heads, head_dim, _ = MODELS[name]
    per_token_per_layer = 2 * kv_heads * head_dim * BPE[cache_type]  # K and V
    tokens = full * ctx + swa * min(ctx, window)
    return per_token_per_layer * tokens / 2**30

for name, spec in MODELS.items():
    weights = spec[5] * 1e9 / 2**30
    for ctx in (32_768, 65_536):
        row = "  ".join(
            f"{t}: {kv_gib(name, ctx, t):5.2f} (total {weights + kv_gib(name, ctx, t):4.1f})"
            for t in BPE
        )
        print(f"{name:16} {ctx:>6}  {row}")
```

Its output, in GiB (weights plus KV, before compute buffers):

| Model | Weights | 32k f16 | 32k q8_0 | 32k q4_0 | 64k f16 | 64k q8_0 | 64k q4_0 |
|---|---|---|---|---|---|---|---|
| qwen3:14b | 8.7 | 13.7 | 11.3 | 10.1 | 18.7 | 14.0 | 11.5 |
| qwen3-coder:30b | 17.7 | 20.7 | 19.3 | 18.5 | 23.7 | 20.9 | 19.4 |
| gpt-oss:20b | 13.0 | 13.8 | 13.4 | 13.3 | 14.5 | 13.8 | 13.5 |

Per token, the full-attention cache costs 160 KiB for `qwen3:14b`, 96 KiB for `qwen3-coder:30b` and 24 KiB for `gpt-oss:20b` at `f16`. That 6.7x spread between the two smallest models is the whole story of this post.

Note that the 64k column for `qwen3:14b` is only there to show the cost. You would not run it that way, for the native-window reason above.

## Picking a model per card

**12 GB card (12 GiB, minus what the desktop holds).** `qwen3:14b` is the dense model that fits. At 32k with a `q8_0` cache you are at 11.3 GiB before compute buffers, which is too tight if the same card drives your monitors. Either drop to `q4_0` (10.1 GiB) or keep `q8_0` and use 24k. `gpt-oss:20b` does not fit fully: 13 GiB of weights alone exceeds the card. Accept a context below OpenCode's 64k recommendation and compensate with aggressive compaction (below).

**16 GB card.** `gpt-oss:20b` at 64k is the standout: 14.5 GiB at `f16`, and the cache adds only 1.5 GiB on top of the weights because only 12 layers keep the full window. That leaves about 1.5 GiB for compute buffers, so close other GPU consumers or settle on 48k if `ollama ps` shows a CPU split. `qwen3:14b` at its full 40,960 with `q8_0` (about 12 GiB) is the comfortable dense alternative.

**`qwen3-coder:30b` on either card.** 17.7 GiB of weights cannot fit in 16 GB, so Ollama splits layers between GPU and system RAM and `ollama ps` shows something like `30%/70% CPU/GPU`. This is where MoE helps in a different way: with 8 of 128 experts active, each token reads roughly 3B parameters of weights instead of 30B, so the layers left on the CPU cost much less per token than the same split of a dense 30B model would. It is the one model in this list that is usable while partially offloaded, but it is still slower than a model that sits at `100% GPU`, and nothing in this post measured how much slower on your hardware.

Whatever you pick, OpenCode needs tool calling. Run `ollama show <model>` and check that `tools` appears under capabilities. OpenCode reads that same capability flag during discovery.

## Step 1: turn on flash attention and a quantized KV cache

Both are server-level environment variables. Per the [Ollama FAQ](https://docs.ollama.com/faq), flash attention is used automatically where the backend supports it, and the KV cache can be quantized "to significantly reduce memory usage when Flash Attention is enabled". Force it on so the quantized cache is never silently skipped:

```bash
# Ollama 0.40.18, Linux/macOS shell
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0   # f16 (default) | q8_0 | q4_0
ollama serve
```

On Linux with the systemd unit, put them in an override instead (`sudo systemctl edit ollama`, then `Environment="OLLAMA_KV_CACHE_TYPE=q8_0"` under `[Service]`). On Windows, set them as user environment variables and restart the Ollama tray app.

Which type to choose: the FAQ calls `q8_0` "usually" without noticeable quality impact and recommends it if you leave `f16`. It says `q4_0` has a "small-medium loss in precision that may be more noticeable at higher context sizes", which is exactly the regime an agent lives in. It also warns that models with a high GQA count, and it names Qwen2, "may see a larger impact". Qwen3-Coder's 32 query heads sharing 4 KV heads is a GQA ratio of 8, so treat `q4_0` on it as something to test against your own tasks, not a default.

`OLLAMA_KV_CACHE_TYPE` is global: every model the server loads uses it. If you run a second model that tolerates quantization badly, you need a second Ollama instance on another port.

## Step 2: bake the context into a model, not into every request

You have three ways to set the window, and only one of them reaches OpenCode reliably:

- `OLLAMA_CONTEXT_LENGTH=40960 ollama serve` sets a server-wide default. Fine if you only run one model, wrong as soon as you run two with different native windows.
- `"options": {"num_ctx": ...}` works on the native `/api/chat` and `/api/generate` endpoints. OpenCode talks to Ollama through the OpenAI-compatible `/v1` endpoint, and the [OpenAI compatibility page](https://docs.ollama.com/api/openai-compatibility) states the OpenAI API "does not have a way of setting the context size".
- A Modelfile with `PARAMETER num_ctx`, which is what that same page recommends. The context travels with the model name, so no client can get it wrong.

```text
# Modelfile.qwen3-14b-40k  (Ollama 0.40.18)
FROM qwen3:14b
PARAMETER num_ctx 40960
```

```text
# Modelfile.gpt-oss-20b-64k  (Ollama 0.40.18)
FROM gpt-oss:20b
PARAMETER num_ctx 65536
```

```bash
ollama create qwen3:14b-40k -f Modelfile.qwen3-14b-40k
ollama create gpt-oss:20b-64k -f Modelfile.gpt-oss-20b-64k
```

`ollama create` only writes a small manifest layer on top of the existing weights, so this costs no disk space. Giving the new model an explicit tag (`qwen3:14b-40k` rather than a bare name) keeps Ollama from appending `:latest`, so the name OpenCode discovers is exactly the one you type in `opencode.json`. Because `/api/show` returns the Modelfile parameters (its `parameters` field reads like `num_ctx 40960`), the new name also documents itself.

## Step 3: verify the model is fully on the GPU

Load it once and look at `ollama ps`:

```bash
ollama run gpt-oss:20b-64k "say ok" >/dev/null
ollama ps
```

The columns are `NAME`, `ID`, `SIZE`, `PROCESSOR`, `CONTEXT` and `UNTIL`. Two of them matter:

- `CONTEXT` must show the number you asked for (65536 here). If it shows 4096, you are talking to a different model name or the Modelfile did not apply.
- `PROCESSOR` must read `100% GPU`. Anything like `12%/88% CPU/GPU` means the weights plus the cache plus buffers did not fit, and Ollama moved layers to system RAM. For a dense model that is a large slowdown on every token. Lower `num_ctx`, step the cache type down, or pick a smaller model until it reads `100% GPU`.

`SIZE` in that output is the total Ollama allocated, so compare it against the table above. If it is well above your estimate, the compute buffers are larger than the headroom you budgeted.

## Step 4: tell OpenCode the real window

OpenCode 2.4 discovers the new model names automatically (they show up in `/models` as `ollama/qwen3:14b-40k` and so on). Then make its limit match the server instead of trusting metadata. The [OpenCode config schema](https://opencode.ai/config.json) allows a `models` map under each provider with a `limit` object (`context`, `input`, `output`):

```jsonc
// ~/.config/opencode/opencode.json  (OpenCode 2.4.2)
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/gpt-oss:20b-64k",
  "providers": {
    "ollama": {
      "models": {
        "gpt-oss:20b-64k": {
          "limit": { "context": 65536, "output": 8192 }
        },
        "qwen3:14b-40k": {
          "limit": { "context": 40960, "output": 8192 }
        }
      }
    }
  },
  "compaction": {
    "auto": true
  }
}
```

The OpenCode docs say explicit `limit` values replace its fallbacks, and that OpenCode "cannot detect whether the custom-model fallback values are accurate". With `limit.context` equal to `num_ctx`, automatic compaction kicks in before Ollama has to truncate, so the model gets a summary instead of a silently cut prompt. `compaction.buffer` controls how much of the window is kept free before compaction starts; on a 32k-40k window, leave it at the default rather than shrinking it, because one large file read can eat several thousand tokens.

If Ollama runs on another machine, add `"settings": { "baseURL": "http://gpu-box:11434/v1" }` to the `ollama` provider. Keep the `/v1`: OpenCode derives the native `/api/tags` and `/api/show` discovery paths from it.

There is also a shortcut: `ollama launch opencode` starts OpenCode with an inline config for a model you pick and does not touch `~/.config/opencode/opencode.json`. It is a good smoke test, but it does not change the context the server allocates, so the Modelfile step still applies.

## Gotchas

- **The default changes with the card, not the model.** The same Modelfile-less `qwen3:14b` gets 4k on a 16 GB card and 32k on a 24 GB card. Configs copied from someone with a 4090 will behave differently on yours.
- **Unloading is not instant.** `OLLAMA_KV_CACHE_TYPE` changes only apply to models loaded after the restart. Run `ollama stop <model>` or restart the server, then check `ollama ps` again.
- **Parallel requests multiply the cache.** If `OLLAMA_NUM_PARALLEL` is above 1, the server can reserve room for several sequences. OpenCode subagents can send concurrent requests, so on a 12-16 GB card keep it at 1.
- **`q4_0` hides its cost until late.** Degradation from a 4-bit cache grows with context length. A model that looks fine on a 2k-token test can lose track of a long agent session, which is the opposite of what you tested.
- **Reasoning models spend output tokens.** `gpt-oss:20b` and `qwen3` think before answering, and that text counts against the window. Keep `limit.output` well under `limit.context`.
- **A partially offloaded MoE is a trade, not a fix.** `qwen3-coder:30b` will run on a 16 GB card, but OpenCode makes many sequential calls per task. Small per-token slowdowns add up across a session.

## Related

- [Local Ollama models vs cloud models in GitHub Copilot](/2026/09/local-ollama-models-vs-cloud-models-in-github-copilot/) covers the same context-length trap from the Copilot side, including `COPILOT_PROVIDER_MAX_PROMPT_TOKENS`.
- [Bring your own key in VS Code Copilot with Anthropic, Ollama and Foundry Local](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/) shows wiring a local Ollama endpoint into an editor agent.
- [Visual Studio 18.12 bring-your-own-model in agent mode](/2026/11/visual-studio-18-12-bring-your-own-model-ga-local-models-in-agent-mode/) for the Visual Studio take on local models.
- [ACP vs MCP](/2026/11/acp-vs-mcp-what-the-agent-client-protocol-does-that-mcp-does-not/) explains how editors drive agents like OpenCode over the Agent Client Protocol.
- [Calling local models from .NET 11 with IChatClient](/2026/11/llama-on-windows-call-local-models-from-dotnet-11-with-ichatclient/) if you want the same local server behind your own code.

## Sources

- [Ollama: Context length](https://docs.ollama.com/context-length) (VRAM-based defaults, `ollama ps` columns)
- [Ollama FAQ](https://docs.ollama.com/faq) (flash attention, `OLLAMA_KV_CACHE_TYPE`, CPU/GPU split)
- [Ollama: OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) (setting context size through a Modelfile)
- [Ollama: OpenCode integration](https://docs.ollama.com/integrations/opencode)
- [Ollama Modelfile reference](https://docs.ollama.com/modelfile)
- [OpenCode providers](https://opencode.ai/docs/providers/) and [models](https://opencode.ai/docs/models/) docs, [config schema](https://opencode.ai/config.json)
- Model configs: [Qwen3-14B](https://huggingface.co/Qwen/Qwen3-14B/blob/main/config.json), [Qwen3-Coder-30B-A3B-Instruct](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/blob/main/config.json), [gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b/blob/main/config.json)
- [Ollama releases](https://github.com/ollama/ollama/releases) and [OpenCode releases](https://github.com/anomalyco/opencode/releases)
