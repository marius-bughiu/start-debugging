---
title: "Crea y ejecuta tu primera aplicación de Aspire"
description: "Crea una aplicación de Aspire en C# con una API y un frontend Blazor, abre el dashboard y compara el proyecto y las capturas de la preview de .NET 8."
pubDate: 2023-11-15
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "es"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Prepara primero [la CLI de Aspire y los requisitos para C#](/es/2023/11/how-to-install-net-aspire/). Para una solución **nueva**, la plantilla `aspire-starter` proporciona un servicio de API, un frontend Blazor y un AppHost que los conecta. Si ya tienes una solución, sigue la [guía de Aspire 13.4 para añadir un AppHost a proyectos existentes](/es/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/).

## Crear la aplicación y abrir el dashboard

Ejecuta estos comandos desde el directorio donde quieres crear la solución:

```sh
aspire new aspire-starter -n HelloAspire -o HelloAspire
cd HelloAspire
aspire run
```

Responde a las preguntas de la plantilla si aparecen. El primer comando crea la solución en `HelloAspire`. El último ejecuta su AppHost. Abre la URL del dashboard que aparece en la terminal y luego el endpoint del frontend en la lista de recursos. Visita la página del tiempo para enviar una petición del frontend a la API. En el dashboard, inspecciona los registros y la traza de esa petición. Pulsa `Ctrl+C` en la terminal para detener la aplicación.

En la plantilla, `ApiService` sirve los datos, `Web` los consume y `ServiceDefaults` proporciona la configuración común. El AppHost registra los proyectos y conecta el frontend a sus dependencias. La [guía de inicio rápido de C#](https://aspire.dev/get-started/first-app/?lang=csharp) muestra la estructura y [la introducción a Aspire](/es/2023/11/what-is-net-aspire/) explica cómo funciona una referencia a un recurso.

## Archivo: la preview de .NET 8 de noviembre de 2023

**Corrección — 2 de noviembre de 2026:** los pasos anteriores usan la CLI de Aspire 13.x. Las capturas, la opción de Redis y la API `AddRedisContainer` siguientes corresponden a la [preview de 2023](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/). Su AppHost apuntaba a `net8.0` y referenciaba [Aspire.Hosting 8.0.0-preview.1.23557.2](https://www.nuget.org/packages/Aspire.Hosting/8.0.0-preview.1.23557.2).

En Visual Studio 2022 Preview, la guía original seleccionaba **.NET Aspire Starter Application** y activaba **Use Redis for caching**. El comando equivalente era:

```sh
dotnet new aspire-starter --use-redis-cache --output Foo
```

[![Diálogo de creación de nuevo proyecto de Visual Studio mostrando una lista filtrada de plantillas de proyecto .NET Aspire.](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

[![Diálogo de información adicional para la plantilla de proyecto .NET Aspire Starter Application con la opción opcional Use Redis for caching (requiere Docker).](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

El AppHost referenciaba `ApiService` y `Web`. Ambos proyectos compartían `ServiceDefaults`, como muestra el diagrama original:

[![Un grafo de dependencias de proyecto para una .NET Aspire Starter Application mostrando AppHost en la parte superior, dependiente de ApiService y Web, ambos dependientes de ServiceDefaults.](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

El AppHost de la preview registraba Redis como `cache` y la API como `apiservice`. El frontend referenciaba ambos recursos. Esta era la API de entonces:

```cs
var builder = DistributedApplication.CreateBuilder(args);
var cache = builder.AddRedisContainer("cache");
var api = builder.AddProject<Projects.Foo_ApiService>("apiservice");
builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(api);
builder.Build().Run();
```

El dashboard original mostraba los proyectos y el contenedor. Al abrir la traza de una petición del tiempo se veían las llamadas individuales a los servicios:

[![El dashboard de .NET Aspire ejecutando la plantilla de proyecto .NET Aspire Starter Application.](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

[![Una traza de solicitud dentro del dashboard de .NET Aspire mostrando la solicitud en etapas a medida que pasa por los diferentes componentes de la aplicación.](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)
