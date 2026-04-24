---
title: "Как правильно использовать records с EF Core 11"
description: "Практическое руководство по сочетанию records C# и EF Core 11. Где records подходят, где они ломают change tracking, и как моделировать value objects, сущности и проекции, не воюя с фреймворком."
pubDate: 2026-04-21
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "records"
  - "dotnet-11"
  - "how-to"
lang: "ru"
translationOf: "2026/04/how-to-use-records-with-ef-core-11-correctly"
translatedBy: "claude"
translationDate: 2026-04-24
---

Короткий ответ: на EF Core 11 и C# 14 используйте `record class` для проекций, DTO и комплексных типов (value objects), а для отслеживаемых сущностей предпочитайте обычный `class` с init-only свойствами и связывающим конструктором. `record struct` нормален как комплексный тип, но никогда как отслеживаемая сущность. Трение, в которое попадают люди, почти всегда возникает из-за попыток использовать позиционные records как полноценные сущности и удивления, когда `with`-выражения, равенство по значению или read-only первичные ключи сталкиваются с identity tracking EF Core. Решение - не настройка, а понимание, какая форма record на каком кресле сидит.

Эта статья охватывает три кресла (сущность, комплексный тип, проекция), показывает правила связывания конструктора, реально присутствующие в EF Core 11, и проходит через специфические подводные камни, на которых спотыкаются: store-generated ключи, выражение `with`, навигационные свойства, ловушки равенства по значению и records, замапленные в JSON.

## Почему у records и EF Core репутация конфликтующих

Records C# были спроектированы так, чтобы упростить неизменяемые типы данных с равенством по значению. Два экземпляра `record Address(string City, string Zip)` равны, когда равны их поля, а не когда это одна и та же ссылка. Это и есть правильная семантика для value object.

Change tracker EF Core построен на противоположном предположении. [ChangeTracker](https://learn.microsoft.com/en-us/ef/core/change-tracking/) хранит снапшот значений свойств каждой сущности при первом её прикреплении, а [identity resolution](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution) утверждает, что в одном `DbContext` ровно один CLR-экземпляр на первичный ключ. Оба полагаются на ссылочную идентичность, а не на идентичность по значению. Если вы штампуете `record` первичным ключом, а потом мутируете его, создавая новый экземпляр через `with`, у вас две CLR-ссылки, которые сравниваются как равные, но не одна и та же отслеживаемая сущность. Change tracker либо бросает, потому что PK уже отслеживается, либо молча игнорирует ваши правки.

Официальная документация C# уже годами говорит, что «record-типы не подходят для использования в качестве entity types в Entity Framework Core». Это предупреждение - грубое резюме описанной выше ситуации, а не жёсткий запрет. Records можно использовать как сущности, и EF Core 11 по-прежнему поддерживает все механизмы для этого. Просто нужно выбрать непозиционную, init-only форму и играть по правилам связывания конструктора в [документации по конструкторам EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/constructors).

## Кресло 1: records как комплексные типы (sweet spot)

EF Core 8 ввёл `ComplexProperty`, а EF Core 11 сделал комплексные типы достаточно стабильными, чтобы рекомендовать их как замену owned entities по умолчанию в большинстве случаев. Комплексные типы - именно там, где records блистают: у комплексного типа нет собственной идентичности, его равенство по значению совпадает с семантикой базы, и он рассчитан на полную замену при изменении любого поля.

```csharp
// .NET 11, C# 14, EF Core 11
public record Address(string Street, string City, string PostalCode);

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Address ShippingAddress { get; set; } = new("", "", "");
    public Address BillingAddress { get; set; } = new("", "", "");
}

// OnModelCreating
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress);
    b.ComplexProperty(c => c.BillingAddress);
});
```

Что заставляет это работать:

- `Address` - позиционный `record class`. EF Core маппит позиционные records из коробки для комплексных типов, потому что первичный конструктор сопоставляется с именами свойств один-к-одному.
- `Address` не нуждается в собственном первичном ключе, потому что у комплексных типов нет идентичности.
- Замена `ShippingAddress` клиента через `customer.ShippingAddress = customer.ShippingAddress with { City = "Cluj" };` обновляет отслеживаемую сущность так, как вы ожидаете. EF Core видит, что снапшот `Customer` отклонился от прежних значений, и помечает три замапленные колонки грязными.

Если нужен значимый тип, `record struct` тоже валиден для комплексного свойства и избегает дополнительной кучной аллокации на строку. Компромисс обычный: большие наборы полей дороги при копировании, и вы теряете возможность легко добавить безпараметровый конструктор для конвенций EF.

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency);
```

Используйте `record struct` для маленьких значений с фиксированной формой (деньги, координаты, диапазоны дат). Для всего остального - `record class`.

## Кресло 2: records как сущности (работает, но требует дисциплины)

Если хочется внешне неизменяемой сущности, форма, выживающая в change tracking, - это `record class` с **непозиционными** init-only свойствами и связывающим конструктором, который EF Core может вызвать при материализации.

```csharp
// .NET 11, C# 14, EF Core 11
public record class BlogPost
{
    // EF binds to this ctor during materialization
    public BlogPost(int id, string title, DateTime publishedAt)
    {
        Id = id;
        Title = title;
        PublishedAt = publishedAt;
    }

    // Parameterless ctor lets EF (and serializers) create instances
    // before setting properties one at a time when needed.
    private BlogPost() { }

    public int Id { get; init; }
    public string Title { get; init; } = "";
    public DateTime PublishedAt { get; init; }

    // Navigation props cannot be bound via constructor.
    public List<Comment> Comments { get; init; } = new();
}
```

Правила из [документации по связыванию конструктора](https://learn.microsoft.com/en-us/ef/core/modeling/constructors), применённые к records:

1. Если EF Core находит конструктор, имена и типы параметров которого совпадают с замапленными свойствами, он использует этот конструктор при материализации. Свойства в Pascal-case могут совпадать с параметрами в camel-case.
2. Навигационные свойства (коллекции, ссылки) нельзя связать через конструктор. Держите их вне первичного конструктора и инициализируйте дефолтом.
3. Свойства без сеттера по конвенции не маппятся. `init` считается сеттером, поэтому init-only свойства маппятся. Свойство, объявленное как `public string Title { get; }` без сеттера вообще, считается вычислимым и пропускается.
4. Store-generated ключи требуют записываемого ключа. `init` записываем во время инициализации объекта - это как раз то, когда EF Core ставит значение, поэтому `int Id { get; init; }` работает для store-generated identity-колонок.

Почему не использовать позиционный record для самой сущности? Две причины.

Во-первых, у позиционного record есть **неявный сгенерированный компилятором набор свойств** с `init`-сеттерами, но также защищённый метод `<Clone>$` и копирующий конструктор, которым пользуются `with`-выражения. В момент `post with { Title = "New title" }` вы получаете совершенно новый экземпляр `BlogPost` с тем же первичным ключом, что и у отслеживаемого. Если попробовать `context.Update(newPost)`, упадёт `InvalidOperationException: The instance of entity type 'BlogPost' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked.` Identity resolution делает свою работу: вы дали ей две ссылки на то, что она считает одной и той же строкой.

Во-вторых, позиционные records генерируют `Equals` и `GetHashCode` на основе значения. Change tracker EF Core, fixup отношений и `DbSet.Find` опираются на ссылочную идентичность. Равенство по значению не ломает их напрочь, но создаёт удивительные эффекты: две свежезагруженные сущности из разных запросов могут оказаться hash-равны, будучи разными отслеживаемыми экземплярами, и `HashSet<BlogPost>` их схлопнет. Держите равенство по значению подальше от того, у чего есть идентичность.

Record class с явными свойствами, как выше, обходит обе ловушки. Вы получаете неизменяемость и приятный `ToString`, и отказываетесь от мутаций через `with` (которые на отслеживаемой сущности и не нужны).

### Обновление сущности в иммутабельном стиле

Поскольку сущность «неизменяемая», путь обновления не может быть «мутировал, потом SaveChanges». Два рабочих паттерна на EF Core 11:

```csharp
// .NET 11, EF Core 11
// Pattern A: load, assign to a local with init setters cleared.
// Requires exposing init setters on the class.
var post = await db.BlogPosts.SingleAsync(p => p.Id == id);

// This mutates the tracked instance. Works because 'init' is
// a settable accessor from EF Core's point of view, and nothing
// stops you from assigning through reflection or source-gen.
// If you want real immutability, use Pattern B.
db.Entry(post).Property(p => p.Title).CurrentValue = "New title";
await db.SaveChangesAsync();

// Pattern B: detach the old, attach a freshly-constructed one,
// mark the touched columns modified. No 'with' expression.
var updated = new BlogPost(post.Id, "New title", post.PublishedAt);
db.Entry(post).State = EntityState.Detached;
db.Attach(updated);
db.Entry(updated).Property(p => p.Title).IsModified = true;
await db.SaveChangesAsync();
```

Паттерн A - то, к чему обычно приходит большинство команд: используют records ради эргономичного `ToString`, деконструкции и пофилдового равенства на чтении, и принимают, что путь записи идёт через change tracker, мутирующий init-свойства через метаданные EF Core. Это не нарушение неизменяемости на уровне языка, это просто способ EF Core связывать свойства. Есть давний issue в EF Core, отслеживающий первоклассную поддержку неизменяемых обновлений ([efcore#11457](https://github.com/dotnet/efcore/issues/11457)), если хотите полную картину.

## Кресло 3: records как проекции и DTO (всегда безопасно)

Каждый раз, когда record материализуется вне change tracker, ни одна из проблем выше не применима. Проекции на records - самый скучный и самый полезный паттерн:

```csharp
// .NET 11, C# 14, EF Core 11
public record PostSummary(int Id, string Title, DateTime PublishedAt);

// No tracking, no identity, no ChangeTracker snapshot.
var summaries = await db.BlogPosts
    .AsNoTracking()
    .Select(p => new PostSummary(p.Id, p.Title, p.PublishedAt))
    .ToListAsync();
```

Пайплайн запросов EF Core 11 спокойно связывается с позиционными records в проекциях. Их можно отдавать прямо из веб-API через `System.Text.Json`, поддерживающий сериализацию records с .NET 5 и десериализацию позиционных records с .NET 7.

То же касается входных DTO для команд: примите позиционный record из контроллера, валидируйте, замапьте на форму сущности выше и дайте EF Core отслеживать сущность. Раздельные тип на проводе (record) и тип в персистенции (class с init) убирают всю категорию багов, которым посвящена эта статья.

Подробнее про records как формы возврата см. [таблицу решений в конце статьи о множественных значениях](/ru/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/).

## Store-generated ключи и init-only свойства

Это самое частое место, где люди застревают. Если `Id` объявлен как `public int Id { get; }` без сеттера, EF Core его не замаппит, и миграции будут жаловаться на отсутствующий ключ. Если же `public int Id { get; init; }`, он замаплен и записываем во время инициализации объекта - это как раз когда EF Core ставит значение, прочитанное из базы.

Для inserts EF Core также нужно записать сгенерированное значение обратно в сущность после `SaveChanges`. Делается это через сеттер свойства, который для init-only свойств всё ещё работает, потому что EF Core использует метаданные доступа к свойству, а не публичный синтаксис C#. Подтверждено в EF Core 11; стабильно с EF Core 5.

Что не работает: `public int Id { get; } = GetNextId();` с инициализатором поля и без сеттера. EF Core не видит сеттер, не маппит свойство, и вы получаете либо ошибку сборки про недостающий ключ, либо непредусмотренный shadow key.

## Выражение `with` - выстрел в ногу для отслеживаемых сущностей

Когда сущность - `record` (позиционный или нет) с копированием, сгенерированным первичным конструктором, `with` производит клон, равный оригиналу, но другой CLR-ссылки. EF Core воспринимает это как «тот же ключ, другой экземпляр», что запускает identity resolution. Безопасное правило:

```csharp
// .NET 11, EF Core 11
// BAD: creates a second instance with the same PK.
var edited = post with { Title = "New" };
db.Update(edited); // throws InvalidOperationException on SaveChanges

// GOOD: mutate the tracked instance.
post.Title = "New"; // via init (within EF) or a regular setter
await db.SaveChangesAsync();
```

Если вам действительно нужна семантика «detach, clone, re-attach», сначала пройдите через `db.Entry(post).State = EntityState.Detached;`, потом приатачьте клон и пометьте свойства как `IsModified`. Чаще всего вам это не нужно. Вам нужен Паттерн A из предыдущего раздела.

У комплексных типов такой проблемы нет. `with` на `Address` внутри `Customer` производит новое значение, вы присваиваете его обратно в `customer.ShippingAddress`, и EF Core сравнивает поле за полем со снапшотом. В этом и весь смысл комплексных типов.

## Равенство по значению против идентичности на горячих путях

Если настаиваете на сущности-позиционном record, помните, что равенство по значению просачивается во все коллекции, опирающиеся на `GetHashCode`. `HashSet<BlogPost>` схлопнет «две разные сущности с одинаковыми данными». Словарь, ключ которого - сущность, ведёт себя непредсказуемо, если у двух разных PK совпадают payload. Стандартный обход - переопределить `Equals` и `GetHashCode` у record так, чтобы ключевать только по первичному ключу, что обнуляет всю причину выбора record.

Сам change tracker, начиная с EF Core 11, по-прежнему использует ссылочную идентичность внутри. Подробности можно посмотреть [в исходниках change-tracking](https://github.com/dotnet/efcore), но коротко: EF Core не «сливает» две сущности случайно лишь потому, что они равны по значению. Однако такое слияние всплывает через `DbSet.Find`, `FirstOrDefault` на отслеживаемом запросе и fixup отношений - именно поэтому команды видят странности, которые не могут сразу объяснить.

И снова: исправление - не спорить с рантаймом. Это держать равенство по значению на значимых типах (комплексных, DTO) и оставлять типы сущностей с дефолтным ссылочным равенством.

## JSON-колонки и records

EF Core 7 добавил маппинг JSON-колонок, а EF Core 11 расширяет это [трансляцией JSON_CONTAINS на SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) и комплексными типами внутри JSON-документов. Позиционные records эргономично подходят для owned JSON-типов:

```csharp
// .NET 11, C# 14, EF Core 11
public record TagSet(List<string> Tags, DateTime UpdatedAt);

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public TagSet Metadata { get; set; } = new(new(), DateTime.UtcNow);
}

// OnModelCreating
modelBuilder.Entity<Article>()
    .OwnsOne(a => a.Metadata, b => b.ToJson());
```

Record - комплексное свойство, хранимое как JSON. Заменяете его целиком через `article.Metadata = article.Metadata with { Tags = [..article.Metadata.Tags, "net11"] };`, и EF Core сериализует всё поддерево при `SaveChanges`. Никакого identity tracking, никаких споров `with` против мутации.

## Складываем вместе

Реалистичный домен от и до:

```csharp
// .NET 11, C# 14, EF Core 11
// Complex types (records)
public record Address(string Street, string City, string PostalCode);
public readonly record struct Money(decimal Amount, string Currency);

// Entity (class with init-only properties + binding ctor)
public class Order
{
    public Order(int id, string customerName, Money total, Address shipTo)
    {
        Id = id;
        CustomerName = customerName;
        Total = total;
        ShipTo = shipTo;
    }

    private Order() { } // EF fallback

    public int Id { get; init; }
    public string CustomerName { get; init; } = "";
    public Money Total { get; init; }
    public Address ShipTo { get; init; } = new("", "", "");

    public List<OrderLine> Lines { get; init; } = new();
}

// Projection/DTO (positional record)
public record OrderSummary(int Id, string CustomerName, decimal Total);

// Input command (positional record, validated before mapping)
public record CreateOrder(string CustomerName, Money Total, Address ShipTo);
```

Вот всё практическое правило: классы для вещей с идентичностью, records для вещей, определяемых своими данными. Связывание конструктора в EF Core 11, маппинг комплексных типов и маппинг JSON поддерживают это разделение без дополнительной конфигурации, кроме `ComplexProperty` или `OwnsOne(..ToJson())` где уместно.

## Связанное чтение

- [EF Core 11 добавляет GetEntriesForState, чтобы пропустить DetectChanges](/2026/04/efcore-11-changetracker-getentriesforstate/) покрывает внутренности change tracker, на которые опирается эта статья.
- [EF Core 11 убирает ненужные reference-джойны в split-запросах](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) - хороший спутник, если ваши сущности активно используют навигации.
- [EF Core 11 транслирует Contains в JSON_CONTAINS на SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) связан с паттерном JSON-маппленных records выше.
- [Как вернуть несколько значений из метода в C# 14](/ru/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) глубже разбирает, когда records выигрывают над кортежами и классами на уровне возврата метода.

## Источники

- [Конструкторы и связывание свойств EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/constructors)
- [Обзор change tracking EF Core](https://learn.microsoft.com/en-us/ef/core/change-tracking/)
- [Identity resolution EF Core](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution)
- [Что нового в EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Справочник по record-типам C#](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/types/records)
- [Поддержка неизменяемых обновлений сущностей (efcore#11457)](https://github.com/dotnet/efcore/issues/11457)
- [Документировать record-типы как сущности (EntityFramework.Docs#4438)](https://github.com/dotnet/EntityFramework.Docs/issues/4438)
