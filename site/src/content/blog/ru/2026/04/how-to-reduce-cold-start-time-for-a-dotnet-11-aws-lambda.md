---
title: "Как сократить время холодного старта AWS Lambda на .NET 11"
description: "Практичный, привязанный к версиям сценарий сокращения холодного старта Lambda на .NET 11. Покрывает Native AOT на provided.al2023, ReadyToRun, SnapStart на управляемом runtime dotnet10, тюнинг памяти, переиспользование статических полей, безопасность trim и как реально читать INIT_DURATION."
pubDate: 2026-04-27
template: how-to
tags:
  - "aws"
  - "aws-lambda"
  - "dotnet-11"
  - "native-aot"
  - "performance"
lang: "ru"
translationOf: "2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda"
translatedBy: "claude"
translationDate: 2026-04-29
---

Типичная Lambda на .NET переходит от стандартного `dotnet new lambda.EmptyFunction` с холодным стартом 1500-2500 мс к менее чем 300 мс, складывая четыре рычага: выбрать правильный runtime (Native AOT на `provided.al2023` или SnapStart на управляемом runtime), дать функции достаточно памяти, чтобы init шёл на полной vCPU, поднять всё переиспользуемое в статическую инициализацию и прекратить грузить код, который не нужен. Это руководство проходит каждый рычаг для Lambda на .NET 11 (`Amazon.Lambda.RuntimeSupport` 1.13.x, `Amazon.Lambda.AspNetCoreServer.Hosting` 1.7.x, .NET 11 SDK, C# 14), объясняет порядок их применения и показывает, как проверять каждый шаг по строке `INIT_DURATION` в CloudWatch.

## Почему стандартная .NET-Lambda холодно стартует так медленно

Холодный старт на управляемом runtime в Lambda выполняет четыре вещи подряд, и стандартная .NET-функция платит за все. Сначала **microVM Firecracker** загружается и Lambda забирает ваш пакет деплоя. Во-вторых, **runtime инициализируется**: для управляемого runtime это значит, что CoreCLR грузится, JIT хоста прогревается, а сборки вашей функции мапятся в память. В-третьих, конструируется ваш **класс handler**, включая constructor injection, загрузку конфигурации и конструирование клиентов AWS SDK. Только после всего этого Lambda вызывает ваш `FunctionHandler` для первой инвокации.

Стоимость, специфичная для .NET, проявляется в шагах два и три. CoreCLR JIT-компилирует каждый метод при первом вызове. ASP.NET Core (когда вы используете мост хостинга API Gateway) строит полноценный host с logging, configuration и pipeline option-binding. Стандартные клиенты AWS SDK лениво разрешают учётные данные, обходя цепочку credential providers, что в Lambda быстро, но всё равно аллоцирует. Сериализаторы, сильно зависящие от reflection, как стандартные пути `System.Text.Json`, инспектируют каждое свойство каждого типа, который видят впервые.

Можно тянуть за четыре рычага, в этом порядке, с убывающей отдачей:

1. **Native AOT** поставляет предкомпилированный бинарник, поэтому стоимость JIT уходит в ноль и runtime запускает крошечный самодостаточный исполняемый файл.
2. **SnapStart** делает снимок уже прогретой фазы init и восстанавливает с диска при холодном старте.
3. **Размер памяти** покупает вам пропорциональный CPU, что ускоряет всё в init.
4. **Переиспользование статических полей и trimming** уменьшают то, что выполняется во время init и что переделывается при каждом холодном старте.

## Рычаг 1: Native AOT на provided.al2023 (наибольший единичный выигрыш)

Native AOT компилирует вашу функцию и runtime .NET в один статический бинарник, устраняет JIT и сокращает холодный старт примерно до времени, которое нужно Lambda для запуска процесса. AWS публикует [первоклассное руководство](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) для этого на кастомном runtime `provided.al2023`. С .NET 11 toolchain совпадает с тем, что поставлялось в .NET 8, но trim-анализатор строже, и предупреждения `ILLink`, которые были зелёными в .NET 8, могут зажечься.

Минимальная функция, готовая к AOT, выглядит так:

```csharp
// .NET 11, C# 14
// PackageReference: Amazon.Lambda.RuntimeSupport 1.13.0
// PackageReference: Amazon.Lambda.Serialization.SystemTextJson 2.4.4
using System.Text.Json.Serialization;
using Amazon.Lambda.Core;
using Amazon.Lambda.RuntimeSupport;
using Amazon.Lambda.Serialization.SystemTextJson;

var serializer = new SourceGeneratorLambdaJsonSerializer<LambdaFunctionJsonContext>();

var handler = static (Request req, ILambdaContext ctx) =>
    new Response($"hello {req.Name}", DateTimeOffset.UtcNow);

await LambdaBootstrapBuilder.Create(handler, serializer)
    .Build()
    .RunAsync();

public record Request(string Name);
public record Response(string Message, DateTimeOffset At);

[JsonSerializable(typeof(Request))]
[JsonSerializable(typeof(Response))]
public partial class LambdaFunctionJsonContext : JsonSerializerContext;
```

Важные переключатели `csproj`:

```xml
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <PublishAot>true</PublishAot>
  <StripSymbols>true</StripSymbols>
  <InvariantGlobalization>true</InvariantGlobalization>
  <RootNamespace>MyFunction</RootNamespace>
  <AssemblyName>bootstrap</AssemblyName>
  <TieredCompilation>false</TieredCompilation>
</PropertyGroup>
```

`AssemblyName` `bootstrap` требуется кастомным runtime. `InvariantGlobalization=true` удаляет ICU, экономя размер пакета и избегая страшной инициализации ICU при холодном старте. Если нужны реальные данные культур, замените на `<PredefinedCulturesOnly>false</PredefinedCulturesOnly>` и примите рост размера.

Собирайте на Amazon Linux (или в Linux-контейнере), чтобы линкер совпадал с окружением Lambda:

```bash
# .NET 11 SDK
dotnet lambda package --configuration Release \
  --framework net11.0 \
  --msbuild-parameters "--self-contained true -r linux-x64 -p:PublishAot=true"
```

Глобальный инструмент `Amazon.Lambda.Tools` упаковывает бинарник `bootstrap` в ZIP, который вы загружаете как кастомный runtime. С функцией 256 MB и шаблоном выше ожидайте холодные старты в диапазоне **150 ms - 300 ms**, упавшие с 1500-2000 ms на управляемом runtime.

Компромисс: каждая библиотека, тяжёлая на reflection, которую вы тянете, становится trim-предупреждением. Генераторы кода `System.Text.Json` покрывают сериализацию, но если используете что-то, что отражает по generic-типам в runtime (старый AutoMapper, Newtonsoft, обработчики MediatR на reflection), получите предупреждения ILLink или исключение в runtime. Воспринимайте каждое предупреждение как реальный баг. Альтернатива mediator, дружественная к trim, рассмотрена в [SwitchMediator v3, медиатор с нулевыми аллокациями, остающийся дружественным к AOT](/2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot/).

## Рычаг 2: SnapStart на управляемом runtime dotnet10

Если ваш код не дружит с AOT (тяжёлый reflection, динамические плагины, EF Core 11 с построением модели в runtime), Native AOT не подходит. Следующая лучшая опция -- **Lambda SnapStart**, поддерживаемая сегодня на **управляемом runtime `dotnet10`**. На апрель 2026 управляемый runtime `dotnet11` ещё не GA, поэтому практическая "управляемая" цель для кода .NET 11 -- мульти-таргет на `net10.0` и запуск на runtime `dotnet10` с включённым SnapStart, либо использование кастомного runtime, описанного выше. AWS объявил .NET 10 runtime в конце 2025 ([блог AWS: runtime .NET 10 теперь доступен в AWS Lambda](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/)), а поддержка SnapStart для управляемых .NET runtime задокументирована в [Улучшение производительности запуска с Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html).

SnapStart замораживает функцию после init, делает снимок microVM Firecracker и при холодном старте восстанавливает снимок вместо повторного запуска init. Для .NET, где init -- дорогая часть, это типично снижает холодные старты на 60-90%.

Две вещи важны для корректности SnapStart:

1. **Детерминизм после восстановления.** Всё, захваченное во время init (random seed'ы, машинно-специфичные токены, сетевые сокеты, кеши, производные от времени), общее для каждого восстановленного экземпляра. Используйте runtime hooks, которые предоставляет AWS:

```csharp
// .NET 10 target multi-targeted with .NET 11
using Amazon.Lambda.RuntimeSupport;

Core.SnapshotRestore.RegisterBeforeSnapshot(() =>
{
    // flush anything that should not be captured
    return ValueTask.CompletedTask;
});

Core.SnapshotRestore.RegisterAfterRestore(() =>
{
    // re-seed RNG, refresh credentials, reopen sockets
    return ValueTask.CompletedTask;
});
```

2. **Pre-JIT'те то, что хотите видеть прогретым.** SnapStart захватывает JIT'ed состояние. Tiered-компиляция не успеет продвинуть горячие методы до tier-1 во время init, поэтому вы получаете снимок преимущественно tier-0 кода, если не подтолкнуть. Пройдите по горячему пути один раз во время init (вызовите handler с синтетическим warm-up payload или явно вызовите ключевые методы), чтобы снимок включал их JIT'ed формы. С `<TieredPGO>true</TieredPGO>` (стандарт .NET 11) это значит чуть меньше, но всё ещё ощутимо помогает.

SnapStart сегодня бесплатен для управляемых runtime .NET, с оговоркой, что создание снимка добавляет небольшую задержку к деплоям.

## Рычаг 3: размер памяти покупает CPU

Lambda распределяет CPU пропорционально памяти. На 128 MB вы получаете долю vCPU. На 1769 MB -- одну полную vCPU, а выше -- больше одной. **Init работает на той же пропорциональной CPU**, поэтому функция, настроенная на 256 MB, платит счёт по JIT и DI значительно медленнее, чем тот же код на 1769 MB.

Конкретные цифры для маленькой Lambda на минимальном API ASP.NET Core:

| Память  | INIT_DURATION (управляемый dotnet10) | INIT_DURATION (Native AOT) |
| ------- | ------------------------------------ | -------------------------- |
| 256 MB  | ~1800 ms                             | ~280 ms                    |
| 512 MB  | ~1100 ms                             | ~200 ms                    |
| 1024 MB | ~700 ms                              | ~180 ms                    |
| 1769 MB | ~480 ms                              | ~160 ms                    |

Вывод не "всегда используй 1769 MB". А что нельзя сделать никаких выводов о холодном старте на 256 MB. Бенчмаркуйте на том размере памяти, на котором собираетесь деплоить, и помните, что **state machine [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning)** находит оптимальный по стоимости размер памяти для вашей нагрузки за несколько минут.

## Рычаг 4: переиспользование статических полей и trim графа init

После выбора runtime и памяти оставшиеся выигрыши приходят от того, чтобы делать меньше работы во время init и больше переиспользовать между инвокациями. Три паттерна покрывают большую часть достойного.

### Поднимите клиентов и сериализаторы в статические поля

Lambda переиспользует одну и ту же среду выполнения между инвокациями, пока она не остынет. Всё, что вы кладёте в статическое поле, выживает. Классическая ошибка -- аллоцировать `HttpClient` или клиент AWS SDK внутри handler'а:

```csharp
// .NET 11 - bad: per-invocation construction
public async Task<Response> Handler(Request req, ILambdaContext ctx)
{
    using var http = new HttpClient(); // pays DNS, TCP, TLS every time
    var s3 = new AmazonS3Client();      // re-resolves credentials chain
    // ...
}
```

Поднимите их выше:

```csharp
// .NET 11 - good: shared across warm invocations
public sealed class Function
{
    private static readonly HttpClient Http = new();
    private static readonly AmazonS3Client S3 = new();

    public async Task<Response> Handler(Request req, ILambdaContext ctx)
    {
        // reuses Http and S3 across warm invocations on the same instance
    }
}
```

Этот паттерн задокументирован в [Как unit-тестировать код, использующий HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/), который освещает аспект тестируемости. Для Lambda правило простое: всё, что дорого создавать и безопасно переиспользовать, идёт в статику.

### Всегда используйте генераторы кода System.Text.Json

Стандартный `System.Text.Json` отражает по вашим типам DTO при первом использовании, что раздувает время init и несовместимо с Native AOT. Генераторы кода делают работу на этапе сборки:

```csharp
// .NET 11
[JsonSerializable(typeof(APIGatewayProxyRequest))]
[JsonSerializable(typeof(APIGatewayProxyResponse))]
[JsonSerializable(typeof(MyDomainObject))]
public partial class LambdaJsonContext : JsonSerializerContext;
```

Передайте сгенерированный context в `SourceGeneratorLambdaJsonSerializer<T>`. Это срезает сотни миллисекунд с холодных стартов на управляемом runtime и обязательно для AOT.

### Избегайте полного ASP.NET Core, когда он не нужен

Адаптер `Amazon.Lambda.AspNetCoreServer.Hosting` позволяет запускать настоящий минимальный API ASP.NET Core за API Gateway. Это большой выигрыш в DX, но он поднимает весь host ASP.NET Core: провайдеров конфигурации, провайдеров логирования, валидацию options, граф маршрутизации. Для Lambda с 5 endpoint'ами это сотни миллисекунд init. Сравните с самописным handler'ом на `LambdaBootstrapBuilder`, который поднимается за десятки миллисекунд.

Выбирайте осознанно:

-   **Много endpoint'ов, сложный pipeline, нужен middleware**: hosting ASP.NET Core нормально, идите по пути SnapStart.
-   **Один handler, один маршрут, важна производительность**: пишите голый handler против `Amazon.Lambda.RuntimeSupport`. Если хотите формы HTTP-запросов, принимайте `APIGatewayHttpApiV2ProxyRequest` напрямую.

### ReadyToRun, когда AOT слишком ограничителен

Если вы не можете отгрузить Native AOT из-за зависимости с тяжёлым reflection, но также не можете использовать SnapStart (возможно, потому что таргетируете управляемый runtime, который пока его не поддерживает), включите **ReadyToRun**. R2R предкомпилирует IL в нативный код, который JIT может использовать без перекомпиляции при первом вызове. Он урезает стоимость JIT примерно на 50-70% при холодном старте за счёт большего пакета:

```xml
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
  <PublishReadyToRunComposite>true</PublishReadyToRunComposite>
</PropertyGroup>
```

R2R обычно даёт выигрыш холодного старта 100-300 мс на управляемом runtime. Он стекуется со всем остальным и по сути бесплатен, поэтому это первое, что стоит попробовать, если не получается перейти на AOT или SnapStart.

## Правильное чтение INIT_DURATION

Строка `REPORT` в CloudWatch для инвокации с холодным стартом имеет вид:

```
REPORT RequestId: ... Duration: 12.34 ms Billed Duration: 13 ms
Memory Size: 512 MB Max Memory Used: 78 MB Init Duration: 412.56 ms
```

`Init Duration` -- это стоимость холодного старта: загрузка VM + init runtime + ваш статический конструктор и конструирование класса handler. Несколько правил для чтения:

-   `Init Duration` **не оплачивается** на управляемом runtime. На AOT кастомных runtime через модель `provided.al2023` -- оплачивается.
-   Первая инвокация на каждый параллельный экземпляр её показывает. Тёплые инвокации её опускают.
-   Функции SnapStart сообщают `Restore Duration` вместо `Init Duration`. Это ваша метрика холодного старта на SnapStart.
-   `Max Memory Used` -- максимум по высокой воде. Если он остаётся ниже ~30% от `Memory Size`, вы скорее всего переразмещены и могли бы попробовать меньший размер, но только после измерения на меньшем размере, поскольку CPU падает с памятью.

Инструмент, делающий это читаемым: запрос CloudWatch Log Insights вроде

```
fields @timestamp, @initDuration, @duration
| filter @type = "REPORT"
| sort @timestamp desc
| limit 200
```

Для более глубоких трасс [Как профилировать .NET-приложение с dotnet-trace и читать вывод](/ru/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) описывает, как захватывать и читать flame graph init из локальной сессии эмулятора Lambda.

## Provisioned concurrency -- запасной выход, не ответ

Provisioned concurrency держит `N` экземпляров постоянно прогретыми. Холодные старты на этих экземплярах нулевые, потому что они не холодные. Это правильный ответ, когда у вас жёсткий SLO по задержке, который не достигают рычаги выше, или когда семантика восстановления SnapStart конфликтует с вашим кодом. Это неправильный ответ как замена реальной оптимизации init: вы платите за прогретую ёмкость 24/7, чтобы замаскировать решаемую проблему, и счёт растёт с числом экземпляров, которые вы держите прогретыми. Используйте Application Auto Scaling для масштабирования provisioned concurrency по расписанию, если ваш трафик предсказуем.

## Порядок применения в продакшене

На примере примерно дюжины .NET-Lambda, которые я тюнил:

1. **Всегда**: JSON через source generator, статические поля для клиентов, R2R включён, `InvariantGlobalization=true`, если независимо от locale.
2. **Если без reflection**: Native AOT на `provided.al2023`. Один этот рычаг обычно бьёт все остальные вместе.
3. **Если reflection неизбежен**: управляемый runtime `dotnet10` со SnapStart плюс синтетический warm-up вызов во время init для pre-JIT горячего пути.
4. **Проверьте** через INIT_DURATION на реальном размере памяти деплоя. Используйте Power Tuning, если важна кривая стоимость-vs-задержка.
5. **Provisioned concurrency** только после всего вышеперечисленного и только с auto-scaling.

Остальная часть истории Lambda на .NET 11 (версии runtime, форма деплоя, что меняется при переключении с `dotnet10` на будущий управляемый runtime `dotnet11`) рассмотрена в [AWS Lambda поддерживает .NET 10: что проверить перед переключением runtime](/2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime/), сопровождающем этот пост.

## Источники

-   [Скомпилируйте код функции Lambda на .NET в формат нативного runtime](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) -- документация AWS.
-   [Улучшение производительности запуска с Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) -- документация AWS.
-   [Runtime .NET 10 теперь доступен в AWS Lambda](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/) -- блог AWS.
-   [Обзор runtime Lambda](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) -- включая `provided.al2023`.
-   [aws/aws-lambda-dotnet](https://github.com/aws/aws-lambda-dotnet) -- исходник `Amazon.Lambda.RuntimeSupport`.
-   [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) -- настройщик стоимость-vs-задержка.
