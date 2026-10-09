---
title: "Что такое shadow-свойство в EF Core 11 и почему оно появилось в моей миграции?"
description: "Shadow-свойство - это столбец, который EF Core отслеживает без соответствующего CLR-свойства. Почему EF Core 11 их создаёт (отсутствующие FK-свойства, неверно названные FK, несовпадение типов, раздвоенные связи), как заметить столбец вида BlogId1 в миграции, как исправить каждую причину и как использовать shadow-свойства намеренно."
pubDate: 2026-10-09
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "migrations"
  - "relationships"
lang: "ru"
translationOf: "2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration"
translatedBy: "claude"
translationDate: 2026-10-09
---

Коротко: shadow-свойство (теневое свойство) - это свойство, которое существует в модели EF Core и, как правило, в виде столбца в базе данных, но не имеет соответствующего свойства в классе сущности. EF Core 11 создаёт его сам всякий раз, когда связи нужен внешний ключ, а подходящего CLR-свойства он найти не может. Если так происходит потому, что в вашем классе просто нет FK-свойства, shadow-столбец безвреден. Если же это происходит потому, что FK-свойство у вас *есть*, но EF Core не смог его использовать (неверное имя, неверный тип, `[NotMapped]` или связь, настроенная дважды), рядом с нужным столбцом появляется столбец вроде `BlogId1` или `OwnerId`, а исправление состоит в том, чтобы указать EF Core, какое свойство является внешним ключом, через `HasForeignKey`.

Всё ниже выполнялось на `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 с SDK .NET 11 RC1 (11.0.100-rc.1.26425.128), C# 14. Вывод модели и предупреждения скопированы из реальных запусков, а не пересказаны.

## Что EF Core понимает под словом "shadow"

У каждого свойства в модели EF Core есть метаданные: имя, CLR-тип, допустимость null, признак ключа или FK. Для большинства свойств есть ещё и резервный член класса, свойство или поле C#, которое EF Core читает и записывает при материализации сущностей или сохранении изменений. У shadow-свойства метаданные есть, а члена класса нет. Его значение живёт только в отслеживании изменений (change tracker).

Это и есть всё определение, согласно [документации по shadow-свойствам и свойствам-индексаторам](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties). EF Core не интересует, как свойство появилось. Вы можете объявить его намеренно, а можно, чтобы его создали соглашения (conventions) при построении модели. Второй случай и удивляет людей, потому что впервые он становится заметен в миграции, которая добавляет столбец, которого вы не писали.

Увидеть, какие свойства являются shadow-свойствами, можно, выведя модель. `Model.ToDebugString()` помечает их как `(no field, ...)` и `Shadow`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Infrastructure;

using var db = new AppDbContext();
Console.WriteLine(db.Model.ToDebugString(MetadataDebugStringOptions.ShortDefault));
```

Держите эту строчку под рукой. Это самый быстрый способ ответить на вопрос "откуда взялся этот столбец?", не читая снимок миграций.

## Случай 1: у навигации нет FK-свойства (ожидаемо, безвредно)

Самое распространённое shadow-свойство - то, которое EF Core создаёт, когда вы моделируете связь только навигациями:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
}
```

Здесь связь "один ко многим", поэтому таблице `Post` нужен столбец внешнего ключа. У `Post` нет `BlogId`, так что EF Core его придумывает. Отладочное представление показывает его:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    BlogId (no field, int?) Shadow FK Index
    Title (string) Required
  Foreign keys:
    Post {'BlogId'} -> Blog {'Id'} ClientSetNull ToDependent: Posts
```

И сгенерированная таблица:

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "Title" TEXT NOT NULL,
    "BlogId" INTEGER NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id")
);
```

Имя строится по соглашению `<имя навигации или типа principal><имя ключа principal>`, здесь `Blog` + `Id`. Важны две детали. Во-первых, shadow FK имеет тип `int?`, поэтому связь необязательная, а поведение при удалении - `ClientSetNull`, а не `Cascade`. Если вы ожидали обязательную семантику, добавьте настоящее свойство `int BlogId` или вызовите `.IsRequired()` для связи. Во-вторых, EF Core логирует это только на уровне Debug, как `CoreEventId.ShadowPropertyCreated` (событие 10600):

```text
The property 'Post.BlogId' was created in shadow state because there are no eligible CLR members with a matching name.
```

В журнале консоли по умолчанию вы этого не увидите. Так и задумано: это законное моделирование, и во многих кодовых базах значения FK намеренно не выносят в доменные классы.

## Случай 2: у FK-свойства неконвенциональное имя (тихо и неверно)

Именно этот случай даёт "загадочный столбец" в миграции вообще без предупреждения:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class User
{
    public int Id { get; set; }
}

public class Post
{
    public int Id { get; set; }
    public int OwnerUserId { get; set; }
    public User Owner { get; set; } = null!;
}
```

Вы хотели, чтобы `OwnerUserId` был внешним ключом для `Owner`. Соглашение EF Core по поиску FK сопоставляет только имена вида `<имя навигации><имя ключа principal>` (`OwnerId`), `<имя типа principal><имя ключа principal>` (`UserId`) или `<имя типа сущности principal>Id`. `OwnerUserId` не подходит ни под одно из них, поэтому EF Core считает его обычным столбцом `int` и создаёт shadow FK `OwnerId`:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    OwnerId (no field, int) Shadow Required FK Index
    OwnerUserId (int) Required
```

```sql
CREATE TABLE "Posts" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Posts" PRIMARY KEY AUTOINCREMENT,
    "OwnerUserId" INTEGER NOT NULL,
    "OwnerId" INTEGER NOT NULL,
    CONSTRAINT "FK_Posts_User_OwnerId" FOREIGN KEY ("OwnerId") REFERENCES "User" ("Id") ON DELETE CASCADE
);
```

Ваш код присваивает `post.OwnerUserId = 42`, сохраняет, и ничего не связывается. Связь живёт в `OwnerId`, которого ваш код не трогает. EF Core снова логирует только событие `ShadowPropertyCreated` уровня Debug, поэтому первым симптомом обычно становится join, не возвращающий ничего, или разница в миграции, которую кто-то случайно внимательно прочёл.

Исправление - явно назвать FK:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>()
        .HasOne(p => p.Owner)
        .WithMany()
        .HasForeignKey(p => p.OwnerUserId);
}
```

или с помощью аннотации данных на навигации: `[ForeignKey(nameof(OwnerUserId))] public User Owner { get; set; }`. После этого в модели остаётся один FK, `OwnerUserId`, а shadow-столбец исчезает. Если миграция с `OwnerId` уже выехала, следующая миграция удалит `OwnerId` и добавит ограничение FK на `OwnerUserId`. Прежде чем позволить удаление, проверьте, не записывались ли строки через старый столбец.

## Случай 3: у FK-свойства неверный тип (BlogId1)

Теперь знаменитый суффикс `1`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string BlogId { get; set; } = "";   // principal key is int
    public Blog Blog { get; set; } = null!;
}
```

У `BlogId` конвенциональное имя, но это `string`, а `Blog.Id` - `int`. EF Core не может использовать несовместимое свойство как FK. Он также не может назвать shadow-свойство `BlogId`, потому что это имя занято, и делает его уникальным: `BlogId1`. На этот раз EF Core логирует предупреждение (Warning), `CoreEventId.ShadowForeignKeyPropertyCreated` (событие 10625):

```text
warn: CoreEventId.ShadowForeignKeyPropertyCreated[10625]
      The foreign key property 'Post.BlogId1' was created in shadow state because a conflicting property
      with the simple name 'BlogId' exists in the entity type, but is either not mapped, is already used
      for another relationship, or is incompatible with the associated primary key type.
```

Сообщение перечисляет три причины, ведущие к пронумерованному shadow FK. Несовпадение типов - одна из них. Две другие следуют ниже.

## Случай 4: связь настроена дважды (BlogId и BlogId1)

Это происходит из-за Fluent API, который называет только одну сторону связи:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne()                       // no navigation passed
        .HasForeignKey(p => p.BlogId);
}
```

`WithOne()` без аргумента сообщает EF Core: "у этой связи нет навигации на стороне `Post`". Но `Post.Blog` существует, поэтому соглашения строят из неё *вторую* связь. `BlogId` уже занят первой, так что второй достаётся `BlogId1`:

```text
Foreign keys:
  Post {'BlogId'} -> Blog {'Id'} Required Cascade ToDependent: Posts
  Post {'BlogId1'} -> Blog {'Id'} Required Cascade ToPrincipal: Blog
```

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "BlogId" INTEGER NOT NULL,
    "BlogId1" INTEGER NOT NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Post_Blogs_BlogId1" FOREIGN KEY ("BlogId1") REFERENCES "Blogs" ("Id") ON DELETE CASCADE
);
```

Два обязательных FK к одной таблице, и `blog.Posts` с `post.Blog` больше не описывают одну и ту же связь. Исправление - передать навигацию, чтобы оба конца принадлежали одной связи: `.WithOne(p => p.Blog)`. После этого модель снова содержит единственный FK `BlogId` с `Inverse: Posts`.

Полезное отличие: если убрать из этой неверной конфигурации вызов `HasForeignKey(p => p.BlogId)`, EF Core 11 не станет молча создавать `BlogId1`. Вместо этого он выбросит исключение при финализации модели:

```text
System.InvalidOperationException: Both relationships between 'Post' and 'Blog.Posts' and between 'Post.Blog'
and 'Blog' could use {'BlogId'} as the foreign key. To resolve this, configure the foreign key properties
explicitly in 'OnModelCreating' on at least one of the relationships.
```

Поэтому, столкнувшись с этим исключением, не стоит добавлять `HasForeignKey`, пока оно не исчезнет. Так исключение превращается в схему с `BlogId1`, показанную выше. Найдите связь, у которой не хватает навигации, и исправьте её.

## Случай 5: FK-свойство не отображается

Третья причина из предупреждения - свойство, которое EF Core использовать не может:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    [NotMapped] public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}
```

В результате получается таблица только со столбцом `BlogId1` и то же предупреждение 10625. То же самое происходит с `modelBuilder.Entity<Post>().Ignore(p => p.BlogId)`. Если вы хотите, чтобы CLR-свойство было FK, уберите игнорирование. Если оно должно быть неотображаемым вспомогательным, переименуйте его, чтобы оно не совпадало с конвенциональным именем FK.

## Как поймать случайные shadow FK до выпуска

Чтение каждой разницы миграций работает, пока не перестаёт. Два более дешёвых способа защиты.

Превратите предупреждение в исключение. Случаи 3, 4 и 5 вызывают `ShadowForeignKeyPropertyCreated`, и EF Core можно заставить выбрасывать на него исключение:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Diagnostics;

protected override void OnConfiguring(DbContextOptionsBuilder options) => options
    .UseSqlite("Data Source=app.db")
    .ConfigureWarnings(w => w.Throw(CoreEventId.ShadowForeignKeyPropertyCreated));
```

Теперь обращение к `db.Model` завершается ошибкой `An error was generated for warning 'Microsoft.EntityFrameworkCore.Model.Validation.ShadowForeignKeyPropertyCreated'`, а поскольку `dotnet ef migrations add` тоже строит модель, плохая миграция не будет создана. Не делайте то же для `ShadowPropertyCreated`, если у вас нет ни одного намеренного shadow-свойства, потому что оно срабатывает и в безвредном случае 1.

Проверяйте модель в тесте. Случай 2 никогда не вызывает предупреждения, поэтому модульный тест, обходящий модель, - единственная автоматическая сетка безопасности:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, xUnit
[Fact]
public void No_unexpected_shadow_foreign_keys()
{
    using var db = new AppDbContext();
    var allowed = new HashSet<string> { "Post.BlogId" };   // the ones you chose on purpose

    var shadowFks = db.Model.GetEntityTypes()
        .SelectMany(e => e.GetProperties())
        .Where(p => p.IsShadowProperty() && p.IsForeignKey())
        .Select(p => $"{p.DeclaringType.ClrType.Name}.{p.Name}")
        .Where(name => !allowed.Contains(name))
        .ToList();

    Assert.Empty(shadowFks);
}
```

`IsShadowProperty()` и `IsForeignKey()` входят в публичный API метаданных `IReadOnlyProperty`, поэтому доступ к внутренним членам и база данных не требуются.

## Намеренное использование shadow-свойств

Когда вы знаете, что это такое, shadow-свойства становятся чистым инструментом для данных, которым место в таблице, но не в доменном объекте. Классический пример - метки времени аудита:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().Property<DateTime>("LastUpdated");
}

public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<Post>()
                 .Where(e => e.State is EntityState.Added or EntityState.Modified))
    {
        entry.Property("LastUpdated").CurrentValue = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

Класс `Post` остаётся свободным от забот о сохранении, а в таблице появляется столбец `"LastUpdated" TEXT NOT NULL` (в SQLite). Чтение и запись идут через change tracker, `db.Entry(post).Property<DateTime>("LastUpdated").CurrentValue`, а запросы - через `EF.Property`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var recent = await db.Posts
    .Where(p => EF.Property<DateTime>(p, "LastUpdated") > DateTime.UtcNow.AddDays(-1))
    .OrderBy(p => EF.Property<DateTime>(p, "LastUpdated"))
    .ToListAsync();
```

что транслируется в обычную ссылку на столбец:

```sql
SELECT "p"."Id", "p"."LastUpdated", "p"."Title"
FROM "Posts" AS "p"
WHERE "p"."LastUpdated" > rtrim(rtrim(strftime('%Y-%m-%d %H:%M:%f', 'now', CAST(-1.0 AS TEXT) || ' days'), '0'), '.')
```

Если сущностей больше одной, вынесите логику проставления меток в `SaveChangesInterceptor`, а не переопределяйте `SaveChanges` в каждом контексте.

## Подводные камни, о которых стоит знать

- **Значения shadow-свойств теряются при отсоединении.** Значение существует только в change tracker. Запросы с `AsNoTracking()` по-прежнему возвращают shadow-столбцы в SQL, но прочитать их из материализованного объекта нельзя. Если они нужны, проецируйте их явно через `EF.Property` в `Select`.
- **Shadow FK и отсоединённые графы.** Если присоединить `Post` только с заданной навигацией, EF Core заполнит shadow FK из навигации при `SaveChanges`. Если присоединить `Post` без навигации и без FK-свойства, заполнять нечем, и значение нужно задать через `Entry(...).Property("BlogId").CurrentValue`.
- **Исправления с переименованием - это миграции, а не только код.** Исправление случаев 2, 3 или 4 меняет схему. EF Core сгенерирует удаление shadow-столбца. Если в продакшене данные записывались через него, скопируйте их в настоящий столбец FK внутри миграции до удаления.
- **Свойства-индексаторы - родственники, но не то же самое.** Контейнеры свойств (типы сущностей `Dictionary<string, object>`) используют свойства-индексаторы, у которых есть CLR-доступ, индексатор. Они не являются shadow-свойствами, хотя у них тоже нет именованного свойства C#.

## Связанные материалы

- Если shadow-столбец впервые появился как необъяснимая миграция, [исправление "the model for context has pending changes" в EF Core 11](/ru/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) объясняет, как работает разница со снимком.
- Шаблон аудита, сделанный правильно, смотрите в [использовании перехватчиков EF Core 11 для аудита](/ru/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).
- Чтобы увидеть столбец `BlogId1` в реальном SQL, который выдаёт EF Core, [журналирование SQL, генерируемого EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) показывает все варианты.
- Обязательный shadow FK с `Cascade` меняет поведение при удалении; [исправление FOREIGN KEY constraint failed при удалении](/ru/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) объясняет, как EF Core его выбирает.
- Если вы всё равно переименовываете FK, [пользовательские соглашения об именовании ключей, внешних ключей и индексов в EF Core 11](/ru/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) показывают, как сделать это для всей модели.

## Источники

- [Shadow and Indexer Properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), документация EF Core.
- [Foreign and principal keys in relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/foreign-and-principal-keys), документация EF Core, правила именования при поиске FK.
- [CoreEventId.ShadowForeignKeyPropertyCreated](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.coreeventid.shadowforeignkeypropertycreated), справочник API.
- [Microsoft.EntityFrameworkCore 11.0.0-rc.1.26425.128](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore/11.0.0-rc.1.26425.128) на NuGet, версия, использованная для всех запусков в этой статье.
