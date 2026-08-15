---
title: "Safe File-Write Tools for an Agent: Preview, Confirm, Apply"
description: "A write tool that asks before it writes needs three things the MCP SDK does not give you: an approval bound to the exact diff, a precondition on the file it previewed, and an integrity-protected requestState. Verified end to end on @modelcontextprotocol/server 2.0.0 against protocol revision 2026-07-28, including the argument-swap that gets past a naive confirm."
pubDate: 2026-08-15
tags:
  - "mcp"
  - "ai-agents"
  - "llm"
  - "typescript"
  - "security"
---

If you are exposing a file write, a database update, or any other side effect to an agent through MCP, the tool needs a confirmation step, and on protocol revision `2026-07-28` that step is a multi round-trip request: your handler returns an `InputRequiredResult` carrying an `elicitation/create` form, and the client retries the same `tools/call` with the user's answer. What the SDK does not do, and what almost every implementation I have read gets wrong, is bind the approval to the thing the user approved. I verified the whole flow on `@modelcontextprotocol/server` 2.0.0 with Node 24.14.1, and a client that swaps `arguments` between the two rounds while echoing the same `requestState` gets its second, unreviewed write applied unless you check for it yourself.

The short version: one tool, two rounds. Round one previews and mints a signed `requestState` containing a hash of the arguments you previewed and a hash of the file as it exists right now. Round two verifies the confirmation, re-checks both hashes, and only then writes, through a temp file and a rename. Everything below is that design with the wire output from each failure mode.

## Why `write_file(path, content)` is not enough on its own

The instinct is to declare the tool honestly and let the client handle safety:

```ts
// @modelcontextprotocol/server 2.0.0
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
```

Those four fields are real, they serialize into `tools/list`, and I confirmed they arrive intact on the client. They are also, per the [tools specification](https://modelcontextprotocol.io/specification/latest/server/tools), something clients "MUST consider ... to be untrusted unless they come from trusted servers." They are metadata for a UI, not a gate. Nothing in the protocol stops a client from calling a `destructiveHint: true` tool without asking anyone.

The client side is not a substitute either. Host permission systems are coarse by design: they gate on tool name and, at best, a path pattern, which is why a rule as reasonable-looking as `Write(src)` silently [fails to match any file under `src/`](/2026/08/fix-write-rule-is-not-matched-by-file-permission-checks/), and why the difference between [auto mode and manual approval](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/) is a question of which classifier runs, not of what the write actually does. Neither the host nor the model can show the user a diff of a file only your server has read. That has to come from the server.

## One tool, two rounds

MCP `2026-07-28` replaced server-initiated requests with the [multi round-trip pattern](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr): the server answers `tools/call` with `resultType: "input_required"` instead of a result, and the client gathers the input and calls again with a new JSON-RPC id. Here is the real round-one response from the server below, captured over `createMcpHandler`:

```json
{
  "result": {
    "resultType": "input_required",
    "inputRequests": {
      "confirm": {
        "method": "elicitation/create",
        "params": {
          "message": "Write notes.txt? Replaces 2 line(s), 3 line(s) added, 5 line(s) after the write.",
          "requestedSchema": {
            "type": "object",
            "properties": { "apply": { "type": "boolean", "description": "Apply this write" } },
            "required": ["apply"],
            "$schema": "https://json-schema.org/draft/2020-12/schema"
          },
          "mode": "form"
        }
      }
    },
    "requestState": "v1.eyJwIjp7InBhdGgiOiJub3Rlcy50eHQiLCJiYXNlSGFzaCI6ImI2Mjg1YzU3...In0.a68e1odZJLXyB4Ptcg-HPw_tep4d7butjYTTcr_KxQM"
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

Two details matter. The first: the client retries with the **same `arguments`** plus `inputResponses` and the echoed `requestState`, under a different id. The second: your handler is entered twice, and the only thing distinguishing round two is that `ctx.mcpReq.requestState()` returns something.

Form-mode elicitation schemas are restricted to flat objects of primitives, so the diff itself cannot ride in `requestedSchema`. It goes in `message`. Keep that string informative, because it is the entire basis on which a human says yes.

## The handler

```ts
// @modelcontextprotocol/server 2.0.0, MCP protocol revision 2026-07-28, Node 24.14.1
import { McpServer, inputRequired, acceptedContent, createRequestStateCodec } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const codec = createRequestStateCodec<{ path: string; baseHash: string | null; newHash: string }>({
  key: process.env.SAFE_WRITE_STATE_KEY!,          // 32 bytes minimum, or the constructor throws
  ttlSeconds: 120,
  bind: (ctx) => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? 'local'}`,
});

const server = new McpServer(
  { name: 'safe-write', version: '1.0.0' },
  { requestState: { verify: codec.verify } },      // runs before the handler, on every round
);

server.registerTool(
  'write_file',
  {
    title: 'Write file',
    description: 'Replace a file under the project root. Shows a diff and asks before writing.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  },
  async ({ path, content }, ctx) => {
    const abs = resolveInRoot(ROOT, path);         // rejects anything that escapes the root
    const before = await readOrNull(abs);
    const baseHash = before === null ? null : sha256(before);
    const newHash = sha256(content);

    if (baseHash === newHash) {
      return { content: [{ type: 'text', text: `${path} already matches, nothing written.` }] };
    }

    const approved = ctx.mcpReq.requestState<{ path: string; baseHash: string | null; newHash: string }>();

    if (!approved) {
      const stat = diffStat(before, content);
      return inputRequired({
        requestState: await codec.mint({ path, baseHash, newHash }, ctx),
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Write ${path}? ${before === null ? 'Creates a new file' : `Replaces ${stat.removed} line(s)`}, `
              + `${stat.added} line(s) added, ${stat.totalAfter} line(s) after the write.`,
            requestedSchema: z.object({ apply: z.boolean().describe('Apply this write') }),
          }),
        },
      });
    }

    const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', z.object({ apply: z.boolean() }));
    if (!answer?.apply) {
      return { content: [{ type: 'text', text: `Write to ${path} was not applied.` }], isError: true };
    }
    if (approved.path !== path || approved.newHash !== newHash) {
      return { content: [{ type: 'text', text: 'Arguments changed after the preview was approved.' }], isError: true };
    }
    const current = await readOrNull(abs);
    if ((current === null ? null : sha256(current)) !== approved.baseHash) {
      return { content: [{ type: 'text', text: `${path} changed on disk since the preview.` }], isError: true };
    }

    const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, content, 'utf8');
      await rename(tmp, abs);                      // atomic within the same directory
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return { content: [{ type: 'text', text: `Wrote ${path} (${content.length} bytes).` }] };
  },
);
```

`acceptedContent` returns `undefined` for a declined or cancelled elicitation as well as for content that fails the schema, which is why the single `!answer?.apply` branch covers accept-with-false, decline, and cancel. All three leave the file untouched. I checked each one.

## `requestState` is attacker-controlled input

The spec is explicit that a server which lets `requestState` influence authorization or business logic MUST integrity-protect it and reject state that fails verification, and equally explicit that the SDK does none of this for you. `createRequestStateCodec` is the helper: HMAC-SHA256, a TTL, and an optional `bind` callback that ties the state to the authenticated principal and the originating method. Wired into `ServerOptions.requestState.verify`, it runs before your handler on every round, and its decoded payload is what `ctx.mcpReq.requestState<T>()` hands back.

Flip four characters of the state and the request dies at the seam, before any of your code runs:

```json
{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"Invalid or expired requestState",
 "data":{"reason":"invalid_request_state"}}}
```

The message is frozen; the real reason (`mac`, `expired`, `bind`, `malformed`) reaches your `onerror` callback and never the wire. That is the right default, and it means your logs are the only place you will see why a legitimate client started failing.

One property to internalise: the envelope is **signed, not encrypted**. Base64url-decode the middle segment of the state above and you get the payload in clear:

```json
{"p":{"path":"notes.txt","baseHash":"b6285c57e879...","newHash":"32a77951649a..."},
 "exp":1786785391,"b":"cmhe5ZV6iRw0H-bbv3k_cw"}
```

So put hashes and identifiers in there, never file contents, tokens, or connection strings. The binding value is stored as a keyed tag rather than raw, which is why the principal does not leak. The whole envelope came out at 350 characters for this payload, so it is cheap enough to mint per round but not free: it is echoed on every retry.

## The check the SDK will not do for you

Here is the failure mode I have not seen discussed anywhere. Round one previews a three-line edit to `notes.txt`. The user approves it. Round two arrives with the same `requestState` and completely different `arguments`:

```jsonc
// round 2, same state, different content
{ "name": "write_file",
  "arguments": { "path": "notes.txt", "content": "rm -rf everything\n" },
  "requestState": "v1.eyJwIjp7InBhdGgiOiJub3Rlcy50eHQ...",
  "inputResponses": { "confirm": { "action": "accept", "content": { "apply": true } } } }
```

Nothing in the protocol says the retry must carry the arguments it was previewed with, and nothing in the SDK compares them. The approval and the arguments are independent inputs that happen to arrive in the same message. With the `approved.newHash !== newHash` check in place the server answers:

```json
{"content":[{"type":"text","text":"Arguments changed after the preview was approved."}],"isError":true}
```

and the file on disk stays `"one\ntwo\nthree\n"`. Take that check out and the second payload lands with a user-visible "approved" next to it. This is the whole reason the content hash goes into the minted state: the state is not a session token, it is a receipt for one specific diff.

The same logic covers the file. `approved.baseHash` is the hash of the file at preview time, re-checked at apply time, so an edit that landed in between (another agent, a rebase, the user's editor) aborts the write rather than silently clobbering it. In my run the file was rewritten by a third party during the confirmation and the server refused: `notes.txt changed on disk since the preview.` That is optimistic concurrency, and it costs one extra read.

Replay deserves a note. The spec's TTL, principal binding and request binding bound the replay window but, in its own words, do not guarantee single use. Rather than keeping a server-side set of spent states, make replay harmless: the base-hash precondition already fails on the second apply, and the `baseHash === newHash` short-circuit at the top of the handler turns a replayed identical write into `already matches, nothing written`. Idempotence beats bookkeeping here.

## Clients that do not do elicitation

Servers MUST NOT send an `inputRequests` entry the client has not declared support for, and the SDK enforces it. Serve the same tool to a client whose envelope declares no elicitation capability and you get a protocol error rather than a hang:

```json
{"jsonrpc":"2.0","id":99,"error":{"code":-32021,
 "message":"Cannot request input 'confirm' (elicitation/create): the request's client capabilities do not declare the required capability",
 "data":{"requiredCapabilities":{"elicitation":{"form":{}}}}}}
```

HTTP 400, and `data.requiredCapabilities` tells the client exactly what to declare. Failing this way is a defensible product decision: no confirmation channel, no destructive tool.

If you need to serve those clients, the fallback is the two-tool shape: `preview_write` returns the diff plus the same signed state as a plain string, and `apply_write` takes `{ state }` alongside the original arguments and runs the identical round-two checks. Note what you cannot do: hide `apply_write` until a preview has happened. Since `2026-07-28`, `tools/list` MUST NOT vary per-connection, which is the same constraint that rules out per-session tool registration when you are [designing a server over a large internal API](/2026/08/mcp-server-design-for-a-large-internal-api-surface/). The apply tool is always visible; its safety has to live in the state check, not in its absence from the catalog.

## What actually happens on today's clients

Worth knowing before you ship: the published SDK negotiates up to `2025-11-25`. `SUPPORTED_PROTOCOL_VERSIONS` in `@modelcontextprotocol/server` 2.0.0 is `2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07`, and the `2026-07-28` era is selected per request by the `_meta` envelope (`io.modelcontextprotocol/protocolVersion`) rather than by the handshake. Driving it over HTTP also requires `Mcp-Method` and `Mcp-Name` headers that agree with the body; omit either and you get `-32020` with a message naming the mismatch.

Connect the exact same server to a 2.0.0 `Client` over `InMemoryTransport`, which handshakes at `2025-11-25`, and the handler code does not change at all. The SDK's legacy shim turns the `inputRequired(...)` return into an old-style push request and runs round two in process:

```text
C->S {"method":"tools/call","params":{"name":"write_file","arguments":{...}},"id":1}
S->C {"method":"elicitation/create","params":{"message":"Write notes.txt? ...","mode":"form"},"id":0}
C->S {"result":{"action":"accept","content":{"apply":true}},"id":0}
S->C {"result":{"content":[{"type":"text","text":"Wrote notes.txt (19 bytes)."}]},"id":1}
```

One `tools/call`, not two, and `requestState` never crosses the wire. The `verify` hook still runs on the shim's in-process rounds, so the argument and drift checks behave identically; I ran accept, decline, apply-false and mid-flight drift through both paths and got the same outcomes. Writing to the MRTR shape today is therefore free: it is the only shape on the new era and it degrades cleanly on the old one.

## Gotchas worth writing down

- **Never elicit secrets in form mode.** The spec forbids requesting passwords, API keys, tokens or payment credentials through form elicitation; those go through URL mode, out of band, so they never touch the client or the model's context.
- **Validate the path before you read it.** The confirmation flow is orthogonal to traversal. `resolve` then `relative` and reject anything starting with `..` or absolute, before the preview, or your diff has already leaked a file outside the root.
- **Write through a temp file in the same directory, then `rename`.** A partial write on a crash is worse than no write, and `rename` across a filesystem boundary is not atomic, so the temp file has to be a sibling.
- **Keep the TTL short.** 120 seconds is generous for a human clicking a button and short enough that a stale approval cannot resurface an hour later against a changed file.
- **The elicitation `message` is the security UI.** Line counts are the minimum. A truncated unified diff is better. Whatever you put there is what "approved" means.
- **`isError: true` is the right channel for a refusal.** It reaches the model as feedback it can act on rather than as a protocol failure, which is the difference between the agent trying a smaller edit and the agent giving up.

## Related on Start Debugging

- Curating a catalog before generating one tool per endpoint, plus the per-connection rule that shapes the fallback above, in [MCP server design for a large internal API surface](/2026/08/mcp-server-design-for-a-large-internal-api-surface/).
- The client-side half of this story, and why `acceptEdits` auto-approves more than file edits, in [auto mode vs manual approval](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/).
- A different take on gating, at the agent rather than the server, in [gating Cursor SDK tool calls with auto-review](/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/).
- If you are starting from zero, [building an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) covers the scaffolding this post assumes.
- Transport choice decides whether you get the modern per-request envelope at all: [MCP stdio vs HTTP vs SSE](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/).

## Sources

- [MCP specification, Tools](https://modelcontextprotocol.io/specification/latest/server/tools) (revision `2026-07-28`): annotations as untrusted hints, the per-connection `tools/list` rule, and error handling.
- [MCP specification, Multi Round-Trip Requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr): `InputRequiredResult`, `requestState` integrity and replay requirements, client retry rules.
- [MCP specification, Elicitation](https://modelcontextprotocol.io/specification/latest/client/elicitation): form vs URL mode, the restricted `requestedSchema` subset, and the three response actions.
- [`@modelcontextprotocol/server` 2.0.0 on npm](https://www.npmjs.com/package/@modelcontextprotocol/server): `inputRequired`, `acceptedContent`, `createRequestStateCodec`, and `ServerOptions.requestState.verify`.
