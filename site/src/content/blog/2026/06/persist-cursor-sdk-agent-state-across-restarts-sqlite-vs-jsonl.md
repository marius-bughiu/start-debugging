---
title: "How to Persist Cursor SDK Agent State Across Restarts (SQLite vs JSONL vs a Custom LocalAgentStore)"
description: "The Cursor SDK already persists agent state to disk so Agent.resume() can pick a conversation back up after a crash. This walks the SqliteLocalAgentStore default, the JsonlLocalAgentStore you can commit to git, and how to implement the LocalAgentStore interface for Postgres, Redis, or an in-memory CI store."
pubDate: 2026-06-15
tags:
  - "cursor"
  - "ai-agents"
  - "typescript"
  - "mcp"
---

If you build anything real on top of `@cursor/sdk`, the first hard question is not "how do I call the model" but "what happens when the process that owns the agent dies." A long-running run gets killed by a deploy, a CI job restarts, a worker crashes mid-task: where did the conversation go, and can you continue it? As of the June 4, 2026 update (`@cursor/sdk@1.0.16`, with the matching Python `cursor-sdk@0.1.6`), the answer is built in. Local agents persist their state to disk, `Agent.resume("agent-id")` reattaches to it, and you get to choose the storage backend: the default `SqliteLocalAgentStore`, a git-friendly `JsonlLocalAgentStore`, or your own implementation of the public `LocalAgentStore` interface. This post covers all three, what actually gets persisted, and which one to reach for.

The short version: SQLite is the right default for a long-lived process that owns one directory and resumes agents often. JSONL is for CI and audit trails you want to read, diff, and commit. A custom store is for when agent state has to live next to the rest of your data in Postgres or be thrown away entirely between test runs.

## What "agent state" actually means in the SDK

Before picking a backend it helps to know what the SDK is writing, because the store is not a single conversation blob. The `LocalAgentStore` interface is four sub-stores, each owning one category of data:

```typescript
// @cursor/sdk@1.0.16
interface LocalAgentStore {
  readonly agents: LocalAgentStoreAgents;
  readonly checkpoints: LocalAgentStoreCheckpoints;
  readonly runs: LocalAgentStoreRuns;
  readonly runEvents: LocalAgentStoreRunEvents;
}
```

Each one has a distinct job:

- **agents** holds the metadata row per agent, including a pointer to its latest conversation checkpoint. This is the index you look up by agent ID on `Agent.resume()`.
- **checkpoints** holds content-addressed conversation blobs. A checkpoint is the full conversation state the model finished a run with, so the next `send()` can replay it. Because they are content-addressed, identical state is not stored twice.
- **runs** holds one row per run (one `agent.send()` produces one run), with execution metadata.
- **runEvents** is the append-only event log: the per-step stream of assistant tokens, tool calls, thinking, and status updates that you also see live through `run.stream()`.

The split matters for the comparison below. The catalog sub-stores (`agents`, `checkpoints`, `runs`) are random-access lookups keyed by ID and paginated with an opaque `cursor` / `nextCursor`. The `runEvents` log is an append-only stream resumed with an exclusive `afterOffset` / `nextOffset`. SQLite serves both shapes well from one file. A flat JSONL file serves the append-only log naturally and the random lookups by scanning. That is the whole tradeoff in one sentence, and everything below is the detail.

This is the persistence story for **local** agents specifically. Cloud agents (the ones you get by swapping `local` for `cloud`, the same runtime you use when you [hand a Jira ticket to a Cursor cloud agent](/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/)) persist their state server-side automatically, so none of the store configuration here applies to them. Stores are a local-agent concern.

## The default you already have: SqliteLocalAgentStore

If you have written agents with the SDK since the [TypeScript SDK launch](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/) and never thought about persistence, you have been using `SqliteLocalAgentStore` the whole time. The SDK writes an on-disk SQLite database under your state root (in your home directory) and every `agent.send()` checkpoints into it. You do not have to configure anything to get resume to work:

```typescript
// @cursor/sdk@1.0.16
import { Agent } from "@cursor/sdk";

// Process A: create an agent and run a task, then exit.
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: { cwd: process.cwd() },
});

const run = await agent.send("Refactor the auth module to use the new token service");
await run.wait();

console.log("Resume later with:", agent.id);
// e.g. "Resume later with: a1b2c3..."
```

Now the process can die. In a completely separate process, days later, you reattach by ID:

```typescript
// @cursor/sdk@1.0.16
import { Agent } from "@cursor/sdk";

// Process B: pick the same conversation back up.
const agent = await Agent.resume("a1b2c3...", {
  apiKey: process.env.CURSOR_API_KEY!,
});

const run = await agent.send("Now add tests for the change you just made");
await run.wait();
```

`Agent.resume(agentId, options?)` loads the agent row, finds its latest checkpoint, and hands that conversation to the model, so the follow-up `send()` sees the same context the previous run finished with. The SDK infers the runtime from the ID: a `bc-` prefix means a cloud agent (resumed against Cursor's servers), anything else is a local agent (resumed against your store). You do not pick local vs cloud on resume; the ID encodes it.

One gotcha that bites people immediately: **inline `mcpServers` are not persisted across `Agent.resume()`.** If you configured MCP servers by passing them inline at `Agent.create()`, the resumed agent will not have them. Either pass them again on the resume call, or configure them through a file-based `.cursor/mcp.json` so they are picked up fresh every time. Custom tools defined via `local.customTools` are in the same boat; like the MCP servers behind [`local.customTools`](/2026/06/expose-functions-to-cursor-sdk-agent-with-local-customtools/), they are a property of the live process, not of the stored conversation. The store remembers what the model said and did, not how you wired the process.

SQLite is the right default for exactly the reason it is the default: it is a single file, it indexes lookups by agent ID, it handles concurrent reads, and its write locking keeps one process from corrupting the database. The costs are that the file is binary (you cannot `git diff` it or `grep` it), and it pulls in a native `sqlite3` dependency, which is occasionally annoying in slim container images or serverless bundles.

## JsonlLocalAgentStore: state you can read, diff, and commit

The June update added a second built-in store you opt into explicitly. `JsonlLocalAgentStore` writes the same four sub-stores as newline-delimited JSON files (`agents.ndjson`, `runs.ndjson`, `run_events.ndjson`, `checkpoints.ndjson`) in a directory you choose. Both stores are exported directly from the package, so switching is one import and one config field:

```typescript
// @cursor/sdk@1.0.16
import { Agent, JsonlLocalAgentStore } from "@cursor/sdk";

const store = new JsonlLocalAgentStore("/var/lib/cursor-agents");

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: { cwd: process.cwd(), store },
});
```

Everything else is identical: `agent.send()`, `run.stream()`, and `Agent.resume()` all behave the same. The difference is entirely in what lands on disk. Instead of an opaque SQLite file you get plain text you can `cat`, `tail -f`, `jq`, and check into version control.

That last property is the reason to choose it. If you have ever wanted the full transcript of what an agent did as a reviewable artifact, append-only JSONL is the same format the broader tooling has converged on. It is why [Claude Code logs sessions as JSONL](/2026/04/export-claude-code-conversations-to-pdf-with-jsonl-to-pdf/) and why .NET shipped [first-class JSON Lines serialization in System.Text.Json](/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/). One JSON object per line, append-only, streams cleanly, diffs cleanly.

The flip side is real and worth pinning before you ship it as your primary store:

- **It grows unbounded.** Append-only means checkpoints and run events accumulate; nothing is compacted or vacuumed for you. A chatty agent over weeks produces large `run_events.ndjson`. Plan a rotation or retention step.
- **Random lookups scan.** Resuming agent `a1b2c3` by ID means reading `agents.ndjson` to find the latest record for that ID. SQLite indexes this; JSONL walks the file. Fine for tens or hundreds of agents, slower as the file grows into the thousands.
- **Concurrent writers are risky.** A single SQLite file has real locking. Plain append from two processes into the same `.ndjson` can interleave writes. Treat a JSONL store as owned by one writer process at a time.

So the honest rule: reach for `JsonlLocalAgentStore` when the transcript is the point. CI runs where you want to upload the agent log as a build artifact, debugging sessions where you want to eyeball exactly what the model did, audit trails you commit to a repo. Stay on SQLite when the store is hot infrastructure that one long-lived process hammers with resumes and lookups.

## Setting a store once for the whole process

Passing `store` on every `Agent.create()` gets repetitive. `Cursor.configure()` sets a process-wide default that every later `Agent.create()` inherits unless it overrides:

```typescript
// @cursor/sdk@1.0.16
import { Cursor, Agent, JsonlLocalAgentStore } from "@cursor/sdk";

Cursor.configure({
  local: { store: new JsonlLocalAgentStore("/var/lib/cursor-agents") },
});

// Inherits the JSONL store automatically.
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: { cwd: process.cwd() },
});
```

Clear it back to the SQLite default with `Cursor.configure({ local: { store: null } })`. This is the cleanest place to switch backends by environment: JSONL when `process.env.CI` is set, SQLite (or your own store) in production, decided once at startup instead of threaded through every call site.

## Implementing a custom LocalAgentStore

When neither default fits, you implement the public `LocalAgentStore` interface and pass your instance through `local.store`. The two cases that justify the work:

1. **Postgres-backed persistence**, so agent state lives in the same database as the rest of your application data and participates in your backups, replication, and access control instead of sitting in a file on one box.
2. **An in-memory store for ephemeral CI**, where you want resume to work within a single run but want zero disk artifacts and zero cleanup afterward.

You do not have to assemble the four-substore object by hand from scratch. The SDK exports `composeLocalAgentStore`, which builds a `LocalAgentStore` from four sub-store implementations:

```typescript
// @cursor/sdk@1.0.16
import { composeLocalAgentStore } from "@cursor/sdk";

const store = composeLocalAgentStore({
  agents: myAgentsTable,
  checkpoints: myCheckpointBlobs,
  runs: myRunsTable,
  runEvents: myRunEventLog,
});
```

Each catalog sub-store (`agents`, `checkpoints`, `runs`) implements a small CRUD surface: fetch by ID, upsert a record, and list with `cursor` / `nextCursor` pagination. The `runEvents` sub-store is append-only: append events and read from an exclusive `afterOffset`, returning a `nextOffset` for the next page. Here is the shape of an in-memory implementation, the kind you would back a CI run with. Treat it as the structure, and check the field-by-field method names against the [SDK reference](https://cursor.com/docs/sdk/typescript) for your installed version, since the exact surface is still moving in beta:

```typescript
// @cursor/sdk@1.0.16 - illustrative in-memory store for ephemeral CI
import { composeLocalAgentStore } from "@cursor/sdk";

function inMemoryCatalog<T extends { id: string }>() {
  const rows = new Map<string, T>();
  return {
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async put(row: T) {
      rows.set(row.id, row);
    },
    async list(_cursor?: string) {
      return { items: [...rows.values()], nextCursor: undefined };
    },
  };
}

function inMemoryEventLog() {
  const events: unknown[] = [];
  return {
    async append(batch: unknown[]) {
      events.push(...batch);
    },
    async read(afterOffset = 0) {
      return { items: events.slice(afterOffset), nextOffset: events.length };
    },
  };
}

const store = composeLocalAgentStore({
  agents: inMemoryCatalog(),
  checkpoints: inMemoryCatalog(),
  runs: inMemoryCatalog(),
  runEvents: inMemoryEventLog(),
});
```

Pass that `store` through `local.store` (or `Cursor.configure`) and `Agent.resume()` works within the process lifetime, with nothing written to disk and nothing to clean up. Swap the `Map`s and the array for Postgres tables and an event table and you have durable, query-able agent state that lives next to your application data. Because the interface is just CRUD plus an append log, the Postgres version is mostly schema and SQL, not SDK-specific cleverness.

One detail that helps when you build the Postgres version: every `send()` now carries a platform-generated `requestId` that persists across all store types. Store it on the run row and you can correlate a specific agent turn with your backend logs, traces, and billing, which is the kind of join you only appreciate when you are debugging a run that went sideways three days ago.

## Picking the backend

Map the choice to how the process lives, not to which store looks fanciest:

- **One long-lived process, frequent resumes, many agents:** stay on the default `SqliteLocalAgentStore`. Indexed lookups, real write locking, one file. You already have it.
- **CI, debugging, or audit where the transcript is the deliverable:** `JsonlLocalAgentStore`. Commit it, `jq` it, upload it as an artifact. Budget for file growth and keep it to one writer.
- **Distributed workers, or state that must live with your app data:** a custom `LocalAgentStore` over Postgres, built with `composeLocalAgentStore`. Durable, query-able, backed up with everything else.
- **Ephemeral tests that need resume but no artifacts:** a custom in-memory store. Resume works for the process lifetime, nothing touches disk.

The deeper point is that persistence is the piece that turns the SDK from a request/response client into something you can build a service on. A model call you can retry. An agent whose conversation survives a crash is infrastructure. If you are wiring that infrastructure up, it is worth contrasting this disk-backed checkpoint model with the API-level approach of [caching multi-turn Claude conversations across calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/): the Cursor SDK persists the whole conversation as a resumable checkpoint, while raw provider SDKs leave you to re-send the transcript and lean on prompt caching to keep the cost down. Same goal, two layers.

The authoritative reference for the exact `LocalAgentStore` method surface is the [Cursor TypeScript SDK docs](https://cursor.com/docs/sdk/typescript), and the [June 2026 SDK changelog](https://cursor.com/changelog/sdk-updates-jun-2026) is where JSONL stores, custom stores, custom tools, and auto-review all landed in the same release.
