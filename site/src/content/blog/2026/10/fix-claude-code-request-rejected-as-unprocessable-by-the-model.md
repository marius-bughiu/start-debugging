---
title: "Fix: Claude Code stuck on \"Request rejected as unprocessable by the model\" in an image-heavy session"
description: "Claude Code 2.1.289 and earlier resend every screenshot on every turn, so one refused request means every later turn is refused too. Update to 2.1.290+ and resume with claude --continue; the client then trims the oldest images to 510, 255, then 127. On an old build, /compact or /clear. Then stop the screenshots piling up."
pubDate: 2026-10-22
template: error-page
tags:
  - "errors"
  - "claude-code"
  - "ai-agents"
  - "llm"
  - "vision"
  - "playwright-mcp"
  - "computer-use"
---

If a long Claude Code session full of screenshots answers every message with "Request rejected as unprocessable by the model", update to **Claude Code 2.1.290 or later** and resume the same session with `claude --continue`. From 2.1.290, the client catches this 400, drops the oldest images and documents to fit a limit of 510, then 255, then 127, and sends the request again. If you can't update, run `/compact`. If that fails too, run `/clear` and start fresh. Then stop the images from piling up: ask Playwright MCP for `browser_snapshot` instead of screenshots, or start it with `--image-responses omit`. Everything below was checked against Claude Code 2.1.308 (the current release on October 22, 2026), Playwright MCP 0.0.83 and the Anthropic Python SDK 2.1.0.

## The error in context

```text
Request rejected as unprocessable by the model (too many or oversized images, or unsupported parameters)
```

Claude Code prints it after an `API Error: 400` prefix. The clue is that it shows up on every turn after the first one. You type "continue", you type "hi", you paste nothing at all, and the answer is always the same 400. It mostly happens in sessions that ran a browser or desktop loop for an hour or more: Playwright MCP, Claude in Chrome, computer use, or a habit of pasting screenshots into the prompt.

## Why the session gets stuck

Two facts combine to cause this.

First, the Messages API is stateless. Each turn sends the whole conversation, and every image in it, again. A screenshot that a tool returned two hours ago is still an `image` block nested inside a `tool_result`, and it goes over the wire on every request. The [vision docs](https://platform.claude.com/docs/en/build-with-claude/vision) spell this out: all image blocks count, "including images from earlier conversation turns that you resend and images nested inside `tool_result` content".

Second, the API has more than one image ceiling, and you can hit them before the advertised maximum:

| Limit | Value |
| --- | --- |
| Images per request, 200k-context models | 100 |
| Images per request, all other models | 600 |
| Per-image size, Claude API | 10 MB base64 (5 MB on Bedrock and Vertex) |
| Per-image dimensions | 8000x8000 px |
| Per-image dimensions once a request has more than 20 images | 2000 px on either side |
| Whole request body | 32 MB on standard endpoints |

The docs also warn that "requests with many large images can fail before reaching the 600-image count". When that happens, the API refuses the request as unprocessable without saying which image or which limit was the problem.

Up to and including 2.1.289, Claude Code had no answer for that. The refused request held N images. The next turn held the same N images plus your new message. Every turn after it failed the same way, because nothing ever removed an image. The [2.1.290 changelog](https://code.claude.com/docs/en/changelog) lists the fix as: "Fixed long sessions with hundreds of images getting stuck on 'Request rejected as unprocessable by the model' errors".

## Minimal repro

You don't need a special setup. Any loop that returns a screenshot per step gets there:

```bash
# Claude Code 2.1.289 or earlier, Playwright MCP 0.0.83
claude mcp add playwright -- npx @playwright/mcp@0.0.83
claude
# > Open http://localhost:5173, then click through every route in the sidebar.
# >   After each click, take a screenshot and check that nothing overflows.
# ...a few hundred browser_take_screenshot calls later, every turn returns the 400
```

Each screenshot is a separate base64 image block. A few hundred of them push the request past what the model will take, even though no single image breaks a documented rule.

## Fix 1: update and resume the same session

```bash
# any install method; claude update works for the native installer
claude --version          # 2.1.289 or lower means you don't have the fix
claude update             # or: npm i -g @anthropic-ai/claude-code@latest / brew upgrade
claude --continue         # reopens the most recent session in this directory
```

Send any message. With 2.1.290 or later, the first request will most likely be refused again, and this time the client recovers. Here is what the 2.1.308 build does, read from the shipped CLI bundle:

1. It recognises the error by an HTTP 400 whose message contains the exact string "Request rejected as unprocessable by the model (too many or oversized images, or unsupported parameters)".
2. It counts every `image` and `document` block in the conversation, top-level and inside tool results.
3. It picks the first step from the list `[510, 255, 127]` that is strictly lower than that count (or lower than the limit it already tried).
4. It removes the **oldest** media until 20 fewer than the limit remain. The 20-item slack means the next few screenshots don't push the conversation straight back over. Images inside a tool result are replaced with the text `[media removed: request limit]`, so the tool call still has a result. Pasted images are removed outright.
5. It sends the request again and logs a warning: "The model refused this request as unprocessable. It held 312 images and documents; the oldest were removed to fit a limit of 255, and it is being sent again. If it is answered, this conversation keeps that limit."
6. If 255 is refused too, it tries 127. Below 127 it gives up: "The model still refuses this request as unprocessable with N images and documents left. Not removing any more."

The limit is stored per conversation and per model, so later turns trim to it before sending instead of being refused first. The cost is that Claude no longer sees the oldest screenshots. If one of them mattered ("compare against the layout from the first run"), paste it again or describe it in text.

## Fix 2: /compact when you can't update

If you're pinned to an older build (managed install, air-gapped machine), `/compact` is the way out. Compaction replaces the transcript with a text summary, and the images go with it. If the summarisation call itself is refused because of the images, Claude Code retries it with every image and document replaced by `[image]` and `[document]` placeholders. That fallback was already present before 2.1.290.

```text
# Claude Code 2.1.2xx, inside the stuck session
/compact Keep the list of routes already checked and every layout bug found so far.
```

The instruction after `/compact` matters here. The summary is all the next turn will have, so tell it what to keep. If `/compact` also fails, `/clear` (or quit and run `claude` without `--continue`) is the last resort. Copy the useful findings out of the scrollback first.

## Fix 3: stop the images from accumulating

The 2.1.290 trimming is a safety net, not a plan. A session that hovers around 500 images still uploads all of them on every turn. That is slow, and on models with high-resolution vision each 1920x1080 screenshot costs about 2,691 visual tokens. Make the screenshots rarer and smaller.

**Ask for the accessibility tree instead of pixels.** Playwright MCP's own tool description says "You can't perform actions based on the screenshot, use browser_snapshot for actions." A snapshot is text: roles, names and `ref`s Claude can click. Put the rule where the agent will read it:

```markdown
<!-- CLAUDE.md, Claude Code 2.1.308 + Playwright MCP 0.0.83 -->
## Browser testing
- Use `browser_snapshot` to inspect pages and find elements. It is text and costs no image tokens.
- Only call `browser_take_screenshot` when the question is visual (layout, overflow, colour),
  and at most once per route.
```

**Turn image responses off at the server** when a run never needs to look at pixels. Playwright MCP 0.0.83 has a switch for it:

```bash
# Playwright MCP 0.0.83: tools still run, but responses carry no image parts
claude mcp add playwright -- npx @playwright/mcp@0.0.83 --image-responses omit --viewport-size 1280x720
```

`--image-responses` takes `allow` (the default), `omit` or `only`. A smaller `--viewport-size` also keeps each screenshot you do take smaller. 1280x720 stays below the 2000 px many-image limit with room to spare.

**Move the screenshot loop into a subagent.** A subagent has its own context. Its screenshots stay in its transcript, and the main session gets back only the text report. The setup is in [how to write a Claude Code subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/). Because the subagent's context is thrown away when it finishes, it can't build up a 500-image history across a whole afternoon.

**Compact at natural breaks.** After finishing a feature or a test pass, run `/compact` yourself. If you rely on auto-compaction, note that it triggers on tokens, not on image count. A few hundred small screenshots can be refused long before the token threshold is reached. You can lower the threshold for an image-heavy subagent, as shown in [giving each Claude Code subagent its own compaction threshold](/2026/10/how-to-give-each-claude-code-subagent-its-own-compaction-threshold-with-autocompactwindow/).

## Check how many images a session is carrying

Session transcripts are JSONL files under `~/.claude/projects/<project-dir>/<session-id>.jsonl`. This script counts the media blocks the same way the 2.1.308 client does, so you can see how close a session is to the next step:

```python
# count_media.py - Python 3.10+, transcript format as of Claude Code 2.1.308
# Usage: python3 count_media.py ~/.claude/projects/<project-dir>/<session-id>.jsonl
import json
import sys
from collections import Counter

MEDIA = {"image", "document"}

def media_blocks(block):
    """Yield (block, origin) for every image/document, including those inside tool results."""
    if not isinstance(block, dict):
        return
    if block.get("type") in MEDIA:
        yield block, "pasted"
    elif block.get("type") == "tool_result" and isinstance(block.get("content"), list):
        for inner in block["content"]:
            if isinstance(inner, dict) and inner.get("type") in MEDIA:
                yield inner, "tool_result"

counts = Counter()
payload = 0
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        content = (json.loads(line).get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            for media, origin in media_blocks(block):
                counts[(media["type"], origin)] += 1
                payload += len((media.get("source") or {}).get("data", ""))

total = sum(counts.values())
for (kind, origin), n in sorted(counts.items()):
    print(f"{kind:9} {origin:12} {n}")
print(f"total media blocks: {total}")
print(f"base64 payload:     {payload / 1_048_576:.1f} MiB")
first_step = next((s for s in (510, 255, 127) if s < total), None)
print(f"first trim step if refused: {first_step or 'none (at or under 127, Claude Code gives up)'}")
```

A session with 300 Playwright screenshots and 12 pasted images prints:

```text
image     pasted       12
image     tool_result  300
total media blocks: 312
base64 payload:     0.3 MiB
first trim step if refused: 255
```

(The payload line is small here because the test transcript used tiny placeholder images. Real screenshots make it far larger.) The transcript keeps the original images even after the client trims them from the request, so this tells you what the session has accumulated, not what was sent last.

## The same error in your own agent loop

The 400 comes from the API, not from Claude Code. If you run your own tool loop on the Messages API with computer use, a browser tool or uploaded screenshots, you will hit it at the same point, and resending unchanged gets you the same refusal. You can copy the client's strategy:

```python
# prune.py - anthropic Python SDK 2.1.0, model claude-sonnet-5-5
import anthropic

STEPS = (510, 255, 127)
SLACK = 20
PLACEHOLDER = {"type": "text", "text": "[image removed: request limit]"}

def _is_media(b):
    return isinstance(b, dict) and b.get("type") in ("image", "document")

def count_media(messages):
    n = 0
    for m in messages:
        if isinstance(m["content"], list):
            for b in m["content"]:
                if _is_media(b):
                    n += 1
                elif b.get("type") == "tool_result" and isinstance(b.get("content"), list):
                    n += sum(1 for x in b["content"] if _is_media(x))
    return n

def keep_newest_media(messages, limit):
    """Return a copy with only the newest `limit - SLACK` media blocks left."""
    drop = max(0, count_media(messages) - (limit - SLACK))
    out = []
    for m in messages:
        if not isinstance(m["content"], list):
            out.append(m)
            continue
        content = []
        for b in m["content"]:
            if _is_media(b) and drop:
                drop -= 1
                continue
            if b.get("type") == "tool_result" and isinstance(b.get("content"), list):
                inner = []
                for x in b["content"]:
                    if _is_media(x) and drop:
                        drop -= 1
                        inner.append(PLACEHOLDER)
                    else:
                        inner.append(x)
                b = {**b, "content": inner}
            content.append(b)
        out.append({**m, "content": content or [PLACEHOLDER]})
    return out

def create_with_media_backoff(client, messages, **kwargs):
    limit = None
    while True:
        try:
            return client.messages.create(messages=messages, **kwargs), messages
        except anthropic.BadRequestError as e:
            if "unprocessable by the model" not in str(e):
                raise
            current = min(count_media(messages), limit or 10**9)
            limit = next((s for s in STEPS if s < current), None)
            if limit is None:
                raise
            messages = keep_newest_media(messages, limit)
```

Keep the returned `messages` as your new history so the next turn starts trimmed. Run against a stub client that refuses anything above 200 media blocks, a 300-screenshot history goes 300, then 235, then 107, then succeeds. Two improvements over pure backoff: upload screenshots once with the [Files API](https://platform.claude.com/docs/en/build-with-claude/files) and reference them by `file_id` so the request body stays small, and downscale screenshots before returning them to the model. For computer-use and browser-use tool results, the API rejects an image over the model's limits outright instead of downscaling it, so resizing is your job anyway.

## Gotchas that look like the same problem

- **"An image in the conversation exceeds the dimension limit for many-image requests (2000px)."** This is a different 400. The request has more than 20 images and one of them is wider or taller than 2000 px. Claude Code shows this message with "Run /compact to remove old images from context, or start a new session". If compaction is disabled with `DISABLE_COMPACT`, it says "Start a new session with fewer images" instead. The fix is the same: compact, or make screenshots smaller. Retina screenshots pasted from macOS are the usual offenders. [Issue #13480](https://github.com/anthropics/claude-code/issues/13480) shows the full error, `messages.100.content.2.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels`, and how it used to kill a session for good.
- **New images vanish after one oversized image was refused.** That was a separate bug, fixed in 2.1.299 ("Fixed long conversations losing newly attached images on every turn after one oversized image was refused by the API"). The same release fixed images attached while Claude is working being sent at full size from VS Code, the desktop app and the SDK.
- **"Autocompact is thrashing" in turns that read many images or PDF pages.** Fixed in 2.1.307. If you see it on an older build, update before you tune anything.
- **"Prompt is too long".** That is the token limit, not an image limit, and `/compact` can fail on it for different reasons. See [Claude Code dropping MCP tools after auto-compaction](/2026/06/fix-claude-code-drops-mcp-tools-after-auto-compaction/) for what compaction keeps and loses. For the Aider version of the same wall, see [context window exceeded during an Aider refactor](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/).
- **It still fails at 127.** Then the count isn't the problem. Look for one corrupt or zero-byte image (recent builds turn unreadable pasted, MCP and dialog images into text placeholders, older ones sent them as is), a single image over 10 MB, or a request body over 32 MB from large PDFs. `/clear` is the reliable exit.

## Related

- [How to write a Claude Code subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/) keeps the screenshot loop out of the main context.
- [Giving each Claude Code subagent its own compaction threshold with autoCompactWindow](/2026/10/how-to-give-each-claude-code-subagent-its-own-compaction-threshold-with-autocompactwindow/) lets an image-heavy subagent compact early.
- [Fix: Claude Code drops MCP tools after auto-compaction](/2026/06/fix-claude-code-drops-mcp-tools-after-auto-compaction/) covers the other common compaction surprise.
- [How to let GitHub Copilot drive a desktop app with computer use](/2026/10/how-to-let-github-copilot-drive-a-desktop-app-with-computer-use/) is the same screenshot-per-step pattern in another agent.

## Sources

- [Claude Code changelog](https://code.claude.com/docs/en/changelog), entries for 2.1.287, 2.1.290, 2.1.299 and 2.1.307.
- [Vision: request limits, resolution and token cost](https://platform.claude.com/docs/en/build-with-claude/vision), Claude Platform docs.
- [Files API](https://platform.claude.com/docs/en/build-with-claude/files), Claude Platform docs.
- [Playwright MCP README](https://github.com/microsoft/playwright-mcp), `--image-responses` and `--viewport-size` options (0.0.83).
- [Claude Code issue #13480](https://github.com/anthropics/claude-code/issues/13480), the many-image 2000 px variant that kept failing because the image stayed in history.
- Claude Code 2.1.308 CLI bundle (`@anthropic-ai/claude-code-darwin-arm64`), read for the `[510, 255, 127]` steps, the 20-item slack and the recovery messages.
