---
title: "GitHub Copilot Chat BYOK ist GA in VS Code: Anthropic, Ollama, Foundry Local"
description: "GitHub Copilot für VS Code hat am 22. April 2026 Bring Your Own Key veröffentlicht. Verbinden Sie Ihren eigenen Anthropic-, OpenAI-, Gemini-, OpenRouter- oder Azure-Account mit Chat oder verweisen Sie auf ein lokales Modell via Ollama oder Foundry Local. Die Abrechnung umgeht die Copilot-Quota und läuft direkt über den Anbieter."
pubDate: 2026-04-26
tags:
  - "github-copilot"
  - "vscode"
  - "ai-agents"
  - "ollama"
lang: "de"
translationOf: "2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local"
translatedBy: "claude"
translationDate: 2026-04-26
---

[GitHub hat BYOK für Copilot Chat in VS Code am 22. April 2026 als GA veröffentlicht](https://github.blog/changelog/2026-04-22-bring-your-own-language-model-key-in-vs-code-now-available/). Kurzfassung: Sie können jetzt Ihren eigenen Anthropic-, OpenAI-, Gemini-, OpenRouter- oder Azure-Schlüssel in die Copilot-Chat-UI einbinden und die Anfragen vom Anbieter abrechnen lassen, statt die Copilot-Quota zu verbrauchen. Lokale Modelle funktionieren ebenfalls, über Ollama oder Foundry Local. Das Feature ist GA für Copilot Business und Enterprise und deckt Chat, Plan Agents und Custom Agents ab, nicht aber Inline-Completions.

## Warum das die Copilot-Preisrechnung verändert

Bis zu diesem Release lief Copilot Chat auf dem von Microsoft gehosteten Modell-Pool, und jede Anfrage wurde gegen das monatliche Kontingent Ihres Seats gezählt. Das machte explorative Agenten-Arbeit auf günstigen schnellen Modellen unbequem, ebenso die Nutzung eines Frontier-Modells, für das Ihre Organisation bereits einen Vertrag hat. Mit BYOK absorbiert die bestehende Anthropic- oder Azure-OpenAI-Rechnung Ihrer Organisation die Kosten, und der Copilot-Seat bleibt für das, was er am besten kann: Code Completions, die weiterhin auf den von GitHub gehosteten Modellen laufen. Aus den Release Notes: "BYOK does not apply to code completions" und "usage doesn't consume GitHub Copilot quota allocations."

Das andere wichtige Update ist lokal. Bisher war es ein Forschungsprojekt, Copilot Chat gegen eine Air-Gapped-Ollama-Instanz oder gegen Foundry Local auf einem Entwickler-Laptop laufen zu lassen. Das Feature ist jetzt First-Class.

## Einen Provider einrichten

Öffnen Sie die Chat-Ansicht, klicken Sie auf den Modell-Picker und führen Sie **Manage Models** aus (oder rufen Sie `Chat: Manage Language Models` aus der Command Palette auf). VS Code öffnet den Language-Models-Editor, in dem Sie einen Provider auswählen, einen Schlüssel einfügen und ein Modell auswählen. Modelle erscheinen sofort im Chat-Picker.

Für OpenAI-kompatible Endpunkte, die nicht auf der eingebauten Liste stehen (denken Sie an LiteLLM-Gateways, On-Prem-Inferenz-Proxys oder Azure-OpenAI-Deployments hinter einer benutzerdefinierten URL), lautet der äquivalente `settings.json`-Eintrag:

```jsonc
{
  "github.copilot.chat.customOAIModels": {
    "claude-sonnet-4-6-via-litellm": {
      "name": "claude-sonnet-4-6",
      "url": "https://gateway.internal/v1/chat/completions",
      "toolCalling": true,
      "vision": false,
      "thinking": false,
      "maxInputTokens": 200000,
      "maxOutputTokens": 16384
    }
  },
  "inlineChat.defaultModel": "claude-sonnet-4-6-via-litellm"
}
```

Der Schlüssel liegt weiterhin im Secure Store, nicht in `settings.json`. Die Einstellung beschreibt nur die Form des Modells, damit VS Code weiß, welche Fähigkeiten im Picker zu aktivieren sind (Tool Calling, Vision, Extended Thinking).

Für Ollama richten Sie den Provider auf `http://localhost:11434` und einen Tag wie `qwen2.5-coder:14b` oder `phi-4:14b`. Für Foundry Local steht der OpenAI-kompatible Endpunkt standardmäßig auf `http://localhost:5273/v1`, sobald `foundry service start` läuft.

## Was das für das Tooling von .NET-Teams bedeutet

Zwei praktische Folgen für Teams, die bereits auf Copilot standardisiert haben:

1. Die Einstellung `github.copilot.chat.customOAIModels` ist pro Benutzer in `settings.json`, aber sie ist eine normale VS-Code-Einstellung: Sie kann in einer `.vscode/settings.json`-Vorlage in einem Repo oder in einem [Dev Container](https://code.visualstudio.com/docs/devcontainers/containers)-Image mitreisen. Das heißt, ein `dotnet new` template kann ein Standardmodell für das ganze Team vorverdrahten.
2. Org-Administratoren können BYOK über Copilot policy settings auf github.com deaktivieren, wenn Compliance verlangt, dass der gesamte Traffic auf den von GitHub gehosteten Modellen bleibt. Wenn Sie das für regulierte Workloads abschalten müssen, tun Sie es vor dem Rollout auf Ihre Seats; die Policy aktiviert sich in Business- und Enterprise-Tenants standardmäßig automatisch.

Wenn Sie darauf gewartet haben, die Geschichte rund um [Copilot Agent Skills in Visual Studio 2026](/de/2026/04/visual-studio-2026-copilot-agent-skills/) auszuprobieren, ohne Ihr ganzes Team an die GitHub-gehostete Abrechnung zu binden, ist dies der Schlüssel. Gleiche Agent-Oberfläche, Ihre Rechnung, Ihr Modell.
