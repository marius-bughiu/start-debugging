---
title: "MAUI: How to register handlers in a library"
description: "Whether you are developing a custom controls library or simply organizing your solution into multiple project, you will most likely end up in the situation where you want to register some view handlers and services from within a MAUI library. To start off, there’s no such thing as zero-configuration registration. MAUI uses a builder pattern…"
pubDate: 2023-11-10
tags:
  - "c-sharp"
  - "maui"
  - "net"
---
Whether you are developing a custom controls library or simply organizing your solution into multiple project, you will most likely end up in the situation where you want to register some view handlers and services from within a MAUI library.

To start off, there’s no such thing as zero-configuration registration. MAUI uses a builder pattern to create the application and you will need access to that builder in order to register your handlers and services.

The best approach to this problem is to define a static class with an `MauiAppBuilder` extension method in your library project. See an example below:

```angelscript
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

This type of implementation, follows the builder pattern and can be easily integrated in your consumer project. You just go to your Maui`Program.cs`, and add a `.UseMyPlugin()` in the app builder’s call chain.

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
