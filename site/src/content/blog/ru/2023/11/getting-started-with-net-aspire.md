---
title: "Начало работы с .NET Aspire"
description: "Пошаговое руководство по созданию вашего первого приложения .NET Aspire с описанием структуры проекта, обнаружения сервисов и панели мониторинга Aspire."
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "ru"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
Эта статья проведёт вас через создание вашего первого приложения .NET Aspire. Если вам нужен обзор .NET Aspire и того, что он предлагает, ознакомьтесь со статьёй [What is .NET Aspire](/ru/2023/11/what-is-net-aspire/).

## Prerequisites

Есть несколько вещей, которые нужно подготовить перед началом работы с .NET Aspire:

-   Visual Studio 2022 Preview (версия 17.9 или выше)
    -   с установленным workload .NET Aspire
    -   и .NET 8.0
-   Docker Desktop

Если вы предпочитаете не использовать Visual Studio, можете установить .NET Aspire с помощью CLI dotnet через команду `dotnet workload install aspire`. После этого вы свободны использовать любую IDE по своему вкусу.

Для подробного руководства по установке всех необходимых предварительных требований .NET Aspire ознакомьтесь со статьёй [How to install .NET Aspire](/ru/2023/11/how-to-install-net-aspire/).

## Create new project

В Visual Studio выберите **File** > **New** > **Project**, выберите **.NET Aspire** в выпадающем списке типов проекта или найдите слово "Aspire". Должны появиться два шаблона:

-   **.NET Aspire Application** -- пустой шаблон проекта .NET Aspire.
-   **.NET Aspire Starter Application** -- более полный шаблон проекта, содержащий фронтенд на Blazor, бэкенд-сервис API и, опционально, кеширование с использованием Redis.

Для нашего первого приложения .NET Aspire выберем шаблон **.NET Aspire Starter Application**.

[![Диалог создания нового проекта Visual Studio с отфильтрованным списком шаблонов проектов .NET Aspire.](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

Дайте проекту имя и в диалоге **Additional information** убедитесь, что включена опция **Use Redis for caching**. Это полностью опционально, но служит хорошим примером того, что .NET Aspire может для вас сделать.

[![Диалог дополнительной информации для шаблона проекта .NET Aspire Starter Application с опциональной настройкой Use Redis for caching (требуется Docker).](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

### Using dotnet CLI

Также вы можете создавать приложения .NET Aspire с помощью CLI dotnet. Для создания приложения по шаблону .NET Aspire Starter Application используйте следующую команду, заменив `Foo` на желаемое имя решения.

```bash
dotnet new aspire-starter --use-redis-cache --output Foo
```

## Project structure

После создания решения .NET Aspire рассмотрим его структуру. В вашем решении должно быть 4 проекта:

-   **ApiService**: проект API ASP.NET Core, используемый фронтендом для получения данных.
-   **AppHost**: выступает в роли оркестратора, соединяя и настраивая различные проекты и сервисы вашего приложения .NET Aspire.
-   **ServiceDefaults**: общий проект для управления конфигурациями, связанными с устойчивостью, обнаружением сервисов и телеметрией.
-   **Web**: приложение Blazor, выступающее в качестве нашего фронтенда.

Зависимости между проектами выглядят так:

[![Граф зависимостей проектов для .NET Aspire Starter Application: AppHost наверху, зависит от ApiService и Web, оба зависят от ServiceDefaults.](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

Начнём сверху.

## AppHost project

Это наш проект-оркестратор решения .NET Aspire. Его роль — соединять и настраивать различные проекты и сервисы нашего приложения .NET Aspire.

Посмотрим на его файл `.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsAspireHost>true</IsAspireHost>
  </PropertyGroup>

  <ItemGroup>
    <ProjectReference Include="..\Foo.ApiService\Foo.ApiService.csproj" />
    <ProjectReference Include="..\Foo.Web\Foo.Web.csproj" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting" Version="8.0.0-preview.1.23557.2" />
  </ItemGroup>

</Project>
```

Бросаются в глаза две вещи:

-   элемент `IsAspireHost`, который явно помечает этот проект как оркестратор нашего решения
-   ссылка на пакет `Aspire.Hosting`. Этот пакет содержит основной API и абстракции для модели приложения .NET Aspire. Поскольку фреймворк всё ещё в preview, NuGet-пакеты .NET Aspire также отмечены как предварительные версии.

Далее посмотрим на `Program.cs`. Вы заметите очень знакомый builder-паттерн, используемый для связывания различных проектов и включения кеширования.

```cs
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedisContainer("cache");

var apiservice = builder.AddProject<Projects.Foo_ApiService>("apiservice");

builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(apiservice);

builder.Build().Run();
```

Что код выше по сути делает:

-   создаёт экземпляр `IDistributedApplicationBuilder`, используемый для построения нашего `DistributedApplication`
-   создаёт `RedisContainerResource`, на который мы можем ссылаться позже в наших проектах и сервисах
-   добавляет наш проект `ApiService` в приложение и хранит экземпляр `ProjectResource`
-   добавляет наш проект `Web` в приложение, ссылаясь на кеш Redis и `ApiService`
-   прежде чем наконец вызвать `Build()` для построения экземпляра `DistributedApplication` и `Run()` для его запуска.

## ApiService project

Проект `ApiService` предоставляет конечную точку `/weatherforecast`, которую мы можем использовать из нашего проекта `Web`. Чтобы сделать API доступным для использования, мы зарегистрировали его в нашем проекте `AppHost` и дали ему имя `apiservice`.

```cs
builder.AddProject<Projects.Foo_ApiService>("apiservice")
```

## Web project

Проект `Web` представляет наш фронтенд на Blazor и потребляет конечную точку `/weatherforecast`, предоставляемую нашим `ApiService`. Способ, которым он это делает, — это то место, где магия .NET Aspire по-настоящему начинает действовать.

Вы заметите, что он использует типизированный `HttpClient`:

```cs
public class WeatherApiClient(HttpClient httpClient)
{
    public async Task<WeatherForecast[]> GetWeatherAsync()
    {
        return await httpClient.GetFromJsonAsync<WeatherForecast[]>("/weatherforecast") ?? [];
    }
}
```

Теперь, если вы посмотрите внутрь `Program.cs`, заметите кое-что интересное на строке 14:

```cs
builder.Services.AddHttpClient<WeatherApiClient>(client =>
    client.BaseAddress = new("http://apiservice"));
```

Помните, как мы дали проекту `ApiService` имя `apiservice` при добавлении его в качестве `ProjectResource` в наш `DistributedApplication`? Теперь эта строка настраивает типизированный `WeatherApiClient` на использование обнаружения сервисов и подключение к сервису с именем `apiservice`. `http://apiservice` автоматически разрешится в правильный адрес нашего ресурса `ApiService` без какой-либо дополнительной конфигурации с вашей стороны.

## ServiceDefaults project

Подобно проекту `AppHost`, общий проект также отличается с помощью специального свойства проекта:

```xml
<IsAspireSharedProject>true</IsAspireSharedProject>
```

Проект гарантирует, что все различные проекты и сервисы настроены одинаково в отношении устойчивости, обнаружения сервисов и телеметрии. Делает он это, предоставляя набор методов расширения, которые могут быть вызваны проектами и сервисами решения на их собственных экземплярах `IHostApplicationBuilder`.

## Run the project

Для запуска проекта убедитесь, что `AppHost` назначен в качестве вашего стартового проекта, и нажмите run (F5) в Visual Studio. Альтернативно вы можете запустить проект из командной строки, используя `dotnet run --project Foo/Foo.AppHost`, заменив `Foo` на имя вашего проекта.

После запуска приложения вам будет показана панель .NET Aspire.

[![Панель .NET Aspire, выполняющая шаблон проекта .NET Aspire Starter Application.](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

Панель позволяет отслеживать различные части вашего приложения .NET Aspire: ваши проекты, контейнеры и исполняемые файлы. Также она предоставляет агрегированные структурированные журналы для ваших сервисов, трассировки запросов и различные другие полезные метрики.

[![Трассировка запроса внутри панели .NET Aspire, показывающая запрос на этапах его прохождения через различные компоненты приложения.](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)

Вот и всё! Поздравляем с созданием и запуском вашего самого первого приложения .NET Aspire!
