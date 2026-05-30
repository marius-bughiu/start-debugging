---
title: "Миграция с Newtonsoft.Json 13 на System.Text.Json в большой кодовой базе .NET 11"
description: "Руководство с фиксированными версиями по замене Newtonsoft.Json 13.0.4 на встроенный в .NET 11 System.Text.Json: сопоставления атрибутов и параметров, значения по умолчанию, которые незаметно меняют формат вывода, стратегия поэтапного развёртывания, проверка и подводные камни, бьющие по большим кодовым базам."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "newtonsoft-json"
  - "system-text-json"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase"
translatedBy: "claude"
translationDate: 2026-05-30
---

Замена `Newtonsoft.Json` на `System.Text.Json` в большой кодовой базе редко сводится к поиску и замене. Две библиотеки расходятся в значениях по умолчанию так, что это меняет сериализованный вывод и незаметно ломает десериализацию, поэтому наивная замена доставляет изменение контракта каждому потребителю вашего JSON. Закладывайте несколько дней на небольшой сервис и от двух до четырёх недель на обширную кодовую базу с пользовательскими конвертерами, полиморфными payload и разбором через `dynamic`/`JObject`. Выигрыш реален: `System.Text.Json` входит в состав среды выполнения, сериализует примерно вдвое быстрее с долей аллокаций и является единственной из двух, работающей под Native AOT. Эта статья фиксирует `Newtonsoft.Json` 13.0.4 (текущую стабильную версию, выпущенную 2025-12-30) как источник и встроенный в .NET 11 SDK `System.Text.Json` с C# 14 как цель. Если вы ещё решаете, переходить ли вообще, сначала прочитайте [System.Text.Json против Newtonsoft.Json в 2026 году](/ru/2026/05/system-text-json-vs-newtonsoft-json-in-2026/); эта статья предполагает, что вы уже решили мигрировать.

## Почему мигрировать сейчас

- `System.Text.Json` входит в общий фреймворк в .NET 11. Удаление `PackageReference` на `Newtonsoft.Json` убирает транзитивную зависимость, от которой среда выполнения, ASP.NET Core и платформа тестирования активно избавляются.
- Пропускная способность. На типичных POCO payload `System.Text.Json` сериализует примерно в 2 раза быстрее `Newtonsoft.Json` с заметно меньшим числом аллокаций, потому что работает напрямую с байтами UTF-8 через `Utf8JsonReader` и `Utf8JsonWriter`, а не через `string` и `TextReader`.
- Native AOT и trimming. `Newtonsoft.Json` опирается на рефлексию и не работает под Native AOT. У `System.Text.Json` есть режим генератора исходного кода (`JsonSerializerContext`), который во время компиляции порождает безопасные для trimming, совместимые с AOT метаданные сериализации. Если [Native AOT](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) есть в вашем плане, эта миграция — предпосылка, а не оптимизация.
- Безопасность. `System.Text.Json` по умолчанию строгий (RFC 8259), экранирует чувствительные к HTML и не-ASCII символы при выводе и не интерпретирует некорректный JSON. Это устраняет целый класс сюрпризов с инъекциями и разбором, которые допускают разрешающие значения по умолчанию `Newtonsoft.Json`.

## Что ломается

Опасность этой миграции — не код, который не компилируется. Это код, который компилируется без проблем и меняет ваш формат вывода. Эту таблицу стоит прочитать дважды.

| Область                           | Изменение                                                                                      | Серьёзность |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| Сопоставление имён свойств        | `Newtonsoft.Json` по умолчанию не различает регистр при чтении; `System.Text.Json` различает   | высокая     |
| Комментарии и завершающие запятые | Приняты по умолчанию в `Newtonsoft.Json`, бросают `JsonException` в `System.Text.Json`          | высокая     |
| JSON в одинарных кавычках / без кавычек | Принят `Newtonsoft.Json`, отклонён по дизайну в `System.Text.Json`                       | высокая     |
| Не-string значение в свойстве `string` | `Newtonsoft.Json` преобразует `1` или `true`; `System.Text.Json` бросает исключение        | высокая     |
| Числа в кавычках                  | `Newtonsoft.Json` читает `"23"` в `int`; `System.Text.Json` требует `NumberHandling`            | средняя     |
| Экранирование символов            | `System.Text.Json` экранирует агрессивнее, поэтому байты вывода отличаются для не-ASCII и HTML   | средняя     |
| `[JsonProperty("name")]`          | Превращается в `[JsonPropertyName("name")]`; нет совмещённых опций ignore/required в одном атрибуте | средняя  |
| `TypeNameHandling.All`            | Нет эквивалента, по дизайну. Полиморфизм использует вместо этого `[JsonDerivedType]`             | высокая     |
| `JObject` / `JToken` / `dynamic`  | Заменены на `JsonNode` / `JsonDocument` / `JsonElement` с другим API                            | средняя     |
| `JsonConvert.PopulateObject`      | Нет встроенного эквивалента; нужен пользовательский конвертер или ручное слияние                 | средняя     |
| `ReferenceLoopHandling.Ignore`    | Нет режима "молча отбросить цикл"; вы получаете `ReferenceHandler.Preserve` или перепроектируете граф | средняя |
| `DateFormatString`, `DateTimeZoneHandling` | Нет глобальной настройки формата даты; нужен пользовательский `JsonConverter<DateTime>` | средняя |
| Приоритет регистрации конвертеров | Коллекция `Converters` теперь переопределяет атрибут на уровне типа (обратно `Newtonsoft.Json`)  | низкая      |

Авторитетный источник по каждой строке здесь — [руководство по миграции от Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), которое также перечисляет горстку возможностей (запросы `JsonPath`, `TypeNameHandling.All`, разбор одинарных кавычек), для которых нет обходного пути.

## Предполётный чек-лист

Сделайте всё это, прежде чем удалить хотя бы один `using Newtonsoft.Json`.

1. Зафиксируйте контракт. Если ваш JSON пересекает границу процесса (публичный API, очередь сообщений, сохраняемая колонка), захватите эталонные образцы текущего вывода. Сериализуйте репрезентативный набор объектов через `Newtonsoft.Json` 13.0.4 и сохраните строки как тестовые fixtures. Это ваш оракул регрессий.
2. Инвентаризируйте поверхность. Прогоните grep по всему, что касается старой библиотеки, чтобы оценить объём работы:
   ```bash
   # run from the repo root; counts the call sites you have to touch
   grep -rEl "Newtonsoft\.Json|JsonConvert|JObject|JArray|JToken|JsonProperty|JsonSerializerSettings" --include="*.cs" .
   ```
   Проверка: список файлов совпадает с вашей мысленной моделью того, где живёт сериализация. Сюрпризы здесь (конвертер, зарытый во вспомогательном классе логирования) — именно то, что вы хотите найти сейчас.
3. Отметьте возможности без обходного пути. Ищите конкретно `TypeNameHandling`, `SelectToken`, `SelectTokens` и тестовые fixtures с одинарными кавычками. Если найдёте `TypeNameHandling.All` или `.Auto`, остановитесь и спроектируйте замену полиморфизма, прежде чем продолжать, потому что прямой замены для этого нет.
4. Подтвердите цель. Выполните `dotnet --version` и подтвердите `11.0.x`. `System.Text.Json` встроен, поэтому для основных сценариев пакет добавлять не нужно; вы добавляете `System.Text.Json` как явный `PackageReference` только если вам нужна более новая out-of-band версия, чем поставляет SDK.

## Шаги миграции

1. **Сопоставьте глобальные параметры.**

   `Newtonsoft.Json` централизует поведение в `JsonSerializerSettings`. `System.Text.Json` использует `JsonSerializerOptions`. Переведите ваш существующий объект настроек поле за полем; не принимайте значения по умолчанию `System.Text.Json` вслепую, потому что они отличаются от того, что ваш код выдавал годами.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: Newtonsoft.Json 13.0.4
   var settings = new JsonSerializerSettings
   {
       ContractResolver = new CamelCasePropertyNamesContractResolver(),
       NullValueHandling = NullValueHandling.Ignore,
       ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
   };

   // AFTER: System.Text.Json (in-box on .NET 11)
   var options = new JsonSerializerOptions
   {
       PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
       PropertyNameCaseInsensitive = true,                       // restore Newtonsoft read behavior
       DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
       ReferenceHandler = ReferenceHandler.IgnoreCycles,         // closest match to ReferenceLoopHandling.Ignore
       // AllowTrailingCommas = true,                            // uncomment only if your inputs have them
       // ReadCommentHandling = JsonCommentHandling.Skip,        // uncomment only if your inputs have comments
   };
   ```

   Проверка: сериализуйте ваши эталонные объекты-образцы с этими `options` и сравните с fixtures из шага 1 предполётной подготовки. Разница должна быть пустой или объяснённой. `PropertyNameCaseInsensitive = true` — самая важная строка для больших кодовых баз, потому что бесчисленные пути десериализации молча зависят от регистронезависимого сопоставления `Newtonsoft.Json`.

2. **Замените атрибуты.**

   Переименование атрибутов механическое, но `[JsonProperty]` упаковывал несколько задач в один атрибут, который `System.Text.Json` разделяет.

   ```csharp
   // .NET 11, C# 14
   // BEFORE
   public class Order
   {
       [JsonProperty("order_id")]
       public int Id { get; set; }

       [JsonProperty("notes", NullValueHandling = NullValueHandling.Ignore)]
       public string? Notes { get; set; }

       [JsonProperty(Required = Required.Always)]
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }

   // AFTER
   public class Order
   {
       [JsonPropertyName("order_id")]
       public int Id { get; set; }

       [JsonPropertyName("notes")]
       [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
       public string? Notes { get; set; }

       [JsonRequired]                       // or the C# `required` modifier
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }
   ```

   Проверка: проект компилируется с нулём директив `using` для `Newtonsoft.Json` в сборке моделей, а тест на полный круг (`Deserialize(Serialize(order))`) сохраняет каждое поле.

3. **Перенесите пользовательские конвертеры.**

   Вот где уходят часы. Формы похожи, но контракты различаются: конвертеры `System.Text.Json` работают над `Utf8JsonReader` (это `ref struct`) и `Utf8JsonWriter`, а `Read` вызывается с позицией на первом токене.

   ```csharp
   // .NET 11, C# 14 -- a converter that reads/writes DateTime in a fixed format,
   // replacing Newtonsoft's DateFormatString / DateTimeZoneHandling settings.
   public sealed class Iso8601DateTimeConverter : JsonConverter<DateTime>
   {
       public override DateTime Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions o)
           => DateTime.ParseExact(reader.GetString()!, "yyyy-MM-dd'T'HH:mm:ss'Z'",
                                  CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

       public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions o)
           => writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'",
                                      CultureInfo.InvariantCulture));
   }
   ```

   Зарегистрируйте его в `options.Converters`, а не только как атрибут типа, и обратите внимание на изменение приоритета: в `System.Text.Json` конвертер в коллекции `Converters` переопределяет атрибут `[JsonConverter]` на уровне типа, в отличие от `Newtonsoft.Json`. Детальная механика в статье [как написать пользовательский JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Проверяйте каждый перенесённый конвертер против его собственного fixture, а не только сквозной payload, чтобы сюрприз с приоритетом не спрятался за проходящим интеграционным тестом.

4. **Замените полиморфизм и TypeNameHandling.**

   Если вы использовали `TypeNameHandling` для полного круга иерархии классов, эквивалента нет, и это намеренно: `TypeNameHandling.All` — хорошо известный вектор удалённого выполнения кода. `System.Text.Json` делает дискриминированный полиморфизм через атрибуты на базовом типе.

   ```csharp
   // .NET 11, C# 14
   [JsonDerivedType(typeof(Dog), typeDiscriminator: "dog")]
   [JsonDerivedType(typeof(Cat), typeDiscriminator: "cat")]
   public abstract class Animal { public string Name { get; set; } = ""; }

   public sealed class Dog : Animal { public bool GoodBoy { get; set; } }
   public sealed class Cat : Animal { public int Lives { get; set; } }
   ```

   Это порождает дискриминатор `"$type": "dog"` и читает его обратно в правильный подтип. Проверка: сериализуйте `List<Animal>` из смешанных подтипов, десериализуйте её и убедитесь, что типы времени выполнения сохраняются. Заметьте, что формат вывода изменился (явная строка-дискриминатор вместо квалифицированного сборкой `$type` от `Newtonsoft.Json`), поэтому любой внешний потребитель должен быть обновлён синхронно.

5. **Преобразуйте разбор через dynamic и JObject.**

   Код, ковыряющийся в нетипизированном JSON через `JObject`/`JToken`/`dynamic`, переходит на `JsonNode` (изменяемый) или `JsonDocument`/`JsonElement` (только для чтения, из пула).

   ```csharp
   // .NET 11, C# 14
   // BEFORE: JObject o = JObject.Parse(json); var name = (string)o["user"]!["name"]!;
   JsonNode root = JsonNode.Parse(json)!;
   string name = root["user"]!["name"]!.GetValue<string>();
   ```

   Единственная ловушка: `JsonDocument` владеет буфером из пула и является `IDisposable`, в отличие от `JObject`. Оберните его в `using`, иначе вы утечёте арендованный буфер. Предпочитайте `JsonNode`, когда вам нужно изменяемое дерево, похожее на `JObject`. Проверка: каждый прежний путь доступа к `JObject` имеет модульный тест, прогоняющий те же поиски по ключу.

6. **Переключите интеграцию ASP.NET Core.**

   Если кодовая база вызывает `AddNewtonsoftJson()` в `Program.cs`, его удаление переключает весь конвейер на `System.Text.Json`. Веб-значения по умолчанию ASP.NET Core уже включают camelCase, регистронезависимое сопоставление и чтение чисел в кавычках, поэтому многие из ваших ручных параметров становятся избыточными на MVC-пути.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: builder.Services.AddControllers().AddNewtonsoftJson();
   builder.Services.AddControllers().AddJsonOptions(o =>
   {
       o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
       // camelCase + case-insensitive are already on by ASP.NET Core web defaults
   });
   ```

   Следите за пределом глубины: ASP.NET Core ограничивает `MaxDepth` у `System.Text.Json` значением 32, а не библиотечным значением по умолчанию 64. Глубоко вложенные payload, которые работали с `AddNewtonsoftJson()`, могут начать бросать исключения. Проверка: запустите интеграционные тесты контроллера и убедитесь, что ни один payload не задевает предел глубины.

## Проверка

Прогоняйте этот список дымовых тестов после каждого PR, а не только в конце:

- Решение собирается с нулём ссылок на `Newtonsoft.Json` в мигрированных проектах (`grep -r "Newtonsoft" --include="*.csproj"` ничего не возвращает для этих проектов).
- Разница эталонных образцов из шага 1 предполётной подготовки пуста или каждое различие задокументировано и намеренно.
- Весь набор тестов проходит: `dotnet test` сообщает о нуле провалов.
- Тест на полный круг (`Deserialize(Serialize(x))`) выполняется для каждой модели с пользовательским конвертером или полиморфной иерархией.
- Для горячих путей прогоните быстрое сравнение через `BenchmarkDotNet` и убедитесь, что числа пропускной способности и аллокаций сдвинулись в нужную сторону, а не регрессировали из-за случайного `new JsonSerializerOptions()` на каждый вызов (всегда кешируйте и переиспользуйте экземпляр options; конструировать его на каждый вызов — самая частая регрессия производительности в этой миграции).

## План отката

Эта миграция обратима по проектам, но не тривиально, потому что шаг 1 меняет ваш формат вывода. Чистая стратегия — подход strangler: мигрируйте по одной сборке или одному endpoint за раз, держите `Newtonsoft.Json` подключённым, пока не переедет последний потребитель, и защитите рискованные endpoint за feature flag, который может перенаправить обратно на форматтер `Newtonsoft.Json`. Как только вы удалите `PackageReference` и доставите новый формат вывода внешним потребителям, откат означает повторное добавление пакета и отмену изменения формата везде сразу, а это скоординированный релиз, а не `git revert`. Не удаляйте ссылку на пакет, пока разницы эталонных образцов не будут зелёными в продакшен-телеметрии хотя бы один релизный цикл.

## Подводные камни, на которые мы наткнулись

- **Тихая потеря данных из-за регистрозависимости.** Объект конфигурации, десериализованный из файла с ключами `PascalCase`, вернулся со всеми свойствами на значениях по умолчанию, потому что `System.Text.Json` сопоставлял с учётом регистра против членов в camelCase. Ничего не бросило исключение. Решением было `PropertyNameCaseInsensitive = true`, а урок — проверять значения, а не только то, "разобралось ли".
- **Полные круги `DateTime` дрейфовали.** `DateTimeZoneHandling` у `Newtonsoft.Json` тихо нормализовал timestamp. `System.Text.Json` читает формат полного круга ISO 8601 и сохраняет смещение, поэтому сохранённые timestamp вернулись с другим kind. Пользовательский конвертер из шага 3 плюс исправление [значение JSON не удалось преобразовать в System.DateTime](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) решили это.
- **Циклы объектов бросали исключения вместо отбрасывания.** `ReferenceLoopHandling.Ignore` маскировал настоящую циклическую ссылку в навигационном свойстве EF Core. `System.Text.Json` вынес её на поверхность как [обнаружен возможный цикл объектов](/ru/2026/05/fix-possible-object-cycle-was-detected-system-text-json/). `ReferenceHandler.IgnoreCycles` — это мост, но лучшим решением был проекционный DTO, у которого цикла не было вовсе.
- **`new JsonSerializerOptions()` на каждый запрос обрушил пропускную способность.** Конструирование объекта options внутри горячего обработчика обходит внутренний кеш метаданных и было медленнее кода `Newtonsoft.Json`, который оно заменило. Закешируйте один `static readonly JsonSerializerOptions` и переиспользуйте его.

## Источники

- [Microsoft Learn: Миграция с Newtonsoft.Json на System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft)
- [Microsoft Learn: Как настроить имена и значения свойств](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [Microsoft Learn: Полиморфная сериализация с System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Microsoft Learn: Сохранение ссылок и обработка циклических ссылок](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references)
- [Newtonsoft.Json 13.0.4 на NuGet](https://www.nuget.org/packages/newtonsoft.json/)
