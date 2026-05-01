---
title: "MAUI: Cómo registrar handlers en una biblioteca"
description: "Aprende a registrar view handlers y servicios desde dentro de una biblioteca de .NET MAUI usando el patrón builder y los métodos de extensión de MauiAppBuilder."
pubDate: 2023-11-10
tags:
  - "csharp"
  - "maui"
  - "dotnet"
lang: "es"
translationOf: "2023/11/maui-library-register-handlers"
translatedBy: "claude"
translationDate: 2026-05-01
---
Tanto si estás desarrollando una biblioteca de controles personalizados como si simplemente organizas tu solución en varios proyectos, lo más probable es que termines en la situación de querer registrar algunos view handlers y servicios desde dentro de una biblioteca MAUI.

Para empezar, no existe un registro de configuración cero. MAUI usa un patrón builder para crear la aplicación y necesitarás acceso a ese builder para poder registrar tus handlers y servicios.

El mejor enfoque para este problema es definir una clase estática con un método de extensión de `MauiAppBuilder` en el proyecto de tu biblioteca. Mira un ejemplo a continuación:

```cs
public static class Config
{
    public static MauiAppBuilder UseMyPlugin(this MauiAppBuilder builder)
    {
        builder.ConfigureMauiHandlers(handlers =>
        {
            handlers.AddHandler(typeof(MyView), typeof(MyViewHandler));
        });

        builder.Services.AddSingleton<IMyService, MyService>();

        return builder;
    }
}
```

Este tipo de implementación sigue el patrón builder y se puede integrar fácilmente en tu proyecto consumidor. Solo tienes que ir a tu `Program.cs` de MAUI y añadir un `.UseMyPlugin()` en la cadena de llamadas del app builder.

```cs
public static MauiApp CreateMauiApp()
{
    var builder = MauiApp.CreateBuilder();

    builder
        .UseMauiApp<App>()
        .UseMyPlugin()
        .ConfigureFonts(fonts =>
        {
            fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
        });


    return builder.Build();
}
```
