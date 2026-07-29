---
title: "Решение: Reflection-based serialization has been disabled for this application"
description: "Это InvalidOperationException означает, что PublishTrimmed или PublishAot выставили JsonSerializerIsReflectionEnabledByDefault в false. Решается сгенерированным JsonSerializerContext."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "trimming"
  - "native-aot"
lang: "ru"
translationOf: "2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application"
translatedBy: "claude"
translationDate: 2026-07-29
---

В вашем проекте `PublishTrimmed` или `PublishAot` выставлены в `true`, и .NET SDK в ответ установил `JsonSerializerIsReflectionEnabledByDefault` в `false`. Это отключает основанный на рефлексии резолвер контрактов, на который молча полагается `JsonSerializer.Serialize(obj)`. Решение состоит в том, чтобы дать сериализатору источник контрактов: добавьте `partial class`, наследующий от `JsonSerializerContext`, пометьте его атрибутом `[JsonSerializable(typeof(YourType))]` и передавайте `MyContext.Default.YourType` (или задайте `options.TypeInfoResolver = MyContext.Default`) в каждой точке вызова.

```text
System.InvalidOperationException: Reflection-based serialization has been disabled for this application. Either use the source generator APIs or explicitly configure the 'JsonSerializerOptions.TypeInfoResolver' property.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_JsonSerializerIsReflectionDisabled()
   at System.Text.Json.JsonSerializerOptions.ConfigureForJsonSerializer()
   at System.Text.Json.JsonSerializerOptions.GetTypeInfoForRootType(Type type, Boolean fallBackToNearestAncestorType)
   at System.Text.Json.JsonSerializer.Serialize[TValue](TValue value, JsonSerializerOptions options)
   at MyApp.Program.Main(String[] args)
```

Точная строка берётся из ресурса `JsonSerializerIsReflectionDisabled` в `System.Text.Json` и сформулирована одинаково начиная с .NET 8. Всё описанное ниже ориентировано на .NET 11 SDK (`11.0.100`) и C# 14, но поведение идентично на `net8.0` и новее, потому что именно тогда был введён этот переключатель.

## Почему в проекте, который вы никогда не настраивали, рефлексия отключена

`System.Text.Json` определяет форму типа одним из двух способов: во время выполнения через рефлексию (`DefaultJsonTypeInfoResolver`) или во время компиляции через генератор исходного кода (`JsonSerializerContext`). Когда вы вызываете `JsonSerializer.Serialize(obj)` без опций, срабатывает резолвер на рефлексии.

Рефлексия не переживает trimming. Триммер удаляет члены, достижимость которых он не может доказать, а геттеры свойств, вызываемые только через `PropertyInfo`, именно таковы: недостижимы для статического анализа. До .NET 8 обрезанное приложение спокойно сериализовало объект и просто молча теряло свойства, которые триммер удалил. Молчаливая потеря данных хуже падения, поэтому в .NET 8 поведение по умолчанию изменили: установка `PublishTrimmed` в `true` [автоматически выставляет `JsonSerializerIsReflectionEnabledByDefault` в `false`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed), если вы не указали иное. `PublishAot` подразумевает `PublishTrimmed`, поэтому приложения Native AOT наследуют то же значение по умолчанию.

Свойство MSBuild здесь не механизм, а лишь переключатель. SDK превращает его в параметр конфигурации хоста среды выполнения:

```xml
<!-- Microsoft.NET.Sdk.targets, .NET 11 SDK -->
<RuntimeHostConfigurationOption Include="System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault"
                                Condition="'$(JsonSerializerIsReflectionEnabledByDefault)' != ''"
                                Value="$(JsonSerializerIsReflectionEnabledByDefault)"
                                Trim="true" />
```

Это попадает в ваш `.runtimeconfig.json` как переключатель `AppContext`, а `Trim="true"` говорит ILLink рассматривать его как константу времени компоновки, чтобы ветки кода с рефлексией можно было удалить полностью. `JsonSerializer.IsReflectionEnabledByDefault` читает этот переключатель и [по умолчанию равен `true`, если он не задан](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault).

Отсюда следуют две вещи, которые объясняют большинство запутанных баг-репортов. Во-первых, переключатель действует на приложение, а не на библиотеку: NuGet-пакет не может отключить его за вас, и вы не можете включить его для отдельной сборки. Во-вторых, исключение возникает при первом использовании, а не при старте. `JsonSerializerOptions.Default` создаётся с `JsonTypeInfoResolver.Empty` вместо резолвера на рефлексии, а `ConfigureForJsonSerializer` выбрасывает исключение только тогда, когда вызов сериализации или десериализации натыкается на пустой резолвер. Так что узнаете вы об этом на той ветке кода, которая выполняется раз в неделю.

## Минимальное воспроизведение

Три строки файла проекта и одна строка C#:

```xml
<!-- MyApp.csproj, .NET 11 SDK 11.0.100 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var json = JsonSerializer.Serialize(new { Value = 42 });
// System.InvalidOperationException: Reflection-based serialization has been disabled...
```

Обратите внимание, где находится `PublishTrimmed`. Поскольку свойство попадает в `runtimeconfig.json` уже на этапе **сборки**, размещение его в файле проекта приводит к тому, что `dotnet run` в конфигурации Debug тоже выбрасывает исключение. Если же передавать его только в командной строке публикации (`dotnet publish -p:PublishTrimmed=true`), локальный `dotnet run` продолжит работать, и падать будет только опубликованный артефакт. Именно эта разновидность ошибки доезжает до продакшена. Документация по trimming рекомендует файл проекта [именно затем, чтобы настройка применялась и при `dotnet build`](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options).

Чтобы убедиться, что вы имеете дело именно с этим, а не с чем-то другим, посмотрите вывод сборки:

```bash
cat bin/Debug/net11.0/MyApp.runtimeconfig.json
```

```json
{
  "runtimeOptions": {
    "tfm": "net11.0",
    "configProperties": {
      "System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault": false
    }
  }
}
```

Либо проверьте из кода, что работает и для Native AOT, где файла runtimeconfig для чтения нет:

```csharp
// .NET 11, C# 14
Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault); // False
```

## Решение 1: поставляйте JsonSerializerContext и используйте его везде

Это то решение, о котором просит сообщение об ошибке, и единственное, которое оставляет вас с действительно trim-безопасным приложением. Объявите частичный контекст, перечислите каждый корневой тип, который вы сериализуете, и направьте вызовы через него.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0
using System.Text.Json;
using System.Text.Json.Serialization;

public record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WeatherForecast))]
[JsonSerializable(typeof(List<WeatherForecast>))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Затем выберите одну из трёх поддерживаемых форм вызова:

```csharp
// .NET 11, C# 14
// 1. Strongly typed, zero options plumbing. Preferred.
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);
WeatherForecast? back = JsonSerializer.Deserialize(json, AppJsonContext.Default.WeatherForecast);

// 2. Through options, when an API forces you to hand it a JsonSerializerOptions.
var options = new JsonSerializerOptions { TypeInfoResolver = AppJsonContext.Default };
json = JsonSerializer.Serialize(forecast, options);

// 3. Non-generic, when the type is only known at runtime.
json = JsonSerializer.Serialize(forecast, typeof(WeatherForecast), AppJsonContext.Default);
```

Задавайте опции через `[JsonSourceGenerationOptions]`, а не на экземпляре `JsonSerializerOptions`, где это возможно. Тогда сгенерированное свойство `Default` уже сконфигурировано на этапе компиляции, и вы не сможете забыть применить политику именования в одной из шести точек вызова. Коллекциям нужна собственная запись `[JsonSerializable]` (`List<WeatherForecast>` выше), а членам, объявленным как `object`, нужна регистрация каждого возможного типа времени выполнения, потому что генератору больше не на что опереться.

## Решение 2: подключите контекст к ASP.NET Core, HttpClient и Blazor

Большинство приложений не вызывают `JsonSerializer` напрямую. Они передают тип методу фреймворка, который вызывает сериализатор за них, и таким методам резолвер нужно установить один раз при старте.

Для minimal API, включая шаблон Native AOT, использующий `CreateSlimBuilder`:

```csharp
// .NET 11, ASP.NET Core 11
var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});
```

Для контроллеров MVC и Web API:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(static options =>
    options.JsonSerializerOptions.TypeInfoResolverChain.Add(AppJsonContext.Default));
```

Для `HttpClient` используйте перегрузки, принимающие `JsonTypeInfo<T>`, а не те, которые выводят его сами:

```csharp
// .NET 11, C# 14
var forecast = await client.GetFromJsonAsync("/weather", AppJsonContext.Default.WeatherForecast);
await client.PostAsJsonAsync("/weather", forecast, AppJsonContext.Default.WeatherForecast);
```

О `TypeInfoResolverChain` стоит знать и само по себе: опции опрашивают резолверы по порядку и берут первый ненулевой результат, так что вы можете собрать несколько контекстов из разных проектов через `JsonTypeInfoResolver.Combine(ContextA.Default, ContextB.Default)` или вставить свой перед фреймворковым.

## Решение 3: вернуть рефлексию в точке вызова, не трогая MSBuild

Сообщение об ошибке предлагает второй выход: "explicitly configure the `JsonSerializerOptions.TypeInfoResolver` property". Резолвер на рефлексии остаётся публичным типом, и его создание переключатель не проверяет:

```csharp
// .NET 11, C# 14. Works in a trimmed app. Does NOT work under Native AOT.
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver()
};
string json = JsonSerializer.Serialize(new { Value = 42 }, options);
```

Понимайте, что именно вы покупаете. Исключение исчезает, потому что вы запросили рефлексию явно, но триммер уже удалил члены, которые счёл неиспользуемыми. Вы получаете сериализацию, которая отрабатывает и молча выдаёт неполный объект, то есть ровно тот сценарий отказа, ради предотвращения которого и появилось изменение в .NET 8. Под Native AOT всё хуже: `DefaultJsonTypeInfoResolver` помечен атрибутом `[RequiresDynamicCode]`, так что вы меняете `InvalidOperationException` на `PlatformNotSupportedException` или на отказ из-за отсутствующих метаданных во время выполнения. Считайте это диагностическим шагом (переживает ли моя полезная нагрузка trimming?), а не решением.

По-настоящему полезен условный резолвер, который документация рекомендует для библиотек, обязанных работать в обоих мирах:

```csharp
// .NET 11, C# 14
static JsonSerializerOptions CreateDefaultOptions() => new()
{
    TypeInfoResolver = JsonSerializer.IsReflectionEnabledByDefault
        ? new DefaultJsonTypeInfoResolver()
        : AppJsonContext.Default
};
```

Поскольку `IsReflectionEnabledByDefault` подставляется как константа времени компоновки, ILLink сворачивает ветку и никогда не удерживает резолвер на рефлексии в AOT-сборке.

## Решение 4: вернуть переключатель обратно, и когда это оправдано

Восстановить поведение .NET 7 можно одним свойством:

```xml
<!-- MyApp.csproj, .NET 11 SDK -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <JsonSerializerIsReflectionEnabledByDefault>true</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

Делайте так, когда сторонняя зависимость вызывает `JsonSerializer.Serialize` для собственных типов глубоко внутри своего кода и не поставляет никакого `JsonSerializerContext`. Переписать её точки вызова вы не можете, а генератор исходного кода в вашей сборке не поможет, потому что резолвер должен быть привязан к тому экземпляру опций, который создаёт библиотека. На это натыкались несколько широко используемых пакетов: это породило баг-репорты, среди прочего, к провайдеру Azure App Configuration и к конечной точке Swagger UI в ASP.NET Core.

Две оговорки. Во-первых, вы возвращаете себе молчаливую потерю данных: резолвер на рефлексии отработает, но только по тем членам, которые пережили trimming, поэтому тестируйте реальный опубликованный артефакт на реальных данных, а не полагайтесь на успешный `dotnet run`. Во-вторых, если вы на Native AOT, переключение этого свойства не заставит рефлексию работать; оно лишь убирает ограждение, которое вовремя говорило вам правду.

## Ловушки, ведущие к неверному решению

**Следующая ошибка будет `NoMetadataForType`.** После добавления контекста тип, который вы забыли пометить, выбросит `JsonTypeInfo metadata for type 'X' was not provided by TypeInfoResolver of type 'Y'`. Это прогресс, а не регресс: ошибка называет недостающий тип. Добавьте для него `[JsonSerializable(typeof(X))]`, включая типы коллекций и каждый подтип, который вы сериализуете полиморфно. Если вы используете `[JsonDerivedType]`, каждому производному типу нужна своя запись, о чём подробно рассказывает руководство по [полиморфной сериализации с `JsonDerivedType`](/ru/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/).

**Предупреждения на этапе компиляции нет.** Очевидная просьба, анализатор, помечающий `JsonSerializer.Serialize(x)` при выключенном переключателе, была заведена как [dotnet/runtime#107440](https://github.com/dotnet/runtime/issues/107440) и закрыта как не запланированная. Предупреждения анализа trimming (`IL2026`, `IL3050`) всё же укажут на сериализацию через рефлексию в вашем собственном коде, так что считайте чистую сборку с анализом trimming ближайшим аналогом проверки на этапе компиляции. Как этого добиться, разбирается в статье про [trim-безопасный код](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**В .NET MAUI это воспроизводится только в Release или только на устройстве.** MAUI сам задаёт свойства trimming: Android и Mac Catalyst используют частичный trimming для сборок Release, а iOS использует его для любой сборки под устройство независимо от конфигурации, тогда как сборки под симулятор не обрезаются вовсе. Так что "работает в симуляторе, падает на настоящем iPhone" и "работает в Debug, падает в Release" это одна и та же ошибка. Не задавайте `PublishTrimmed` самостоятельно в проекте MAUI: этим свойством владеет SDK.

**`PlatformNotSupportedException` это другая ошибка.** Если в трассировке стека упоминается `Reflection.Emit` или компиляция деревьев выражений, а не `ConfigureForJsonSerializer`, вы смотрите на отсутствие JIT в AOT, а не на переключатель JSON. Этот случай разбирается в статье про [`PlatformNotSupportedException` в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/).

**Необобщённый `JsonStringEnumConverter` не поддерживается в AOT.** Как только вы перешли на генерацию исходного кода, замените его на `JsonStringEnumConverter<TEnum>` на самом перечислении или задайте `UseStringEnumConverter = true` в `[JsonSourceGenerationOptions]`. То же ограничение действует для написанных вручную конвертеров, что стоит сверить с правилами [написания собственного `JsonConverter`](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

**Включить это намеренно тоже разумный выбор.** Если вы хотите видеть эту ошибку в необрезанном приложении, чтобы несовместимости с AOT всплывали на CoreCLR ещё во время разработки, выставьте `JsonSerializerIsReflectionEnabledByDefault` в `false` сами. Поведение свойства одинаково на CoreCLR и Native AOT, что и делает его хорошей системой раннего предупреждения. Это самостоятельное применение свойства разбирается в более ранней заметке про [отключение сериализации на основе рефлексии](/ru/2023/10/system-text-json-disable-reflection-based-serialization/).

## Похожие статьи

- [Что такое trim-безопасный код и как его писать?](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [Что такое Native AOT и во что он вам обходится?](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Решение: PlatformNotSupportedException в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [Как сериализовать полиморфную иерархию типов с JsonDerivedType](/ru/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [Как использовать Native AOT с minimal API в ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## Источники

- [Breaking change: PublishTrimmed projects fail reflection-based serialization](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed) - MS Learn
- [How to use source generation in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation), включая раздел "Disable reflection defaults" - MS Learn
- [Свойство JsonSerializer.IsReflectionEnabledByDefault](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault) - MS Learn
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options) - MS Learn
- [Trim a .NET MAUI app](https://learn.microsoft.com/en-us/dotnet/maui/deployment/trimming), про значения trimming по умолчанию для каждой платформы - MS Learn
- [System.Text.Json analyzers should warn about using reflection when reflection is disabled](https://github.com/dotnet/runtime/issues/107440) - dotnet/runtime
- [`JsonSerializerOptions.ConfigureForJsonSerializer`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/JsonSerializerOptions.cs) и строковый ресурс `JsonSerializerIsReflectionDisabled` - dotnet/runtime
