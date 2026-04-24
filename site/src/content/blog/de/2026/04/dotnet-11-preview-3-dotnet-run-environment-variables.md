---
title: ".NET 11 Preview 3: dotnet run -e setzt Umgebungsvariablen ohne Launch Profiles"
description: "dotnet run -e in .NET 11 Preview 3 übergibt Umgebungsvariablen direkt aus der CLI und zeigt sie als MSBuild RuntimeEnvironmentVariable-Items an."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "dotnet-cli"
  - "msbuild"
lang: "de"
translationOf: "2026/04/dotnet-11-preview-3-dotnet-run-environment-variables"
translatedBy: "claude"
translationDate: 2026-04-24
---

.NET 11 Preview 3 wurde am 14. April 2026 mit einer kleinen, aber breit anwendbaren SDK-Änderung ausgeliefert: `dotnet run` akzeptiert jetzt `-e KEY=VALUE`, um Umgebungsvariablen direkt von der Kommandozeile zu übergeben. Keine Shell-Exports, keine `launchSettings.json`-Edits, keine einmaligen Wrapper-Skripte.

## Warum das Flag zählt

Vor Preview 3 hieß das Setzen einer Env-Variablen für einen einzelnen Lauf eine von drei unbequemen Optionen. Auf Windows hatten Sie `set ASPNETCORE_ENVIRONMENT=Staging && dotnet run` mit den Quoting-Überraschungen von `cmd.exe`. In bash hatten Sie `ASPNETCORE_ENVIRONMENT=Staging dotnet run`, was funktioniert, aber die Variable in jeden Child-Prozess blutet, der aus der Shell forkt. Oder Sie fügten noch ein weiteres Profile in `Properties/launchSettings.json` hinzu, das sonst niemand im Team wirklich wollte.

`dotnet run -e` übernimmt diesen Job und hält den Scope auf den Lauf selbst begrenzt.

## Die Syntax und was sie tatsächlich setzt

Übergeben Sie ein `-e` pro Variable. Sie können das Flag so oft wiederholen, wie Sie brauchen:

```bash
dotnet run -e ASPNETCORE_ENVIRONMENT=Development -e LOG_LEVEL=Debug
```

Das SDK injiziert diese Werte in das Environment des gestarteten Prozesses. Ihre App sieht sie über `Environment.GetEnvironmentVariable` oder die ASP.NET-Core-Konfigurationspipeline wie jede andere Variable:

```csharp
var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
Console.WriteLine($"Running as: {env}");
```

Es gibt einen zweiten, weniger offensichtlichen Nebeneffekt, den man kennen sollte: Dieselben Variablen werden MSBuild als `RuntimeEnvironmentVariable`-Items zur Verfügung gestellt. Das heißt, Targets, die während der Build-Phase von `dotnet run` laufen, können sie ebenfalls lesen, was Szenarien wie das Gaten von Code-Generierung an einem Flag oder das Tauschen von Resource-Files pro Umgebung ermöglicht.

## RuntimeEnvironmentVariable-Items aus einem Target lesen

Wenn Sie ein Custom Target haben, das auf das Flag reagieren soll, zählen Sie die Items auf, die MSBuild bereits befüllt hat:

```xml
<Target Name="LogRuntimeEnvVars" BeforeTargets="Build">
  <Message Importance="high"
           Text="Runtime env: @(RuntimeEnvironmentVariable->'%(Identity)=%(Value)', ', ')" />
</Target>
```

Laufen Sie `dotnet run -e FEATURE_X=on -e TENANT=acme`, und das Target druckt `FEATURE_X=on, TENANT=acme` bevor die App startet. Das sind reguläre MSBuild-Items, also können Sie sie mit `Condition` filtern, in andere Properties einspeisen oder nutzen, um `Include`/`Exclude`-Entscheidungen innerhalb desselben Builds zu steuern.

## Wo es in den Workflow passt

`dotnet run -e` ist kein Ersatz für `launchSettings.json`. Launch Profiles machen weiter Sinn für die üblichen Konfigurationen, die Sie jeden Tag treffen, und für Debug-Szenarien in Visual Studio oder Rider. Das CLI-Flag ist am besten für One-Shot-Fälle: einen Bug reproduzieren, den jemand unter einem bestimmten `LOG_LEVEL` gemeldet hat, ein Feature Flag testen, ohne ein Profile zu committen, oder einen schnellen CI-Step in `dotnet watch` verdrahten, ohne ein YAML-File umzuschreiben.

Eine kleine Einschränkung: Werte mit Leerzeichen oder shell-speziellen Zeichen brauchen immer noch Quoting für Ihre Shell. `dotnet run -e "GREETING=hello world"` ist in bash und PowerShell in Ordnung, `dotnet run -e GREETING="hello world"` funktioniert in `cmd.exe`. Das SDK selbst akzeptiert die Zuweisung wie sie ist, aber die Shell parst die Kommandozeile zuerst.

Das kleinste .NET-11-Preview-3-Feature auf Papier und wahrscheinlich eines der meistgenutzten in der Praxis. Vollständige Release Notes leben unter [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk), und der Ankündigungs-Post ist im [.NET Blog](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).
