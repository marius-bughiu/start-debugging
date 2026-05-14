---
title: "How to Add Retrieval-Augmented Generation to a Claude Code Session"
description: "A 2026 walkthrough for wiring RAG into Claude Code 2.1.x: when agentic grep stops scaling, how to attach a hybrid BM25 + dense vector MCP server, how to wrap a retrieval CLI in a custom skill, and how Anthropic's contextual embeddings technique pushes recall above 92%. Anchored to claude-sonnet-4-6, claude-opus-4-7, and Claude Context 0.x."
pubDate: 2026-05-14
tags:
  - "claude-code"
  - "mcp"
  - "ai-agents"
  - "rag"
  - "agent-skills"
  - "prompt-caching"
---

Claude Code's default retrieval is agentic file reading: the model sees your directory listing, decides which files to grep, opens them, and feeds the relevant lines back into its own context. On a 5,000-file repo with sane structure that works well, and on the kind of monorepo we covered in [the context window playbook](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) it works well enough once you trim the startup payload. It stops working when the corpus is too big to grep cheaply, when the signal is semantic rather than lexical ("where do we handle idempotency in webhook handlers"), or when the knowledge you need lives outside the repo entirely: design docs, RFCs, vendor SDK docs, an internal wiki. That is where retrieval-augmented generation earns its keep.

The short version: do not bolt a RAG pipeline onto Claude Code until grep stops being good enough. When it does, attach a hybrid search MCP server (BM25 plus dense vectors) instead of trying to stuff a vector store into the system prompt, and prefer Anthropic's contextual embeddings technique over plain chunking. Wrap the retrieval call in a [custom skill](https://code.claude.com/docs/en/skills) so Claude Code triggers it on the right query shapes, not on every turn. This post walks through each layer with the exact configuration to ship, anchored to Claude Code 2.1.x, `claude-sonnet-4-6`, `claude-opus-4-7`, and the open-source [Claude Context MCP server](https://github.com/zilliztech/claude-context).

## When agentic grep is enough, and when it is not

Open Claude Code in a small or medium repo and watch what it does. On a question like "where do we validate the bearer token," it calls `Glob` to find auth-shaped files, opens the two or three with promising names, then quotes the exact validator. No vectors, no embeddings, no index. The reason that works is that 200,000 tokens of context and a few seconds of tool calls cover a surprising amount of code, and the model is genuinely good at picking files to read.

Three failure modes push you past it:

1. **Corpus size**. Once your candidate set exceeds what `Glob` plus a handful of `Read` calls can sift through, Claude spends real money guessing which file to open. A 200k-LOC repo with 40 microservices is firmly in that zone.
2. **Semantic queries**. "Find the queue consumer that handles retries with jitter" is a concept, not a string. There is no grep regex for "retries with jitter," but a dense embedding of the chunk that imports an exponential-backoff helper and registers a consumer will rank correctly.
3. **External knowledge**. Vendor PDFs, your design docs in Notion, last quarter's incident reports, the MCP spec itself. Claude Code cannot grep what is not on disk, and pasting docs into the prompt blows the cache and the budget.

Anthropic's own [contextual retrieval evaluation](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide) ran across nine codebases and 248 queries: a plain dense-vector RAG hit Pass@10 of 87.15%, and the same pipeline with contextual embeddings plus BM25 hybrid search and a reranker hit 95.26%. The takeaway is not "always RAG." It is "if you decide you need retrieval, the difference between a naive RAG and a well-built one is roughly 8 percentage points of recall and a 47% reduction in retrieval failures."

## The cheapest first step: a hybrid-search MCP server

The lowest-effort way to give Claude Code retrieval is to attach an MCP server that already implements hybrid BM25 plus dense vector search and exposes it as a tool. [Claude Context](https://github.com/zilliztech/claude-context) is the reference implementation. It indexes a directory into Milvus or Zilliz Cloud, embeds chunks with OpenAI, VoyageAI, Gemini, or Ollama, and exposes four tools to any MCP client: `index_codebase`, `search_code`, `clear_index`, and `get_indexing_status`.

Installation is a single `claude mcp add` line. The values you pass become environment variables on the server process when Claude Code launches it. If you have not built one of these before, the same pattern is covered end to end in [building a custom MCP server in TypeScript](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) and [the Python SDK equivalent](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/).

```bash
# Claude Code 2.1.x, Claude Context @zilliz/claude-context-mcp@latest, Node 20+
claude mcp add claude-context \
  -e OPENAI_API_KEY=sk-your-openai-api-key \
  -e MILVUS_ADDRESS=your-zilliz-cloud-public-endpoint \
  -e MILVUS_TOKEN=your-zilliz-cloud-api-key \
  -- npx @zilliz/claude-context-mcp@latest
```

After registration, `claude mcp list` shows the server and `claude mcp tools claude-context` shows the four tool names. You index from inside a Claude Code session by asking the model directly, since `index_codebase` is just another tool call:

```text
> Index this repo so we can semantic-search it.
```

Claude calls `index_codebase` with the cwd, the server walks the tree, chunks files (Claude Context uses tree-sitter for AST-aware chunking), embeds each chunk, and writes to Milvus. A 50k-file repo takes a few minutes the first time and is incremental afterwards. From then on, any time Claude wants to find something it can call `search_code` instead of guessing which file to open. The published claim from Zilliz is roughly a 40% token reduction at equivalent retrieval quality versus reading files directly, and that lines up with what I have measured on a 1.2M-LOC repo: search calls cost a few thousand tokens; the file-read fallback on the same query routinely costs 30k.

## Push retrieval into a skill, not the system prompt

Adding the MCP server is necessary but not sufficient. Without nudging, Claude Code will still default to `Glob` and `Read` on small queries, and call `search_code` only when it remembers to. A [custom skill](https://code.claude.com/docs/en/skills) is the right place to encode the policy "when the question is semantic or the repo is large, use the vector index first."

Drop this at `.claude/skills/codebase-rag/SKILL.md` in your repo. The one-line description is what Claude reads at startup to decide whether to load the body of the skill, so it has to advertise the trigger shapes plainly.

```markdown
---
name: codebase-rag
description: Use when the user asks a semantic question about this repo ("where do we X", "how does Y work", "find the code that does Z") or when the candidate file set is larger than ~20 files. Calls the claude-context MCP server's search_code tool with the user's question and returns the top 8 chunks.
---

# Codebase RAG

When the trigger fires:

1. Call `mcp__claude-context__search_code` with the user's natural-language question
   as the query, `limit: 8`, `extension_filter: []`. Do not pre-filter by directory
   unless the user named one.
2. Quote each returned chunk with its file path and line range in the response.
3. Only after reading the chunks, fall back to `Read` on the most relevant 1-2 files
   for full context. Do not blindly Read entire files when search returned an answer.

When NOT to use this skill:

- Questions about a specific file the user already named -- just Read that file.
- Questions about repo conventions captured in CLAUDE.md or .claude/rules/ -- those
  are already loaded.
- Questions about recent changes -- prefer `git log` / `git diff`.
```

Two details matter. First, the description must include concrete trigger phrases ("where do we", "how does", "find the code that"), because skills load on description match. Second, the body explicitly tells the model when not to fire, otherwise you will get retrieval on every turn and burn tokens on irrelevant searches. Skills sit in context across turns once loaded, so brevity here is a recurring cost, as covered in [the SKILL.md best-practices doc](https://code.claude.com/docs/en/skills).

## The quality lever: contextual embeddings, not plain chunks

The default chunking strategy for code is "split the file every N tokens or every function." That is fine for grep-like recall and terrible for semantic recall. A function called `handleRetry` embedded in isolation looks identical to dozens of other `handleRetry` functions across the org. The fix Anthropic shipped in late 2025 and refined through 2026 is [contextual retrieval](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide): before you embed a chunk, prepend a one- or two-sentence description of where it sits in its source file, generated by Claude itself.

The pattern is straightforward. For each chunk you index, send the chunk and the full file to `claude-haiku-4-5` (cheap, fast) with this prompt:

```text
<document>
{full_file_contents}
</document>

Here is the chunk we want to situate within the whole document:
<chunk>
{chunk_contents}
</chunk>

Give a short succinct context to situate this chunk within the overall document
for the purposes of improving search retrieval. Answer only with the context.
```

You get back something like "This chunk is the retry policy for the Stripe webhook consumer in services/billing/webhook.ts; it implements exponential backoff with jitter and is called from the queue handler." Prepend that to the chunk before embedding. Now the embedding captures both the local semantics and the document-level role.

The cost objection vanishes once you turn on [prompt caching](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/). The document is identical across every chunk in the same file, so you mark it as a cache breakpoint and pay full price on the first chunk, then read at a 90% discount on the next dozen. Anthropic's published numbers from their evaluation: on an 800-chunk dataset across nine codebases, 61.83% of input tokens were cache reads, reducing the contextualisation cost from about $9.20 to $2.85. The same caching mechanic powers multi-turn conversations, which we covered in [caching multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/).

The recall payoff against plain RAG on Anthropic's benchmark:

| Pipeline | Pass@10 |
| --- | --- |
| Baseline dense RAG | 87.15% |
| + Contextual embeddings | 92.34% |
| + Contextual + BM25 hybrid | 93.21% |
| + Contextual + BM25 + reranker | 95.26% |

If you build your own indexer instead of using Claude Context off the shelf, contextual embeddings is the single highest-leverage thing you can add. If you stay with Claude Context, the hybrid BM25 + dense path is already on by default, but the contextual prefix is not, and the project has an issue tracking it as a feature request rather than a built-in.

## Indexing external knowledge: docs, RFCs, incident reports

The same MCP server pattern works for non-code knowledge, with one caveat: tree-sitter chunking is the wrong default for prose. For Notion exports, Markdown wikis, or PDFs, run a Markdown-aware splitter (LangChain's `MarkdownHeaderTextSplitter` or LlamaIndex's `MarkdownNodeParser`) and embed at the section level. A simple second MCP server registered under a different name (`claude mcp add docs-rag ...`) keeps the namespaces clean and lets you call `mcp__docs-rag__search` versus `mcp__claude-context__search_code` from the same Claude Code session.

If your docs live in a SaaS with an API (Notion, Confluence, Linear, Slack), the registry at [claude.ai/mcp](https://claude.ai/mcp) lists pre-built MCP servers that surface them as tools. Those are not RAG in the strict sense -- they hit the live API per query -- but they fill the same need: external knowledge accessible by tool call rather than by paste.

## Gotchas

**Stale indexes silently degrade**. Claude Context re-indexes incrementally when you tell it to. It does not watch the filesystem. Add `claude mcp tools claude-context.index_codebase` to your post-merge hook or run it on a scheduled task, otherwise the model will retrieve a function signature from before last week's refactor.

**Embedding model drift**. If you started on `text-embedding-3-small` and switch to VoyageAI's `voyage-code-3`, you must `clear_index` and re-embed. Mixing embedding models in the same collection silently destroys recall because cosine similarity is not comparable across models.

**Skill description false positives**. If your skill description fires on too broad a phrase ("when the user asks about code"), Claude Code will load it on every turn. Watch the cost reports for a week after shipping a new skill and tighten the trigger if you see it loading on unrelated questions.

**Retrieval is not a substitute for CLAUDE.md**. Project conventions, build commands, the prompt-cache breakpoint policy: those belong in `CLAUDE.md` and load deterministically, not in a vector index that might or might not retrieve them. The same logic applies to repo-specific rules covered in [writing a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) and [giving a Copilot agent skill access to your repo conventions](/2026/05/how-to-give-a-copilot-agent-skill-access-to-your-repo-conventions/).

**Hybrid search beats pure vector for code**. Code is full of identifier strings that BM25 ranks correctly and dense embeddings sometimes do not. If you write your own retriever, do not skip BM25 because "we have embeddings now." The Anthropic numbers above show BM25 adds about a point of Pass@10 on top of contextual embeddings; on code-heavy queries the lift is larger.

## Where to go next

Start by attaching `@zilliz/claude-context-mcp` to one repo and a small skill that fires only on semantic questions. Measure tool-call cost for a week against a baseline week without it. If recall is the bottleneck and the corpus is yours to control, layer contextual embeddings on top by running a one-shot indexer that calls `claude-haiku-4-5` per chunk with prompt caching. If the corpus is somebody else's docs, point a second MCP server at it and rely on hybrid search alone -- the contextual-prefix trick mostly pays off on code.

The point is not that every Claude Code session needs a vector index. It is that once you have one, the model stops guessing which file to open, the context window stops filling with `Read` results that turned out to be irrelevant, and the questions you can ask out loud get noticeably harder.

## Source links

- [Claude Code skills documentation](https://code.claude.com/docs/en/skills)
- [Claude Context MCP server](https://github.com/zilliztech/claude-context)
- [Anthropic contextual retrieval cookbook](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide)
- [RAG for Claude projects (Help Center)](https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification)
