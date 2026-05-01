---
title: "So beheben Sie: dotnet ef not found (dotnet-ef does not exist)"
description: "Beheben Sie den Fehler 'dotnet-ef does not exist' / 'dotnet ef command not found', indem Sie die EF Core CLI als globales oder lokales .NET-Tool installieren."
pubDate: 2023-06-11
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "entity-framework"
lang: "de"
translationOf: "2023/06/how-to-fix-command-dotnet-ef-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
> Could not execute because the specified command or file was not found.  
> Possible reasons for this include:  
> -- You misspelled a built-in dotnet command.  
> -- You intended to execute a .NET Core program, but dotnet-ef does not exist.  
> -- You intended to run a global tool, but a dotnet-prefixed executable with this name could not be found on the PATH.

Der wahrscheinlichste Grund für diese Fehlermeldung ist, dass Sie das Tool **dotnet ef** nicht installiert haben.

Ab ASP.NET Core 3 gehört das Befehlstool **dotnet ef** nicht mehr zum .NET Core SDK. Durch diese Änderung kann das Team dotnet ef als reguläres .NET-CLI-Tool ausliefern, das entweder als globales oder lokales Tool installiert werden kann. Das gilt für alle Distributionen, egal ob Sie mit Visual Studio unter Windows arbeiten oder `dotnet` auf einem Mac oder unter Ubuntu Linux verwenden.

Um beispielsweise Migrationen verwalten oder einen **DbContext** scaffolden zu können, installieren Sie **dotnet ef** als globales Tool mit folgendem Befehl:

```shell
dotnet tool install --global dotnet-ef
```

Wenn Sie eine bestimmte Version installieren möchten, können Sie den Parameter **--version** angeben. Zum Beispiel:

```shell
dotnet tool install --global dotnet-ef --version 3.*
dotnet tool install --global dotnet-ef --version 5.*
dotnet tool install --global dotnet-ef --version 6.*
dotnet tool install --global dotnet-ef --version 7.*
dotnet tool install --global dotnet-ef --version 8.*
```

## dotnet-ef deinstallieren

Wenn Sie das Tool nicht mehr benötigen und `dotnet-ef` deinstallieren möchten, können Sie das mit dem Befehl `dotnet tool uninstall` tun.

```shell
dotnet tool uninstall dotnet-ef --global
```
