---
title: "The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found."
description: "Исправьте ошибку 'Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found', обновив стек Azure App Service и версию runtime .NET."
pubDate: 2020-12-20
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "azure"
  - "docker"
lang: "ru"
translationOf: "2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Эта ошибка обычно означает несоответствие между AppService Stack и версией .NET и target framework вашего приложения. Такое может произойти, когда вы обновляете веб-приложение, но не обновляете runtime у App Service.

Это часто встречается у проектов ASP.NET MVC и Web API при переходе на новый major-релиз .NET, и устраняется довольно просто.

Если вы получаете эту ошибку, перейдите в App Service > Settings > Configuration и убедитесь, что Stack и версия фреймворка соответствуют вашему приложению. В нашем случае после обновления с .NET Core 3.1 на .NET 5 пришлось переключить Stack с .NET Core на .NET и выбрать версию 5.

После внесения изменений вам также нужно вручную перезапустить App Service, чтобы они вступили в силу.

![](/wp-content/uploads/2020/12/image-1024x463.png)

Полный текст ошибки:

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

По сути это означает, что вы используете docker-образ без runtime .NET, требуемого вашему приложению. Вам нужен docker-образ ASP.NET 6.0.

```plaintext
docker pull mcr.microsoft.com/dotnet/aspnet:6.0
```

## Обновите зависимости в соответствии с версией .NET

Может оказаться, что target framework вашего веб-приложения и app service на самом деле совпадают, но вы по-прежнему получаете ту же ошибку.

В таком случае возможно, что вы по-прежнему ссылаетесь на старые пакеты, которые ищут более раннюю версию ASP.NET, например `ASP.NET Core Logging Integration`. Обновите расширение до версии, соответствующей вашему target framework, и проблема должна исчезнуть.

То же касается сторонних зависимостей, таких как `MiniProfiler.AspNetCore`: убедитесь, что вы используете версию, совместимую с целевым runtime ASP.NET, иначе это может привести к ошибкам, подобным рассматриваемой.
