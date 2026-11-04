---
title: "What Is the MCP Tasks Extension and When Do You Need Poll-Based Long-Running Tools"
description: "The MCP Tasks extension (io.modelcontextprotocol/tasks, spec 2026-07-28, SEP-2663) lets a server answer tools/call with a durable task handle instead of a result. The client polls tasks/get, answers mid-flight questions with tasks/update, and can cancel or reconnect. Here is the wire protocol, what changed from the experimental 2025-11-25 version, when a task is worth it, and a working server and client checked against @modelcontextprotocol/ext-tasks 0.2.2."
pubDate: 2026-11-04
tags:
  - "mcp"
  - "ai-agents"
  - "llm"
  - "typescript"
  - "long-running-tools"
---

The MCP Tasks extension, `io.modelcontextprotocol/tasks`, is the protocol's answer to "this tool takes ten minutes." Instead of holding `tools/call` open until the work finishes, a server that supports it can answer with a `CreateTaskResult` (`resultType: "task"`) carrying a `taskId`, a `ttlMs` and a suggested `pollIntervalMs`. The client then polls `tasks/get` until the task reaches `completed`, `failed` or `cancelled`, answers any questions the task asks through `tasks/update`, and can stop it with `tasks/cancel`. The current version is the extension defined for protocol revision `2026-07-28` by SEP-2663, which replaced the experimental in-core tasks that shipped in `2025-11-25`.

You need it when the work outlives the connection: anything that runs longer than your client's tool timeout, anything a user might want to walk away from and come back to, and anything that should survive a client crash or a redeploy of the server's load balancer. You do not need it for a tool that finishes in a few seconds, and you should not reach for it just to show progress.

## Why `tools/call` alone breaks on long work

A plain `tools/call` is one request and one response. Every second the tool runs, something has to keep that request alive: an HTTP connection, a stdio pipe, a client-side timer. In practice each of those has a limit you do not control. Claude Code, for example, moves a slow MCP call into the background after two minutes and has its own idle and total timeouts, which is the subject of [why a long MCP tool call gets auto-backgrounded after two minutes](/2026/07/fix-long-mcp-tool-call-auto-backgrounded-after-two-minutes/). Proxies and serverless platforms cut idle HTTP requests well before that.

The `2026-07-28` revision made this worse for anyone who was relying on the transport to carry state. The protocol went stateless: no session ID, no long-lived stream that a server can push requests down, and any request may land on any replica. The full list of what moved is in [stateful vs stateless MCP servers](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/). A ten-minute `tools/call` on a stateless deployment is a ten-minute request pinned to one process, and if that process restarts, the result is gone and the client has no way to ask for it again.

Tasks fix that by turning the result into something addressable. The `taskId` is a durable handle. A client that crashed, or a different client process on the same account, can call `tasks/get` with it later and pick up where things stood.

## The wire protocol in five messages

### 1. Negotiation is per request

There is no handshake to remember. The client declares the extension inside `_meta` on each request that may produce a task, and the server advertises it in its `server/discover` result:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "export_report",
    "arguments": { "rows": 48210 },
    "_meta": {
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": { "io.modelcontextprotocol/tasks": {} }
      }
    }
  }
}
```

An empty object means "supported"; no extension settings are defined yet. Two rules come with it. The server is the sole decider of whether a given call becomes a task, and declaring the capability does not ask for one. And a server MUST NOT return a `CreateTaskResult` to a request that did not carry the capability, even if the same client declared it on an earlier request. If the server cannot answer that call without a task, it returns `-32021` (Missing Required Client Capability) with the required extension in `error.data.requiredCapabilities`.

### 2. The server answers with a task

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "task",
    "taskId": "326000d9-540d-488b-9dbe-01d4a6c2a8cf",
    "status": "working",
    "statusMessage": "Querying rows",
    "createdAt": "2026-11-04T10:11:17.218Z",
    "lastUpdatedAt": "2026-11-04T10:11:17.218Z",
    "ttlMs": 900000,
    "pollIntervalMs": 500
  }
}
```

`ttlMs` is measured from `createdAt`, may be `null` for "no limit", and may change over the task's life, as may `pollIntervalMs`. The server must not send this response until the task is durably created, meaning a `tasks/get` for that `taskId` would already resolve. On a multi-replica deployment that means the task record is in shared storage before the response leaves, not in a `Map` on one pod.

### 3. The client polls `tasks/get`

`tasks/get` takes `{ "taskId": "..." }` and returns the task with `resultType: "complete"`, plus whatever the current status implies: `inputRequests` when it is `input_required`, `result` when it is `completed`, `error` when it is `failed`. There is no separate `tasks/result` call any more; the final payload rides on the same poll. Clients SHOULD respect `pollIntervalMs`, and servers MAY rate-limit clients that poll faster.

Two statuses are easy to confuse. A tool that ran and returned `isError: true` ends `completed`, with the tool result in `result`. `failed` is reserved for JSON-RPC-level errors during execution, such as `{ "code": -32603, "message": "API rate limit exceeded" }`.

### 4. Mid-task questions go through `tasks/update`

If the work hits a decision point, the task moves to `input_required` and `tasks/get` returns a map of requests, each shaped like the elicitation or sampling request it stands in for:

```json
"inputRequests": {
  "confirm-overwrite": {
    "method": "elicitation/create",
    "params": {
      "mode": "form",
      "message": "report.csv already exists. Overwrite it with 48210 rows?",
      "requestedSchema": {
        "type": "object",
        "properties": { "overwrite": { "type": "boolean" } },
        "required": ["overwrite"]
      }
    }
  }
}
```

The client answers with `tasks/update`, keyed the same way, and gets back an empty acknowledgement:

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tasks/update",
  "params": {
    "taskId": "326000d9-540d-488b-9dbe-01d4a6c2a8cf",
    "inputResponses": {
      "confirm-overwrite": { "action": "accept", "content": { "overwrite": true } }
    }
  }
}
```

The ack is eventually consistent, so the next poll may still show `input_required`. `inputRequests` is a snapshot repeated on every poll until it is answered, which is why clients should deduplicate by key. Keys must be unique for the lifetime of a task, and servers ignore responses for keys that are not outstanding.

This is deliberately not the same mechanism as [Multi Round-Trip Requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr). If the server needs input before it can even start (say, which environment to export from), it uses MRTR on the original `tools/call`: `resultType: "input_required"`, client retries with `inputResponses`, and only then the `CreateTaskResult`. The spec says servers SHOULD resolve all MRTR exchanges before creating the task. Input needed during execution goes through the task. A real MRTR confirmation flow, including the argument-swap it has to defend against, is in [safe file-write tools for an agent](/2026/08/safe-file-write-tools-for-an-agent-preview-confirm-apply/).

### 5. Cancellation is cooperative

`tasks/cancel` takes a `taskId` and returns an empty ack. It is a request, not a guarantee: the task may stay `working` for a while and may still end `completed` or `failed` if the work finished first. Do not use `notifications/cancelled` for tasks; the spec forbids it.

Optionally, a client can stop polling and subscribe instead: `subscriptions/listen` with `params.notifications.taskIds`, after which the server MAY send `notifications/tasks` messages carrying the same payload `tasks/get` would return. Clients MUST NOT rely on them, so a poll loop is still the baseline. Progress notifications (`notifications/progress`) are not supported on tasks at all; use `statusMessage` instead.

## What changed from the `2025-11-25` experimental tasks

If you implemented tasks against the earlier revision, most of the surface moved. The table is from the [2025-11-25 tasks page](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) and the [2026-07-28 extension spec](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html):

| | `2025-11-25` (in core, experimental) | `2026-07-28` (extension, SEP-2663) |
|---|---|---|
| Opt-in | `capabilities.tasks`, plus `"task": { "ttl": ... }` on the request | `_meta` extension capability per request; server decides |
| Per-tool flag | `execution.taskSupport`: `required` / `optional` / `forbidden` | none; no `tools/list` warm-up |
| Result shape | `{ "task": { ... } }` nested | flat, `resultType: "task"` |
| Field names | `ttl`, `pollInterval` | `ttlMs`, `pollIntervalMs` |
| Getting the result | blocking `tasks/result` | inline in `tasks/get` |
| Mid-task input | side-channel requests on the `tasks/result` stream | `inputRequests` + `tasks/update` |
| Listing | `tasks/list` | removed |
| Cancel response | the `Task` | empty ack |
| Notification | `notifications/tasks/status` | `notifications/tasks` |
| Which requests | `tools/call`, plus client-side sampling and elicitation tasks | `tools/call` only |

Two removals are worth understanding rather than just porting. `tasks/list` is gone because a server cannot reliably scope it to the right caller, and an unscoped list leaks the existence of other people's tasks. `tasks/result` is gone because it was a blocking call that brought back exactly the held-open request tasks were meant to eliminate; SEP-2663 calls it a "blocking trap."

## A working server and client

The official TypeScript server package, `@modelcontextprotocol/server` 2.4.0, still only carries the `2025-11-25` task schemas (`ListTasksRequestSchema`, `GetTaskPayloadRequestSchema` for `tasks/result`), so there is no first-party helper yet for serving the `2026-07-28` extension. The requester side is covered by [`@modelcontextprotocol/ext-tasks`](https://tasks.extensions.modelcontextprotocol.io/typescript/) 0.2.2, which needs a `rawDispatch` adapter and `v2RequestFraming` to talk to a `2026-07-28` server.

To show the protocol without that plumbing, here is a deliberately small JSON-RPC server that implements only what this post discusses: `server/discover`, a task-backed `tools/call`, and `tasks/get`, `tasks/update` and `tasks/cancel`. It is not a complete MCP server (no `tools/list`, no MRTR, no real auth), but every message it sends follows the extension spec.

```js
// Node 26.4.0, MCP protocol revision 2026-07-28, io.modelcontextprotocol/tasks (spec 2026-07-28)
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const EXT = 'io.modelcontextprotocol/tasks';
const tasks = new Map(); // taskId -> task record (use Redis/Postgres in production)

const now = () => new Date().toISOString();
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data && { data }) } });
const declaresTasks = (params) =>
  !!params?._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.[EXT];

// The public view of a task: what CreateTaskResult, tasks/get and notifications/tasks carry.
function view(t) {
  const v = {
    taskId: t.taskId, status: t.status, createdAt: t.createdAt, lastUpdatedAt: t.lastUpdatedAt,
    ttlMs: t.ttlMs, pollIntervalMs: t.pollIntervalMs,
    ...(t.statusMessage && { statusMessage: t.statusMessage }),
  };
  if (t.status === 'input_required') v.inputRequests = t.inputRequests;
  if (t.status === 'completed') v.result = t.result;
  if (t.status === 'failed') v.error = t.error;
  return v;
}
const set = (t, patch) => Object.assign(t, patch, { lastUpdatedAt: now() });

// The long-running work. It pauses once to ask the user a question.
async function exportReport(t, { rows }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  if (t.status === 'cancelled') return;
  set(t, {
    status: 'input_required', statusMessage: 'Waiting for confirmation',
    inputRequests: {
      'confirm-overwrite': {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: `report.csv already exists. Overwrite it with ${rows} rows?`,
          requestedSchema: {
            type: 'object',
            properties: { overwrite: { type: 'boolean' } },
            required: ['overwrite'],
          },
        },
      },
    },
  });
  const answer = await new Promise((resolve) => (t.resume = resolve));
  if (t.status === 'cancelled') return;
  if (answer.action !== 'accept' || !answer.content?.overwrite) {
    // A tool-level failure is still "completed", with isError: true.
    set(t, { status: 'completed', result: { content: [{ type: 'text', text: 'Skipped: user declined.' }], isError: true } });
    return;
  }
  set(t, { status: 'working', inputRequests: undefined, statusMessage: 'Writing rows' });
  await sleep(1500);
  if (t.status === 'cancelled') return;
  set(t, { status: 'completed', statusMessage: undefined,
    result: { content: [{ type: 'text', text: `Wrote ${rows} rows to report.csv` }], isError: false } });
}

function handle(msg, principal) {
  const { id, method, params } = msg;
  switch (method) {
    case 'server/discover':
      return ok(id, { resultType: 'complete', capabilities: { tools: {}, extensions: { [EXT]: {} } } });

    case 'tools/call': {
      if (params.name !== 'export_report') return err(id, -32602, `Unknown tool: ${params.name}`);
      if (!declaresTasks(params)) {
        // The server is the sole decider, but it may only return a task to a client that declared the extension.
        return err(id, -32021, 'Missing required client capability', {
          requiredCapabilities: { extensions: { [EXT]: {} } },
        });
      }
      const t = {
        taskId: randomUUID(), owner: principal, status: 'working', statusMessage: 'Querying rows',
        createdAt: now(), lastUpdatedAt: now(), ttlMs: 15 * 60_000, pollIntervalMs: 500,
      };
      tasks.set(t.taskId, t); // durable before we answer: a tasks/get for this id must resolve
      exportReport(t, params.arguments).catch((e) =>
        set(t, { status: 'failed', error: { code: -32603, message: String(e?.message ?? e) } }));
      return ok(id, { resultType: 'task', ...view(t) });
    }

    case 'tasks/get':
    case 'tasks/update':
    case 'tasks/cancel': {
      if (!declaresTasks(params)) return err(id, -32021, 'Missing required client capability');
      const t = tasks.get(params?.taskId);
      // Unknown, expired, or someone else's task all look the same: "not found".
      if (!t || t.owner !== principal) return err(id, -32602, 'Failed to retrieve task: Task not found');
      if (Date.parse(t.createdAt) + t.ttlMs < Date.now()) {
        tasks.delete(t.taskId);
        return err(id, -32602, 'Failed to retrieve task: Task has expired');
      }
      if (method === 'tasks/get') return ok(id, { resultType: 'complete', ...view(t) });
      if (method === 'tasks/update') {
        const r = params.inputResponses?.['confirm-overwrite'];
        if (t.status === 'input_required' && r && t.resume) { const go = t.resume; t.resume = null; go(r); }
        return ok(id, { resultType: 'complete' }); // empty ack, eventually consistent
      }
      if (!['completed', 'failed', 'cancelled'].includes(t.status)) {
        set(t, { status: 'cancelled', inputRequests: undefined });
        t.resume?.({ action: 'cancel' });
      }
      return ok(id, { resultType: 'complete' });
    }
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const principal = req.headers.authorization ?? 'anonymous'; // stand-in for real OAuth
    const reply = handle(JSON.parse(body), principal);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
}).listen(3917, () => console.log('tasks server on http://localhost:3917/mcp'));
```

And a client in plain `fetch` that uses the v2 type guards from `@modelcontextprotocol/ext-tasks/core/v2` to validate what comes back. It sets `Mcp-Method` and `Mcp-Name` because the spec requires `Mcp-Name` to be the `taskId` for task methods on Streamable HTTP, so a gateway can route without parsing the body.

```js
// Node 26.4.0, @modelcontextprotocol/ext-tasks 0.2.2 (type guards only), MCP 2026-07-28
import { withTaskCapabilityV2, isCreateTaskResultV2, isDetailedTaskV2 } from '@modelcontextprotocol/ext-tasks/core/v2';

const URL_ = 'http://localhost:3917/mcp';
const AUTH = process.env.AUTH ?? 'Bearer alice';
let nextId = 1;

async function rpc(method, params, name) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', authorization: AUTH,
      'mcp-method': method, ...(name && { 'mcp-name': name }), // Mcp-Name = tool name or taskId
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: withTaskCapabilityV2(params) }),
  });
  const msg = await res.json();
  if (msg.error) throw Object.assign(new Error(msg.error.message), { code: msg.error.code });
  return msg.result;
}

const first = await rpc('tools/call', { name: 'export_report', arguments: { rows: 48210 } }, 'export_report');
if (!isCreateTaskResultV2(first)) { console.log('immediate result', first); process.exit(0); }
console.log('task created', first.taskId, first.status, `poll every ${first.pollIntervalMs} ms`);

const answered = new Set();
let task = first;
while (!['completed', 'failed', 'cancelled'].includes(task.status)) {
  await new Promise((r) => setTimeout(r, task.pollIntervalMs ?? 1000));
  task = await rpc('tasks/get', { taskId: first.taskId }, first.taskId);
  if (!isDetailedTaskV2(task)) throw new Error('malformed tasks/get result');
  console.log('poll ->', task.status, task.statusMessage ?? '');
  if (task.status === 'input_required') {
    for (const [key, req] of Object.entries(task.inputRequests)) {
      if (answered.has(key)) continue; // inputRequests repeats on every poll until fulfilled
      answered.add(key);
      console.log(`  ${req.method}: ${req.params.message}`);
      await rpc('tasks/update', {
        taskId: first.taskId,
        inputResponses: { [key]: { action: 'accept', content: { overwrite: true } } },
      }, first.taskId);
    }
  }
}
console.log('final', task.status, JSON.stringify(task.result ?? task.error));
```

Run with `node server.mjs`, then `node client.mjs` in another terminal, after `npm i @modelcontextprotocol/ext-tasks@0.2.2`. This exact pair was run on Node 26.4.0 on macOS; `isCreateTaskResultV2` and `isDetailedTaskV2` accepted every server response, and the client printed:

```text
task created 326000d9-540d-488b-9dbe-01d4a6c2a8cf working poll every 500 ms
poll -> working Querying rows
poll -> working Querying rows
poll -> input_required Waiting for confirmation
  elicitation/create: report.csv already exists. Overwrite it with 48210 rows?
poll -> working Writing rows
poll -> working Writing rows
poll -> completed
final completed {"content":[{"type":"text","text":"Wrote 48210 rows to report.csv"}],"isError":false}
```

The same run also checked the three refusal paths with `curl`. A `tools/call` without the capability got `-32021` with `requiredCapabilities` in `data`. A `tasks/get` for alice's task sent with a different `Authorization` header got `-32602 "Failed to retrieve task: Task not found"`. And `tasks/cancel` returned `{"resultType":"complete"}`, after which `tasks/get` reported `"status":"cancelled"`.

## When a task is the right shape, and when it is not

Use a task when at least one of these is true:

- **The work routinely outlasts a client timeout.** Builds, data exports, test suites, video renders, crawls, batch LLM jobs. If p95 is above about a minute, assume some client will give up on a blocking call.
- **The result must survive a disconnect.** A laptop closing, a CLI being killed, or a server replica being rotated mid-run. The `taskId` is the only thing in MCP that outlives the request that created it.
- **The work needs a human decision halfway through.** "File exists, overwrite?" after five minutes of querying is exactly what `input_required` is for, and it does not hold a connection open while the human thinks.
- **The work is expensive to repeat.** A retry after a timed-out blocking call usually starts the job again. A task lets the client ask about the job it already paid for.

Skip it when:

- **The tool is fast.** A task costs at least two extra round trips and a storage write. For a three-second lookup that is pure overhead.
- **You only want progress output.** A short blocking call with progress notifications is simpler, and tasks do not support `notifications/progress` anyway.
- **Your clients do not declare the extension.** The docs say host support "varies by client." Since the server may only return a task to a declaring client, a good tool returns a normal result when it can finish inline and creates a task only for declaring clients, or returns `-32021` when the job is too big to do any other way.

That last point means a task-capable tool usually has two paths. Decide per call, based on the expected work and whether this request declared the extension, not with a per-tool flag. The flag was removed for exactly that reason.

## Gotchas that bite in production

**The task store is the hard part.** The in-memory `Map` above works for one process. Real deployments need the task record, its status and its pending `inputRequests` in shared storage, written before the `CreateTaskResult` goes out, because the client's next `tasks/get` can land on any replica. The work itself also needs to run somewhere that outlives the request handler: a queue worker, not a dangling promise.

**Task IDs are bearer tokens.** The spec allows servers to treat them as such, which is why they MUST be unguessable. A UUIDv4 from `crypto.randomUUID()` is fine; an auto-increment ID is not.

**Authorize every task request.** Servers MUST check on every `tasks/get`, `tasks/update` and `tasks/cancel` that the caller may access that task. Return the same "not found" for a task that does not exist and one that belongs to someone else, so the error does not confirm the ID is real.

**TTL is a backstop, not a schedule.** A server may discard a task after `ttlMs` and may mark it `failed` first. Pick a TTL that covers the job plus a realistic delay before the client comes back, and expect `-32602 "Task has expired"` from clients that come back too late.

**Treat `inputRequests` like any other elicitation.** The spec is explicit that a task is not a higher-trust channel. A host should render the same consent UI it would for a direct `elicitation/create`, and should not auto-accept because the request arrived through a poll.

**Do not mix the two input mechanisms.** MRTR before the task exists, `tasks/update` after. An `input_required` task status comes back with `resultType: "complete"` on `tasks/get`; the `"input_required"` result type belongs only to MRTR. Clients that switch on `resultType` alone will get this wrong.

**Do not port `tasks/list` habits.** A UI that shows "my running jobs" now has to remember task IDs on the client side, or get them from an application-level tool of your own that is properly scoped to the authenticated user.

If you are building the server side from scratch, the transport choice still matters: tasks are most useful over Streamable HTTP, where [the stdio vs HTTP tradeoffs](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) decide whether you even have multiple replicas to route across. For contrast with a protocol that made long-running work first-class from day one, the task lifecycle in [A2A vs MCP](/2026/07/a2a-protocol-vs-mcp-agent-to-agent-vs-agent-to-tool/) is a useful comparison.

## Related

- [Fix: a long MCP tool call gets auto-backgrounded after two minutes](/2026/07/fix-long-mcp-tool-call-auto-backgrounded-after-two-minutes/)
- [Stateful vs stateless MCP servers: what breaks when the session goes away](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/)
- [Safe file-write tools for an agent: preview, confirm, apply](/2026/08/safe-file-write-tools-for-an-agent-preview-confirm-apply/)
- [How to build an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)
- [What is the Model Context Protocol and why every IDE is shipping it](/2026/09/what-is-the-model-context-protocol-and-why-every-ide-is-shipping-it/)

## Sources

- [MCP Tasks extension specification, 2026-07-28](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks.html): negotiation, `CreateTaskResult`, `tasks/get`, `tasks/update`, `tasks/cancel`, `notifications/tasks`, error codes and security requirements.
- [SEP-2663: Tasks Extension](https://tasks.extensions.modelcontextprotocol.io/seps/2663-tasks-extension.html), the design rationale for removing `tasks/list` and `tasks/result`.
- [MCP Tasks overview](https://modelcontextprotocol.io/docs/extensions/tasks) and the [ext-tasks repository](https://github.com/modelcontextprotocol/ext-tasks).
- [MCP 2025-11-25: Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks), the experimental in-core version.
- [Key changes in the 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
- [`@modelcontextprotocol/ext-tasks` TypeScript guide](https://tasks.extensions.modelcontextprotocol.io/typescript/).
