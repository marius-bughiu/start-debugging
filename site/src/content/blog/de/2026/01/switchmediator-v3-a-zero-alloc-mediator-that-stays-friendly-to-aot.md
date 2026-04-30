---
title: "SwitchMediator v3: Ein Mediator ohne Allokationen, der AOT-freundlich bleibt"
description: "SwitchMediator v3 zielt auf allokationsfreien, AOT-freundlichen Dispatch für CQRS-Dienste in .NET 9 und .NET 10. Was das bedeutet und wie Sie Ihren eigenen Mediator messen."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot"
translatedBy: "claude"
translationDate: 2026-04-30
---
Wer schon einmal eine "saubere" CQRS-Codebasis profiliert und in der Mediator-Schicht den Tod durch tausend Allokationen gefunden hat, sollte sich das heutige Release von **SwitchMediator v3** ansehen. Der Autor stellt explizit **allokationsfreies** und **AOT-freundliches** Verhalten heraus, also genau die Kombination, die in .NET 9- und .NET 10-Diensten gefragt ist, denen Latenz wichtig ist.

## Wo typische Mediator-Implementierungen Allokationen verlieren

Es gibt einige verbreitete Muster, die im Stillen allokieren:

-   **Boxing und Interface-Dispatch**: vor allem, wenn Handler als `object` abgelegt und pro Anfrage gecastet werden.
-   **Pipeline-Behavior-Listen**: sie allokieren Enumeratoren, Closures und Zwischenlisten.
-   **Reflection-basierte Handler-Erkennung**: bequem, aber schlecht mit Trimming und Native AOT zu vereinen.

Ein AOT-freundlicher Mediator macht meist das Gegenteil: er macht die Handler-Registrierung explizit und stützt die Dispatch-Logik auf bekannte generische Typen statt auf Laufzeit-Reflection.

## Ein kleines "vorher vs nachher"-Benchmark-Gerüst

Auch wenn Sie SwitchMediator nicht übernehmen, sollten Sie die Grenze Ihres Mediators messen. Dies ist ein minimales Gerüst, das Sie in eine Konsolen-App für **.NET 10** stellen können, um Ihre Baseline zu verstehen.

```cs
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

public static class Program
{
    public static void Main() => BenchmarkRunner.Run<MediatorBench>();
}

public sealed record Ping(int Value);
public sealed record Pong(int Value);

public interface IMediator
{
    ValueTask<Pong> Send(Ping request, CancellationToken ct = default);
}

public sealed class MediatorBench
{
    private readonly IMediator _mediator = /* wire your mediator here */;

    [Benchmark]
    public async ValueTask<Pong> SendPing() => await _mediator.Send(new Ping(123));
}
```

Worauf ich achte:

-   **Allokierte Bytes pro Operation** sollten für triviale Anfragen nahe null liegen.
-   **Durchsatz** sollte mit der Handler-Arbeit skalieren, nicht mit dem Dispatch-Overhead.

Wenn Sie Allokationen im Dispatch-Pfad sehen, finden Sie sie meist, indem Sie den Rückgabetyp auf `ValueTask` umstellen (wie oben) und Request- bzw. Response-Typen als Records oder Structs halten, die für den JIT vorhersagbar sind.

## AOT-freundlich heißt meist "explizit"

Wer mit Native AOT in **.NET 10** experimentiert, stellt fest: Reflection-lastige Mediatoren gehören zu den ersten Dingen, die brechen.

Der Architektur-Trade-off ist einfach:

-   **Reflection-Scanning**: hervorragende Developer Experience, schwache Trimming-/AOT-Geschichte.
-   **Explizite Registrierung**: etwas mehr Setup, aber vorhersagbar und trimming-freundlich.

Der Pitch von SwitchMediator deutet darauf hin, dass es zum expliziten Ende des Spektrums tendiert. Das passt zu meinem Vorgehen bei Performance-Arbeit: ich nehme ein paar Zeilen Verdrahtung mehr in Kauf, wenn sie mir vorhersagbares Verhalten in Produktion verschaffen.

Wer Details möchte, beginnt im Ankündigungs-Thread und folgt von dort dem Repository-Link: [https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator\_v3\_is\_out\_now\_a\_zeroalloc/](https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator_v3_is_out_now_a_zeroalloc/)
