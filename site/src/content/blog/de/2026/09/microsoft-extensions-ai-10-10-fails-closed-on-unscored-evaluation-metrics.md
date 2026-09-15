---
title: "Microsoft.Extensions.AI 10.10 lässt Evaluierungsmetriken scheitern, die der Judge nie bewertet hat"
description: "Microsoft.Extensions.AI.Evaluation.Quality 10.10.0 markiert nicht parsbare und außerhalb des Wertebereichs liegende Qualitätsbewertungen jetzt als fehlgeschlagen, und Microsoft.Extensions.AI.OpenAI 10.10.0 entfernt den Assistants-Adapter. Gemessen vor und nach dem Wechsel von 10.9.0."
pubDate: 2026-09-15
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "testing"
  - "csharp"
lang: "de"
translationOf: "2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics"
translatedBy: "claude"
translationDate: 2026-09-15
---

Die [Release Notes zu v10.10.0](https://github.com/dotnet/extensions/releases/tag/v10.10.0) von `dotnet/extensions` sind am 2026-09-14 erschienen (die Pakete lagen bereits am 2026-09-09 auf NuGet). Das meiste davon ist Infrastruktur, aber zwei Änderungen können das Verhalten Ihres Builds verändern: Die Qualitäts-Evaluatoren schlagen jetzt im Zweifel fehl (fail closed), und der OpenAI-Assistants-Adapter ist entfernt. Wenn Ihre CI von den Ergebnissen der KI-Evaluierung abhängt, kann die erste Änderung eine grüne Pipeline rot färben, und das ist das richtige Ergebnis.

## Ein Judge, der nichts sagt, zählt nicht mehr als bestanden

`CoherenceEvaluator`, `FluencyEvaluator`, `RelevanceEvaluator` und die übrigen Evaluatoren aus `Microsoft.Extensions.AI.Evaluation.Quality` fragen einen LLM-Judge nach einer Bewertung von 1 bis 5 und interpretieren diese selbst. Bis 10.9.0 ließ die Interpretation eine Metrik nur dann fehlschlagen, wenn der Wert als Zahl unter 4,0 geparst wurde. Lieferte der Judge Text ohne Bewertung, war `metric.Value` gleich `null`, die Einstufung wurde `Inconclusive`, und `Failed` blieb `false`. Eine Bewertung von 6 nahm denselben Weg. Jede Pipeline, die prüft, ob irgendetwas fehlgeschlagen ist, las eine nie bewertete Metrik als grün.

[PR #7735](https://github.com/dotnet/extensions/pull/7735) (behebt [Issue #7665](https://github.com/dotnet/extensions/issues/7665)) schließt diese Lücke. Ich habe denselben Test gegen beide Versionen ausgeführt, mit einem `IChatClient` als Judge, der feste Antworten zurückgibt:

```csharp
var result = await new CoherenceEvaluator().EvaluateAsync(
    new ChatMessage(ChatRole.User, "What is 2+2?"),
    new ChatResponse(new ChatMessage(ChatRole.Assistant, "4")),
    new ChatConfiguration(new CannedJudge(reply)));

var m = result.Get<NumericMetric>(CoherenceEvaluator.CoherenceMetricName);
Console.WriteLine($"value={m.Value} rating={m.Interpretation?.Rating} failed={m.Interpretation?.Failed}");
```

| Antwort des Judges | 10.9.0 | 10.10.0 |
| --- | --- | --- |
| `<S2>5</S2>` | Exceptional, nicht fehlgeschlagen | Exceptional, nicht fehlgeschlagen |
| `<S2>3</S2>` | Average, fehlgeschlagen | Average, fehlgeschlagen |
| `<S2>6</S2>` | Inconclusive, **nicht fehlgeschlagen** | Inconclusive, fehlgeschlagen: "Coherence is outside the valid range." |
| "I am unable to evaluate this response." | Inconclusive, **nicht fehlgeschlagen** | Inconclusive, fehlgeschlagen: "Coherence has no score." |

Bewertungen innerhalb der Skala verhalten sich genau wie zuvor, einschließlich der Grenze bei 4,0. Neu ist, dass ein unzuverlässiger, durch Rate Limits gebremster oder falsch konfigurierter Judge jetzt als Fehlschlag erscheint, statt sich hinter einem Bestanden zu verstecken. Meldet Ihr nächtlicher Lauf nach dem Upgrade plötzlich Fehlschläge, lohnt zuerst ein Blick auf den `Reason`-Text: "has no score" deutet auf das Judge-Modell hin, nicht auf Ihre App.

Die Korrektur beschränkt sich auf das Quality-Paket. Laut PR haben `InterpretContentSafetyScore` und `InterpretContentHarmScore` aus dem Safety-Paket sowie die Bewertungsinterpretation des NLP-Pakets dieselbe Struktur und blieben unverändert. Gehen Sie also nicht davon aus, dass diese bereits im Zweifel fehlschlagen.

## Der Assistants-Adapter ist entfernt, nicht nur als veraltet markiert

OpenAI hat die Assistants API am 2026-08-26 abgeschaltet, und [PR #7724](https://github.com/dotnet/extensions/pull/7724) hat die zugehörige experimentelle API-Oberfläche aus `Microsoft.Extensions.AI.OpenAI` entfernt: beide Überladungen von `AssistantClient.AsIChatClient(...)`, `OpenAIAssistantsChatClient` und `AsOpenAIAssistantsFunctionToolDefinition`. Das Paket `OpenAI` 2.13.0 enthält `AssistantClient` weiterhin, daher scheitert das Upgrade beim Kompilieren und nicht beim Restore:

```text
error CS1929: 'AssistantClient' does not contain a definition for 'AsIChatClient' and the best extension method overload 'OpenAIClientExtensions.AsIChatClient(ResponsesClient, string?)' requires a receiver of type 'OpenAI.Responses.ResponsesClient'
```

Der Ersatz ist der Responses-Client: Die Anweisungen wandern in `ChatOptions`, und die Conversation-ID übernimmt die Rolle der Thread-ID. Dieser Code kompiliert gegen 10.10.0:

```csharp
IChatClient chat = new OpenAIClient(apiKey)
    .GetResponsesClient()
    .AsIChatClient("gpt-5-mini");

var options = new ChatOptions
{
    Instructions = "You are the support assistant for Contoso.",
    ConversationId = conversationId, // previous response id, replaces the thread id
};

ChatResponse response = await chat.GetResponseAsync("Where is my order?", options);
```

Da die Endpunkte bereits Fehler zurückgeben, war jeder Code, der noch diesen Weg nutzt, schon vor zwei Wochen in Produktion defekt. Der Kompilierfehler macht das nur sichtbar.

Der Rest von 10.10.0 ist kleiner: `OpenAI` wird auf 2.13.0 angehoben, nicht unterstützte `detail`-Werte für Bilder lösen keine `ArgumentNullException` mehr aus, und der Azure-Storage-Ergebnisspeicher validiert Pfadsegmente. Wenn Sie die Routing-Clients aus [Microsoft.Extensions.AI 10.9](/de/2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients/) übernommen haben, ist dies ein unbedenkliches Update, sofern Sie bereit sind, dass Ihr Evaluierungs-Gate anfängt, die Wahrheit zu sagen.
