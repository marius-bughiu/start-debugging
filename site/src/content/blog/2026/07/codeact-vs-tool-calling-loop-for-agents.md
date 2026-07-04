---
title: "CodeAct vs a Traditional Tool-Calling Loop for Agents: Which Should You Pick in 2026?"
description: "Use CodeAct (the agent writes executable code as its action) when your tasks chain many tools, loop, or move large data, and you can afford a sandbox. Use the JSON tool-calling loop for a handful of discrete, high-stakes actions where a code interpreter is overkill or unsafe. CodeAct wins on token cost and multi-step success rate; tool calling wins on safety and simplicity."
pubDate: 2026-07-04
template: vs
tags:
  - "comparison"
  - "ai-agents"
  - "llm"
  - "mcp"
  - "tool-calling"
  - "anthropic-sdk"
---

There are two ways to let a language model *do* something instead of just talk about it. In the traditional tool-calling loop, the model emits one JSON object per turn (`{"name": "search", "arguments": {...}}`), your harness runs it, feeds the result back, and the loop repeats. In CodeAct, the model writes a snippet of executable code instead. That code calls your tools as ordinary functions, loops, branches, stores intermediate values in variables, and only reports back what matters. The short answer: **reach for CodeAct when a single task fans out into many tool calls, needs control flow, or shovels large payloads between steps, and you can stand up a sandbox to run model-written code. Stick with the JSON tool-calling loop when you have a small set of discrete, auditable actions, or when running arbitrary generated code is a non-starter for security or platform reasons. CodeAct is measurably cheaper and more accurate on multi-step work; the tool-calling loop is simpler and safer per action.**

Everything below is pinned to what is current as of July 4, 2026: the Anthropic Messages API with `claude-opus-4-8` and `claude-sonnet-4-6`, the MCP specification revision `2025-11-25`, Hugging Face `smolagents` 1.x (which ships both a `CodeAgent` and a `ToolCallingAgent`), and the original CodeAct paper, *Executable Code Actions Elicit Better LLM Agents* (Wang et al., ICML 2024, arXiv 2402.01030).

## Two answers to "how does the model act?"

Both patterns end at the same primitive: the model produces a structured request, your code executes it, and the observation goes back into the context. What differs is the *granularity* of a single action.

- **Tool-calling loop**: one action is one function call, described by a JSON schema, chosen from a fixed `tools` array on every request. The model picks a tool, fills in arguments, and stops. Your harness runs exactly that one call, appends the result as a `tool_result` message, and asks the model again.
- **CodeAct**: one action is a block of code. The model can call three tools, filter a list, sum a column, and format a string in a single turn. The code runs in an interpreter, and only whatever the code prints or returns becomes the observation.

That granularity difference is the entire comparison. Everything in the matrix below is downstream of it.

## The feature matrix

| Dimension                         | CodeAct (code actions)                            | Tool-calling loop (JSON)                       |
| --------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| Action unit                       | A code snippet (usually Python/JS)                | One function call as JSON                       |
| Control flow (loops, `if`)        | Native, inside one action                         | Emulated across multiple model turns           |
| Multi-tool composition            | One turn can chain many calls                     | One call per turn                               |
| Turns to finish a multi-step task | ~30% fewer (paper: up to 30%)                     | Baseline                                        |
| Success on complex tool tasks     | Up to ~20 percentage points higher (M3ToolEval)   | Baseline                                        |
| Large intermediate payloads       | Stay in the sandbox, never re-enter context       | Pass through the model on every hop            |
| Execution environment             | Requires a sandboxed interpreter                  | None; harness dispatches calls directly        |
| Provider-enforced structure       | No (code is free-form text, can fail to parse)    | Yes (JSON schema, structured-output modes)     |
| Auditing a single action          | Read the code, then trust the sandbox             | Inspect the exact JSON call before running      |
| Small / weak models               | Degrade faster (bad code fails hard)              | More forgiving (schema constrains them)         |
| Where the paradigm shows up       | `smolagents` `CodeAgent`, OpenHands, MCP code exec | Anthropic/OpenAI tool use, most agent SDKs      |

Version note: all figures in the "success" and "turns" rows come from the ICML 2024 CodeAct evaluation across 17 LLMs on API-Bank and the M3ToolEval benchmark, not from a single model. Re-run them on your own tasks before quoting them as a promise.

## When to pick CodeAct

**Your task is a pipeline, not a single button.** The canonical example is "read a document from one system and write part of it into another." With a tool-calling loop, the model calls `gdrive.getDocument`, the entire transcript lands in context, the model calls `salesforce.updateRecord`, and the transcript passes through the model a second time. With CodeAct the model writes:

```javascript
// smolagents / MCP code-execution style, JS sandbox
const transcript = (await gdrive.getDocument({ documentId: "abc123" })).content;
await salesforce.updateRecord({ objectType: "SalesMeeting", recordId: "d1", data: { Notes: transcript } });
console.log("done");
```

The transcript never re-enters the model. In Anthropic's own "code execution with MCP" writeup (November 2025), a workflow like this dropped from roughly 150,000 tokens to about 2,000, a 98.7% reduction, precisely because the bulky intermediate data stayed inside the execution environment. If your agent moves logs, spreadsheets, search results, or transcripts between tools, CodeAct is the pattern that stops you paying to shuttle them through the model twice. This is the same context-bloat problem that pushes teams to [prune how many MCP tools the model loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/), approached from the data side instead of the tool-definition side.

**The task needs real control flow.** "Fetch every open PR, and for each one whose title starts with `fix:`, add the `bug` label" is a `for` loop with a condition. In a tool-calling loop that is N+1 model turns (list, then one label call per PR, each round-tripping through the model). In CodeAct it is one snippet with a loop, executed once. Fewer turns means fewer model calls, which the paper measured as roughly 30% fewer steps on multi-tool tasks, and, since model calls dominate cost, a proportional cut in spend.

**You already run untrusted code safely.** If you have a container, a WASM runtime, a `pyodide` sandbox, or a Firecracker microVM in your stack, the main objection to CodeAct is already handled. `smolagents` leans into this: its `CodeAgent` is the default agent, and it supports executing generated Python in a sandbox (E2B, Docker, or a restricted local interpreter) precisely because "think in code" is only safe with somewhere safe to run it.

## When to pick the tool-calling loop

**You have a handful of discrete, high-stakes actions.** "Refund this order," "delete this record," "send this email." You want to see the exact JSON, gate it behind an approval, and know that the model cannot do anything the schema does not describe. A JSON call is trivially auditable: the arguments are right there before anything runs. A code action requires you to read and reason about a whole snippet, then still trust the sandbox boundary. For a small set of consequential operations, the loop's per-action clarity beats CodeAct's efficiency, and human-in-the-loop gating slots in naturally, the same way it does for [tool-call permission gates in the Cursor SDK](/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/).

**You cannot run model-written code.** Regulated environments, edge devices, browser extensions with no interpreter, or any deployment where "execute arbitrary generated Python" fails the security review. The tool-calling loop needs no sandbox at all: your harness dispatches named calls to code *you* wrote. That is a smaller attack surface and a much shorter conversation with your security team.

**You are running a smaller or cheaper model.** CodeAct's gains in the paper were "most pronounced with more capable models." Weak models write buggy code that fails hard, and a syntax error costs you a whole turn. A JSON schema, by contrast, constrains a weak model into a valid shape. Providers reinforce this with structured-output and strict-schema modes, so `claude-sonnet-4-6` or a small local model stays on the rails far more reliably emitting JSON than free-form code. The same tradeoff surfaces when you compare [MCP against plain custom tool calling](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/): the more structure the transport enforces, the less the model can go off-script.

## The numbers, and the one that undercuts CodeAct

The CodeAct paper's headline: on M3ToolEval, code actions delivered **up to ~20 percentage points higher success rate** than JSON or text baselines, while using **up to ~30% fewer turns**. Across 17 models on API-Bank the direction held, with the size of the win scaling with model capability.

But there is a catch that lives entirely on the CodeAct side: **parsing**. Because a code action is free-form text, the model can emit something the extractor cannot run. Hugging Face measured this directly when they compared plain `CodeAgent` output to structured code generation (July 2025 "CodeAgents + Structure" writeup). About 2.4% of traces hit a parsing error on the very first call, and that mattered: traces with no first-call parse error succeeded 51.3% of the time versus 42.3% for traces that did, a 21.3% relative swing. Their fix was to make the model emit code inside a structured JSON envelope (thought plus code fields) rather than fishing it out of a markdown block, which recovered 2 to 7 percentage points on average for capable OpenAI and Claude models.

Read that carefully, because it is the crux of the whole comparison: the failure mode CodeAct introduces (unparseable actions) is exactly the failure mode the JSON tool-calling loop was built to eliminate. Providers guarantee well-formed tool calls; nobody guarantees well-formed code. So the honest framing is not "code beats JSON." It is "code beats JSON on multi-step, data-heavy tasks *once you have solved sandboxing and parsing*, and loses on simple, high-stakes, or low-capability setups where JSON's guardrails are worth more than code's expressiveness."

## The gotcha that picks for you

Two constraints override preference:

- **No sandbox, no CodeAct.** If you cannot safely execute model-written code, the decision is made regardless of how attractive the token savings look. Running untrusted code needs sandboxing, resource limits, and monitoring, and those are real infrastructure and real audit burden. If that is off the table, run the tool-calling loop and stop deliberating.
- **Payload size decides cost.** If your intermediate results are small (IDs, short strings, booleans), the tool-calling loop's "everything passes through context" property costs almost nothing, and CodeAct's efficiency edge mostly evaporates. If your intermediates are large (documents, query results, file contents), CodeAct's "keep it in the sandbox" property is the difference between a 2,000-token run and a 150,000-token one.

You do not have to choose globally, either. The modern pattern, and what `smolagents` ships out of the box, is to keep both: a `CodeAgent` for the exploratory, multi-tool, data-wrangling legs of a task, and a `ToolCallingAgent` (or a plain JSON loop) for the discrete, gated, consequential actions. Orchestrating those as separate agents is its own design question, the same tradeoff space as [Claude subagents versus OpenAI Assistants for parallel work](/2026/06/claude-subagents-vs-openai-assistants-for-parallel-work/).

## The recommendation, restated

Default to the **tool-calling loop** when your agent performs a small number of discrete actions, when each action is consequential enough to want auditing and approval, when you are on a smaller model, or when running generated code is unsafe or impossible. Default to **CodeAct** when tasks chain many tools, need loops and conditionals, or move large data between steps, when you are on a capable model like `claude-opus-4-8`, and when you already have a sandbox to run code in. The measured wins (up to 20 points of success rate, around 30% fewer turns, and up to 98.7% fewer tokens on data-heavy workflows) are real, but they are conditional on solving sandboxing and parsing first. If you have not solved those, the JSON loop is not a compromise, it is the correct answer. And whichever you pick, put it behind [an eval harness](/2026/06/llm-as-judge-vs-rule-based-evals-for-a-coding-agent/) before you trust the percentages on your own tasks.

## Related

- [MCP vs OpenAPI Plugins vs Custom Tool Calling for AI Agents](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/)
- [How to Reduce the Number of MCP Tools Claude Loads to Avoid the Tool-Use Limit](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/)
- [Claude Subagents vs OpenAI Assistants for Parallel Work](/2026/06/claude-subagents-vs-openai-assistants-for-parallel-work/)
- [LLM-as-Judge vs Rule-Based Evals for a Coding Agent](/2026/06/llm-as-judge-vs-rule-based-evals-for-a-coding-agent/)
- [How to Gate Cursor SDK Tool Calls with Auto-Review and permissions.json](/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/)

## Sources

- Wang et al., *Executable Code Actions Elicit Better LLM Agents* (ICML 2024), [arXiv:2402.01030](https://arxiv.org/abs/2402.01030) and the [official code-act repo](https://github.com/xingyaoww/code-act).
- Hugging Face, [*CodeAgents + Structure: A Better Way to Execute Actions*](https://huggingface.co/blog/structured-codeagent) and the [`smolagents` library](https://github.com/huggingface/smolagents).
- Anthropic Engineering, [*Code execution with MCP: building more efficient AI agents*](https://www.anthropic.com/engineering/code-execution-with-mcp).
- Model Context Protocol specification, revision [`2025-11-25`](https://modelcontextprotocol.io/).
