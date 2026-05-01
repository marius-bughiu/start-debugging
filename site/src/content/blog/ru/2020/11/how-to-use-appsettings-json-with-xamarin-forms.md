---
title: "Как использовать appsettings.json в Xamarin.Forms"
description: "Узнайте, как использовать конфигурационные файлы appsettings.json в Xamarin.Forms, встраивая файл как ресурс и создавая объект IConfiguration."
pubDate: 2020-11-13
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin-forms"
lang: "ru"
translationOf: "2020/11/how-to-use-appsettings-json-with-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
По сравнению с ASP.NET есть два ключевых отличия:

-   во-первых, мы будем работать с Embedded Resource, а не с файлом на диске
-   во-вторых, мы сами зарегистрируем файл `appsettings.json`

Для начала добавьте файл `appsettings.json` в общий (shared) проект. Установите для него `Build Action` равное `Embedded Resource`. Добавьте в файл несколько ключей и значений, которые сможем использовать для проверки. Например:

```json
{
  "ChatHubUrl": "https://signalrchatweb.azurewebsites.net/"
}
```

Далее нужно получить поток ресурса.

```cs
Stream resourceStream = GetType().GetTypeInfo().Assembly.GetManifestResourceStream("SignalRChat.appsettings.json");
```

И использовать его для построения объекта `IConfiguration`.

```cs
var configuration = new ConfigurationBuilder()
                .AddJsonStream(resourceStream)
                .Build();
```

Теперь, чтобы получить из него значения конфигурации, используйте его как обычный словарь.

```cs
configuration["ChatHubUrl"];
```

Либо можно зарегистрировать его в вашем IoC-контейнере как `IConfiguration`, внедрить в viewmodel и использовать так же.

Полный пример раньше находился в репозитории Xamarin Forms -- SignalR Chat на GitHub, который больше не доступен.
