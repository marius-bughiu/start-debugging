---
title: "What Is the Difference Between an AI Agent and an AI Workflow?"
description: "In a workflow, your code decides the next step and the model fills in each step. In an agent, the model decides the next step and your code only executes it. That one question (who owns the control flow) determines cost, latency, testability and failure modes. Here is the distinction as Anthropic, Microsoft Agent Framework and LangGraph define it, with the same task built both ways in Python against claude-haiku-4-5 and claude-sonnet-5-5."
pubDate: 2026-10-04
template: vs
tags:
  - "ai-agents"
  - "llm"
  - "microsoft-agent-framework"
  - "anthropic-sdk"
  - "comparison"
---

**Short answer:** the difference is who owns the control flow. In an **AI workflow**, your code decides what happens next: step 1 calls a model, step 2 branches on the result with an `if`, step 3 runs a check, and the path through the program is written down before any request arrives. In an **AI agent**, the model decides what happens next: you hand it a goal and a set of tools, run a loop, and it chooses which tool to call, with which arguments, and when to stop. Both use the same LLM calls and the same tools. A workflow is predictable, cheap and testable but cannot handle a task whose steps you could not list in advance. An agent can, at the price of more tokens, more latency and errors that compound across turns. The code in this post is pinned to the `anthropic` Python SDK 1.11.0, Python 3.14, and the models `claude-haiku-4-5` and `claude-sonnet-5-5`.

## Three vendors, one definition

The terms get used loosely in marketing, but the people who build the frameworks agree on the line. Anthropic's [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (December 2024, still the most-cited reference) calls both kinds "agentic systems" and then splits them:

- Workflows are "systems where LLMs and tools are orchestrated through predefined code paths."
- Agents are systems where the LLM directs "their own processes and tool usage, maintaining control over how they accomplish tasks."

LangGraph's [Workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) page uses nearly the same wording: workflows "have predetermined code paths", agents "define their own processes and tool usage". Microsoft Agent Framework puts it in a decision table on its [overview page](https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview): use an agent when the task is open-ended or conversational and needs autonomous tool use and planning; use a workflow when the process has well-defined steps, you need explicit control over execution order, or multiple agents and functions must coordinate. It also adds the line every team should tape to the wall: if you can write a function to handle the task, write the function.

Notice what none of these definitions mention: the number of model calls, whether tools are involved, or how many "agents" appear in a diagram. A workflow can call five models and fifty tools. An agent can be one model and one tool in a `while` loop. The only test is: **when the program is about to take its next step, is that step chosen by your code or by the model's output?**

## The same task, built both ways

Abstract definitions do not help much when you are staring at a ticket that says "use AI to triage our GitHub issues". So here is that ticket, implemented twice.

### Version 1: a workflow

The task, as a workflow, is three fixed steps: classify the issue, draft a reply with a prompt specific to that class, and check the draft with plain code before posting it. This combines two of Anthropic's workflow patterns, routing and prompt chaining with a gate.

```python
# anthropic 1.11.0, Python 3.14, models claude-haiku-4-5 and claude-sonnet-5-5
import anthropic

client = anthropic.Anthropic()

CLASSIFY_TOOL = {
    "name": "classify_issue",
    "description": "Record the category of a GitHub issue.",
    "input_schema": {
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": ["bug", "feature", "question", "spam"]},
        },
        "required": ["category"],
    },
}

def classify(issue: str) -> str:
    # Step 1: routing. A small model, forced to answer through one tool.
    resp = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=100,
        tools=[CLASSIFY_TOOL],
        tool_choice={"type": "tool", "name": "classify_issue"},
        messages=[{"role": "user", "content": issue}],
    )
    return next(b.input["category"] for b in resp.content if b.type == "tool_use")

def draft_reply(issue: str, category: str) -> str:
    # Step 2: one specialised prompt per route.
    prompts = {
        "bug": "Ask for a minimal repro, the version, and the OS. Do not promise a fix.",
        "feature": "Thank the author and point them to the roadmap discussion.",
        "question": "Answer briefly and link the docs if you can.",
    }
    resp = client.messages.create(
        model="claude-sonnet-5-5",
        max_tokens=400,
        system=prompts[category],
        messages=[{"role": "user", "content": issue}],
    )
    return resp.content[0].text

def gate(reply: str) -> bool:
    # Step 3: a programmatic check. Plain code, no model call.
    return 0 < len(reply) < 1200 and "I will fix" not in reply

def triage(issue: str) -> dict:
    category = classify(issue)
    if category == "spam":
        return {"action": "close", "category": category}
    reply = draft_reply(issue, category)
    if not gate(reply):
        return {"action": "escalate_to_human", "category": category}
    return {"action": "comment", "category": category, "body": reply}
```

Look at where the decisions live. The model produces a category, but it is forced (`tool_choice` with a named tool) to pick from an enum your code defined. The branch on `"spam"` is a Python `if`. The gate is a Python function. Every issue, no matter what it says, costs at most two model calls, and you can enumerate every path through `triage()` on a whiteboard. When I ran this with a scripted client, the call log was exactly `['claude-haiku-4-5', 'claude-sonnet-5-5']`, and it will be that for every bug report you ever feed it.

This is still "AI". The model is doing real work in both calls. It is just not steering.

### Version 2: an agent

Now change the ticket. Product wants triage to go further: for a bug report, find the code responsible and say whether the existing tests already reproduce it. You cannot write that as a fixed chain. How many files to search, which one to open, whether to run the tests before or after reading the code: all of that depends on the issue text and on what the first search returns. So you hand the model tools and a loop:

```python
# anthropic 1.11.0, Python 3.14, model claude-sonnet-5-5
import subprocess
import anthropic

client = anthropic.Anthropic()

TOOLS = [
    {
        "name": "grep",
        "description": "Search the repository with a regex. Returns matching lines as path:line:text.",
        "input_schema": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}},
            "required": ["pattern"],
        },
    },
    {
        "name": "read_file",
        "description": "Read a UTF-8 text file from the repository.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "run_tests",
        "description": "Run the test suite. Returns the last 50 lines of output.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

def run_tool(name: str, args: dict) -> str:
    if name == "grep":
        out = subprocess.run(["git", "grep", "-n", "-E", args["pattern"]],
                             capture_output=True, text=True)
        return out.stdout[:8000] or "no matches"
    if name == "read_file":
        with open(args["path"], encoding="utf-8") as f:
            return f.read()[:20000]
    if name == "run_tests":
        out = subprocess.run(["pytest", "-q"], capture_output=True, text=True)
        return "\n".join((out.stdout + out.stderr).splitlines()[-50:])
    return f"unknown tool {name}"

def investigate(issue: str, max_turns: int = 15) -> str:
    messages = [{"role": "user", "content": issue}]
    for _ in range(max_turns):
        resp = client.messages.create(
            model="claude-sonnet-5-5",
            max_tokens=2000,
            system="You are triaging a bug report. Find the code responsible and "
                   "say whether the existing tests reproduce it. Stop when you know.",
            tools=TOOLS,
            messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason != "tool_use":
            return "".join(b.text for b in resp.content if b.type == "text")
        results = [
            {"type": "tool_result", "tool_use_id": b.id, "content": run_tool(b.name, b.input)}
            for b in resp.content if b.type == "tool_use"
        ]
        messages.append({"role": "user", "content": results})
    return "Stopped: turn budget exhausted."
```

Your code no longer contains the plan. It contains a loop, a tool dispatcher and a stopping condition. The model reads the issue, decides to `grep`, reads the matches, decides which file to open, and decides when it knows enough to stop (signalled by a `stop_reason` other than `tool_use`). Anthropic's own summary of an agent is exactly this: "LLMs using tools based on environmental feedback in a loop." The `max_turns` cap is not decoration. It is the only part of the control flow you still own, which is why Anthropic recommends "stopping conditions (such as a maximum number of iterations) to maintain control."

## What changes when the model owns the control flow

Moving the `if` statements from your code into the model's output changes almost every operational property of the system.

**Cost becomes a distribution instead of a number.** The workflow above costs one Haiku call plus one Sonnet call, every time. At current list prices (Haiku 4.5 at $1 input / $5 output per million tokens, Sonnet 5.5 at $2 / $10, per the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)), you can multiply that by your issue volume and get a budget. The agent's cost depends on how many turns it takes, and every turn re-sends the whole growing transcript, including every file it has read. A three-turn investigation and a fifteen-turn one can differ by an order of magnitude. Prompt caching softens the re-send cost but does not change the shape.

**Latency follows the same pattern.** The workflow has a fixed critical path. The agent's wall-clock time is the sum of however many sequential model round trips it chooses to make.

**Testing changes category.** You can unit-test `triage()` by stubbing two calls and asserting on the returned dict, and the test covers every path. You cannot enumerate the agent's paths, so you test it statistically: a fixed set of issues, run many times, scored on outcome. That is what an [LLM-as-judge eval harness](/2026/05/how-to-set-up-an-llm-as-judge-eval-harness-for-a-coding-agent/) is for, and you need one before you ship an agent, not after.

**Errors compound.** In the workflow, a bad classification produces one bad reply, and the gate may catch it. In the agent, a wrong conclusion on turn 2 ("the bug is in `parser.py`") shapes every following turn, and the agent will often defend it. Anthropic flags "the potential for compounding errors" as the main reason to test agents in a sandbox with guardrails.

**Observability needs more than logs.** A workflow's trace is the same shape every run. An agent's trace is a transcript, and debugging means reading it. Anthropic's principle of "explicitly showing the agent's planning steps" exists because of this.

**Security exposure grows with autonomy.** The workflow's model can only produce a category and some text. The agent's model chooses arguments to `subprocess.run`. Every tool you give an agent is an action an attacker can try to trigger through the issue text. Constrain the tools (here, `git grep` with no shell, a read-only file reader) rather than trusting the prompt to constrain the model.

## How to decide which one you need

Ask these in order, and stop at the first "yes":

1. **Can you write the whole task as a normal function?** Then do that. No model at all. Microsoft's docs say this explicitly, and it is the cheapest, fastest and most reliable option on the list.
2. **Does one model call with good context solve it?** Anthropic notes that "for many applications, however, optimizing single LLM calls with retrieval and in-context examples is usually enough." Summarising a diff, extracting fields, rewriting text: one call.
3. **Can you list the steps before you see the input?** Then build a workflow. Routing, chaining, parallel sectioning, voting and evaluator-optimizer loops are all workflows, because your code still decides when each one runs and when it ends.
4. **Does the number and order of steps depend on what the earlier steps discover?** Then you need an agent. Debugging, codebase investigation, research across unknown sources and anything that looks like "figure out what's wrong" fall here.

A quick smell test: if you find yourself writing a prompt that says "first do X, then do Y, then do Z" to an agent, you have written a workflow in English and handed it to a component that may not follow it. Move those steps into code.

## The middle ground is where most production systems live

Real systems rarely sit at either end. The common shape is a workflow on the outside with an agent inside one bounded step. For the triage example, that looks like this:

```python
# anthropic 1.11.0, Python 3.14
from workflow import classify, draft_reply, gate
from agent import investigate

def triage_with_investigation(issue: str) -> dict:
    category = classify(issue)                     # workflow: fixed step
    if category != "bug":
        return {"action": "comment", "category": category,
                "body": draft_reply(issue, category)}
    findings = investigate(issue, max_turns=10)    # agent: bounded autonomy
    reply = draft_reply(issue + "\n\nInvestigation:\n" + findings, category)
    if not gate(reply):                            # workflow: code-owned check
        return {"action": "escalate_to_human", "category": category}
    return {"action": "comment", "category": category, "body": reply}
```

The outer program guarantees that spam never reaches the expensive agent, that the agent's turn budget is capped, and that nothing gets posted without passing a deterministic check. The agent gets autonomy only where autonomy is actually required.

Anthropic's orchestrator-workers pattern is the interesting edge case. A central model "dynamically breaks down tasks" and delegates to workers, so the model chooses the subtasks, yet Anthropic still files it under workflows because the orchestration scaffolding (fan out, collect, synthesise) is fixed code. If you want a precise rule: the more of the plan the model chooses, the further you are toward the agent end, and the line is less a wall than a slider.

Frameworks increasingly model this explicitly. Microsoft Agent Framework has separate `Agent` and `Workflow` types, and a workflow node can be an agent; its [orchestration patterns](/2026/07/agent-framework-orchestration-patterns-compared/) (sequential, concurrent, handoff, group chat, magentic) sit at different points on the slider, with sequential fully code-driven and magentic letting a manager model plan. Whether you author that graph in [declarative YAML or code](/2026/08/agent-framework-declarative-yaml-vs-code-first-orchestration/) does not change which side of the line each node sits on.

## Product names that blur the line

Part of the confusion is that vendors name things for marketing, not for this taxonomy. Three examples you will run into:

- **GitHub Agentic Workflows** are a GitHub Actions workflow (fixed trigger, fixed permissions, fixed `safe-outputs` step) that runs a coding agent in the middle. That is the hybrid pattern above, with the outer workflow enforcing what the agent may write. The [setup without a PAT](/2026/06/github-agentic-workflows-without-a-personal-access-token/) shows how the outer layer constrains the inner one.
- **Claude Code Dynamic Workflows** have the model *write* a JavaScript orchestration script that fans out subagents. The script, once written, is a workflow. The decision to write it, and what to put in it, is agentic. It is a nice illustration of the slider: [Dynamic Workflows](/2026/05/claude-code-dynamic-workflows-opus-4-8/) let an agent generate a workflow at runtime.
- **"AI agent" in a no-code tool** often means a fixed sequence of LLM steps with a chat box in front. By the definition above, that is a workflow, and that is usually a good thing.

When someone says "we built an agent", ask the one question: who picks the next step? The answer tells you how to test it, how to budget for it and how it will fail.

## Gotchas when moving between the two

- **Do not give a workflow step tools it does not need.** If the classification call can see a `run_tests` tool, it may call it, and your "fixed" step now has a variable cost. Force the tool (`tool_choice`) or pass none.
- **An agent without a turn cap is a billing incident.** Always bound `max_turns` and check `stop_reason`. A response that stops on `max_tokens` mid tool call is neither finished nor safe to continue blindly.
- **Agents read their tool output as instructions sometimes.** A file containing "ignore previous instructions" is untrusted input that reaches the model. Keep side-effecting tools behind a code-owned approval step.
- **Measure before you promote a workflow to an agent.** Anthropic's advice is to add complexity "only when it demonstrably improves outcomes." Run both versions over the same eval set and compare success rate against cost per task. Often the workflow plus one extra route wins.
- **Consider whether the agent should write code instead of calling tools.** For agents that chain many tool calls, [CodeAct versus a classic tool-calling loop](/2026/07/codeact-vs-tool-calling-loop-for-agents/) can cut turns sharply, which addresses the cost and latency problems directly.
- **Depth multiplies everything.** An agent that spawns agents multiplies the cost and the compounding-error risk at every layer. The [nested subagent depth analysis](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/) has numbers.

## Related

- [CodeAct vs a traditional tool-calling loop for agents](/2026/07/codeact-vs-tool-calling-loop-for-agents/)
- [Microsoft Agent Framework orchestration: sequential vs concurrent vs group chat vs handoff vs magentic](/2026/07/agent-framework-orchestration-patterns-compared/)
- [Declarative YAML workflows vs code-first orchestration in Microsoft Agent Framework](/2026/08/agent-framework-declarative-yaml-vs-code-first-orchestration/)
- [How to set up an LLM-as-judge eval harness for a coding agent](/2026/05/how-to-set-up-an-llm-as-judge-eval-harness-for-a-coding-agent/)
- [Nested subagent hierarchies: when delegation depth helps and when it burns tokens](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/)

## Sources

- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (December 19, 2024)
- Microsoft Learn, [Microsoft Agent Framework overview: when to use agents vs workflows](https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview)
- LangChain, [LangGraph: Workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents)
- Anthropic, [Tool use with Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- Anthropic, [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) and [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
