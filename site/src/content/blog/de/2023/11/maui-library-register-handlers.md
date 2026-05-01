---
title: "MAUI: Wie Sie Handler in einer Bibliothek registrieren"
description: "Erfahren Sie, wie Sie View-Handler und Services innerhalb einer .NET MAUI-Bibliothek mit dem Builder-Muster und MauiAppBuilder-Erweiterungsmethoden registrieren."
pubDate: 2023-11-10
tags:
  - "csharp"
  - "maui"
  - "dotnet"
lang: "de"
translationOf: "2023/11/maui-library-register-handlers"
translatedBy: "claude"
translationDate: 2026-05-01
---
Egal, ob Sie eine Bibliothek mit benutzerdefinierten Steuerelementen entwickeln oder Ihre Solution einfach in mehrere Projekte gliedern: Höchstwahrscheinlich landen Sie in der Situation, in der Sie einige View-Handler und Services aus einer MAUI-Bibliothek heraus registrieren möchten.

Vorweg: Eine Registrierung ohne Konfiguration gibt es nicht. MAUI verwendet ein Builder-Muster, um die Anwendung zu erstellen, und Sie benötigen Zugriff auf diesen Builder, um Ihre Handler und Services zu registrieren.

Der beste Ansatz für dieses Problem ist, eine statische Klasse mit einer `MauiAppBuilder`-Erweiterungsmethode in Ihrem Bibliotheksprojekt zu definieren. Sehen Sie sich das folgende Beispiel an:

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

Diese Art der Implementierung folgt dem Builder-Muster und lässt sich problemlos in Ihr Konsumentenprojekt integrieren. Sie gehen einfach in die `Program.cs` Ihres MAUI-Projekts und fügen ein `.UseMyPlugin()` in die Aufrufkette des App-Builders ein.

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
