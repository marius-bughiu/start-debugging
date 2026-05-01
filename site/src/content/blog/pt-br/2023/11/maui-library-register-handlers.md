---
title: "MAUI: Como registrar handlers em uma biblioteca"
description: "Aprenda a registrar view handlers e serviços de dentro de uma biblioteca .NET MAUI usando o padrão builder e os métodos de extensão do MauiAppBuilder."
pubDate: 2023-11-10
tags:
  - "csharp"
  - "maui"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/11/maui-library-register-handlers"
translatedBy: "claude"
translationDate: 2026-05-01
---
Quer você esteja desenvolvendo uma biblioteca de controles personalizados ou apenas organizando sua solução em vários projetos, é bem provável que acabe na situação de querer registrar alguns view handlers e serviços de dentro de uma biblioteca MAUI.

Para começar, não existe registro com configuração zero. O MAUI usa um padrão builder para criar a aplicação e você precisará de acesso a esse builder para registrar seus handlers e serviços.

A melhor abordagem para esse problema é definir uma classe estática com um método de extensão de `MauiAppBuilder` no projeto da sua biblioteca. Veja um exemplo abaixo:

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

Esse tipo de implementação segue o padrão builder e pode ser facilmente integrada ao projeto consumidor. Você só precisa ir até o `Program.cs` do MAUI e adicionar um `.UseMyPlugin()` na cadeia de chamadas do app builder.

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
