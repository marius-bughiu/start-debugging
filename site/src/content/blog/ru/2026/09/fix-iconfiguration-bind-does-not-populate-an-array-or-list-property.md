---
title: "Исправление: IConfiguration.Bind не заполняет свойство-массив или List<T> из appsettings.json"
description: "Биндер молча пропускает свойства-массивы без публичного сеттера, IReadOnlyList<T> только для чтения, поля и init-члены при генераторе исходного кода, а также добавляет элементы к значениям по умолчанию вместо их замены. Проверено на .NET 10.0.12 и 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "dotnet-11"
  - "configuration"
  - "options-pattern"
  - "aspnetcore"
lang: "ru"
translationOf: "2026/09/fix-iconfiguration-bind-does-not-populate-an-array-or-list-property"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Короткий ответ:** `ConfigurationBinder` никогда не выбрасывает исключение, если не может привязать коллекцию. Он просто оставляет свойство как есть. Обычные причины такие: свойство является массивом (или `IReadOnlyList<T>`, `IEnumerable<T>`) без публичного сеттера, это публичное поле, а не свойство, имя секции, переданное в `GetSection`, не совпадает с JSON, или вы включили Native AOT либо тримминг, что переключает биндер на генератор исходного кода, а генератор игнорирует аксессоры `init`. Дайте свойству публичные `get; set;`, привяжите правильную секцию и включите `ErrorOnUnknownConfiguration`, чтобы следующее несоответствие привело к явной ошибке. Если список привязывается, но содержит *лишние* элементы, это вторая половина той же проблемы: биндер добавляет элементы к тому, что уже есть в свойстве, и никогда это не заменяет.

Всё, что описано ниже, измерено файловым тестовым приложением на SDK 10.0.302 с `Microsoft.Extensions.Configuration.Binder` 10.0.12, а затем повторено с 11.0.0-rc.1.26425.128 на SDK .NET 11 RC 1. Все строки совпали в обеих версиях. Значимые различия есть между рефлексивным биндером и биндером на основе генератора исходного кода, а не между .NET 10 и 11.

## Почему биндер молча пропускает коллекцию

Рефлексивный биндер в `ConfigurationBinder.cs` для каждого свойства решает, может ли он в него записать. Проверка короткая: нужен публичный геттер, а для всего, что приходится *заменять*, а не *изменять*, нужен ещё и публичный сеттер (или `BinderOptions.BindNonPublicProperties = true`). Если проверка не проходит, `BindProperty` молча возвращает управление.

Это разделение на "заменить" и "изменить" объясняет большинство запутанных случаев:

- **Массив** нельзя изменить на месте, потому что у него фиксированная длина. Биндер создаёт новый массив, и для его сохранения нужен сеттер. `string[] Hosts { get; } = [];` навсегда остаётся пустым.
- **`List<T>` или `IList<T>`**, уже содержащий экземпляр, можно изменить. Биндер вызывает у него `Add`, поэтому `List<string> Hosts { get; } = new();` только для чтения привязывается нормально.
- У **`IReadOnlyList<T>`** и **`IEnumerable<T>`** нет `Add`. При наличии сеттера биндер создаёт новый массив и присваивает его. Без сеттера ничего не происходит.

Ошибки преобразования элементов тоже поглощаются. В `BindArray` и `BindCollection` каждый элемент привязывается внутри `try`/`catch`, который пробрасывает исключение повторно, только если установлен `ErrorOnUnknownConfiguration`. Значение вроде `"abc"` в `int[]` просто исчезает из результата.

## Измеренная матрица

Тестовое приложение привязывает `{ "App": { "Hosts": [ "a.example", "b.example" ] } }` к классам параметров разной формы: один раз стандартным рефлексивным биндером и один раз с `EnableConfigurationBindingGenerator=true`:

```csharp
// .NET 10.0.12 / .NET 11 RC 1, Microsoft.Extensions.Configuration.Binder
class GetOnlyArray { public string[] Hosts { get; } = []; }
class GetOnlyList { public List<string> Hosts { get; } = new(); }
class GetOnlyRoList { public IReadOnlyList<string> Hosts { get; } = []; }
class FieldArray { public string[] Hosts = []; }
class PrivateSet { public string[] Hosts { get; private set; } = []; }
class InitOnly { public string[] Hosts { get; init; } = []; }
class Settable { public string[] Hosts { get; set; } = []; }
```

| Форма свойства | Рефлексивный биндер | Генератор исходного кода |
| --- | --- | --- |
| `string[] { get; }` | `[]` | `[]` |
| `List<string> { get; } = new()` | `[a, b]` | `[a, b]` |
| `IReadOnlyList<string> { get; } = []` | `[]` | `[]` |
| `IList<string> { get; } = new List<string>()` | `[a, b]` | `[a, b]` |
| публичное поле `string[]` | `[]` | `[]` |
| `string[] { get; private set; }` | `[]` | `[]` |
| то же, `BindNonPublicProperties = true` | `[a, b]` | `NotSupportedException` |
| `string[] { get; init; }` | `[a, b]` | `[]` |
| `string[] { get; set; }` | `[a, b]` | `[a, b]` |
| `record Opts(string[] Hosts)` через `Get<T>()` | `[a, b]` | `[a, b]` |
| `ImmutableArray<string> { get; set; }` | `[]` | `NullReferenceException` |

Три строки заслуживают отдельного внимания. Аксессоры `init` работают с рефлексией и молча пропускаются генератором. `ImmutableArray<T>` не заполняется никогда. А сборка этого тестового приложения с генератором выдала **ноль** предупреждений, так что на этапе компиляции ничто не сообщит вам ни об одной из этих проблем.

## Исправление по шагам

1. **Проверьте путь к секции.** `builder.Configuration.GetSection("App")` должен точно соответствовать JSON вплоть до имени свойства (сопоставление нечувствительно к регистру, так что дело не в регистре). Привязка корня вместо секции, самая частая опечатка, в тестовом приложении дала `[]`. Прежде чем винить биндер, выведите, что на самом деле содержит конфигурация:

   ```csharp
   // .NET 10 / 11
   foreach (var kv in builder.Configuration.GetSection("App").AsEnumerable())
       Console.WriteLine($"{kv.Key} = {kv.Value}");
   // Among the output you should see:
   // App:Hosts:0 = a.example
   // App:Hosts:1 = b.example
   ```

   Массивы разворачиваются в индексированные ключи (`App:Hosts:0`, `App:Hosts:1`). Если этих строк нет, проблема в файле (не копируется в выходной каталог, неверное имя окружения, неверная вложенность), а не в классе.

2. **Дайте коллекции публичный сеттер.** Это исправление для большинства случаев:

   ```csharp
   // .NET 10 / 11
   public sealed class AppOptions
   {
       public string[] Hosts { get; set; } = [];
       public List<EndpointOptions> Endpoints { get; set; } = [];
   }

   public sealed class EndpointOptions
   {
       public string Url { get; set; } = "";
   }
   ```

   Используйте `get; set;`, а не `init`, если есть хоть какой-то шанс, что проект будет публиковаться с `PublishAot` или `PublishTrimmed` (см. ниже). Избегайте `ImmutableArray<T>` в классах параметров. Если нужна семантика только для чтения для потребителей, объявите `IReadOnlyList<T> { get; set; }`: рефлексивный биндер присваивает ему `string[]`, а генератор присваивает `List<T>`, и в тестовом приложении оба варианта заполнились правильно.

3. **Сделайте так, чтобы несоответствия приводили к явной ошибке.** `ErrorOnUnknownConfiguration` выбрасывает исключение, когда в конфигурации есть ключ без соответствующего свойства, а также не даёт биндеру поглощать ошибки преобразования элементов:

   ```csharp
   // .NET 10 / 11
   builder.Services.AddOptions<AppOptions>()
       .Bind(builder.Configuration.GetSection("App"),
             o => o.ErrorOnUnknownConfiguration = true)
       .ValidateOnStart();
   ```

   С `"Host": ["a"]` в JSON (в единственном числе) тестовое приложение выбросило `InvalidOperationException: 'ErrorOnUnknownConfiguration' was set on the provided BinderOptions, but the following properties were not found on the instance of Settable: 'Host'`. С `"Ports": [1, "abc", 3]` оно выбросило `'ErrorOnUnknownConfiguration' was set and binding has failed` с внутренним исключением `Failed to convert configuration value 'abc' at 'App:Ports:1' to type 'System.Int32'`. Без этой опции та же привязка вернула `[1, 3]`.

   Добавьте к этому валидацию, чтобы пустой список становился ошибкой при запуске, а не загадкой в продакшене. [Валидация параметров при запуске с `IValidateOptions<T>`](/ru/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) подробно описывает сторону `ValidateOnStart`.

4. **Перестаньте инициализировать коллекции значениями по умолчанию.** См. следующий раздел: к значениям по умолчанию элементы добавляются, а не заменяют их.

## Биндер добавляет элементы к значениям по умолчанию вместо их замены

С этой проблемой сталкиваются сразу после исправления пустого списка. Задайте свойству значение по умолчанию и привяжите секцию, в которой есть значения:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public List<string> Hosts { get; set; } = ["localhost"];
}
// appsettings.json: "App": { "Hosts": [ "a.example", "b.example" ] }
// Result: [ "localhost", "a.example", "b.example" ]
```

Именно это тестовое приложение вернуло для `List<T>`, `string[]`, `IEnumerable<T>`, `IReadOnlyList<T>` и `HashSet<T>`, причём и для `Bind`, и для `Get<T>()`. `BindArray` буквально начинает с копирования существующих элементов в новый список и только потом добавляет сконфигурированные. Двойной вызов `Bind` для одного и того же экземпляра, например из колбэка токена изменений, дал `[a, b, a, b]`.

Это давнее и намеренное поведение. Опцию перезаписи существующих коллекций предложили в [dotnet/runtime#62112](https://github.com/dotnet/runtime/issues/62112) в 2021 году, и она до сих пор открыта в вехе Future, как и [dotnet/runtime#118204](https://github.com/dotnet/runtime/issues/118204), так что не ждите флага. Применяйте значения по умолчанию *после* привязки и только тогда, когда конфигурация ничего не предоставила:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public string[]? Hosts { get; set; }
}

builder.Services.Configure<AppOptions>(builder.Configuration.GetSection("App"));
builder.Services.PostConfigure<AppOptions>(o => o.Hosts ??= ["localhost"]);
```

В тестовом приложении это дало `[a, b]`, когда секция существовала, и `[localhost]`, когда её не было. Фабрика `IOptionsMonitor<T>` создаёт новый экземпляр при каждой перезагрузке, поэтому шаг post-configure каждый раз выполняется на чистом состоянии. [IOptions vs IOptionsSnapshot vs IOptionsMonitor](/ru/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) объясняет, когда создаётся каждый из этих экземпляров.

## Многоуровневые файлы объединяют массивы по индексу

`appsettings.Development.json` не заменяет массив из `appsettings.json`. Провайдеры конфигурации только добавляют ключи, и побеждает последний провайдер, установивший данный ключ. Массив это просто ключи `0`, `1`, `2`. Тестовое приложение наложило друг на друга эти два файла:

```json
// appsettings.json
{ "App": { "Hosts": [ "a", "b", "c" ] } }
```

```json
// appsettings.Development.json
{ "App": { "Hosts": [ "dev1", "dev2" ] } }
```

Результат привязки был `[dev1, dev2, c]`. Индекс 2 по-прежнему берётся из базового файла. То же самое происходит с переменными окружения (`App__Hosts__0=env.example` заменила только первый элемент) и аргументами командной строки (`--App:Hosts:2=cli.example` добавил третий). Документация по конфигурации ASP.NET Core отдельно упоминает это и советует держать индексы согласованными между источниками.

Два способа очистить базовый массив, которые могут прийти в голову, не работают:

- Пустой массив `"Hosts": []` в переопределяющем файле: результат всё равно был `[a, b]`.
- `"Hosts": null` в переопределяющем файле: тоже `[a, b]`.

Работает другое: вообще не определять этот массив в базовом файле, определять полный массив в каждом файле окружения или хранить значение как одну строку с разделителями и разбивать её в `PostConfigure`. Простая строка `"Hosts": "a.example,b.example"`, привязанная напрямую к `string[]`, даёт `[]`: биндер не разбивает строки за вас.

## Native AOT и тримминг незаметно меняют биндер

.NET SDK автоматически включает генератор исходного кода для привязки конфигурации в приложениях с триммингом. Из `Microsoft.NET.Sdk.FrameworkReferenceResolution.targets` в SDK 10.0.302:

```xml
<PropertyGroup Condition="'$(PublishTrimmed)' == 'true' Or '$(PublishAot)' == 'true'">
  <EnableRequestDelegateGenerator Condition="'$(EnableRequestDelegateGenerator)' == ''">true</EnableRequestDelegateGenerator>
  <EnableConfigurationBindingGenerator Condition="'$(EnableConfigurationBindingGenerator)' == ''">true</EnableConfigurationBindingGenerator>
</PropertyGroup>
```

Генератор перехватывает ваши вызовы `Bind`, `Get<T>` и `Configure<T>` на этапе компиляции. Так Native AOT получает привязку без рефлексии, но это другая реализация, и тестовое приложение обнаружило четыре различия в поведении:

| Случай | Рефлексия | Генератор исходного кода |
| --- | --- | --- |
| `string[] { get; init; }` | привязывается | молча пропускается |
| `BindNonPublicProperties = true` | привязывает приватные сеттеры | `NotSupportedException` |
| `"Ports": [1, "abc", 3]` в `int[]` | `[1, 3]` | `InvalidOperationException: Failed to convert configuration value 'abc'` |
| `"Ports": [1, null, 3]` в `int[]` | `InvalidCastException` | `[1, 3]` |
| `ImmutableArray<string>` | `[]` | `NullReferenceException` |

Поэтому приложение, которое прекрасно привязывает конфигурацию под `dotnet run`, может вести себя иначе после того, как кто-то добавит в проект `<PublishAot>true</PublishAot>`. Если вы переходите на AOT, явно установите `<EnableConfigurationBindingGenerator>true</EnableConfigurationBindingGenerator>` и в Debug, чтобы тесты использовали тот же биндер, что и продакшен. [Native AOT с минимальными API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) описывает другие генераторы, которые включаются одновременно с ним. Файловые приложения (`dotnet run app.cs`) по умолчанию используют `PublishAot=true`, поэтому быстрое тестовое приложение, написанное таким образом, уже работает с генератором, если не добавить `#:property PublishAot=false`.

## Другие случаи, о которых стоит знать

- **Разреженные индексы уплотняются.** Ключи `App:Hosts:0` и `App:Hosts:5` привязались к `[a, f]`, массиву из двух элементов, а не из шести с пропусками. Пример в документации с отсутствующим индексом 3 показывает то же самое.
- **Ключи объекта работают как индексы.** `"Hosts": { "x": "a", "y": "b" }` привязался к `[a, b]`. Поэтому JSON-объект там, где вы имели в виду массив, не приводит к ошибке.
- **Строковые элементы null сохраняются.** `["a", null, "c"]` в `string[]` дал `[a, null, c]` в обоих биндерах, хотя документация ASP.NET Core утверждает, что биндер не может создавать элементы `null`. Не полагайтесь ни на одно из этих поведений; отфильтровывайте null в `PostConfigure` или при валидации.
- **Привязка через конструктор работает для коллекций.** `record AppOptions(string[] Hosts)` и типы элементов только с параметризованным конструктором (`class Endpoint(string url)`) корректно привязались через `Get<T>()` в обоих режимах.
- **`Get<string[]>()` на самой секции массива** (`GetSection("App:Hosts").Get<string[]>()`) позволяет быстро проверить данные независимо от вашего класса параметров.

## Как протестировать собственный класс параметров

Держите модульный тест, который привязывает ваш настоящий `appsettings.json` к вашему настоящему типу параметров с той же настройкой генератора, что и в продакшене:

```csharp
// .NET 10 / 11, xUnit
[Fact]
public void AppOptions_binds_hosts()
{
    var config = new ConfigurationBuilder()
        .AddJsonFile("appsettings.json")
        .Build();

    var options = config.GetSection("App")
        .Get<AppOptions>(o => o.ErrorOnUnknownConfiguration = true);

    Assert.NotNull(options);
    Assert.Equal(new[] { "a.example", "b.example" }, options.Hosts);
}
```

Для сквозного покрытия, включая файлы конкретных окружений и переменные окружения, [интеграционные тесты с WebApplicationFactory](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) позволяют получить `IOptions<AppOptions>` из настоящего хоста.

## Связанные материалы

- [Как валидировать параметры при запуске с IValidateOptions<T> в .NET 11](/ru/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) превращает пустой список в ошибку при запуске.
- [IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T> в .NET 11](/ru/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) о том, когда привязанные экземпляры создаются и пересоздаются.
- [Как использовать Native AOT с минимальными API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) о других генераторах исходного кода, которые включает AOT.
- [Как писать интеграционные тесты с WebApplicationFactory<T> в ASP.NET Core 11](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) для тестирования конфигурации на настоящем хосте.

## Источники

- [Конфигурация в ASP.NET Core: привязка массива](https://learn.microsoft.com/aspnet/core/fundamentals/configuration/#bind-an-array), Microsoft Learn
- [Генератор исходного кода для привязки конфигурации](https://learn.microsoft.com/dotnet/core/extensions/configuration-generator), Microsoft Learn
- [`ConfigurationBinder.cs` в v10.0.12](https://github.com/dotnet/runtime/blob/v10.0.12/src/libraries/Microsoft.Extensions.Configuration.Binder/src/ConfigurationBinder.cs), dotnet/runtime
- [dotnet/runtime#62112: возможность перезаписи существующих изменяемых экземпляров коллекций](https://github.com/dotnet/runtime/issues/62112)
- [dotnet/runtime#118204: стандартное объединение массивов в конфигурации запутанно и подвержено ошибкам](https://github.com/dotnet/runtime/issues/118204)
- [`Microsoft.Extensions.Configuration.Binder` на NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Configuration.Binder), протестированы версии 10.0.12 и 11.0.0-rc.1.26425.128
