---
title: "The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found."
description: "Soluciona el error 'Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found' actualizando el stack del Azure App Service y la versión del runtime de .NET."
pubDate: 2020-12-20
updatedDate: 2023-11-05
tags:
  - "aspnet"
  - "azure"
  - "docker"
lang: "es"
translationOf: "2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Este error suele significar que hay un desajuste entre el AppService Stack y la versión de .NET y el target framework de tu aplicación. Esto puede ocurrir cuando actualizas tu web app pero no actualizas el runtime del App Service.

Es algo bastante común en proyectos ASP.NET MVC y Web API que pasan por una actualización mayor de versión de .NET, y es bastante simple de arreglar.

Si recibes este error, ve a tu App Service > Settings > Configuration y asegúrate de que el Stack y la versión del framework coincidan con tu aplicación. En nuestro caso, tras actualizar de .NET Core 3.1 a .NET 5, tuvimos que cambiar el Stack de .NET Core a .NET y elegir la versión 5.

Tras hacer los cambios, también deberás reiniciar manualmente el App Service para que surtan efecto.

![](/wp-content/uploads/2020/12/image-1024x463.png)

El mensaje de error completo:

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

Esto básicamente dice que estás usando una imagen de docker que no tiene el runtime de .NET requerido por tu aplicación. Lo que necesitarás es la imagen docker 6.0 para ASP.NET.

```plaintext
docker pull mcr.microsoft.com/dotnet/aspnet:6.0
```

## Actualiza tus dependencias para que coincidan con la versión de .NET

Puede que te encuentres en una situación en la que el target framework de tu aplicación web y el del app service realmente coincidan, pero aun así obtengas el mismo error.

Si ese es el caso, puede que sigas referenciando paquetes antiguos que buscan una versión anterior de ASP.NET, como `ASP.NET Core Logging Integration`. Asegúrate de actualizar la extensión a una versión que coincida con tu target framework y tu problema debería resolverse.

Lo mismo ocurre con las dependencias de terceros, como `MiniProfiler.AspNetCore`: asegúrate de usar una versión compatible con tu runtime de ASP.NET de destino, de lo contrario puede provocar errores como el que cubrimos.
