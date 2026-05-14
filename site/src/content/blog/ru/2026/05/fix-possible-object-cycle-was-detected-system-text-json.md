---
title: "Fix: A possible object cycle was detected"
description: "System.Text.Json отказывается сериализовать графы с обратными ссылками. Установите ReferenceHandler.IgnoreCycles, спроецируйте на DTO или пометьте обратный указатель атрибутом [JsonIgnore]. Preserve - крайнее средство."
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
  - "ef-core"
lang: "ru"
translationOf: "2026/05/fix-possible-object-cycle-was-detected-system-text-json"
translatedBy: "claude"
translationDate: 2026-05-14
---

Решение: `System.Text.Json` отказывается сериализовать любой граф объектов, который замыкается сам на себя. В сущности EF Core со свойством `Parent` и коллекцией `Children`, ссылающимися друг на друга, writer уходит в бесконечный цикл, упирается в guard глубины и бросает исключение. Установите `JsonSerializerOptions.ReferenceHandler = ReferenceHandler.IgnoreCycles` для решения в одну строку, пометьте обратный указатель атрибутом `[JsonIgnore]` для постоянного решения или спроецируйте сущность на DTO, у которого попросту нет обратного указателя. `ReferenceHandler.Preserve` работает, но меняет формат на проводе на `$id`/`$ref`, что редко бывает нужно потребителю API.

```text
System.Text.Json.JsonException: A possible object cycle was detected. This can either be due to a cycle or if the object depth is larger than the maximum allowed depth of 32. Consider using ReferenceHandler.Preserve on JsonSerializerOptions to support cycles. Path: $.Children.Parent.Children.Parent.Children.Parent...
   at System.Text.Json.ThrowHelper.ThrowJsonException_SerializerCycleDetected(Int32 maxDepth)
   at System.Text.Json.Serialization.JsonConverter`1.TryWrite(Utf8JsonWriter writer, T& value, JsonSerializerOptions options, WriteStack& state)
   at System.Text.Json.Serialization.Metadata.JsonTypeInfo`1.SerializeAsObject(Utf8JsonWriter writer, Object rootValue)
   at System.Text.Json.JsonSerializer.WriteString[TValue](TValue value, JsonTypeInfo jsonTypeInfo)
```

Это руководство написано относительно .NET 11 preview 4 и `System.Text.Json` 11.0.0-preview.4. Сообщение исключения не менялось с тех пор, как `System.Text.Json` впервые получил обнаружение циклов в .NET 5, а `ReferenceHandler.IgnoreCycles` доступен начиная с .NET 6. Сегмент `Path` в исключении - это путь JSON, на котором writer находился в момент сдачи. Если путь является повторяющимся узором вроде `$.Children.Parent.Children.Parent`, у вас настоящий цикл. Если путь является прямым спуском вроде `$.Order.Customer.Address.Country.Region.Continent...`, у вас не цикл, а граф, действительно более глубокий, чем 32 уровня, и нужен `MaxDepth`, что является другим решением.

## Почему writer отказывается следовать по циклу

`System.Text.Json` сериализует графы как деревья. Документ JSON по определению является деревом, в нём нет синтаксиса для "этот узел тот же, что и тот узел вон там". Поэтому writer обходит граф объектов в глубину и выводит каждую ссылку как новый вложенный объект. В тот момент, когда свойство указывает обратно на предка, обход не завершается.

Чтобы процесс не выполнялся до исчерпания стека, writer отслеживает текущую глубину и бросает `JsonException`, когда она превышает `JsonSerializerOptions.MaxDepth`, который по умолчанию равен 64. Стандартное сообщение об ошибке смешивает два случая (настоящий цикл и честное глубокое дерево), потому что writer не может различить их изнутри, он лишь видит, что слишком глубоко. Подсказка `Consider using ReferenceHandler.Preserve` в конце сообщения - это лучшее предположение среды выполнения. Верно, что `Preserve` позволил бы вызову пройти, но это редко правильное решение для API. Проекция на DTO или разрыв обратного указателя - вот что правильно.

Значение по умолчанию в ASP.NET Core было изменено в .NET 6 так, что `JsonOptions` фреймворка (используемые minimal API и действиями контроллеров) не переключаются на `IgnoreCycles` сами. Вы соглашаетесь явно. Обоснование состояло в том, что тихое выбрасывание циклов скрывает баги в модели ответа, канонический ответ - чинить модель.

## Минимальное воспроизведение

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4, System.Text.Json 11.0.0-preview.4
public class Author
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Book> Books { get; set; } = new();
}

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }
    public Author Author { get; set; } = null!;
}
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var author = new Author { Id = 1, Name = "Carla" };
var book = new Book { Id = 1, Title = "Refactoring", Author = author };
author.Books.Add(book);

var json = JsonSerializer.Serialize(author); // throws
```

`author.Books[0].Author` - это тот же самый экземпляр, что и `author`. Writer спускается в `Books`, спускается в первый `Book`, затем спускается в его `Author`, снова находит `Books` и зацикливается. Guard глубины в 64 уровня срабатывает раньше, чем процесс умрёт.

Та же форма появляется в тот момент, когда вы делаете `Include` навигационного свойства в EF Core и возвращаете отслеживаемую сущность из контроллера без проекции. EF Core фиксирует навигационные свойства так, что родитель указывает на детей, а дети указывают обратно на родителя. Это правильное поведение для отслеживания изменений. Это неправильная форма для JSON.

## Решение, детально

### 1. Спроецировать на DTO

Канонический ответ - никогда не сериализовать сущности EF Core напрямую. Возвращайте DTO, которое уплощает или опускает обратный указатель:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public record AuthorDto(int Id, string Name, IReadOnlyList<BookDto> Books);
public record BookDto(int Id, string Title);

var dto = await db.Authors
    .Where(a => a.Id == 1)
    .Select(a => new AuthorDto(
        a.Id,
        a.Name,
        a.Books.Select(b => new BookDto(b.Id, b.Title)).ToList()))
    .FirstAsync();

var json = JsonSerializer.Serialize(dto); // works
```

Это ответ, который рекомендует команда .NET, и это правильный ответ для любого публичного API. DTO - это то, что на самом деле хочет потребитель, сущность - это внутренний тип, который случайно имеет те же имена полей. Проекция в запросе EF Core также делает SQL меньше, база данных возвращает только те столбцы, которые нужны DTO. Для контекста по стороне EF Core этого шаблона пост [прогреть модель EF Core перед первым запросом](/ru/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) разбирает механику проекций подробнее.

### 2. Установить ReferenceHandler.IgnoreCycles глобально

Если нужно сериализовать сущность напрямую (быстрый внутренний endpoint, админ-инструмент, отладочный дамп), установите опцию один раз на хосте:

```csharp
// .NET 11, C# 14, ASP.NET Core 11
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

Для контроллеров (System.Text.Json):

```csharp
// .NET 11, C# 14, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(o =>
{
    o.JsonSerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

`IgnoreCycles` пишет `null` всякий раз, когда writer обнаруживает, что собирается снова посетить экземпляр, уже находящийся в текущей ветке. Цикл разрывается, вызов проходит, и потребитель получает дерево. Цена в том, что `book.Author` сериализуется как `null`, хотя он явно был заполнен, что может сбить с толку, если потребитель ожидает корректного round-trip.

`IgnoreCycles` был добавлен в .NET 6 именно потому, что `Preserve` был слишком разрушительным по умолчанию, а `[JsonIgnore]` решает проблему только точечно. Применяйте его как глобальную настройку сериализатора для путей только-чтения и не трогайте модель.

### 3. Пометить обратную ссылку атрибутом [JsonIgnore]

Если обратный указатель никогда не полезен в JSON (потребитель всегда знает родителя, потому что только что его запросил), пометьте его напрямую:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }

    [JsonIgnore]
    public Author Author { get; set; } = null!;
}
```

`[JsonIgnore]` убирает свойство как из сериализатора, так и из десериализатора для этого типа. Цикл исчезает на этапе компиляции, никаких опций среды выполнения не нужно. Это правильное решение для навигационного свойства, которое существует только для отслеживания изменений и которое не нужно ни одному потребителю JSON.

Компромисс в том, что `Author` теперь невидим для слоя JSON везде. Если у вас есть другой endpoint, который хочет вернуть `Book` с вложенным `Author`, `[JsonIgnore]` слишком груб, и лучше спроецировать на DTO.

### 4. ReferenceHandler.Preserve, когда вам действительно нужен round-trip

Если ваш сценарий - внутренний-к-внутреннему (актор-система, протокол сервер-к-серверу, снимок, который вы читаете обратно в другом процессе .NET), `Preserve` - это опция, сохраняющая граф нетронутым:

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.Preserve
};

var json = JsonSerializer.Serialize(author, options);
```

В выходе появляются свойства `$id` и `$ref`:

```json
{
  "$id": "1",
  "Id": 1,
  "Name": "Carla",
  "Books": {
    "$id": "2",
    "$values": [
      {
        "$id": "3",
        "Id": 1,
        "Title": "Refactoring",
        "Author": { "$ref": "1" }
      }
    ]
  }
}
```

`Preserve` **никогда** не является правильным ответом для публичного REST API. JavaScript-клиенты, мобильные клиенты, Postman, любой генератор кода, любой валидатор Swagger ожидают обычный JSON. `$id` и `$ref` - это собственное соглашение System.Text.Json (изначально из Newtonsoft), они не являются стандартом. Браузеры их не распакуют. Если вы не десериализуете на другой стороне с помощью `System.Text.Json` с той же опцией `Preserve`, не выводите их.

Законное применение - сервер-к-серверу, где оба конца на .NET, вы контролируете контракт и вам действительно нужно, чтобы граф проходил round-trip без дублирования.

### 5. Увеличить MaxDepth, но только для честно глубоких деревьев

Если вы изучили путь в исключении и это не повторяющийся узор, а длинный прямой спуск, ваш граф действительно глубже 64 уровней:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    MaxDepth = 128
};
```

Это редкость. В большинстве доменов нет деревьев глубиной в 64 уровня, и если ваше такое, почти наверняка вы захотите разбить ответ на части или пагинировать. Но это правильная ручка для вещей вроде рекурсивных структур папок, организационных иерархий или деревьев выражений, где глубина - это данные, а не баг.

**Не** поднимайте `MaxDepth`, чтобы "обойти" цикл. Guard глубины - единственное, что стоит между вашим процессом и переполнением стека.

## Распространённые формы, приводящие к этому

### Навигационные свойства EF Core на сериализуемой сущности

Учебный случай. У `Order` есть `Customer`, у `Customer` есть `List<Order> Orders`, и `Include` заполняет обе стороны. Решение - спроецировать на DTO или применить `[JsonIgnore]` к обратному указателю. Возврат сущностей из контроллера - самый распространённый источник этого исключения.

### Самоссылающиеся деревья

`Category` с `Parent` и `List<Category> Children`, заполненная рекурсивными `Include`. Цикл - это `category.Children[0].Parent == category`. `IgnoreCycles` обрабатывает это чисто, потому что writer обнаруживает цикл на обратном указателе и выдаёт там `null`.

### Анонимные типы, построенные из LINQ

Проекция LINQ, превращающаяся в анонимный тип внутри графа, обычно безопасна (у анонимных типов нет обратных указателей). Но проекция вроде `Select(a => new { a, Books = a.Books })` снова вводит сущность, и цикл возвращается. Проверьте, что вы написали на самом деле, а не что хотели написать.

### DTO, скопировавший навигационные свойства своего источника

Конфигурация маппинга, переносящая `Author Author` из сущности в DTO, обнуляет смысл DTO. Либо уберите свойство из DTO, либо измените его тип на `AuthorDto` (record-лист без обратного указателя).

### Граф глубже 32, со старым стандартным сообщением

До .NET 8 значение `MaxDepth` по умолчанию было 64 только если не задано явно; путь генератора исходного кода и некоторые устаревшие инициализаторы использовали 32. Сообщение исключения жёстко содержит "32" в некоторых старых версиях и "64" или ваше пользовательское значение в новых. Читайте фактическое исключение, а не документацию, версия среды выполнения определяет число.

## Варианты, похожие на это, но другие

### "The object or value could not be serialized. There was a recursive call detected."

Другая ошибка, та же семья. Это сообщение, которое выдаёт Newtonsoft.Json, когда его `ReferenceLoopHandling` оставлен по умолчанию в `Error`. Решение в Newtonsoft - `ReferenceLoopHandling.Ignore` (аналог `IgnoreCycles`) или `PreserveReferencesHandling.All` (аналог `Preserve`). Если вы в процессе миграции, [маршрут миграции с Newtonsoft на System.Text.Json](/ru/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) - наиболее близкий к каноническому разбору случай; обе библиотеки приходят к одной форме решения, но называют опции по-разному.

### "JsonException: The JSON value could not be converted to ..."

Другое исключение, другой стек. Это о парсинге ввода, не соответствующего целевому типу. Исключение цикла - это проблема стороны записи; исключение преобразования - проблема стороны чтения. [Руководство по преобразованию System.DateTime](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) - канонический текст для семьи на стороне чтения.

### "Self referencing loop detected for property ..."

Это дословно сообщение Newtonsoft. Если вы видите его в коде 2026 года, который, как вы думали, использует `System.Text.Json`, где-то всё ещё подключён сериализатор Newtonsoft, обычно остаточный вызов `AddNewtonsoftJson()` на MVC-билдере. Поищите в startup хоста; фреймворк выбирает JSON-форматер, зарегистрированный последним.

### "An item with the same key has already been added. Key: $id"

Это десериализатор `Preserve` падает, потому что один и тот же `$id` встречается дважды во входе. Либо payload некорректен (двум разным объектам присвоен один и тот же id), либо он был сериализован с `Preserve`, а затем повторно сериализован через трансформер, переписавший id. Решение на стороне производителя, а не потребителя.

### "PossibleCycleDetected" из рендера Blazor

Совсем другой слой. У движка дифинга Blazor есть собственный guard циклов для параметров компонентов; тип исключения и стек другие. Не меняйте `JsonSerializerOptions`, чтобы починить цикл рендера Blazor.

## Работа с генератором исходного кода

При использовании генерации исходного кода `System.Text.Json` применяются те же опции. Установите `ReferenceHandler` на `JsonSerializerOptions`, которые вы передаёте в сгенерированный контекст, или используйте атрибут `[JsonSourceGenerationOptions]` на типе контекста:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    ReferenceHandler = JsonKnownReferenceHandler.IgnoreCycles)]
[JsonSerializable(typeof(Author))]
public partial class ApiJsonContext : JsonSerializerContext { }
```

`JsonKnownReferenceHandler` - это enum, удобный для атрибутов, он сопоставляется с теми же обработчиками, что `ReferenceHandler.IgnoreCycles` / `Preserve` во время выполнения. Пост по генератору исходного кода [interceptors и эргономика генерации исходного кода System.Text.Json](/ru/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) проходит по форме регистрации контекста, которая переживает trimming и AOT-публикацию, та же форма применима и здесь.

## Связанное

Парный пост по стороне чтения см. в [исправлении The JSON value could not be converted to System.DateTime](/ru/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/). Общий каркас для написания собственных конвертеров, обходящих обработку ссылок по умолчанию, живёт в [разборе пользовательского JsonConverter](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Если сериализуемая сущность приходит из EF Core 11 и вам нужна история round-trip с базой данных, [разбор JSON contains в SQL Server 2025](/ru/2026/04/efcore-11-json-contains-sql-server-2025/) объясняет, как тип столбца JSON обрабатывает графы на уровне базы данных. Для более широкого случая миграции всей кодовой базы с `ReferenceLoopHandling` от Newtonsoft заметка о [vstest, отказывающемся от Newtonsoft.Json в .NET 11 preview 4](/ru/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) содержит собственный playbook команды .NET.

## Источники

- [Preserve references and handle circular references in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references), Microsoft Learn.
- [`JsonSerializerOptions.ReferenceHandler`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.referencehandler), Microsoft Learn.
- [`JsonSerializerOptions.MaxDepth`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.maxdepth), Microsoft Learn.
- [`JsonIgnoreAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonignoreattribute), Microsoft Learn.
- [dotnet/runtime issue 30820: cycle detection in JSON serialization](https://github.com/dotnet/runtime/issues/30820), исходное обсуждение дизайна, в результате которого появились `Preserve`, а позже `IgnoreCycles`.
