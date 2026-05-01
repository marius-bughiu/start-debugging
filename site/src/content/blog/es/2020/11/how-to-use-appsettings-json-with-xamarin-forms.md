---
title: "Cómo usar appsettings.json con Xamarin.Forms"
description: "Aprende a usar archivos de configuración appsettings.json con Xamarin.Forms incrustando el archivo como recurso y construyendo un objeto IConfiguration."
pubDate: 2020-11-13
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin-forms"
lang: "es"
translationOf: "2020/11/how-to-use-appsettings-json-with-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hay dos diferencias clave en comparación con ASP.NET:

-   primero, trabajaremos con un Embedded Resource en lugar de un archivo en disco
-   segundo, registraremos el archivo `appsettings.json` nosotros mismos

Para empezar, añade un archivo `appsettings.json` en tu proyecto compartido. Asegúrate de configurar su `Build Action` como `Embedded Resource`. Añade algunas claves + valores en el archivo que podamos usar para pruebas. Por ejemplo:

```json
{
  "ChatHubUrl": "https://signalrchatweb.azurewebsites.net/"
}
```

A continuación, necesitamos obtener el stream del recurso.

```cs
Stream resourceStream = GetType().GetTypeInfo().Assembly.GetManifestResourceStream("SignalRChat.appsettings.json");
```

Y usarlo para construir un objeto `IConfiguration`.

```cs
var configuration = new ConfigurationBuilder()
                .AddJsonStream(resourceStream)
                .Build();
```

Ahora, para obtener los valores de configuración, úsalo como cualquier otro diccionario.

```cs
configuration["ChatHubUrl"];
```

Como alternativa, puedes registrarlo en tu contenedor IoC como un `IConfiguration`, inyectarlo en tus viewmodels y usarlo de la misma forma.

Originalmente había un ejemplo completo en el repositorio Xamarin Forms -- SignalR Chat en GitHub, que ya no está disponible.
