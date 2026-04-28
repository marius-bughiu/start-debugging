---
title: "Как использовать Native AOT с минимальными API ASP.NET Core"
description: "Полное руководство для .NET 11 по выпуску минимального API ASP.NET Core с Native AOT: PublishAot, CreateSlimBuilder, JSON с генератором исходного кода, ограничение AddControllers, предупреждения IL2026 / IL3050 и EnableRequestDelegateGenerator для библиотечных проектов."
pubDate: 2026-04-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
lang: "ru"
translationOf: "2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis"
translatedBy: "claude"
translationDate: 2026-04-29
---

Чтобы выпустить минимальный API ASP.NET Core с Native AOT на .NET 11, поставьте `<PublishAot>true</PublishAot>` в `.csproj`, постройте host через `WebApplication.CreateSlimBuilder` вместо `CreateBuilder` и зарегистрируйте генератор исходного кода `JsonSerializerContext` через `ConfigureHttpJsonOptions`, чтобы каждый тип запроса и ответа был достижим без reflection. Всё, что не является минимальным API или gRPC, включая `AddControllers`, Razor, hub'ы SignalR и деревья запросов EF Core над графами POCO, выдаст предупреждения IL2026 или IL3050 при публикации и поведёт себя непредсказуемо в runtime. Это руководство проводит весь путь по `Microsoft.NET.Sdk.Web` с .NET 11 SDK и C# 14, включая то, что прячет шаблон нового проекта, и заканчивается чек-листом, чтобы убедиться, что опубликованный бинарник действительно не нуждается в JIT.

## Два флага проекта, которые меняют всё

Минимальный API на Native AOT -- это обычный проект ASP.NET Core с двумя добавленными свойствами MSBuild. Первое переключает путь публикации с CoreCLR на ILC, AOT-компилятор. Второе говорит анализатору падать в момент, когда вы тянетесь к API, требующему генерацию кода в runtime.

```xml
<!-- .NET 11, C# 14 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>

    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

`PublishAot` делает основную работу. Включает компиляцию Native AOT во время `dotnet publish` и, что важно, также включает анализ динамического кода во время сборки и редактирования, поэтому предупреждения IL2026 (`RequiresUnreferencedCode`) и IL3050 (`RequiresDynamicCode`) загораются в IDE ещё до того, как вы дойдёте до публикации. Microsoft документирует это в [обзоре развёртывания Native AOT](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/).

`InvariantGlobalization` строго не обязателен, но я оставляю его включённым в новых проектах. Native AOT по умолчанию не включает файл данных ICU на Linux, и сравнение строк, чувствительное к культуре, над payload запроса бросит `CultureNotFoundException` в продакшене, если про это забыть. Включайте глобализацию явно, когда она действительно нужна.

Шаблон нового проекта (`dotnet new webapiaot`) также добавляет `<StripSymbols>true</StripSymbols>` и `<TrimMode>full</TrimMode>` за вас. `TrimMode=full` подразумевается в `PublishAot=true`, поэтому это избыточно, но безвредно держать.

## CreateSlimBuilder -- это не CreateBuilder с укороченным именем

Самое крупное изменение поведения между обычным минимальным API и AOT -- это host builder. `WebApplication.CreateBuilder` подключает каждую обычную возможность ASP.NET Core: HTTPS, HTTP/3, hosting filters, ETW, провайдеры конфигурации на переменных окружения, и стандартный JSON-сериализатор с откатом на reflection. Большая часть этой машинерии несовместима с Native AOT, поэтому шаблон AOT использует `CreateSlimBuilder`, задокументированный в справочнике [поддержки Native AOT в ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0) и не изменившийся в .NET 11.

```csharp
// .NET 11, C# 14
// PackageReference: Microsoft.AspNetCore.OpenApi 11.0.0
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});

var app = builder.Build();

var todos = app.MapGroup("/todos");
todos.MapGet("/", () => Todo.Sample);
todos.MapGet("/{id:int}", (int id) =>
    Todo.Sample.FirstOrDefault(t => t.Id == id) is { } t
        ? Results.Ok(t)
        : Results.NotFound());

app.Run();

public record Todo(int Id, string Title, bool Done)
{
    public static readonly Todo[] Sample =
    [
        new(1, "Try Native AOT", true),
        new(2, "Profile cold start", false),
    ];
}

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Три вещи в этом примере имеют значение и легко упускаются:

1. `CreateSlimBuilder` по умолчанию не регистрирует HTTPS и HTTP/3. Slim builder включает конфигурацию из JSON-файлов для `appsettings`, user secrets, console logging и конфигурации логирования, но намеренно отбрасывает протоколы, которыми обычно занимается прокси-терминатор TLS. Если вы запускаете это без Nginx, Caddy или YARP впереди, добавьте конфигурацию `Kestrel.Endpoints` явно.
2. `MapGroup("/todos")` нормально работает в том же файле, что и `Program.cs`. Перенесите его в другой файл того же проекта -- и начнёте видеть IL3050, если не включите ещё и генератор делегатов запросов. Сейчас до этого дойдём.
3. JSON-context вставляется по индексу `0` в цепочке резолверов, поэтому имеет приоритет над стандартным резолвером на reflection. Без `Insert(0, ...)` writer ответа ASP.NET Core всё ещё может откатиться на reflection для типов, которые вы не зарегистрировали, что в режиме AOT приводит к `NotSupportedException` в runtime.

## JSON: единственный сериализатор -- тот, который вы сгенерировали

У `System.Text.Json` два режима. Режим reflection обходит каждое свойство в runtime, что несовместимо ни с trimming, ни с AOT. Режим source generation эмитит метаданные в compile time для каждого зарегистрированного типа, что полностью безопасно для AOT. Native AOT требует source generation для каждого типа, который вы кладёте в HTTP-тело или вытаскиваете из него. Это самый крупный источник багов "компилируется отлично, бросает в runtime".

Минимальный жизнеспособный `JsonSerializerContext`:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
[JsonSerializable(typeof(List<Todo>))]
[JsonSerializable(typeof(ProblemDetails))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Каждый тип, который проходит по проводу, должен быть в этом классе, включая формы `T[]` и `List<T>`, которые вы реально возвращаете из endpoint минимального API. Writer ответа ASP.NET Core не разворачивает `IEnumerable<T>` за вас в режиме AOT. Если возвращаете `Enumerable.Range(...).Select(...)`, регистрируйте также `IEnumerable<Todo>` или сначала материализуйте в массив.

Три ловушки, которые кусают даже аккуратных авторов:

- **`Results.Json(value)` против `return value`**: возврат значения напрямую работает, потому что framework знает статический тип возврата. Обёртка в `Results.Json(value)` без передачи `JsonTypeInfo<T>` падает на стандартный сериализатор и может бросить в runtime в AOT. Используйте перегрузку `Results.Json`, принимающую `JsonTypeInfo<T>` из вашего сгенерированного context, или просто верните значение.
- **Полиморфизм**: `[JsonDerivedType(typeof(Cat))]` работает под AOT, но базовый тип и каждый производный тип должны быть в context. Возврат plain `object` требует регистрации `JsonSerializable(typeof(object))`, что затем форсирует каждую форму, которую он может видеть, поэтому предпочтительны конкретные типы.
- **`IFormFile` и `HttpContext.Request.ReadFromJsonAsync`**: привязка form-параметров для примитивов работает в AOT, но `ReadFromJsonAsync<T>()` без context бросит. Всегда передавайте `AppJsonContext.Default.T` вторым аргументом.

[Тур Эндрю Лока по генератору исходного кода минимального API](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/) и [прохождение Мартина Костелло по использованию JSON-генераторов исходного кода с минимальными API](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/) покрывают исходный дизайн .NET 8, который .NET 11 наследует без изменений.

## Библиотечным проектам нужен EnableRequestDelegateGenerator

Генератор исходного кода минимального API превращает каждый `MapGet(...)`, `MapPost(...)` и так далее в строго типизированный `RequestDelegate` в compile time. Когда `PublishAot=true`, SDK включает этот генератор автоматически для веб-проекта. Он **не** включает его для библиотечных проектов, на которые вы ссылаетесь, даже если эти библиотеки сами вызывают `MapGet` через методы расширения.

Симптом -- предупреждения IL3050 при публикации, указывающие на вашу библиотеку и жалующиеся, что `MapGet` делает reflection над делегатом. Лекарство -- одно свойство MSBuild в библиотеке:

```xml
<!-- Library project that defines endpoint extension methods -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <IsAotCompatible>true</IsAotCompatible>
    <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
  </PropertyGroup>
</Project>
```

`IsAotCompatible=true` включает все четыре анализатора trim и AOT, а `EnableRequestDelegateGenerator=true` переключает вызовы `Map*` библиотеки на сгенерированный путь. Без второго библиотека может быть помечена как AOT-совместимая и всё равно эмитить IL3050 из-за того, как анализатор видит call site вида `Delegate.DynamicInvoke` в `RouteHandlerBuilder`. Команда dotnet/aspnetcore отслеживает шероховатости в [issue #58678](https://github.com/dotnet/aspnetcore/issues/58678).

Если библиотека должна переиспользоваться и в AOT-, и в не-AOT-проектах, оставьте свойство. Генератор изящно откатывается на runtime-путь в обычных сборках CoreCLR.

## От чего придётся отказаться

Native AOT -- это не выключатель, который вы переключаете на готовом MVC-монолите. Список неподдерживаемых подсистем короткий, но несущий.

- **MVC-контроллеры**: `AddControllers()` -- канонический пример. API не trim-safe и не поддерживается Native AOT. Команда dotnet/aspnetcore отслеживает долгосрочную поддержку в [issue #53667](https://github.com/dotnet/aspnetcore/issues/53667), но на момент .NET 11 пути AOT для классов, помеченных `[ApiController]`, нет. Вы либо переписываете endpoint'ы как минимальные API, либо не выпускаете AOT. Модели и фильтры слишком сильно опираются на reflection и runtime model binding, чтобы ILC мог безопасно тримить.
- **Razor Pages и MVC Views**: та же причина. Оба зависят от runtime-компиляции views. Они скомпилируются под `PublishAot=true`, если вы их не используете, но регистрация `AddRazorPages()` зажигает IL2026.
- **Серверные hub'ы SignalR**: не поддерживаются под AOT в .NET 11. Клиентские пакеты имеют AOT-дружественные режимы, host hub -- нет.
- **EF Core**: runtime работает, но трансляция запросов, зависящая от reflection над графами свойств POCO, может выдавать IL2026, если только вы не включаете compiled queries и конфигурацию через генератор исходного кода. Для большинства AOT-сервисов правильный ход -- Dapper плюс самописный `SqlClient`, или EF Core только для простого доступа в стиле `DbSet<T>.Find()`.
- **DI-паттерны, тяжёлые на reflection**: всё, что разрешает `IEnumerable<IPlugin>` из сканированного assembly, хрупко под trimming. Регистрируйте конкретные типы явно, или используйте DI-контейнер на основе генератора исходного кода.
- **`AddOpenApi()`**: интеграция OpenAPI из .NET 9 совместима с AOT, но версии `Swashbuckle.AspNetCore` до AOT-осведомлённого рефакторинга всё ещё эмитят IL2026. Если вам нужен OpenAPI в AOT-минимальном API, используйте встроенный пакет [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi) и пропустите Swashbuckle.

Команда Thinktecture опубликовала [читабельный обзор поддерживаемых и неподдерживаемых сценариев](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/), к которому я обращаюсь при онбординге команды на Native AOT.

## Читать IL2026 и IL3050 как профессионал

Два предупреждения, с которыми вы будете биться, легко спутать:

- **IL2026** означает, что вызов требует не-reference-нутого кода. Реализация читает members через reflection, которые trimmer иначе бы удалил. Частая причина: передача runtime-`Type` в перегрузку сериализатора, вызов `GetProperties()`, или использование `Activator.CreateInstance(Type)`.
- **IL3050** означает, что вызов требует динамической генерации кода. Даже со всеми сохранёнными members реализации нужен `Reflection.Emit` или похожий шаг JIT-codegen, которого в AOT нет. Частая причина: перегрузки `JsonSerializer.Serialize(object)`, `MakeGenericType` на ещё не инстанцированном generic, компиляция дерева выражений.

Обе всплывают в анализаторе `IsAotCompatible`, но только IL2026 показывает анализатор trimming сам по себе. Я всегда запускаю одноразовый publish в `bin\publish` из командной строки во время разработки, чтобы вытащить их все сразу:

```bash
dotnet publish -c Release -r linux-x64 -o ./publish
```

Вторая ловушка: dotnet/sdk [discussion #51966](https://github.com/dotnet/sdk/discussions/51966) отслеживает повторяющуюся проблему, при которой Visual Studio 2026 и `dotnet build` глотают IL2026 / IL3050 в некоторых конфигурациях, а `dotnet format` их показывает. Если ваша команда использует Visual Studio, добавьте шаг CI, запускающий `dotnet publish` против AOT-runtime, чтобы пропущенное предупреждение валило pipeline.

Когда нельзя избежать API, использующего reflection, вы можете подавить предупреждение в call site атрибутами `[RequiresUnreferencedCode]` и `[RequiresDynamicCode]` на оборачивающем методе, что распространяет требование вверх. Делайте это только тогда, когда уверены, что потребляющие пути кода не находятся на поверхности AOT-публикации. Подавление внутри handler endpoint почти всегда неверно.

## Проверка, что бинарник реально работает

Чистая публикация не доказывает, что приложение запускается под AOT. Три проверки, которые я делаю до объявления победы:

```bash
# 1. The output is a single static binary, not a CoreCLR loader.
ls -lh ./publish
file ./publish/MyApi
# Expected on Linux: "ELF 64-bit LSB pie executable ... statically linked"

# 2. The runtime never loads the JIT.
LD_DEBUG=libs ./publish/MyApi 2>&1 | grep -E "libcoreclr|libclrjit"
# Expected: empty output. If libclrjit.so loads, you accidentally shipped a runtime fallback.

# 3. A real request round-trips with the source generator.
./publish/MyApi &
curl -s http://localhost:5000/todos | head -c 200
```

Третья проверка -- важная. Классический режим отказа -- "компилируется, публикуется, стартует, отдаёт 500 на первый запрос", потому что какой-то возвращаемый тип отсутствует в JSON-context. Стучите по каждому endpoint хотя бы один раз с репрезентативным payload до отгрузки.

Для container-deployment build с `--self-contained true` подразумевается под `PublishAot=true`. Вывод `./publish/MyApi` плюс файл `.dbg` -- это весь блок развёртывания. Типичный минимальный API .NET 11 ложится в 8-12 MB stripped по сравнению с 80-90 MB self-contained CoreCLR-публикации.

## Связанные руководства на Start Debugging

- Рычаг Native AOT сидит внутри более широкой истории cold-start: [руководство по cold-start AWS Lambda на .NET 11](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) проходит путь AOT-на-`provided.al2023` с тем же setup генератора исходного кода.
- Для OpenAPI поверх AOT-минимального API [руководство по генерации клиента OpenAPI](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) покрывает проход от метаданных минимального API до типизированного `HttpClient`.
- AOT-проекты запрещают JSON на reflection, поэтому [написание собственного `JsonConverter` в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) -- правильный праймер, когда встроенной конверсии недостаточно.
- Чистая история исключений важнее под AOT, где диагностика на reflection недоступна: [добавление глобального фильтра исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) показывает путь `IExceptionHandler`, полностью совместимый с AOT.

## Источники

- [ASP.NET Core support for Native AOT (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [Обзор развёртывания Native AOT (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [Source generation в System.Text.Json (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [aspnetcore#58678 - Map* AOT warnings outside Program.cs](https://github.com/dotnet/aspnetcore/issues/58678)
- [aspnetcore#53667 - Native AOT support for MVC](https://github.com/dotnet/aspnetcore/issues/53667)
- [Andrew Lock - Exploring the new minimal API source generator](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/)
- [Martin Costello - Using JSON source generators with minimal APIs](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/)
- [Thinktecture - Native AOT with ASP.NET Core, an overview](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/)
