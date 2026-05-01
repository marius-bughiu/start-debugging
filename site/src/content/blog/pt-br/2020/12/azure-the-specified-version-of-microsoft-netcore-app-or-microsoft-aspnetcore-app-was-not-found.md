---
title: "The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found."
description: "Resolva o erro 'Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found' atualizando o stack do Azure App Service e a versão do runtime do .NET."
pubDate: 2020-12-20
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "azure"
  - "docker"
lang: "pt-br"
translationOf: "2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Esse erro normalmente significa que há uma incompatibilidade entre o AppService Stack e a versão do .NET e o target framework do seu aplicativo. Isso pode acontecer quando você atualiza sua web app, mas não atualiza o runtime do App Service.

É algo bastante comum em projetos ASP.NET MVC e Web API que passam por uma atualização major de versão do .NET, e é bem simples de resolver.

Se você receber esse erro, vá até seu App Service > Settings > Configuration e verifique se o Stack e a versão do framework correspondem ao seu app. No nosso caso, depois de atualizar do .NET Core 3.1 para o .NET 5, tivemos que mudar o Stack de .NET Core para .NET e escolher a versão 5.

Após fazer as alterações, você também precisará reiniciar manualmente o App Service para que tenham efeito.

![](/wp-content/uploads/2020/12/image-1024x463.png)

Mensagem de erro completa:

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

Isso basicamente diz que você está usando uma imagem docker que não tem o runtime do .NET exigido pela sua aplicação. Você precisará da imagem docker 6.0 para ASP.NET.

```plaintext
docker pull mcr.microsoft.com/dotnet/aspnet:6.0
```

## Atualize suas dependências para corresponder à versão do .NET

Pode ser que o target framework da sua aplicação web e o do app service realmente coincidam, mas mesmo assim você continue recebendo o mesmo erro.

Se for esse o caso, pode ser que você ainda esteja referenciando alguns pacotes mais antigos que procuram uma versão mais antiga do ASP.NET, como o `ASP.NET Core Logging Integration`. Atualize a extensão para uma versão que corresponda ao seu target framework e o problema deve ser resolvido.

O mesmo vale para dependências de terceiros, como `MiniProfiler.AspNetCore`: garanta que você está usando uma versão compatível com o runtime do ASP.NET alvo, caso contrário podem ocorrer erros como o que abordamos.
