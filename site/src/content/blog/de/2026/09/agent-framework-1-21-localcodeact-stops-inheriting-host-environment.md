---
title: "Agent Framework 1.21: LocalCodeAct gibt Ihre Host-Umgebung nicht mehr an modellgeschriebenes Python weiter"
description: "Microsoft Agent Framework .NET 1.21.0 liefert Microsoft.Agents.AI.LocalCodeAct 1.21.0-preview.260911.1 aus, bei dem der CodeAct-Python-Unterprozess die Umgebung des Elternprozesses nicht mehr erbt, wenn Environment null ist. Unter 1.20 konnte generierter Code jede Host-Variable lesen, API-Schlüssel eingeschlossen."
pubDate: 2026-09-13
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "codeact"
  - "security"
lang: "de"
translationOf: "2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment"
translatedBy: "claude"
translationDate: 2026-09-13
---

Microsoft Agent Framework [dotnet-1.21.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.21.0) ist am 2026-09-11 erschienen, und eine Zeile im Changelog verdient mehr Aufmerksamkeit, als sie bekommen wird: "[BREAKING] .NET: Isolate LocalCodeAct subprocess environment" ([PR #8159](https://github.com/microsoft/agent-framework/pull/8159)). Wer `Microsoft.Agents.AI.LocalCodeAct` einsetzt und `LocalCodeActProviderOptions.Environment` nie gesetzt hat, bei dem konnte das vom Modell geschriebene Python bis zu diesem Release jede Umgebungsvariable des Host-Prozesses lesen.

## Zwei Dokumentationen, ein Verhalten

`LocalCodeAct` ist das Geschwister des Hyperlight-CodeAct-Providers ohne Sandbox: Das Modell schreibt Python, und das Paket führt es nach einer AST-Validierung in einem `python`-Kindprozess auf dem Host aus. Die README des Pakets versprach bereits, dass der Unterprozess "does NOT inherit the host environment by default". Der XML-Doc-Kommentar zu `Environment` sagte das Gegenteil: `null` bedeutet erben, ein leeres Dictionary ergibt eine bereinigte Umgebung. Der Code folgte dem XML-Doc-Kommentar. `ProcessBridge.ConfigureEnvironment` kehrte vorzeitig zurück, wenn das Dictionary `null` war, sodass `ProcessStartInfo` die vollständige Umgebung des Elternprozesses behielt.

Das ist relevant, weil der Validator lesenden Zugriff auf `os.environ` bewusst erlaubt. Folgendes bestand unter 1.20 also die Validierung:

```csharp
Environment.SetEnvironmentVariable("FAKE_OPENAI_API_KEY", "sk-leaked-from-host");

var fn = new LocalExecuteCodeFunction("/opt/homebrew/bin/python3.14");
var result = await fn.InvokeAsync(new AIFunctionArguments
{
    ["code"] = "import os\nprint(os.environ.get('FAKE_OPENAI_API_KEY', 'NOT_FOUND'))\nprint(len(os.environ))",
});
```

Ich habe genau diese Probe als dateibasierte .NET-10-App (SDK 10.0.302, macOS, Python 3.14) gegen beide Paketversionen ausgeführt:

```text
1.20.0-preview.260831.1  default options   -> sk-leaked-from-host, 63 variables
1.21.0-preview.260911.1  default options   -> NOT_FOUND, 2 variables
both versions            Environment set   -> NOT_FOUND, 3 variables
```

Alles, was `execute_code` ausgibt, landet direkt wieder im Kontext des Modells. Eine per Prompt Injection eingeschleuste Anweisung, "die Umgebung auszugeben", genügte, um Ihren OpenAI-Schlüssel, einen Storage-Connection-String oder `AZURE_CLIENT_SECRET` ins Transkript zu bringen und von dort in jedes Host-Tool, das der Agent aufrufen kann.

## Was 1.21 jetzt tut

`ConfigureEnvironment` ruft jetzt immer `startInfo.Environment.Clear()` auf und kopiert danach nur das, was Sie in `Environment` angeben. `null` und ein leeres Dictionary verhalten sich gleich. Unter Windows werden `SYSTEMROOT`, `SYSTEMDRIVE`, `COMSPEC`, `PATHEXT`, `TEMP` und `TMP` aus dem Elternprozess ergänzt, sofern Sie sie nicht gesetzt haben, weil Python ohne sie seine Standardbibliothek nicht laden kann.

Die Kehrseite: Alles, worauf sich Ihr generierter Code implizit verlassen hat, ist weg, unter Linux und macOS auch `PATH` und `HOME`. Wenn ein eingebundenes Skript oder ein erlaubtes Modul eine Variable braucht, übergeben Sie sie explizit:

```csharp
using Microsoft.Agents.AI.LocalCodeAct;

using var provider = new LocalCodeActProvider("/usr/bin/python3", new LocalCodeActProviderOptions
{
    Environment = new Dictionary<string, string>
    {
        ["LOG_LEVEL"] = "INFO",
        ["TZ"] = "UTC",
    },
});
```

Halten Sie Geheimnisse aus diesem Dictionary heraus. Wenn generierter Code einen authentifizierten Aufruf braucht, registrieren Sie ein Host-Tool, das die Anmeldeinformationen hält, und lassen Sie das Python es über `await call_tool(...)` erreichen.

## Zwei verwandte LocalCodeAct-Änderungen im selben Release

[PR #8239](https://github.com/microsoft/agent-framework/pull/8239) verschärft den Validator, sodass von OS-Objekten abgeleitete Aliase, reflektiver Zugriff und das Verändern der Umgebung einheitlich abgewiesen werden, und [PR #8289](https://github.com/microsoft/agent-framework/pull/8289) gleicht die Freigaben an Hyperlight an: Ist irgendein registriertes Tool eine `ApprovalRequiredAIFunction`, erfordert `execute_code` selbst eine Freigabe, und `LocalCodeActApprovalMode.AlwaysRequire` erzwingt sie für jeden Lauf.

Nichts davon macht `LocalCodeAct` zu einer Sandbox, und die README sagt das weiterhin in einem Warnkasten. Es gehört in einen Container, eine VM oder einen gehosteten Foundry-Agenten. Falls Sie noch abwägen, ob modellgeschriebener Code diesen Aufwand überhaupt wert ist, habe ich die Vor- und Nachteile in [CodeAct vs. eine klassische Tool-Calling-Schleife](/2026/07/codeact-vs-tool-calling-loop-for-agents/) verglichen. Wenn Sie es bereits einsetzen, aktualisieren Sie auf `1.21.0-preview.260911.1` und prüfen Sie, was Sie in `Environment` übergeben.
