---
title: "Как мапить и запрашивать JSON-столбцы в EF Core 11"
description: "Сопоставьте вложенный тип с одним JSON-столбцом через ComplexProperty(...).ToJson(), позвольте EF Core 11 хранить его в нативном типе json SQL Server 2025, а затем запрашивайте его с помощью LINQ, который транслируется в JSON_VALUE, JSON_CONTAINS и JSON_PATH_EXISTS."
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "json"
  - "sql-server"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/06/how-to-map-and-query-json-columns-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-23
---

Короткий ответ: смоделируйте вложенные данные как комплексный тип, вызовите `ComplexProperty(b => b.Details, d => d.ToJson())` в `OnModelCreating`, и EF Core 11 сопоставит весь граф объектов с одним столбцом. На SQL Server 2025 (уровень совместимости 170) этот столбец имеет нативный тип данных `json`, а не `nvarchar(max)`. Затем вы запрашиваете его обычным LINQ: `Where(b => b.Details.Viewers > 3)` транслируется в `JSON_VALUE(... RETURNING int)`, `b.Tags.Contains("ef-core")` транслируется в `JSON_CONTAINS`, а `EF.Functions.JsonPathExists(...)` проверяет наличие пути. Массовые обновления внутри документа тоже работают, через `ExecuteUpdateAsync` и функцию `.modify()` типа `json` SQL Server.

В этой статье используется `Microsoft.EntityFrameworkCore` 11.0.0 на .NET 11 с C# 14 против SQL Server 2025. API сопоставления не зависят от провайдера, но точный SQL и нативный тип `json` специфичны для SQL Server; PostgreSQL и SQLite используют собственные JSON-функции для того же LINQ.

## Два способа сопоставить столбец с JSON, и почему один теперь предпочтителен

EF Core уже некоторое время умеет помещать вложенный объект .NET в один JSON-столбец, но исторически единственным способом были *owned-типы сущностей*: `OwnsOne(...).ToJson()`. Это по-прежнему работает. Проблема в том, что owned-типы под капотом являются типами сущностей, поэтому несут идентичность и ссылочную семантику, что неожиданным образом просачивается в ваш код.

Начиная с EF Core 10 и далее стабилизированный в 11, рекомендуемым инструментом моделирования является *комплексный тип*. Комплексный тип не имеет ключа, не имеет идентичности и обладает семантикой значения, что в точности соответствует тому, чем является JSON-документ внутри строки. Пометьте тип атрибутом `[ComplexType]` (или настройте его через fluent API) и вызовите `ToJson()`:

```csharp
// .NET 11, EF Core 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    public string[] Tags { get; set; } = [];     // primitive collection
    public required BlogDetails Details { get; set; }
}

[ComplexType]
public class BlogDetails
{
    public string? Description { get; set; }
    public int Viewers { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .ComplexProperty(b => b.Details, d => d.ToJson());
}
```

Здесь в JSON попадают две вещи. `Details` становится JSON-столбцом, потому что вы запросили это с помощью `ToJson()`. `Tags` становится JSON-столбцом автоматически: EF сопоставляет коллекции примитивов (`string[]`, `List<int>` и так далее) с JSON-столбцом-массивом вообще без настройки, поведение, которое существует с EF Core 8.

## Нативный тип данных json, и когда вы его получаете

*Тип* столбца зависит от базы данных, на которую вы направляете EF. С EF Core 10 и 11, если вы настраиваете провайдер с `UseAzureSql` или с уровнем совместимости SQL Server 170 или выше (который сообщает SQL Server 2025), EF по умолчанию задаёт столбцу нативный тип данных `json` вместо `nvarchar(max)`:

```csharp
// .NET 11, EF Core 11.0.0 - opt into the SQL Server 2025 json type
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

Модель выше затем создаёт такую таблицу:

```sql
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Tags] json NOT NULL,
    [Details] json NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
```

Нативный тип `json` проверяет своё содержимое, хранит его компактнее, чем текст, и поддерживает JSON-индекс. Стоит сразу отметить одну деталь миграции: если ваше приложение уже хранит JSON в столбцах `nvarchar(max)` и вы поднимаете уровень совместимости до 170, следующая миграция, которую генерирует EF, *изменит эти столбцы на `json`* автоматически. Если вы к этому не готовы, либо явно зафиксируйте тип столбца обратно на `nvarchar(max)`, либо держите уровень совместимости ниже 170. Ниже 170 всё в этой статье по-прежнему работает; данные просто живут в текстовом столбце, а SQL использует старые JSON-функции на основе строк.

## Настройка сопоставления, шаг за шагом

Вот минимальный, упорядоченный путь от обычного класса к запрашиваемому JSON-столбцу.

1. **Смоделируйте вложенные данные как `[ComplexType]`.** Дайте ему свойства, которые вы хотите видеть внутри документа. Коллекции разрешены внутри комплексного типа, сопоставленного с JSON, в отличие от разбиения таблиц.
2. **Вызовите `ToJson()` в `OnModelCreating`.** Используйте `ComplexProperty(b => b.Details, d => d.ToJson())` для одного вложенного объекта. Для коллекции вложенных объектов используйте `ComplexProperty` с типом коллекции, и весь массив сопоставляется с одним столбцом.
3. **Нацельтесь на SQL Server 2025 ради нативного типа.** Задайте `UseCompatibilityLevel(170)` (или `UseAzureSql`), чтобы столбец был `json`, а не `nvarchar(max)`.
4. **Добавьте миграцию и примените её.** `dotnet ef migrations add AddBlogDetailsJson`, затем `dotnet ef database update`. Изучите сгенерированный `CREATE TABLE`, чтобы убедиться, что тип столбца таков, как вы ожидаете.
5. **Запрашивайте и обновляйте обычным LINQ.** Без сырого SQL, без ручной сериализации. Разделы ниже показывают, во что транслируется каждая форма LINQ.

## Запрос внутри документа с помощью LINQ

Это та часть, которая делает использование JSON-столбцов оправданным вместо сериализованного blob, который приходится десериализовать в памяти. Вы фильтруете, проецируете и сортируете по свойствам *внутри* JSON, и EF транслирует это в серверные JSON-функции.

Фильтрация по вложенному скаляру читается через `JSON_VALUE` с типизированной клаузой `RETURNING`:

```csharp
// .NET 11, EF Core 11.0.0
var popular = await context.Blogs
    .Where(b => b.Details.Viewers > 3)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) > 3
```

Клауза `RETURNING int` -- это то, что позволяет сравнению выполняться как целочисленное на сервере, а не как сравнение строк, что и корректно, и дружественно к индексам.

### Поиск в коллекции примитивов: Contains становится JSON_CONTAINS

Проверка того, содержит ли JSON-массив значение, -- самый распространённый JSON-запрос. На SQL Server 2025 EF Core 11 транслирует `Contains` по коллекции примитивов на основе JSON в новую функцию `JSON_CONTAINS`:

```csharp
var tagged = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

Это заменяет старую, более медленную трансляцию на основе `OPENJSON`, и `JSON_CONTAINS` может использовать JSON-индекс, если он определён. Я подробно разобрал эту трансляцию в [статье об EF Core 11 и JSON_CONTAINS](/2026/04/efcore-11-json-contains-sql-server-2025/), включая переключатель уровня совместимости, который её включает. Один острый угол: `JSON_CONTAINS` не может искать null, поэтому EF выдаёт его только тогда, когда может доказать, что одна сторона не допускает null (ненулевая константа, либо столбец или элемент, не допускающий null). Когда это не удаётся, он возвращается к форме `OPENJSON`, чтобы запрос по-прежнему возвращал правильный ответ.

### Поиск с указанием пути и режима: EF.Functions.JsonContains

Когда вам нужно искать по конкретному пути внутри документа или указать режим поиска, вызывайте `JSON_CONTAINS` напрямую через `EF.Functions.JsonContains()`:

```csharp
var rated = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

Он принимает JSON-значение, искомое значение и, опционально, путь и режим поиска. Он работает со скалярными строковыми свойствами, комплексными типами и owned-типами сущностей, сопоставленными с JSON.

### Существует ли вообще этот путь: EF.Functions.JsonPathExists

Новый в EF Core 11, `EF.Functions.JsonPathExists()` проверяет, присутствует ли JSON-путь, транслируясь в `JSON_PATH_EXISTS` SQL Server (доступную с SQL Server 2022). Это правильный инструмент для «строк, где у документа задано необязательное поле»:

```csharp
var withOptional = await context.Blogs
    .Where(b => EF.Functions.JsonPathExists(b.JsonData, "$.OptionalInt"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_PATH_EXISTS([b].[JsonData], N'$.OptionalInt') = 1
```

## Обновление внутри документа без его загрузки

Запись в JSON-столбец имеет два режима. Знакомый -- отслеживание изменений: вы загружаете сущность, изменяете вложенное свойство, вызываете `SaveChanges`. EF сериализует обновлённый документ и записывает столбец. Для одной строки это нормально.

Интересный -- массовое обновление прямо в базе данных. EF Core 10 добавил поддержку `ExecuteUpdateAsync` для JSON, и она переходит в 11. С приведённым выше сопоставлением комплексного типа вы можете инкрементировать счётчик внутри JSON для целого набора результатов за один круговой рейс:

```csharp
await context.Blogs.ExecuteUpdateAsync(s =>
    s.SetProperty(b => b.Details.Viewers, b => b.Details.Viewers + 1));
```

На SQL Server 2025 это использует функцию `.modify()` типа `json`, поэтому сервер переписывает только одно свойство на месте, а не читает и пересериализует весь документ:

```sql
UPDATE [b]
SET [Details].modify('$.Viewers', JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) + 1)
FROM [Blogs] AS [b]
```

Одно жёсткое требование: `ExecuteUpdate` в JSON работает только тогда, когда тип сопоставлен как *комплексный тип*. Он не работает для owned-типов сущностей. Это самая конкретная причина предпочитать комплексные типы для нового кода, и более широкий компромисс между [`ExecuteUpdate` и загрузкой сущностей с последующим вызовом SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) применим и здесь.

## JSON-столбцы теперь работают с наследованием TPT и TPC

До EF Core 11 комплексные типы и JSON-столбцы нельзя было использовать на типах сущностей, которые применяли наследование «таблица на тип» (TPT) или «таблица на конкретный тип» (TPC). Это ограничение исчезло в 11. Вы можете сопоставить JSON-свойство на базовом типе и использовать его по всей иерархии:

```csharp
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Animal>()
        .UseTptMappingStrategy()
        .ComplexProperty(a => a.Details, b => b.ToJson());
}
```

Если вы поддерживаете доменную модель с настоящей иерархией наследования, это то изменение, которое позволяет сохранить TPT/TPC и при этом моделировать как документ общие, структурированные части каждой сущности.

## Краевые случаи, которые кусаются

**Семантика owned против комплексного.** С owned-типами сущностей присваивание одного документа другому (`blog.BillingDetails = blog.ShippingDetails`) выбрасывает исключение, потому что один и тот же экземпляр сущности нельзя отслеживать дважды. Комплексные типы сравниваются и присваиваются по значению, поэтому присваивание просто копирует поля. Если вы всё ещё на owned-типах для JSON, переход на комплексные типы устраняет целую категорию таких багов; это хорошо сочетается с дисциплиной [правильного использования records с EF Core 11](/2026/04/how-to-use-records-with-ef-core-11-correctly/) для неизменяемых форм значений.

**Комплексные типы-структуры пока не могут быть в коллекциях.** EF Core 10 добавил поддержку `struct` и `record struct` для комплексных типов, что хорошо подходит к их семантике значения. Но *коллекция* комплексных типов-структур в настоящее время не поддерживается. Используйте класс, если вложенный тип живёт в списке.

**Необязательным комплексным типам нужно обязательное свойство.** Необязательный (допускающий null) комплексный тип, сопоставленный с JSON, требует хотя бы одного обязательного свойства, определённого на типе, иначе EF не может отличить полностью-null документ от отсутствующего.

**Миграция nvarchar в json автоматическая.** Поднятие уровня совместимости до 170 переписывает существующие JSON-столбцы `nvarchar(max)` на нативный тип `json` при следующей миграции. Просмотрите эту миграцию перед применением в продакшене; это изменение схемы для каждого JSON-столбца сразу.

**Индексирование.** JSON-индекс -- это то, что делает `JSON_CONTAINS` и поиск по пути быстрыми при масштабировании. Нативный тип `json` поддерживает `CREATE JSON INDEX`; столбцы простого текста -- нет. Если ваши JSON-запросы -- горячие пути, нативный тип плюс индекс -- это разница между seek и полным сканированием, тот же урок, который проявляется в [критических изменениях миграции с EF Core 6 на 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) вокруг планов запросов.

Короткая версия: тянитесь к `[ComplexType]` плюс `ToJson()`, нацельтесь на SQL Server 2025, чтобы столбец был настоящим `json`, а затем обращайтесь с документом как с любой другой частью вашей модели в LINQ. EF Core 11 транслирует фильтрацию, `Contains` по массиву, проверки пути и даже массовые обновления в серверные JSON-функции, поэтому документу никогда не приходится совершать поездку в память только ради того, чтобы быть запрошенным.

## Источники

- [What's New in EF Core 11: complex types and JSON with TPT/TPC, JsonPathExists, JSON_CONTAINS](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: native json data type, complex types ToJson, ExecuteUpdate for JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [SQL Server json data type and the modify() method](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type)
- [JSON_CONTAINS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql)
- [JSON_PATH_EXISTS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-path-exists-transact-sql)
</content>
