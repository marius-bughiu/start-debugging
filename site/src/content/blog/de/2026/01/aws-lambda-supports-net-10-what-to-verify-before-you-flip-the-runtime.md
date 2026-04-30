---
title: "AWS Lambda unterstützt .NET 10: Was Sie prüfen sollten, bevor Sie die Laufzeit umschalten"
description: "AWS Lambda unterstützt jetzt .NET 10, aber das Laufzeit-Upgrade ist nicht der schwierige Teil. Hier ist eine praktische Checkliste, die Cold Starts, Trimming, Native AOT und Deployment-Form abdeckt."
pubDate: 2026-01-08
tags:
  - "aws"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime"
translatedBy: "claude"
translationDate: 2026-04-30
---
Die Unterstützung von AWS Lambda für **.NET 10** taucht heute in Community-Kanälen auf, und es ist die Art von Änderung, die "fertig" aussieht, bis Sie auf Cold Starts, Trimming oder eine native Abhängigkeit in der Produktion stoßen.

Quelldiskussion: [r/dotnet thread](https://www.reddit.com/r/dotnet/comments/1q7p9t3/aws_lambda_supports_net_10/)

## Laufzeit-Unterstützung ist der einfache Teil; Ihre Deployment-Form ist der schwierige Teil

Eine Lambda von .NET 8/9 auf **.NET 10** zu verschieben ist nicht nur eine Target-Framework-Anhebung. Die ausgewählte Laufzeit treibt:

-   **Cold-Start-Verhalten**: JIT, ReadyToRun, Native AOT und wieviel Code Sie ausliefern, ändern alle das Startup-Profil.
-   **Paketierung**: Container-Image vs ZIP, plus wie Sie native Bibliotheken handhaben.
-   **Reflection-lastige Frameworks**: Trimming und AOT können "funktioniert lokal" in "schlägt zur Laufzeit fehl" verwandeln.

Wenn Sie .NET 10 primär aus Leistungsgründen wollen, gehen Sie nicht davon aus, dass das Lambda-Laufzeit-Upgrade der Gewinn ist. Messen Sie Cold Starts mit Ihrem echten Handler, echten Abhängigkeiten, echten Umgebungsvariablen und echten Speichereinstellungen.

## Ein minimaler .NET 10 Lambda-Handler, den Sie benchmarken können

Hier ist ein kleiner Handler, der leicht zu benchmarken und leicht mit Trimming zu brechen ist. Er zeigt auch ein Muster, das mir gefällt: Den Handler winzig halten, alles andere hinter DI oder explizite Codepfade schieben.

```cs
using Amazon.Lambda.Core;

[assembly: LambdaSerializer(typeof(Amazon.Lambda.Serialization.SystemTextJson.DefaultLambdaJsonSerializer))]

public sealed class Function
{
    // Use a static instance to avoid per-invocation allocations.
    private static readonly HttpClient Http = new();

    public async Task<Response> FunctionHandler(Request request, ILambdaContext context)
    {
        // Touch something typical: logging + a small outbound call.
        context.Logger.LogLine($"RequestId={context.AwsRequestId} Name={request.Name}");

        var status = await Http.GetStringAsync("https://example.com/health");
        return new Response($"Hello {request.Name}. Upstream says: {status.Length} chars");
    }
}

public sealed record Request(string Name);
public sealed record Response(string Message);
```

Jetzt veröffentlichen Sie auf eine Weise, die Ihrem beabsichtigten Produktionspfad entspricht. Wenn Sie Trimming testen, machen Sie es explizit:

```bash
dotnet publish -c Release -f net10.0 -p:PublishTrimmed=true
```

Wenn Sie planen, mit Native AOT in .NET 10 weiter zu gehen, veröffentlichen Sie auch so und validieren Sie, dass Ihre Abhängigkeiten tatsächlich AOT-kompatibel sind (Serialisierung, Reflection, native Libs).

## Eine praktische Checkliste für das erste .NET 10 Rollout

-   **Messen Sie Cold Start und Steady State separat**: p50 und p99 für beide.
-   **Schalten Sie Trimming nur ein, wenn Sie es testen können**: Trimming-Fehler sind in der Regel Laufzeitfehler.
-   **Bestätigen Sie die Speichereinstellung Ihrer Lambda**: Sie ändert die CPU-Zuweisung und kann Ihre Ergebnisse umkehren.
-   **Pinnen Sie Abhängigkeiten, die TFM-empfindlich sind**: `Amazon.Lambda.*`, Serializer und alles, was Reflection nutzt.

Wenn Sie einen sicheren ersten Schritt wollen, aktualisieren Sie die Laufzeit auf **.NET 10** und behalten Sie Ihre Deployment-Strategie bei. Sobald sie stabil ist, experimentieren Sie mit Trimming oder AOT in einem Branch und liefern Sie es nur aus, wenn Ihr Monitoring sagt, dass es langweilig ist.
