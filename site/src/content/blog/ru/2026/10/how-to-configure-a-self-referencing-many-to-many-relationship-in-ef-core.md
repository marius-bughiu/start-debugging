---
title: "Как настроить самоссылающуюся связь многие-ко-многим (подписчики и подписки) в EF Core"
description: "Моделируем подписчиков и подписки на одной сущности User в EF Core 11: что строит конвенция, почему SQL Server молча превращает один внешний ключ соединительной таблицы в ClientCascade, как сопоставить явную сущность Follow с временной меткой и как удалить пользователя без ошибок 547 и 1785."
pubDate: 2026-10-24
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "relationships"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-configure-a-self-referencing-many-to-many-relationship-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-24
---

**Короткий ответ:** добавьте в сущность две навигационные коллекции одного и того же типа, `List<User> Followers` и `List<User> Following`, и свяжите их через `HasMany(u => u.Following).WithMany(u => u.Followers)`. EF Core сопоставит это с одной соединительной таблицей с двумя внешними ключами на `Users`. Для реальных проектов дайте соединительной таблице собственный класс (`Follow` с `FollowerId`, `FolloweeId`, `CreatedAt`) через `UsingEntity<Follow>` и сами определите поведение при удалении: SQL Server не разрешает два каскадных внешних ключа из одной таблицы на одного и того же родителя (ошибка 1785), поэтому оставьте `Cascade` с одной стороны, а с другой задайте `ClientCascade`, после чего удаляйте пользователей, сначала выполнив `ExecuteDeleteAsync` для строк соединительной таблицы. Всё ниже проверено на .NET 11 SDK 11.0.100-rc.2, EF Core 11 (`Microsoft.EntityFrameworkCore.SqlServer` и `.Sqlite` 11.0.0-rc.2.26504.105) и C# 14.

Граф подписчиков, это классическая самоссылающаяся связь многие-ко-многим: любой пользователь может подписаться на любое число пользователей, и на любого пользователя может быть подписано любое число людей. Выглядит как две строки маппинга, и с конвенциями EF Core так почти и есть. Проблемы начинаются, когда вы добавляете миграцию для SQL Server, пытаетесь удалить пользователя или хотите знать, *когда* один подписался на другого.

## Что конвенция строит для Followers и Following

Начнём с минимальной модели:

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];
}

public class AppDb : DbContext
{
    public DbSet<User> Users => Set<User>();
}
```

Здесь нет `OnModelCreating`, и всё же EF Core понимает, что `Followers` и `Following` это два конца одной связи многие-ко-многим, потому что это единственные две навигационные коллекции в `User`, которые указывают на `User`. Это тот же механизм, который официальная документация показывает на примере `Person.Parents` и `Person.Children`. Вызов `Database.GenerateCreateScript()` с провайдером SQL Server выводит такую соединительную таблицу:

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, convention-only model
CREATE TABLE [UserUser] (
    [FollowersId] int NOT NULL,
    [FollowingId] int NOT NULL,
    CONSTRAINT [PK_UserUser] PRIMARY KEY ([FollowersId], [FollowingId]),
    CONSTRAINT [FK_UserUser_Users_FollowersId] FOREIGN KEY ([FollowersId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_UserUser_Users_FollowingId] FOREIGN KEY ([FollowingId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_UserUser_FollowingId] ON [UserUser] ([FollowingId]);
```

На трёх моментах в этом выводе стоит остановиться.

Во-первых, имена. Таблица называется `UserUser`, а столбцы названы по навигациям, что читается задом наперёд. Когда Alice (Id 1) добавляет Bob (Id 2) в `alice.Following`, в таблице оказывается строка `FollowersId = 1, FollowingId = 2`. То есть `FollowersId` хранит подписчика, а `FollowingId` того, на кого подписались. Это верно, но через полгода никто, открыв таблицу в SSMS, об этом не догадается.

Во-вторых, только у одного внешнего ключа есть `ON DELETE CASCADE`. В SQLite та же модель даёт каскад на обоих. Разница идёт от `SqlServerOnDeleteConvention`, которая есть у провайдера SQL Server с EF Core 5 ([dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959)). Когда оба внешних ключа соединительной таблицы указывают на одну и ту же таблицу, она оставляет `Cascade` у одного и понижает другой до `DeleteBehavior.ClientCascade`. Какой из них победит, определяется порядковым сравнением строк с именами двух навигаций, а не тем, что вы выбрали бы сознательно. Это видно в модели:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
foreach (var fk in db.Model.FindEntityType("UserUser")!.GetForeignKeys())
    Console.WriteLine($"{fk.Properties[0].Name}: {fk.DeleteBehavior}");

// SQL Server provider:  FollowersId: Cascade, FollowingId: ClientCascade
// SQLite provider:      FollowersId: Cascade, FollowingId: Cascade
```

В-третьих, соединительная сущность это сущность общего типа (shared-type entity) на основе `Dictionary<string, object>`. Столбцу `CreatedAt` там взяться негде, а документация прямо предупреждает не полагаться на этот тип словаря. Если имена столбцов это та же ловушка, что вы встречали и с другими конвенциями, то статья о том, [почему в миграции появилось shadow-свойство](/ru/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/), объясняет, как EF придумывает такие свойства.

## Почему SQL Server требует, чтобы одна сторона не каскадировала

Если бы оба внешних ключа каскадировали, удаление одной строки в `Users` могло бы добраться до одной и той же строки `UserUser` двумя путями (один раз как подписчик, один раз как тот, на кого подписаны). SQL Server этого не допускает и отклоняет `CREATE TABLE` с ошибкой 1785: *Introducing FOREIGN KEY constraint ... may cause cycles or multiple cascade paths. Specify ON DELETE NO ACTION or ON UPDATE NO ACTION, or modify other FOREIGN KEY constraints.*

С моделью только на конвенциях вы эту ошибку не увидите, потому что провайдер уже её обошёл. Она появляется, как только вы берёте соединительную сущность под свой контроль и пишете "очевидную" конфигурацию:

```csharp
// .NET 11, EF Core 11.0.0-rc.2 -- DON'T: explicit Cascade beats the convention
.UsingEntity<Follow>(
    r => r.HasOne<User>().WithMany().HasForeignKey(f => f.FolloweeId).OnDelete(DeleteBehavior.Cascade),
    l => l.HasOne<User>().WithMany().HasForeignKey(f => f.FollowerId).OnDelete(DeleteBehavior.Cascade));
```

Явная конфигурация всегда приоритетнее конвенции, поэтому `SqlServerOnDeleteConvention` отступает, и в сгенерированном DDL теперь `ON DELETE CASCADE` у обоих ограничений. `dotnet ef database update` падает на SQL Server с ошибкой 1785, тогда как та же миграция спокойно проходит на SQLite и PostgreSQL. Из-за этой разницы между провайдерами баг обычно всплывает только в CI или на staging.

Вторая сторона компромисса: что `ClientCascade` значит во время выполнения. Ограничение в базе данных становится `NO ACTION`, а EF Core обещает удалять зависимые строки *только если они отслеживаются*. Если удалить пользователя, у которого строки соединительной таблицы со стороны `ClientCascade` не загружены, SQL Server ответит ошибкой 547 (*The DELETE statement conflicted with the REFERENCE constraint*). В SQLite та же ситуация проявляется как `SQLite Error 19: 'FOREIGN KEY constraint failed'`. Подробнее об этом в разделе об удалении ниже, а общий вариант проблемы разобран в [исправлении FOREIGN KEY constraint failed при удалении сущности](/ru/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/).

## Сопоставляем явную соединительную сущность Follow

Для графа подписчиков почти всегда нужен явный класс соединительной таблицы: он даёт читаемые имена столбцов, место для `CreatedAt` (или `Muted`, `NotificationsEnabled` и так далее) и `DbSet`, по которому можно делать запросы и массовое удаление без загрузки пользователей. Вот полный маппинг по шагам:

1. Добавьте класс `Follow` с `FollowerId`, `FolloweeId`, столбцами полезной нагрузки и ссылочными навигациями на обоих пользователей.
2. Оставьте в `User` пропускающие навигации (`Followers`, `Following`), чтобы повседневный код оставался естественным, и добавьте навигации к соединительной сущности (`FollowerLinks`, `FollowingLinks`) для случаев, когда нужна полезная нагрузка.
3. Свяжите пропускающие навигации через `HasMany(...).WithMany(...)` и передайте `Follow` в `UsingEntity<Follow>`, явно настроив внешний ключ каждой стороны, чтобы ни имя, ни направление не зависели от конвенции.
4. Задайте `Cascade` для одного внешнего ключа и `ClientCascade` для другого, осознанно.
5. Добавьте составной ключ, индекс по второму столбцу ключа, значение по умолчанию для `CreatedAt` и ограничение CHECK, запрещающее подписываться на себя.

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    // skip navigations
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];

    // navigations to the join entity
    public List<Follow> FollowerLinks { get; } = [];   // rows where I am the followee
    public List<Follow> FollowingLinks { get; } = [];  // rows where I am the follower
}

public class Follow
{
    public int FollowerId { get; set; }
    public int FolloweeId { get; set; }
    public DateTime CreatedAt { get; set; }
    public User Follower { get; set; } = null!;
    public User Followee { get; set; } = null!;
}

public class AppDb(DbContextOptions<AppDb> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Follow> Follows => Set<Follow>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>()
            .HasMany(u => u.Following)
            .WithMany(u => u.Followers)
            .UsingEntity<Follow>(
                r => r.HasOne(f => f.Followee).WithMany(u => u.FollowerLinks)
                      .HasForeignKey(f => f.FolloweeId)
                      .OnDelete(DeleteBehavior.Cascade),
                l => l.HasOne(f => f.Follower).WithMany(u => u.FollowingLinks)
                      .HasForeignKey(f => f.FollowerId)
                      .OnDelete(DeleteBehavior.ClientCascade),
                j =>
                {
                    j.ToTable("Follows", t => t.HasCheckConstraint(
                        "CK_Follows_NoSelfFollow", "FollowerId <> FolloweeId"));
                    j.HasKey(f => new { f.FollowerId, f.FolloweeId });
                    j.HasIndex(f => f.FolloweeId);
                    j.Property(f => f.CreatedAt).HasDefaultValueSql("SYSUTCDATETIME()");
                });
    }
}
```

Лямбда `r` настраивает связь с *правой* стороной `HasMany(...).WithMany(...)`, то есть с сущностью, до которой доходят через `Following`, а это тот, на кого подписаны. Лямбда `l` это *левая* сторона, пользователь, которому принадлежит `Following`, то есть подписчик. Если их перепутать, всё компилируется и молча переворачивает весь граф, поэтому я всегда один раз проверяю направление тестом (показан ниже).

DDL для SQL Server, который при этом получается:

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, explicit Follow join entity
CREATE TABLE [Follows] (
    [FollowerId] int NOT NULL,
    [FolloweeId] int NOT NULL,
    [CreatedAt] datetime2 NOT NULL DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT [PK_Follows] PRIMARY KEY ([FollowerId], [FolloweeId]),
    CONSTRAINT [CK_Follows_NoSelfFollow] CHECK (FollowerId <> FolloweeId),
    CONSTRAINT [FK_Follows_Users_FolloweeId] FOREIGN KEY ([FolloweeId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_Follows_Users_FollowerId] FOREIGN KEY ([FollowerId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_Follows_FolloweeId] ON [Follows] ([FolloweeId]);
```

Составной первичный ключ `(FollowerId, FolloweeId)` уже обслуживает запросы "на кого подписан X?". Дополнительный индекс по `FolloweeId` обслуживает "кто подписан на X?", а это запрос, лежащий в основе каждого счётчика подписчиков, поэтому не убирайте его. В SQLite замените `SYSUTCDATETIME()` на `CURRENT_TIMESTAMP`.

## Подписка, отписка и проверка направления

Писать можно как через пропускающую навигацию, так и через соединительную сущность. Через пропускающую навигацию EF сам создаёт строку `Follow`, а `CreatedAt` заполняет база данных:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var dave = await db.Users.Include(u => u.Followers).SingleAsync(u => u.Name == "dave");
var alice = await db.Users.SingleAsync(u => u.Name == "alice");

dave.Followers.Add(alice);   // alice follows dave
await db.SaveChangesAsync();

var row = await db.Follows.SingleAsync(f => f.FollowerId == alice.Id && f.FolloweeId == dave.Id);
// row.FollowerId == alice.Id, row.FolloweeId == dave.Id, row.CreatedAt populated
```

Этот круговой путь и есть мой тест направления: если `FollowerId` возвращается с id Dave, значит лямбды `r` и `l` перепутаны.

В обработчиках запросов, впрочем, загружать пользователя вместе со всей коллекцией подписчиков ради вставки одной строки расточительно. Работайте через соединительную сущность, ей вообще не нужна загрузка:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
db.Follows.Add(new Follow { FollowerId = currentUserId, FolloweeId = targetId });
await db.SaveChangesAsync();

// unfollow, one DELETE statement, no tracking
await db.Follows
    .Where(f => f.FollowerId == currentUserId && f.FolloweeId == targetId)
    .ExecuteDeleteAsync();
```

Оба защитных механизма маппинга срабатывают как настоящие ошибки базы данных. В SQLite подписка на себя падает с `CHECK constraint failed: CK_Follows_NoSelfFollow`, а повторная подписка на того же человека с `UNIQUE constraint failed: Follows.FollowerId, Follows.FolloweeId`. В SQL Server вторая это нарушение первичного ключа (ошибка 2627). При параллельных двойных кликах вы на неё наткнётесь, так что воспринимайте её как "уже подписан", а не как ошибку 500; тот же приём для PostgreSQL описан в [обработке дубликата ключа при параллельной вставке в EF Core](/ru/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

## Запросы: счётчики, взаимные подписки и рекомендации

Пропускающие навигации транслируются в соединения через `Follows`, поэтому для счётчиков коллекции не загружаются:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var profile = await db.Users
    .Where(u => u.Id == userId)
    .Select(u => new { u.Name, Followers = u.Followers.Count, Following = u.Following.Count })
    .SingleAsync();
```

```sql
-- SQL Server, from ToQueryString()
SELECT [u].[Name], (
    SELECT COUNT(*)
    FROM [Follows] AS [f]
    WHERE [u].[Id] = [f].[FolloweeId]) AS [Followers], (
    SELECT COUNT(*)
    FROM [Follows] AS [f0]
    WHERE [u].[Id] = [f0].[FollowerId]) AS [Following]
FROM [Users] AS [u]
WHERE [u].[Id] = @userId
```

"Взаимные подписки" (те, на кого я подписан и кто подписан на меня в ответ) естественно выражаются через пропускающие навигации:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var mutual = await db.Users
    .Where(u => u.Id == userId)
    .SelectMany(u => u.Following.Where(f => f.Following.Any(x => x.Id == userId)))
    .Select(f => f.Name)
    .ToListAsync();
```

Это работает, но генерируемый SQL соединяет `Users` три раза, потому что каждый переход по пропускающей навигации идёт через таблицу пользователей. Для более тяжёлых запросов по графу пишите запросы прямо к `Follows`. Вот "люди, на которых подписаны те, на кого подписан я, и на кого я ещё не подписан", с ранжированием по тому, сколько моих подписок к ним ведёт:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var suggestions = await db.Follows
    .Where(f => db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FollowerId)
             && f.FolloweeId != userId
             && !db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FolloweeId))
    .GroupBy(f => f.Followee.Name)
    .Select(g => new { Name = g.Key, Via = g.Count() })
    .OrderByDescending(x => x.Via)
    .ToListAsync();
```

На примере графа alice -> bob, alice -> carol, bob -> alice, carol -> dave, bob -> dave запрос счётчиков возвращает `{ Name = alice, Followers = 1, Following = 2 }`, взаимные подписки для Alice дают `bob`, а рекомендации возвращают `dave via 2`. Этот запрос компилируется в один `SELECT ... GROUP BY` с двумя подзапросами `EXISTS` и без лишних соединений с пользователями. Для списков подписчиков с постраничным выводом используйте пару `(FolloweeId, CreatedAt)` с [keyset-пагинацией](/ru/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/) вместо `Skip`.

## Удаление пользователя без ошибки 547

Здесь и кусается сторона `ClientCascade`. В маппинге выше строки, где удаляемый пользователь был тем, *на кого подписаны*, уходят через каскад базы данных. Строки, где он был *подписчиком*, зависят от EF Core, а EF удаляет только то, что отслеживает. Я измерил три варианта на SQLite с теми же ограничениями:

```csharp
// .NET 11, EF Core 11.0.0-rc.2

// 1. Join rows on the ClientCascade side NOT loaded -> fails
var bob = await db.Users.SingleAsync(u => u.Name == "bob");
db.Remove(bob);
await db.SaveChangesAsync();
// SQLite: SQLite Error 19: 'FOREIGN KEY constraint failed'
// SQL Server: error 547, DELETE conflicted with the REFERENCE constraint

// 2. Load the ClientCascade side first -> works
var carol = await db.Users.Include(u => u.FollowingLinks).SingleAsync(u => u.Name == "carol");
db.Remove(carol);
await db.SaveChangesAsync();
// EF deletes carol -> dave itself, the database cascade deletes alice -> carol
```

Вариант 2 подходит для административного экрана, но загружать в трекер изменений все строки подписок пользователя с 200 000 подписок ради их удаления нельзя. Подход, который я использую в продакшене, вообще обходит отслеживание и выполняется в одной транзакции:

```csharp
// .NET 11, EF Core 11.0.0-rc.2
// 3. Bulk-delete the join rows, then the user
await using var tx = await db.Database.BeginTransactionAsync();

await db.Follows
    .Where(f => f.FollowerId == userId || f.FolloweeId == userId)
    .ExecuteDeleteAsync();

await db.Users
    .Where(u => u.Id == userId)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

Для Bob в примерном графе это удалило три строки подписок и одного пользователя, оставив только подписки, не затрагивавшие его. Помните, что `ExecuteDeleteAsync` обходит трекер изменений, поэтому все экземпляры `Follow` и `User`, уже отслеживаемые этим контекстом, после этого устаревают. Подробнее компромиссы разобраны в [ExecuteUpdate и ExecuteDelete для массовых записей](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/).

Если приложение удаляет пользователей мягко, то к самому удалению ничего из этого не относится: строка пользователя остаётся, как и строки соединительной таблицы, а в запросах вы сами решаете, считать ли деактивированный аккаунт подписчиком.

## Подводные камни, которые стоит знать до первой миграции

- **Переход от конвенции к явной соединительной сущности переименовывает таблицу.** `UserUser` со столбцами `FollowersId`/`FollowingId` становится `Follows` со столбцами `FollowerId`/`FolloweeId`. Сгенерированная миграция удаляет и пересоздаёт таблицу, и все подписки теряются. Отредактируйте миграцию, используя `RenameTable` и `RenameColumn`, так же как при [переименовании таблицы без потери данных](/ru/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/).
- **Симметричная связь "друзья" имеет другую форму.** С единственной навигацией `List<User> Friends` пары для неё нет. Документация рекомендует сопоставить её как однонаправленную (`HasMany(u => u.Friends).WithMany()`) и самим добавлять каждого человека в коллекцию другого или хранить оба направления двумя строками.
- **Третья навигация `List<User>` молча убирает все.** Добавьте `Blocked` рядом с `Followers` и `Following`, и EF больше не может определить, какие две относятся друг к другу. В EF Core 11 RC 2 исключения нет: `Model.ToDebugString()` показывает `User` только с `Id` и вообще без связей, а коллекции просто никогда не загружаются. Настраивайте каждую пару явно через `HasMany(...).WithMany(...)`, как только появляется третья коллекция того же типа.
- **Для начальных данных о подписках нужна соединительная сущность.** `HasData` не может заполнять пропускающие навигации; задавайте строки `Follow` с фиксированными ключами, как объясняется в [начальных данных для связи многие-ко-многим в EF Core 11](/ru/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/).
- **`Include(u => u.Followers)` для популярного аккаунта это ловушка.** Он материализует всех подписчиков. Вместо этого проецируйте счётчики или листайте страницы через `Follows`.

## Читайте дальше

- [How to seed a many-to-many relationship in EF Core 11](/ru/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [Fix FOREIGN KEY constraint failed when deleting an entity in EF Core 11](/ru/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [What is a shadow property in EF Core 11, and why did one show up in my migration?](/ru/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/)

Источники: [документация EF Core по связям многие-ко-многим](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) (разделы о самоссылающихся и симметричных связях, перегрузки `UsingEntity`), [документация по каскадному удалению](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete) для семантики `ClientCascade`, [исходный код `SqlServerOnDeleteConvention`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Metadata/Conventions/SqlServerOnDeleteConvention.cs) и PR, который её добавил, [dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959), а также документация SQL Server по [каскадной ссылочной целостности](https://learn.microsoft.com/en-us/sql/relational-databases/tables/primary-and-foreign-key-constraints).
