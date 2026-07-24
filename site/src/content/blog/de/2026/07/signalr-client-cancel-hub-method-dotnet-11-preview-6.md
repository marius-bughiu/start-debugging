---
title: "SignalR-Clients können in .NET 11 Preview 6 endlich eine laufende Hub-Methode abbrechen"
description: "Das Abbrechen des CancellationToken, den Sie an InvokeAsync übergeben, erreicht jetzt den Server und bricht die Hub-Methode ab. Damit wird eine seit 2019 offene SignalR-Anfrage geschlossen."
pubDate: 2026-07-24
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
  - "csharp"
lang: "de"
translationOf: "2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-24
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) wurde am 2026-07-15 veröffentlicht und schließt eine der ältesten Funktionswünsche von SignalR. Das [Issue #11542](https://github.com/dotnet/aspnetcore/issues/11542), "Possibility to cancel long running hub method from client," war seit 2019 offen. Der [PR #64098](https://github.com/dotnet/aspnetcore/pull/64098) hat es endlich verdrahtet: Der `CancellationToken`, den Sie im .NET-Client an `InvokeAsync` übergeben, erreicht jetzt tatsächlich den Server und bricht die Hub-Methode ab.

## Der Token, der Sie früher belogen hat

Vor Preview 6 akzeptierte der .NET-Client von SignalR bereits einen `CancellationToken` bei `InvokeAsync`. Er tat nur nicht das, was die meisten annahmen. Ein Abbruch stoppte das Warten des *Clients* auf ein Ergebnis, aber die Hub-Methode auf dem Server lief bis zum Abschluss weiter. Es gab keine Möglichkeit, dem Server zu sagen "stopp, der Aufrufer ist weg." Streaming-Aufrufe sendeten zwar eine `CancelInvocation`-Nachricht, normale Request-Response-Aufrufe jedoch nicht.

Diese Lücke ist jetzt geschlossen. Wenn Sie den an `InvokeAsync` übergebenen Token abbrechen, sendet der Client eine `CancelInvocationMessage` an den Server, der den passenden Aufruf findet und abbricht.

## Die Verdrahtung

Deklarieren Sie auf dem Server einen `CancellationToken`-Parameter an der Hub-Methode. SignalR füllt ihn als synthetisches Argument, sodass der Client ihn nie sendet:

```csharp
public class ReportHub : Hub
{
    public async Task<string> BuildReport(int rows, CancellationToken cancellationToken)
    {
        for (var i = 0; i < rows; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(50, cancellationToken); // real work here
        }

        return "done";
    }
}
```

Bis Preview 6 wurde ein `CancellationToken`-Parameter an einer Nicht-Streaming-Hub-Methode ignoriert: Das Framework synthetisierte einen nur für Streaming-Methoden. Jetzt erlaubt ihn `HubMethodDescriptor` überall.

Übergeben Sie auf dem Client einen Token und brechen Sie ihn ab, sobald Sie das Ergebnis nicht mehr benötigen:

```csharp
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(2));

try
{
    var result = await connection.InvokeAsync<string>(
        "BuildReport", 100_000, cts.Token);
}
catch (OperationCanceledException)
{
    // The server's token fired too, so the hub method stopped.
}
```

## Was intern passiert

`DefaultHubDispatcher` registriert die `CancellationTokenSource` jedes Aufrufs in `ActiveRequestCancellationSources`, indiziert nach Aufruf-ID. Wenn die `CancelInvocationMessage` eintrifft, sucht er diese Quelle und ruft `Cancel()` auf, was den Token auslöst, den Ihre Hub-Methode beobachtet. Das ist dieselbe Registrierung, die Streaming-Aufrufe bereits nutzten, jetzt geteilt mit den normalen.

Zwei Dinge sind zu beachten. Der Abbruch ist kooperativ: Wenn Ihre Hub-Methode den Token nie prüft oder ihn nicht an die asynchronen Aufrufe weitergibt, die sie tätigt, stoppt nichts. Und dies ist eine Preview, sodass sich das Verhalten noch ändern kann, bevor .NET 11 im November 2026 erscheint.

Dasselbe Preview 6 hat auch [den automatischen CSRF-Schutz aktiviert](/de/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/), also ist es ein gutes Release zum Testen. Alle Details stehen in den [ASP.NET Core Preview 6 Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md). Wenn Sie je einen "Abbrechen"-Button gebaut haben, der den Benutzer nur belog, ist dies das Release, das ihn ehrlich macht.
