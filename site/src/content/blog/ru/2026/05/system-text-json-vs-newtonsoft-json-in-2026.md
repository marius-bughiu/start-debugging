---
title: "System.Text.Json vs Newtonsoft.Json в 2026 году: что выбрать?"
description: "Для нового кода на .NET 11 выбирайте System.Text.Json: он встроен, примерно в 2 раза быстрее и единственный работает с Native AOT. К Newtonsoft.Json обращайтесь только ради JSONPath, TypeNameHandling или действительно нестрогого JSON."
pubDate: 2026-05-22
tags:
  - "comparison"
  - "system-text-json"
  - "newtonsoft-json"
  - "dotnet"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/system-text-json-vs-newtonsoft-json-in-2026"
translatedBy: "claude"
translationDate: 2026-05-22
---

Если в 2026 году вы начинаете новый код на .NET 11, используйте **System.Text.Json**. Он встроен в среду выполнения, сериализует примерно вдвое быстрее с малой долей аллокаций и является единственным из двух, кто работает под Native AOT. К **Newtonsoft.Json** обращайтесь только тогда, когда вы зависите от возможности, которой у System.Text.Json пока нет: запросы JSONPath, встраивание типов в стиле `TypeNameHandling` или разбор действительно некорректного JSON (одинарные кавычки, ключи без кавычек). Обе библиотеки живы в 2026 году, но для новой работы они уже не равны.

Каждый пример здесь нацелен на `<TargetFramework>net11.0</TargetFramework>` с SDK .NET 11 и C# 14. System.Text.Json -- это встроенная версия, поставляемая с .NET 11. Newtonsoft.Json относится к версии 13.0.4, выпущенной 2025-12-30, текущей стабильной на NuGet.

## Матрица возможностей с первого взгляда

Это та таблица, ради которой вы пришли. Это практическая версия [официального руководства по миграции от Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), сведённая к решениям, которые действительно меняют то, на какой пакет вы ссылаетесь.

| Аспект | System.Text.Json (.NET 11) | Newtonsoft.Json 13.0.4 |
| ------ | -------------------------- | ---------------------- |
| Встроен | Да, часть среды выполнения | Нет, пакет NuGet |
| Пропускная способность (сериализация) | База, самый быстрый | ~2x медленнее |
| Аллокации | На основе Span, низкие | Выше |
| Native AOT / trimming | Да, через генератор исходного кода | Нет |
| Строгость по умолчанию | Строгая (RFC 8259) | Нестрогая |
| Комментарии / завершающие запятые | По выбору | Включено по умолчанию |
| Сопоставление без учёта регистра | По выбору (включено в ASP.NET Core) | Включено по умолчанию |
| Полиморфная (де)сериализация | Да, с .NET 7 (`[JsonDerivedType]`) | Да (`TypeNameHandling`) |
| `TypeNameHandling.All` (встраивание типа CLR) | Нет, by design | Да |
| JSONPath / `SelectToken` | Нет | Да |
| DOM LINQ-to-JSON | `JsonNode` / `JsonDocument` | `JObject` / `JArray` |
| `DataTable`, `ExpandoObject`, `BigInteger` | Требуется пользовательский конвертер | Встроено |
| Одинарные кавычки, ключи без кавычек | Отклоняются, by design | Принимаются |
| Статус сопровождения | Активная разработка | Режим сопровождения |
| Лицензия | MIT | MIT |

Главное в том, что строки, где Newtonsoft.Json всё ещё выигрывает, узки и специфичны, тогда как строки, где выигрывает System.Text.Json (встроенность, AOT, скорость), применимы почти к любому новому проекту.

## Когда выбирать System.Text.Json

Выбирайте его как вариант по умолчанию для всего нового на .NET 11. Конкретно:

- **API на ASP.NET Core.** Фреймворк уже использует System.Text.Json внутри и настраивает за вас удобные для веба значения по умолчанию: имена свойств в camelCase, сопоставление без учёта регистра и поддержку чисел в кавычках. Добавлять `Microsoft.AspNetCore.Mvc.NewtonsoftJson`, чтобы вернуть старое поведение, -- это шаг назад, если только конкретная возможность не вынуждает вас.
- **Всё, что будет работать под Native AOT или агрессивным trimming.** Это не предпочтение, а жёсткое требование. У System.Text.Json есть [генератор исходного кода](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), который порождает метаданные сериализации на этапе компиляции, поэтому в среде выполнения рефлексия не нужна. Newtonsoft.Json построен на рефлексии в среде выполнения и `Reflection.Emit`, чего AOT не допускает. Если вас интересуют компромиссы здесь, посмотрите разбор [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **Пути с высокой пропускной способностью или чувствительные к памяти.** Сериализаторы, отправщики логов, потребители шины сообщений, всё, что работает в тесном цикле. System.Text.Json работает напрямую над `ReadOnlySpan<byte>` и UTF-8, избегая промежуточных строковых аллокаций, которые делает Newtonsoft.Json.
- **Вам нужен детерминированный вывод, соответствующий спецификации.** System.Text.Json строго следует RFC 8259. Он экранирует чувствительные для HTML символы по умолчанию как мера эшелонированной защиты от XSS и раскрытия информации, что важно, когда JSON встраивается в страницу.

Контекст, порождённый генератором исходного кода, -- это паттерн, открывающий AOT и самый быстрый запуск:

```csharp
// .NET 11, C# 14 - compile-time metadata, no runtime reflection
using System.Text.Json;
using System.Text.Json.Serialization;

[JsonSerializable(typeof(WeatherForecast))]
public partial class AppJsonContext : JsonSerializerContext;

var forecast = new WeatherForecast(DateOnly.FromDateTime(DateTime.Now), 22, "Mild");

// Pass the generated TypeInfo, not the raw type, to stay reflection-free
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);

public record WeatherForecast(DateOnly Date, int TemperatureC, string Summary);
```

System.Text.Json также закрыл большинство исторических пробелов. С .NET 7 он выполняет полиморфную (де)сериализацию через `[JsonDerivedType]`, а .NET 9 добавил несколько давно запрашиваемых опций: `RespectNullableAnnotations` для учёта ссылочных типов, не допускающих null, атрибут `JsonStringEnumMemberName` для переименования значений enum и `JsonSchemaExporter` для получения JSON-схемы из типа .NET. .NET 10 добавил прямую десериализацию из `PipeReader` и однострочный строгий пресет:

```csharp
// .NET 10 and later - the strict, spec-compliant defaults in one preset
var options = JsonSerializerOptions.Strict;

// .NET 10 and later - deserialize straight from a PipeReader, no stream adapter
WeatherForecast? f = await JsonSerializer.DeserializeAsync<WeatherForecast>(pipeReader);
```

## Когда выбирать Newtonsoft.Json

Реальные причины обратиться к нему всё ещё есть. Выбирайте Newtonsoft.Json, когда вы натыкаетесь на одно из следующего:

- **Вам нужны запросы JSONPath.** У `SelectToken("$.store.book[0].title")` нет встроенного эквивалента в System.Text.Json. `JsonNode` позволяет переходить по индексатору, но движка запросов по пути нет. Если вы разбираете произвольные документы и извлекаете значения по пути, Newtonsoft.Json -- это гораздо меньше кода.
- **Вы зависите от `TypeNameHandling`.** Newtonsoft.Json может встроить имя типа CLR в полезную нагрузку (`$type`) и восстановить точный тип среды выполнения на обратном пути. System.Text.Json отказывается это делать, by design, потому что десериализация имени типа, контролируемого злоумышленником, -- хорошо известный вектор удалённого выполнения кода. Если у вас есть существующий внутренний протокол, который на этом держится, миграция -- это не флаг конфигурации, а перепроектирование.
- **Вы разбираете действительно нестрогий или нестандартный JSON.** Строки в одинарных кавычках, имена свойств без кавычек и другой ввод, не соответствующий RFC, принимаются Newtonsoft.Json и отклоняются System.Text.Json, by design. Комментарии и завершающие запятые в System.Text.Json по выбору (`ReadCommentHandling`, `AllowTrailingCommas`), но одинарные кавычки и голые ключи нельзя включить вовсе.
- **Вы сериализуете типы без встроенной поддержки.** `DataTable`, `ExpandoObject`, `TimeZoneInfo`, `BigInteger`, `DBNull` и `ValueTuple` -- все требуют пользовательского конвертера в System.Text.Json. Newtonsoft.Json обрабатывает их нативно.

Разница в строгости по умолчанию -- это то, что кусается при миграции. Одна и та же полезная нагрузка ведёт себя по-разному:

```csharp
// Newtonsoft.Json 13.0.4 - lenient by default, this parses fine
using Newtonsoft.Json;

var config = JsonConvert.DeserializeObject<Config>("""
{
    "Name": "api", // inline comment
    "Retries": 3,
}
""");

public record Config(string Name, int Retries);
```

```csharp
// .NET 11, System.Text.Json - strict by default, the same input throws JsonException
using System.Text.Json;

// You must opt in to match Newtonsoft.Json's leniency
var options = new JsonSerializerOptions
{
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true,
    PropertyNameCaseInsensitive = true
};
var config = JsonSerializer.Deserialize<Config>(input, options);
```

Эта строгость -- самый частый источник послемиграционного сюрприза, когда полезная нагрузка, работавшая годами, вдруг бросает исключение, что также объясняет, почему ошибки вроде [значения JSON, которое не удалось преобразовать](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) или [DateTime, который не разбирается](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/), появляются сразу после перехода.

## Что на самом деле показывают бенчмарки

Производительность -- это утверждение, которое легче всего отделать общими словами, поэтому здесь конкретные числа вместо слова «быстрее». Опубликованные прогоны BenchmarkDotNet на .NET 10, сериализующие коллекцию из 10 000 простых объектов POCO, показывают, что System.Text.Json завершает примерно за 3.7 мс, выделяя 3.4 МБ, против Newtonsoft.Json примерно за 7.6 мс и 8.1 МБ для той же нагрузки.

| Метрика (сериализация 10 000 POCO) | System.Text.Json | Newtonsoft.Json 13.x |
| ---------------------------------- | ---------------- | -------------------- |
| Среднее время | ~3.7 мс | ~7.6 мс |
| Выделено | ~3.4 МБ | ~8.1 МБ |
| Относительно | 1.0x (база) | ~2.0x медленнее, ~2.4x память |

Методология и оговорки важны, поэтому читайте эти числа честно:

- Числа выше получены из публичного бенчмарка .NET 10 (BenchmarkDotNet, конфигурация release по умолчанию) и являются репрезентативными, а не догмой. Запустите BenchmarkDotNet на своих формах объектов, прежде чем цитировать число на ревью дизайна.
- Разрыв наибольший для простых POCO и больших коллекций, ровно той формы, которая доминирует в веб-API и конвейерах сообщений.
- Для крошечных полезных нагрузок (один маленький объект на запрос) абсолютная разница составляет микросекунды и редко является узким местом. Выбирайте по другим аспектам в этом случае.
- Генерация исходного кода ещё больше расширяет разрыв в пользу System.Text.Json, потому что устраняет рефлексию на каждый вызов. У Newtonsoft.Json эквивалента нет.

Итог согласован по каждому заслуживающему доверия бенчмарку 2025 и 2026 годов: System.Text.Json примерно вдвое быстрее и выделяет от половины до трети для типичного случая. Запас не сузился в пользу Newtonsoft.Json.

## Детали, которые решают за вас

Иногда одно ограничение закрывает решение ещё до того, как в комнату входят предпочтения.

**Native AOT -- это закрытые ворота.** Если ваша цель развёртывания требует AOT (урезанный контейнер, функция со scale-to-zero, сборка iOS), Newtonsoft.Json просто не вариант. Он зависит от рефлексии в среде выполнения, которую AOT не предоставляет. Один этот факт дисквалифицирует его для целого класса современных нагрузок .NET.

**Траектория сопровождения.** Newtonsoft.Json не мёртв и не устарел. James Newton-King, который теперь работает в Microsoft над самим System.Text.Json, по-прежнему выпускает релизы безопасности и исправлений (13.0.4 вышла 2025-12-30). Но он явно в режиме сопровождения: никакой крупной работы над возможностями, никакой стратегии AOT впереди. System.Text.Json получает новые возможности в каждом релизе .NET. Ставить новый код на активно развивающуюся библиотеку -- это выбор с меньшим риском для системы, которую вы будете сопровождать годами.

**Обработка ссылок и циклы объектов различаются.** У Newtonsoft.Json есть `ReferenceLoopHandling` и `PreserveReferencesHandling`. System.Text.Json отображает их на `ReferenceHandler.IgnoreCycles` и `ReferenceHandler.Preserve`, но поведение не идентично (`IgnoreCycles` пишет `null` там, где Newtonsoft.Json опускает свойство). Если вы сериализуете графы сущностей EF Core, это разница между чистой полезной нагрузкой и [исключением о возможном цикле объектов](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/). Знайте, какой обработчик вам нужен, до миграции.

**Лицензии идентичны.** Обе поставляются под MIT, поэтому в отличие от ситуации с MediatR или AutoMapper, лицензия здесь не фактор. Не позволяйте вопросу «бесплатен ли ещё Newtonsoft.Json?» вести решение: да, бесплатен, и System.Text.Json тоже.

## Решение, в одну строку

Для нового кода на .NET 11 в 2026 году: по умолчанию используйте System.Text.Json, и добавляйте Newtonsoft.Json только тогда, когда натыкаетесь на конкретную, поименованную возможность, которой он не умеет (JSONPath, `TypeNameHandling`, нестрогий разбор или неподдерживаемый тип без конвертера). Он встроен, быстрее, готов к AOT и это то, что Microsoft продолжает строить. Оставьте Newtonsoft.Json в существующих системах, которые зависят от его гибкости; не торопите миграцию, у которой нет выгоды, но и не начинайте с него. Стратегический выбор по умолчанию сменился годы назад, и в 2026 году разрыв достаточно широк, чтобы бремя доказательства лежало на выборе Newtonsoft.Json, а не на выборе встроенной библиотеки.

## Связанное

- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: a possible object cycle was detected with System.Text.Json](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [Fix: the JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Fix: the JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)

## Источники

- [Migrate from Newtonsoft.Json to System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft) - авторитетная таблица различий возможностей и список поведения по умолчанию.
- [What's new in System.Text.Json in .NET 9](https://devblogs.microsoft.com/dotnet/system-text-json-in-dotnet-9/) - аннотации nullable, имена членов enum, экспортёр схемы.
- [JsonSerializer.DeserializeAsync (PipeReader overload)](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.deserializeasync?view=net-10.0) - потоковый API .NET 10.
- [Newtonsoft.Json releases](https://github.com/JamesNK/Newtonsoft.Json/releases) - версия 13.0.4 и текущая частота сопровождения.
