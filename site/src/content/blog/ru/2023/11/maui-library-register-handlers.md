---
title: "MAUI: как регистрировать обработчики в библиотеке"
description: "Узнайте, как регистрировать обработчики представлений и сервисы внутри библиотеки .NET MAUI с использованием паттерна builder и методов расширения MauiAppBuilder."
pubDate: 2023-11-10
tags:
  - "csharp"
  - "maui"
  - "dotnet"
lang: "ru"
translationOf: "2023/11/maui-library-register-handlers"
translatedBy: "claude"
translationDate: 2026-05-01
---
Разрабатываете ли вы библиотеку пользовательских элементов управления или просто разбиваете решение на несколько проектов, вы, скорее всего, столкнётесь с ситуацией, когда нужно зарегистрировать обработчики представлений и сервисы из библиотеки MAUI.

Сразу оговоримся: никакой регистрации с нулевой конфигурацией здесь нет. MAUI использует паттерн builder для создания приложения, и вам потребуется доступ к этому builder, чтобы зарегистрировать свои обработчики и сервисы.

Лучший подход к этой задаче -- определить статический класс с методом расширения для `MauiAppBuilder` в проекте вашей библиотеки. Пример приведён ниже:

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

Такая реализация следует паттерну builder и легко интегрируется в проект-потребитель. Достаточно открыть `Program.cs` вашего MAUI-приложения и добавить `.UseMyPlugin()` в цепочку вызовов app builder.

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
