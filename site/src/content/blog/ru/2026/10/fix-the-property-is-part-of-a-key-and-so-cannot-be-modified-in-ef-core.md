---
title: "Исправление: The property 'X' is part of a key and so cannot be modified or marked as modified в EF Core"
description: "EF Core никогда не обновляет значение ключа у отслеживаемой сущности. Не копируйте ключ из DTO, используйте уникальный индекс вместо альтернативного ключа, а настоящий ключ меняйте вставкой новой строки и удалением старой. Проверено на EF Core 10.0.14."
pubDate: 2026-10-27
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "change-tracker"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/10/fix-the-property-is-part-of-a-key-and-so-cannot-be-modified-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Краткий ответ:** EF Core считает каждое свойство ключа (первичный ключ, альтернативный ключ и любой внешний ключ, входящий в первичный) доступным только для чтения после сохранения сущности, а трекер изменений выбрасывает исключение, как только замечает новое значение. Найдите, что записывает ключ: обычно это маппер DTO или `CurrentValues.SetValues`, копирующий `Id` со значением `0`, натуральный столбец, настроенный через `HasAlternateKey`, или дочерняя строка с составным ключом, которую переносят к другому родителю. Перестаньте записывать ключ, замените альтернативный ключ уникальным индексом или, если ключ действительно нужно изменить, добавьте новую сущность с новым ключом и удалите старую в том же `SaveChanges`.

Всё ниже воспроизведено на .NET 10 (SDK 10.0.302) с `Microsoft.EntityFrameworkCore.Sqlite` 10.0.14 и базой SQLite в памяти. Проверка, которая выбрасывает исключение, находится в `InternalEntryBase.SetPropertyModified` и не изменилась в ветке `main` EF Core, из которой выйдет EF Core 11, так что те же правила действуют и для release candidate .NET 11.

## Ошибка в контексте

```
System.InvalidOperationException: The property 'Blog.Id' is part of a key and so cannot be modified or marked as modified. To change the principal of an existing entity with an identifying foreign key, first delete the dependent and invoke 'SaveChanges', and then associate the dependent with the new principal.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.SetPropertyModified(IProperty property, Boolean changeState, Boolean isModified, Boolean isConceptualNull, Boolean acceptChanges)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.DetectValueChange(IInternalEntry entry, IProperty property)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntryBase entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntityEntry entry)
```

Имя свойства в сообщении показывает, какой именно ключ защищает EF. `Blog.Id` это первичный ключ. Что-то вроде `Blog.Slug` означает альтернативный ключ. `OrderLine.OrderId` означает внешний ключ, который одновременно входит в составной первичный ключ, то есть тот самый "идентифицирующий внешний ключ", о котором говорит второе предложение сообщения.

## Почему EF Core отказывается менять ключ

Отслеживаемая сущность идентифицируется своим ключом. `DbContext` хранит карту идентичности от значений ключей к экземплярам сущностей, использует исходный ключ в условии `WHERE` команды `UPDATE` и исправляет навигации, сопоставляя внешние ключи с ключами главных сущностей. Если бы ключ можно было менять на месте, все три механизма пришлось бы переписывать на лету, вместе с каждой зависимой строкой в базе данных. EF Core этого не поддерживает, а запрос на добавление такой возможности, [dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), до сих пор открыт.

Защита основана на метаданных. Каждое свойство ключа получает `PropertySaveBehavior.Throw` в качестве поведения после сохранения, и трекер изменений проверяет его всякий раз, когда свойство сущности в состоянии `Unchanged` или `Modified` вот-вот будет помечено как изменённое:

```csharp
// EF Core source, src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs (simplified)
if (changeState
    && !isConceptualNull
    && isModified
    && !StateManager.SavingChanges
    && property.IsKey()
    && property.GetAfterSaveBehavior() == PropertySaveBehavior.Throw)
{
    throw new InvalidOperationException(CoreStrings.KeyReadOnly(property.Name, StructuralType.DisplayName()));
}
```

Для отладки важны два следствия. Во-первых, сущности в состоянии `Added` возвращаются до этой проверки, поэтому менять ключ ещё не сохранённой сущности можно. Во-вторых, при стандартном отслеживании изменений через снимки исключение выбрасывается не на строке, где присваивается ключ. Оно выбрасывается при следующем вызове `DetectChanges`, который выполняется внутри `SaveChanges`, `ChangeTracker.HasChanges()`, `ChangeTracker.Entries()` и похожих вызовов. В моём воспроизведении `blog.Id = 99;` выполнялось молча, а следующий же `db.ChangeTracker.HasChanges()` выбросил исключение. Если трассировка стека указывает на `SaveChangesAsync` в репозитории, настоящий виновник находится где-то раньше в обработке запроса.

Отказаться от этого тоже нельзя. Попытка переключить поведение сохранения для свойства ключа падает уже при построении модели:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().Property(b => b.Id).Metadata
    .SetAfterSaveBehavior(PropertySaveBehavior.Save);
// InvalidOperationException: The property 'Blog.Id' must be marked as read-only after it has been
// saved because it is part of a key. Key properties are always read-only once an entity has been
// saved for the first time.
```

## Минимальное воспроизведение

```csharp
// .NET 10, C# 14, EF Core 10.0.14, Microsoft.EntityFrameworkCore.Sqlite
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

using var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();

using (var db = new AppDb(conn))
{
    db.Database.EnsureCreated();
    db.Blogs.Add(new Blog { Id = 1, Name = "Start Debugging" });
    db.SaveChanges();
}

using (var db = new AppDb(conn))
{
    var blog = db.Blogs.Single(b => b.Id == 1);
    blog.Id = 99;       // no exception here
    db.SaveChanges();   // InvalidOperationException: The property 'Blog.Id' is part of a key...
}

class AppDb(SqliteConnection c) : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite(c);
    protected override void OnModelCreating(ModelBuilder mb) =>
        mb.Entity<Blog>().Property(b => b.Id).ValueGeneratedNever();
}

class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}
```

Никто не пишет `blog.Id = 99` намеренно, поэтому остальная часть статьи посвящена четырём местам, откуда запись берётся на самом деле, в порядке частоты, с которой я их встречаю.

## Исправление 1: не копируйте ключ из DTO

Это самая частая причина с большим отрывом. PUT-эндпоинт загружает сущность, а затем копирует поверх неё входящую модель:

```csharp
// .NET 10, EF Core 10.0.14
public record BlogDto(int Id, string Name);

var blog = await db.Blogs.SingleAsync(b => b.Id == id);
db.Entry(blog).CurrentValues.SetValues(dto);   // dto.Id is 0 because the client never sent it
await db.SaveChangesAsync();                    // throws: 'Blog.Id' is part of a key
```

`PropertyValues.SetValues` копирует каждое свойство с совпадающим именем, включая ключи. Когда `Id` в DTO совпадает с отслеживаемым, ничего не меняется и сохранение проходит успешно; я проверил, что `SetValues` с `Id = 1` для строки с `Id = 1` сохраняется без ошибок. Когда клиент не передаёт id в теле запроса или id в маршруте и в теле расходятся, ключ меняется и EF выбрасывает исключение. Обратите внимание, что трассировка стека в этом случае другая: поскольку `SetValues` работает с трекером изменений напрямую, исключение возникает внутри самого `SetValues` (`ChangeDetector.PropertyChanged`), а не в `SaveChanges`.

Выберите один источник истины для id, обычно это маршрут, и никогда не позволяйте телу запроса его перезаписывать:

```csharp
// .NET 10, EF Core 10.0.14
app.MapPut("/blogs/{id:int}", async (int id, BlogDto dto, AppDb db) =>
{
    if (dto.Id != 0 && dto.Id != id)
        return Results.BadRequest("Route id and body id differ.");

    var blog = await db.Blogs.SingleOrDefaultAsync(b => b.Id == id);
    if (blog is null) return Results.NotFound();

    db.Entry(blog).CurrentValues.SetValues(dto with { Id = id });
    await db.SaveChangesAsync();
    return Results.NoContent();
});
```

Ещё лучше использовать DTO для обновления вообще без свойства `Id`, чтобы копировать было нечего. В AutoMapper эквивалентом будет `.ForMember(d => d.Id, o => o.Ignore())` в карте DTO-сущность, и стоит добавить `ForMember(...Ignore())` для каждого столбца ключа, включая внешние ключи, входящие в составной ключ.

Та же ошибка возникает в ручных помощниках "скопировать все свойства" и в патчерах на основе рефлексии. Если вы пишете такой, отфильтровывайте `entry.Metadata.FindPrimaryKey()!.Properties` и всё, для чего `property.IsKey()` возвращает true.

## Исправление 2: для натуральных идентификаторов используйте уникальный индекс, а не альтернативный ключ

Вторая разновидность: столбец, который вы считаете "уникальным", например slug, email или SKU, настроен как альтернативный ключ:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasAlternateKey(b => b.Slug);

var blog = db.Blogs.Single();
blog.Slug = "new-slug";
db.SaveChanges();   // InvalidOperationException: The property 'Blog.Slug' is part of a key...
```

Альтернативный ключ является ключом во всех смыслах, важных для EF, поэтому после сохранения он доступен только для чтения. В документации EF Core об этом сказано прямо: "In EF, alternate keys are read-only". Если вам нужна только уникальность в базе данных, настройте вместо этого уникальный индекс:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasIndex(b => b.Slug).IsUnique();
```

После этого однострочного изменения тот же код сохранился, а строка при чтении вернула `Slug = "new-slug"`. База данных по-прежнему обеспечивает уникальность, вы лишь теряете возможность направить внешний ключ на `Slug`.

Остерегайтесь альтернативных ключей, которые вы не объявляли. `HasPrincipalKey(x => x.Slug)` в связи заставляет EF создать такой ключ по соглашению, потому что внешний ключ должен ссылаться на ключ. Если в сообщении указано свойство, для которого вы никогда не вызывали `HasAlternateKey`, поищите в конфигурации модели `HasPrincipalKey` или проверьте `db.Model.FindEntityType(typeof(Blog))!.GetKeys()` во время выполнения. Чистое решение это перенацелить такую связь на первичный ключ. С точки зрения миграций переход от альтернативного ключа к уникальному индексу заменяет уникальное ограничение `AK_` на уникальный индекс `IX_`; проверьте сгенерированную миграцию перед применением.

## Исправление 3: переносите зависимую сущность с составным ключом через удаление и повторное добавление

Второе предложение сообщения как раз об этом случае. Допустим, строка заказа имеет ключ `(OrderId, LineNumber)`, а `OrderId` одновременно является внешним ключом на `Order`. Это идентифицирующая связь: идентичность строки включает её родителя. Перенос строки в другой заказ означает изменение её первичного ключа, и любой способ выразить это выбрасывает исключение:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });

var line = db.OrderLines.Single();
line.OrderId = 2;                     // throws at SaveChanges
// line.Order = order2;               // throws during fix-up
// order2.Lines.Add(line);            // throws during fix-up
db.SaveChanges();
```

Все три варианта в моём воспроизведении давали `The property 'OrderLine.OrderId' is part of a key`. Варианты с навигацией и с коллекцией падают в исправлении связей (relationship fix-up), которое само устанавливает внешний ключ.

Решение в том, чтобы рассматривать перенос как то, чем он на самом деле является: удалением одной строки и вставкой другой.

```csharp
// .NET 10, EF Core 10.0.14
var line = await db.OrderLines.SingleAsync(l => l.OrderId == 1 && l.LineNumber == 1);

db.OrderLines.Remove(line);
db.OrderLines.Add(new OrderLine
{
    OrderId = 2,
    LineNumber = 1,
    Sku = line.Sku,
});

await db.SaveChangesAsync();
```

Сообщение советует вызвать `SaveChanges` после удаления и до вставки. В EF Core 10 это не потребовалось ни в одном из проверенных мной случаев: удаление старой строки и добавление новой в одном `SaveChanges` работало и когда новый ключ отличался (`2/1`), и когда он был тем же (`1/1` с новым `Sku`), причём обе команды выполнялись в одной транзакции. Один `SaveChanges` к тому же безопаснее, потому что сбой между двумя сохранениями оставил бы строку удалённой и не созданной заново.

Если строки регулярно переходят между родителями, модель вам что-то подсказывает. Дайте `OrderLine` собственный суррогатный ключ (`int Id`) и сделайте `OrderId` обычным внешним ключом, не входящим в ключ. Тогда `line.OrderId = 2` становится обычным обновлением. Если это ограничение нужно, сохраните уникальность `(OrderId, LineNumber)` с помощью уникального индекса.

## Исправление 4: смена ключа главной сущности через вставку копии и перенаправление дочерних

Иногда сам первичный ключ действительно должен измениться: устаревший натуральный ключ был введён неверно или объединяются две системы. Внутри трекера изменений шаблон тот же, что и в исправлении 3, с одним дополнительным шагом для дочерних сущностей:

```csharp
// .NET 10, EF Core 10.0.14
var old = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);

var replacement = new Blog { Id = 99, Name = old.Name, Slug = old.Slug + "-moved" };
db.Blogs.Add(replacement);

foreach (var post in old.Posts.ToList())
    post.Blog = replacement;          // Post.BlogId is a plain FK, not part of Post's key

db.Blogs.Remove(old);
await db.SaveChangesAsync();
```

EF Core сам определяет порядок команд (вставить новый блог, обновить посты, удалить старый блог) и выполняет их в одной транзакции. В воспроизведении в итоге остался один блог с `Id = 99`, а `BlogId` поста стал равен `99`. Обратите внимание, что slug в копии был изменён: если у `Slug` есть уникальный индекс, вставка идентичного значения может столкнуться со старой строкой, которая ещё не удалена. Либо задайте копии временное значение и исправьте его потом, либо используйте набор-ориентированный подход ниже.

### Запасной вариант на уровне набора строк: ExecuteUpdate

`ExecuteUpdate` транслируется прямо в SQL и никогда не обращается к трекеру изменений, поэтому защита ключей не применяется:

```csharp
// .NET 10, EF Core 10.0.14
var rows = await db.Blogs
    .Where(b => b.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Id, 99));
```

Для блога без постов вызов вернул `1`, и id строки стал `99`. Для блога, на который ссылался пост, SQLite ответил `SQLite Error 19: 'FOREIGN KEY constraint failed'`, что в точности сделает любая база данных, если внешний ключ не объявлен с `ON UPDATE CASCADE`. В fluent API EF Core есть `OnDelete`, но нет аналога для обновлений, поэтому каскад пришлось бы добавлять через `migrationBuilder.Sql(...)` в миграции. Для разового исправления данных это обычно не стоит усилий; вставить, перенаправить, удалить проще для понимания.

Две оговорки, если вы всё же используете `ExecuteUpdate` для ключей. Любая сущность, уже отслеживаемая тем же контекстом, сохраняет старый ключ, поэтому выполняйте обновление в новом контексте или сначала отсоедините сущность. И он обходит перехватчики `SaveChanges` и логику аудита, что, вероятно, и нужно, но должно быть осознанным выбором.

## Подводные камни и похожие ошибки

**Установка `IsModified` для ключа выбрасывает исключение сразу.** Код, который перебирает `entry.Properties` и устанавливает `IsModified = true` для всех свойств, падает на первом же свойстве ключа. `db.Entry(blog).Property(b => b.Id).IsModified = true` выбросило исключение в воспроизведении без какого-либо вызова `SaveChanges`. Пропускайте свойства, для которых `p.Metadata.IsKey()` возвращает true. Установка всей записи в `EntityState.Modified` допустима (в воспроизведении она сохранилась без ошибок), потому что EF помечает только свойства, не входящие в ключ.

**`Update()` для отсоединённого объекта с другим id это другая ошибка.** `db.Update(new Blog { Id = 2, ... })` не пытается изменить ключ. Он отправляет `UPDATE ... WHERE Id = 2`, и если такой строки нет, вы получите `DbUpdateConcurrencyException: The database operation was expected to affect 1 row(s), but actually affected 0 row(s)`. Та же коренная ошибка (неверный id от клиента), другой симптом.

**Два экземпляра с одним ключом это тоже другая ошибка.** Если вы исправляете эту ошибку, присоединяя второй объект с новым ключом, пока старый всё ещё отслеживается, вы можете столкнуться вместо этого с [ошибкой "cannot be tracked because another instance with the same key value is already being tracked"](/ru/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/). [Проверка, отслеживается ли уже сущность](/ru/2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core/) перед присоединением позволяет избежать обеих.

**Изменение ключа у сущности в состоянии `Added` допустимо.** До первого `SaveChanges` ключ ещё не "сохранён", поэтому `var b = new Blog { Id = 5 }; db.Add(b); b.Id = 6;` вставит строку с `Id = 6`. Это важно для кода, который назначает временный id и исправляет его перед сохранением.

## Связанные материалы

Если вы меняете ключи набор-ориентированными командами, разбор [ExecuteUpdate и ExecuteDelete для массовых записей](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) описывает API и его взаимодействие с отслеживаемыми сущностями, а сравнение [ExecuteUpdate и загрузки сущностей с вызовом SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) объясняет, когда уместен каждый из подходов. Когда удаляющая часть смены ключа падает, потому что дочерние строки всё ещё ссылаются на старую, см. [исправление ошибки foreign key constraint failed](/ru/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/). Чтобы увидеть, какие именно записи будут сохранены, до того как сработает исключение, проще всего вывести их с помощью [`ChangeTracker.GetEntriesForState`](/ru/2026/04/efcore-11-changetracker-getentriesforstate/).

## Источники

- [Ресурсная строка `KeyReadOnly`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx) и [`InternalEntryBase.SetPropertyModified`](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs), исходный код dotnet/efcore.
- [Support modifying the value of primary or alternate key properties, dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), открытый запрос на возможность.
- [Keys: alternate keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys#alternate-keys), документация EF Core.
- [Indexes: index uniqueness](https://learn.microsoft.com/en-us/ef/core/modeling/indexes#index-uniqueness), документация EF Core.
- [Change detection and notifications](https://learn.microsoft.com/en-us/ef/core/change-tracking/change-detection), документация EF Core.
- [`PropertyValues.SetValues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete), документация EF Core.
