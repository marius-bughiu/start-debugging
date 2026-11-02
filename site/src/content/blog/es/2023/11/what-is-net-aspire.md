---
title: "¿Qué es .NET Aspire? AppHost, descubrimiento de servicios y dashboard"
description: "Cómo un AppHost de Aspire conecta una API y un frontend, qué configura ServiceDefaults y qué muestra el dashboard."
pubDate: 2023-11-14
updatedDate: 2026-11-02
tags:
  - "aspire"
  - "dotnet"
lang: "es"
translationOf: "2023/11/what-is-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---

Una API y un frontend pueden arrancar correctamente y aun así el frontend puede llamar al puerto equivocado. Aspire permite describir esos servicios y sus dependencias en un **AppHost**. Al ejecutar la aplicación en local, Aspire inicia los recursos y pasa los datos de conexión a los servicios que los referencian.

## Cómo encuentra el frontend la API

Imagina un AppHost de C# con referencias a dos proyectos llamados `Api` y `Web`. Este ejemplo registra ambos como recursos e indica que el servicio web necesita la API:

```cs
var builder = DistributedApplication.CreateBuilder(args);
var api = builder.AddProject<Projects.Api>("api");
builder.AddProject<Projects.Web>("web").WithReference(api);
builder.Build().Run();
```

`WithReference(api)` proporciona al proyecto web los datos del endpoint del recurso `api`. Un cliente configurado para el descubrimiento de servicios puede usar ese nombre lógico. El frontend sigue siendo quien envía la petición HTTP y la API quien la procesa. Si el recurso es una base de datos, el mismo patrón puede proporcionar una cadena de conexión.

## Qué aportan las demás piezas

El proyecto **ServiceDefaults** de la plantilla comparte la configuración de descubrimiento de servicios, comprobaciones de estado y telemetría. Cada servicio participante llama a esas extensiones. El **dashboard** muestra el estado y los endpoints de los recursos y permite seguir las peticiones mediante los registros y las trazas distribuidas que emiten los servicios. Por ejemplo, una traza permite ver si una página lenta pasó el tiempo en el frontend o esperando a la API.

**Corrección — 2 de noviembre de 2026:** el [anuncio de la preview original de .NET 8](https://devblogs.microsoft.com/dotnet/introducing-dotnet-aspire-simplifying-cloud-native-development-with-dotnet-8/) usaba APIs de hospedaje anteriores. El ejemplo describe el modelo de AppHost de C# de Aspire 13.x. Una referencia de proyecto por sí sola no configura automáticamente todos los clientes.

[Instala la CLI de Aspire](/es/2023/11/how-to-install-net-aspire/) y después [crea y ejecuta la aplicación de ejemplo](/es/2023/11/getting-started-with-net-aspire/) para ver los endpoints en el dashboard.
