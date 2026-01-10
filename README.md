# start-debugging (content ops + tooling)

This repo is the working set for the **Start Debugging** daily publishing workflow:

- **Strategy + prompts** live in `content-strategy/`
- **Tiny PowerShell helpers** live in `tools/`

## Daily workflow (fast path)

1. Get a shortlist of recent candidate topics (ranked):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\sd-daily.ps1 -Top 10
```

2. If you already have keywords, run the built-in duplication checks:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\sd-daily.ps1 -Keywords dotnet,grpc,containers -Top 10
```

3. Create a draft file from a title:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\new-draft.ps1 -Title "gRPC in Containers: 4 traps in .NET 9/.NET 10"
```

4. Open `content-strategy/daily-prompt.md`, follow the prompt, and publish.

## Key files

- `content-strategy/daily-prompt.md`: the master prompt used each day
- `content-strategy/style-guide.md`: voice + formatting rules
- `content-strategy/tips-and-tricks.md`: research workflow + tool recipes
- `content-strategy/drafts/`: generated draft markdowns

