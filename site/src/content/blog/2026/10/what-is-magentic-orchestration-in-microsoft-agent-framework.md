---
title: "What Is Magentic Orchestration in Microsoft Agent Framework"
description: "Magentic orchestration is Agent Framework's port of AutoGen's Magentic-One: an LLM manager writes a fact sheet and plan (the task ledger), then grades every round with a JSON progress ledger to pick the next agent, detect stalls and replan. Here is how the loop works on Microsoft.Agents.AI.Workflows 1.24.0 and agent-framework-orchestrations 1.3.1, what it costs per round, and the limit defaults that let it run forever."
pubDate: 2026-10-10
template: how-to
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "llm"
  - "multi-agent"
  - "dotnet"
  - "python"
---

**Short answer:** magentic orchestration is the most autonomous of the five built-in multi-agent patterns in Microsoft Agent Framework. It is a port of AutoGen's [Magentic-One](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html) design: a dedicated manager agent first writes a **task ledger** (a fact sheet plus a bullet-point plan), then runs a coordination loop where, every round, it fills in a **progress ledger** (a five-field JSON verdict: done? looping? progressing? who speaks next? what do I tell them?). When the progress ledger says the team is stuck for too long, the manager wipes the conversation, rewrites facts and plan, and starts again. You use it when the path to the answer is not known up front. On `Microsoft.Agents.AI.Workflows` 1.24.0 (.NET) and `agent-framework-orchestrations` 1.3.1 (Python), both released October 7-8, 2026, the round and reset limits default to **unlimited**, so set them explicitly.

## Where magentic sits among the five patterns

Agent Framework ships sequential, concurrent, handoff, group chat and magentic orchestration. I compared all five side by side in [the orchestration patterns post](/2026/07/agent-framework-orchestration-patterns-compared/); this article goes one level deeper on the last one, because it is the only pattern whose control flow is decided entirely by a model at runtime.

The Microsoft docs describe magentic as having "the same architecture as the Group Chat orchestration pattern, with a very powerful manager." That is accurate. In group chat, the manager is a speaker-selection function: round-robin, or a small prompt that picks the next name. In magentic, the manager is a planner and an auditor. It keeps written state (the two ledgers), judges whether the last turn moved the task forward, and can throw away everything the team said and start over with a revised plan.

If you are still deciding whether you need any of this, the distinction in [AI agent vs AI workflow](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/) applies directly: sequential and concurrent are workflows, magentic is an agent whose "tools" happen to be other agents.

## The two ledgers

Everything magentic does is driven by prompts that are copied almost verbatim from the Magentic-One paper. I read them in the shipped Python source (`agent_framework_orchestrations/_magentic.py`, 1.3.1); the .NET prompts in `MagenticDefaultPrompts.cs` are the same text.

**The task ledger** is built with two model calls when the workflow starts:

1. A "pre-survey" prompt that asks the manager to list facts under exactly four headings: `GIVEN OR VERIFIED FACTS`, `FACTS TO LOOK UP`, `FACTS TO DERIVE`, `EDUCATED GUESSES`.
2. A plan prompt that shows the team (each participant's `name` and `description`) and asks for "a short bullet-point plan", explicitly noting that not every team member has to be used.

The two answers are rendered into one combined message (task, team, facts, plan) and appended to the shared conversation. This is the plan you see in the "plan created" event and the one a human approves during plan review.

**The progress ledger** is produced once per coordination round. The manager receives the full conversation plus a prompt that ends with this schema, which it must answer in pure JSON:

```json
{
  "is_request_satisfied":   { "reason": "string", "answer": false },
  "is_in_loop":             { "reason": "string", "answer": false },
  "is_progress_being_made": { "reason": "string", "answer": true },
  "next_speaker":           { "reason": "string", "answer": "ResearcherAgent" },
  "instruction_or_question":{ "reason": "string", "answer": "Find published training energy figures for BERT-base." }
}
```

The orchestrator then acts on those five answers in a fixed order. This is the whole algorithm, so it is worth reading as code rather than prose. Simplified from `_run_inner_loop_helper` in 1.3.1 (the .NET `RunCoordinationRoundAsync` in 1.24.0 is line-for-line equivalent):

```python
# agent-framework-orchestrations 1.3.1, simplified from MagenticOrchestrator._run_inner_loop_helper
if round_index >= max_round_count or reset_count >= max_reset_count:
    yield_output("Workflow terminated due to reaching maximum round count.")  # or "reset"
    return

round_count += 1
ledger = await manager.create_progress_ledger(context)   # 1 LLM call, up to 3 parse attempts
                                                          # parse failure -> reset and replan

if ledger.is_request_satisfied.answer:
    await prepare_final_answer()                          # 1 LLM call, terminal output
    return

if not ledger.is_progress_being_made.answer or ledger.is_in_loop.answer:
    stall_count += 1
else:
    stall_count = max(0, stall_count - 1)                 # decrements, does not reset to 0

if stall_count > max_stall_count:                         # strictly greater than
    await reset_and_replan()                              # clears history, 2 LLM calls
    return

if ledger.next_speaker.answer not in participants:
    await prepare_final_answer()                          # unknown name ends the run
    return

send(ledger.instruction_or_question.answer, to=ledger.next_speaker.answer)
```

A few things fall out of that code that the docs do not spell out:

- **The stall counter is leaky, not consecutive.** A productive round subtracts one rather than zeroing it, so alternating good and bad rounds never trigger a replan, while three bad rounds and one good one leave you at two.
- **The threshold is "greater than".** With the default `max_stall_count` of 3, the replan fires on the fourth bad round, not the third.
- **A reset is destructive.** `reset_and_replan` clears the manager's chat history and broadcasts a reset signal that wipes every participant's session, then asks for an updated fact sheet ("please at least add or update one educated guess") and a new plan that explains "what went wrong on this last run". Only the facts and plan survive.
- **A hallucinated speaker name ends the run.** If the manager names an agent that does not exist, the orchestrator logs a warning and goes straight to the final answer. Keep participant names short and distinct.

## Building one in Python and C#

Here is the minimum magentic workflow in Python, with the limits set explicitly:

```python
# agent-framework 1.21.0, agent-framework-orchestrations 1.3.1, Python 3.12+
import asyncio, os
from agent_framework import Agent
from agent_framework.foundry import FoundryChatClient
from agent_framework.orchestrations import MagenticBuilder
from azure.identity import AzureCliCredential

client = FoundryChatClient(
    project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"],
    model=os.environ["FOUNDRY_MODEL"],
    credential=AzureCliCredential(),
)

researcher = Agent(name="Researcher", client=client,
    description="Finds facts and sources. Does no math.",
    instructions="You are a researcher. Find information, cite where it came from.")
coder = Agent(name="Coder", client=client,
    description="Writes and runs Python to compute numbers.",
    instructions="Solve quantitative questions with code and show the computation.",
    tools=client.get_code_interpreter_tool())
manager = Agent(name="MagenticManager", client=client,
    description="Coordinates the team.",
    instructions="You coordinate a team to complete complex tasks efficiently.")

workflow = MagenticBuilder(
    participants=[researcher, coder],
    manager_agent=manager,
    max_round_count=12,   # default None = unlimited
    max_stall_count=2,    # default 3
    max_reset_count=2,    # default None = unlimited
).build()

async def main():
    result = await workflow.run("Estimate the CO2 cost of fine-tuning BERT-base for 3 epochs on GLUE SST-2.")
    print(result.get_outputs()[-1])

asyncio.run(main())
```

The `description` fields are not decoration. They are the only thing the manager knows about each participant when it writes the plan and when it picks `next_speaker`, because the team block in both prompts is built from `name: description` pairs.

The .NET equivalent on 1.24.0:

```csharp
// Microsoft.Agents.AI.Workflows 1.24.0, Microsoft.Agents.AI.Foundry, .NET 10
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Specialized.Magentic;
using Microsoft.Extensions.AI;

Workflow workflow = new MagenticWorkflowBuilder(managerAgent)
    .AddParticipants([researcherAgent, coderAgent])
    .RequirePlanSignoff(false)   // default true on .NET, see below
    .WithMaxRounds(12)           // default null = unlimited
    .WithMaxStalls(2)            // default 3
    .WithMaxResets(2)            // default null = unlimited
    .Build();

await using StreamingRun run = await InProcessExecution.RunStreamingAsync(
    workflow, new List<ChatMessage> { new(ChatRole.User, task) });
await run.TrySendMessageAsync(new TurnToken(emitEvents: true));

await foreach (WorkflowEvent evt in run.WatchStreamAsync())
{
    switch (evt)
    {
        case MagenticPlanCreatedEvent created:
            Console.WriteLine($"[plan]\n{created.FullTaskLedger.Text}");
            break;
        case MagenticReplannedEvent replanned:
            Console.WriteLine($"[replan]\n{replanned.FullTaskLedger.Text}");
            break;
        case MagenticProgressLedgerUpdatedEvent progress:
            MagenticProgressLedger l = progress.ProgressLedger;
            Console.WriteLine($"[round] done={l.IsRequestSatisfied} loop={l.IsInLoop} " +
                              $"progress={l.IsProgressBeingMade} next={l.NextSpeaker}");
            break;
        case WorkflowOutputEvent output when output.Is<List<ChatMessage>>():
            Console.WriteLine(output.As<List<ChatMessage>>()!.Last().Text);
            break;
    }
}
```

One correction to the official page: the Microsoft Learn sample still opens with `#pragma warning disable MAAIW001 // Magentic types are experimental`. I compiled the builder, `MagenticPlanCreatedEvent`, `MagenticProgressLedgerUpdatedEvent` and `MagenticPlanReviewRequest` against `Microsoft.Agents.AI.Workflows` 1.24.0 on SDK 10.0.302 with no pragma and got zero diagnostics. My July article, written against 1.13.0, needed the pragma, so it is a leftover. What does still raise a diagnostic is the two newer builder methods, `WithResponseLanguage` and `WithPromptOverrides`, which fail the build with `MAAI001` ("for evaluation purposes only") unless you suppress that ID.

In Python, the three milestones arrive as one event type, `event.type == "magentic_orchestrator"`, whose `event.data.event_type` is `PLAN_CREATED`, `REPLANNED` or `PROGRESS_LEDGER_UPDATED`. In .NET they are three classes that all derive from `MagenticOrchestratorEvent`.

## What a run actually costs

Because the algorithm is explicit, you can count model calls instead of guessing:

| Step | Manager calls | Participant calls |
| --- | --- | --- |
| Initial task ledger | 2 (facts, plan) | 0 |
| Each coordination round | 1 progress ledger (up to 3 if the JSON fails to parse) | 1 |
| Each reset | 2 (updated facts, new plan) | 0 |
| Final answer | 1 | 0 |

So a task that finishes cleanly on round N costs about 2N + 3 model calls. The part that hurts is not the count, it is the input size: every manager call (the progress ledger included) is sent the **entire** shared conversation, and every participant reply is also broadcast to every other participant. Input tokens therefore grow roughly quadratically with the number of rounds. The Python manager deliberately creates a fresh session for every call so the history is not duplicated on top of that (there is a comment in `_complete` referencing regression #4371), but the conversation itself is still resent in full each time.

Practical consequences: give the manager a model that is good at structured JSON and judgment, but you can often give participants a cheaper model. Cap `max_round_count` at a number you are willing to pay for. And do not use magentic for anything a [sequential or handoff pipeline](/2026/08/agent-framework-declarative-yaml-vs-code-first-orchestration/) can express, because those cost one call per step and never resend a growing transcript to a planner.

## Verifying the limit behaviour offline

The limit semantics matter enough that I did not want to trust a reading of the source, so I ran the real `MagenticBuilder` with scripted fake agents (no model, no network). The manager returns canned facts, plan and a progress ledger that always reports `is_in_loop: true`, and counts which prompt it received:

```python
# agent-framework-core 1.21.0, agent-framework-orchestrations 1.3.1, offline
class Scripted:  # satisfies the SupportsAgentRun protocol
    def __init__(self, name, reply):
        self.id = self.name = name; self.description = f"{name} specialist"; self._reply = reply
    def create_session(self, *, session_id=None): return AgentSession(session_id=session_id)
    def get_session(self, service_session_id, *, session_id=None): return AgentSession(session_id=session_id)
    async def run(self, messages=None, *, stream=False, session=None, **kw):
        msg = Message(role="assistant", contents=[self._reply(messages)], author_name=self.name)
        return AgentResponse(messages=[msg])

workflow = MagenticBuilder(
    participants=[Scripted("Researcher", researcher_reply)],
    manager_agent=Scripted("Manager", manager_reply),  # always says "in a loop"
    max_stall_count=1, max_reset_count=2,
).build()
```

Output:

```text
events: {'PLAN_CREATED': 1, 'PROGRESS_LEDGER_UPDATED': 4, 'REPLANNED': 2}
calls:  {'facts': 1, 'plan': 1, 'progress_ledger': 4, 'researcher': 2, 'facts_update': 2, 'replan': 2}
output: Workflow terminated due to reaching maximum reset count.
```

Two things to notice. First, `max_reset_count=2` produced two replans, but the second one was never executed: the limit is checked at the top of the next round (`reset_count >= max_reset_count`), so the run paid two model calls for a plan and then stopped. In effect, `max_reset_count=N` lets N-1 replanned attempts actually run. With `max_stall_count` at its default of 3 and `max_reset_count=1`, the same script took four stalled rounds before the first replan and then terminated immediately after it.

Second, the terminal output is a fixed sentence, not an answer. Hitting a round or reset limit skips `prepare_final_answer` entirely, so the caller gets `"Workflow terminated due to reaching maximum round count."` in Python or `"Task execution stopped due to hitting the maximum round count limit."` in .NET, and whatever the team found is only in the transcript. If you put magentic behind an API, detect that string (or track the round count from the progress events) and decide what to return; do not show it to a user as the result.

A round-limit run (`max_round_count=3`, ledger always "progressing") confirmed the round cap is exact: three progress ledgers, three participant turns, then the termination message.

## Plan review: different defaults per language

Magentic has its own human-in-the-loop hook on top of the generic [tool approval](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/): a person can approve or revise the plan before any participant runs, and again after every stall-triggered replan.

The defaults are opposite. Python has `enable_plan_review=False`. .NET has `RequirePlanSignoff` set to **true**, so a .NET magentic workflow built without calling `.RequirePlanSignoff(false)` will emit a `RequestInfoEvent` carrying a `MagenticPlanReviewRequest` and sit there. If your event loop does not handle it, that looks exactly like a hang.

The request carries the plan, the current progress ledger (null on the first review, populated after a stall) and an `IsStalled` flag. You answer with `request.Approve()` or `request.Revise("feedback")`. A revision is appended to the conversation and triggers another replan and another review, so a reviewer can iterate until they approve. In .NET, the docs' pattern resumes the run from the last checkpoint with `ResumeStreamingAsync` and then calls `SendResponseAsync`, which means plan review effectively requires [checkpointing](/2026/05/agent-framework-durable-workflows-checkpoint-restart/) to be configured; in Python you pass `responses={request_id: response}` into the next `workflow.run(stream=True, ...)` call.

## Customizing the manager

The stock prompts were written for Magentic-One's original four agents (a web surfer, a file surfer, a coder and a terminal), and the docs state plainly that performance outside that design is untested. If your team is different, the manager prompts are the lever:

- **Python:** pass `task_ledger_facts_prompt`, `task_ledger_plan_prompt`, `task_ledger_full_prompt`, `task_ledger_facts_update_prompt`, `task_ledger_plan_update_prompt`, `progress_ledger_prompt` or `final_answer_prompt` to `MagenticBuilder`. A custom progress ledger prompt must still ask for the exact five-field JSON. For full control, subclass `MagenticManagerBase` and implement `plan`, `replan`, `create_progress_ledger` and `prepare_final_answer`.
- **.NET:** `WithPromptOverrides(new MagenticPromptOverrides { ... })` exposes the same seven templates with single-brace placeholders such as `{task}`, `{team}` and `{old_facts}`. A progress ledger override must contain `{schema}`, which is validated at `Build()`. `WithResponseLanguage("German")` forces the ledgers and final answer into one language, which helps with models that answer the JSON reason fields in English even when the task is not. Both methods need `MAAI001` suppressed.

The docs add one rule worth repeating: if you change the initial facts or plan prompt, change the matching update prompt too, or the first replan will revert to the stock format.

In Python, also watch how you pass the manager. `manager_agent=` builds a fresh `StandardMagenticManager` per `build()` while sharing the agent, but `manager=` shares one stateful manager instance across every workflow from that builder. Do not run concurrent workflows on a shared `manager`; use `manager_factory=`. And a built magentic workflow is single-use in both SDKs: sending a second task after it terminates throws "already terminated, create a new workflow instance".

## When magentic is the right choice

Use it when the task is open-ended research or analysis, the steps genuinely depend on what earlier steps find, and you can tolerate a variable number of rounds. The energy-and-CO2 report in Microsoft's sample is a good example: the researcher's findings decide what the coder has to compute.

Skip it when you can draw the flow chart in advance (sequential, concurrent or a declarative workflow), when one agent should own the conversation until it hands off (handoff), or when you only need a few agents to take turns (group chat with a round-robin manager). Also skip it if you need a single capable agent with planning and todos rather than a team; the [Agent Harness](/2026/10/what-is-the-agent-harness-in-microsoft-agent-framework/) gives you a plan/execute loop without paying for a second model to audit every turn.

### Read next

- [Microsoft Agent Framework orchestration: sequential vs concurrent vs group chat vs handoff vs magentic](/2026/07/agent-framework-orchestration-patterns-compared/)
- [What is the Agent Harness in Microsoft Agent Framework](/2026/10/what-is-the-agent-harness-in-microsoft-agent-framework/)
- [What is the difference between an AI agent and an AI workflow](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/)
- [Durable workflows in Agent Framework: checkpoint and restart](/2026/05/agent-framework-durable-workflows-checkpoint-restart/)
- [Declarative YAML workflows vs code-first orchestration](/2026/08/agent-framework-declarative-yaml-vs-code-first-orchestration/)

### Sources

- [Magentic orchestration, Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic) (updated 2026-10-06)
- [Group Chat orchestration, Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat)
- [Magentic-One in AutoGen](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)
- [`MagenticOrchestrator.cs` at dotnet-1.24.0](https://github.com/microsoft/agent-framework/blob/dotnet-1.24.0/dotnet/src/Microsoft.Agents.AI.Workflows/Specialized/Magentic/MagenticOrchestrator.cs)
- [`MagenticWorkflowBuilder.cs` at dotnet-1.24.0](https://github.com/microsoft/agent-framework/blob/dotnet-1.24.0/dotnet/src/Microsoft.Agents.AI.Workflows/MagenticWorkflowBuilder.cs)
- [`agent-framework-orchestrations` 1.3.1 on PyPI](https://pypi.org/project/agent-framework-orchestrations/1.3.1/)
- [Magentic samples, .NET](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/03-workflows/Orchestration/Magentic) and [Python](https://github.com/microsoft/agent-framework/tree/main/python/samples/03-workflows/orchestrations)
