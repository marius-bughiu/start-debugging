---
title: "Visual Studio 18.9 erlaubt den Denkaufwand pro Modell"
description: "Visual Studio 18.9 Insiders 2 ergänzt eine Steuerung des Denkaufwands pro Modell, mit Stufen von Low bis Max, und legt damit denselben Parameter offen, den die Modell-APIs bereits entgegennehmen."
pubDate: 2026-07-30
tags:
  - "visual-studio"
  - "ai-agents"
  - "dotnet"
  - "copilot"
lang: "de"
translationOf: "2026/07/visual-studio-18-9-thinking-effort-control-per-model"
translatedBy: "claude"
translationDate: 2026-07-30
---

Am 2026-07-29 veröffentlichte Rachel Kang [Tell your model when to think harder](https://devblogs.microsoft.com/visualstudio/tell-your-model-when-to-think-harder/), und die dort beschriebene Funktion ist interessanter, als der Titel vermuten lässt. Ab **Visual Studio 18.9 Insiders 2** verfügen unterstützte Modelle über eine Steuerung des Denkaufwands, und sie wird pro Modell gesetzt, nicht pro Anfrage.

## Modellwahl und Denktiefe sind nicht mehr dieselbe Entscheidung

Bisher entschied die Modellwahl in Visual Studio zwei Dinge gleichzeitig: welche Gewichte Ihre Frage beantworten und wie viel Reasoning vor der Antwort stattfindet. Wenn ein Modell tief nachdachte, zahlte jeder Prompt der Art "benenne diese Variable um" dafür mit.

Die Trennung bedeutet, dass Sie dasselbe Modell für eine ganze Sitzung behalten und stattdessen den Regler verschieben. Die Stufen sind:

- **Low**: "Quick responses with minimal reasoning", und es verbraucht weniger AI-Credits.
- **Medium**: "Balanced reasoning and speed, and usually the default."
- **High**: tieferes Reasoning, für einen kniffligen Algorithmus, eine Architekturentscheidung oder einen Bug, den Sie nicht eingrenzen können.
- **Extra High** und **Max**: "The most reasoning some models offer, for the gnarliest problems."

Modelle ohne Denksteuerung zeigen einen Bindestrich und arbeiten weiter wie bisher. Die Steuerung kommt also hinzu und ändert nicht das Verhalten auf breiter Front.

## Wo die Einstellung liegt

Öffnen Sie die Modellauswahl, klicken Sie auf **Manage models**, um das erweiterte Fenster zur Modellverwaltung aufzurufen, und stellen Sie dort die Denkstufe je Modell ein. Sie ist nicht unter Tools > Options versteckt und kein Schalter pro Prompt.

## Die Leiter stammt vom Anbieter, nicht von Visual Studio

Low, Medium, High, Extra High, Max sind keine fünf Namen, die Microsoft für einen Schieberegler erfunden hat. Es ist der Reasoning-Aufwand-Parameter, den die Modell-APIs bereits entgegennehmen, sichtbar gemacht in der IDE. In der Anthropic-API liegt der Aufwand innerhalb von `output_config` und akzeptiert genau `low`, `medium`, `high`, `xhigh` und `max`:

```csharp
using Anthropic;
using Anthropic.Models.Messages;

AnthropicClient client = new();

var response = await client.Messages.Create(new MessageCreateParams
{
    Model = "claude-opus-5",
    MaxTokens = 16000,
    Thinking = new ThinkingConfigAdaptive(),
    OutputConfig = new OutputConfig { Effort = Effort.High },
    Messages = [new() { Role = Role.User, Content = "Why does this query deadlock?" }],
});
```

Auf der Leitung ist das `"output_config": { "effort": "high" }`, wobei `xhigh` zwischen `high` und `max` liegt. Beachten Sie, dass `Effort` unter `OutputConfig` verschachtelt ist und keine Eigenschaft auf oberster Ebene. Das ist der Fehler, den Sie vermeiden sollten, wenn Sie dieselbe Steuerung in eigenes Tooling einbauen.

Zwei Details zählen, wenn Sie beurteilen, was die IDE-Einstellung tatsächlich bewirkt. Der Aufwand ist eine Obergrenze für Denktiefe und Gesamtverbrauch an Tokens, kein festes Budget: bei aktuellen Claude-Modellen entscheidet adaptives Reasoning weiterhin pro Anfrage, wie viel gedacht wird, und der Aufwand begrenzt das. Der frühere Ansatz, ein hartes Budget an Reasoning-Tokens zu benennen, existiert bei diesen Modellen nicht mehr. Genau deshalb ist eine Leiter mit fünf benannten Stufen das, was eine IDE Ihnen vorlegen kann.

## Der Teil, der auf der Rechnung auftaucht

"Higher thinking levels do more reasoning, which consumes more credits. Lower levels use fewer." Damit ist die Steuerung ebenso ein Kostenhebel wie ein Qualitätshebel, und sie passt zu den [AI-Credit-Limits pro Sitzung in Copilot CLI und SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/): eines begrenzt die Obergrenze, das andere setzt die Rate pro Anfrage.

Wenn Sie 18.9 Insiders nutzen, ist die schnellste Kalibrierung: das gewohnte Modell ausgewählt lassen, es für einen Tag mit Routineänderungen auf Low stellen und sehen, wie wenig fehlt.
