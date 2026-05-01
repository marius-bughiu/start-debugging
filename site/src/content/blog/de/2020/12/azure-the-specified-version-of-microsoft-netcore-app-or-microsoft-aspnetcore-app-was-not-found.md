---
title: "The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found."
description: "Beheben Sie den Fehler 'Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found', indem Sie den Stack Ihres Azure App Service und die .NET-Runtime-Version aktualisieren."
pubDate: 2020-12-20
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "azure"
  - "docker"
lang: "de"
translationOf: "2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Dieser Fehler bedeutet in der Regel, dass es eine Diskrepanz zwischen dem AppService Stack und der .NET-Version sowie dem Target Framework Ihrer App gibt. Das kann passieren, wenn Sie Ihre Web App aktualisieren, aber die Runtime des App Service nicht mit anpassen.

Bei ASP.NET MVC- und Web-API-Projekten, die ein Major-Version-Upgrade von .NET durchlaufen, kommt das häufig vor und lässt sich recht einfach beheben.

Wenn Sie diesen Fehler erhalten, gehen Sie zu Ihrem App Service > Settings > Configuration und stellen Sie sicher, dass Stack und Framework-Version zu Ihrer App passen. In unserem Fall mussten wir nach dem Upgrade von .NET Core 3.1 auf .NET 5 den Stack von .NET Core auf .NET umstellen und Version 5 auswählen.

Nach den Änderungen müssen Sie den App Service zudem manuell neu starten, damit sie wirksam werden.

![](/wp-content/uploads/2020/12/image-1024x463.png)

Die vollständige Fehlermeldung:

> HTTP Error 500.31 -- ANCM Failed to Find Native Dependencies Common solutions to this issue: The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found. Specific error detected by ANCM: Error: An assembly specified in the application dependencies manifest (Microsoft.AspNetCore.AzureAppServices.HostingStartup.deps.json) was not found: package: 'Microsoft.Extensions.Logging.AzureAppServices', version: '6.0.1' path: 'lib/net6.0/Microsoft.Extensions.Logging.AzureAppServices.dll

## Docker -- The framework 'Microsoft.AspNetCore.App', version '6.0.0' (x64) was not found

```plaintext
It was not possible to find any compatible framework version
The framework 'Microsoft.AspNetCore.App', version '6.0.0' (x64) was not found.
  - No frameworks were found.
You can resolve the problem by installing the specified framework and/or SDK.
The specified framework can be found at:
  - https://aka.ms/dotnet-core-applaunch?framework=Microsoft.AspNetCore.App&framework_version=6.0.0&arch=x64&rid=debian.11-x64
```

Das bedeutet im Wesentlichen, dass Sie ein Docker-Image verwenden, das die von Ihrer Anwendung benötigte .NET-Runtime nicht enthält. Sie benötigen das 6.0-Docker-Image für ASP.NET.

```plaintext
docker pull mcr.microsoft.com/dotnet/aspnet:6.0
```

## Aktualisieren Sie Ihre Abhängigkeiten passend zur .NET-Version

Möglicherweise befinden Sie sich in der Situation, dass das Target Framework Ihrer Web-Anwendung und das des App Service tatsächlich übereinstimmen, Sie aber dennoch denselben Fehler erhalten.

Falls das der Fall ist, kann es sein, dass Sie noch ältere Pakete referenzieren, die eine ältere Version von ASP.NET suchen, etwa `ASP.NET Core Logging Integration`. Aktualisieren Sie die Erweiterung auf eine Version, die zu Ihrem Target Framework passt, dann sollte das Problem behoben sein.

Dasselbe gilt für Drittanbieter-Abhängigkeiten wie `MiniProfiler.AspNetCore`: Stellen Sie sicher, dass Sie eine Version verwenden, die mit Ihrer Ziel-ASP.NET-Runtime kompatibel ist, sonst kann es zu Fehlern wie dem hier beschriebenen kommen.
