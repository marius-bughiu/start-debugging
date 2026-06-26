---
title: "Исправление: FOREIGN KEY constraint failed при удалении сущности в EF Core 11"
description: "EF Core выбрасывает FOREIGN KEY constraint failed, потому что у родителя ещё есть зависимые строки, которые база данных отказывается оставлять сиротами. Загрузите дочерние записи, сделайте связь необязательной или настройте OnDelete."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ru"
translationOf: "2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-26
---

Решение: вы удаляете строку-принципал (родителя), на которую всё ещё указывают зависимые строки (дочерние), и база данных отказывается оставлять их сиротами. Есть три реальных варианта, по порядку: загрузить зависимые записи в контекст перед `SaveChanges`, чтобы EF Core мог сам выполнить каскадное удаление; сделать связь необязательной (внешний ключ, допускающий null), чтобы внешний ключ дочерних записей можно было обнулить; либо настроить `OnDelete(DeleteBehavior.Cascade)` и пересоздать схему, чтобы база данных удаляла дочерние записи за вас. Выберите тот, который соответствует тому, что должно произойти с дочерними записями.

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Microsoft.Data.Sqlite.SqliteException (0x80004005): SQLite Error 19: 'FOREIGN KEY constraint failed'.
   at Microsoft.Data.Sqlite.SqliteException.ThrowExceptionForRC(int rc, sqlite3 db)
   at Microsoft.EntityFrameworkCore.Update.ReaderModificationCommandBatch.ExecuteAsync(...)
```

Это ошибка базы данных времени выполнения, возникающая в `SaveChanges`/`SaveChangesAsync` и обёрнутая в `DbUpdateException`. Точная формулировка принадлежит провайдеру SQLite. На SQL Server та же ситуация даёт `The DELETE statement conflicted with the REFERENCE constraint "FK_..."`, на PostgreSQL это `23503: update or delete on table "..." violates foreign key constraint`, а на MySQL это `Cannot delete or update a parent row: a foreign key constraint fails`. Текст разный, причина одна и та же. Это руководство написано для .NET 11, C# 14, `Microsoft.EntityFrameworkCore` 11.0.0 и `Microsoft.Data.Sqlite` 11.0.0. Поведение не менялось с EF Core 7, поэтому оно применимо начиная с того выпуска.

## Почему база данных отказывается выполнять удаление

EF Core моделирует связь через внешний ключ: зависимая строка хранит первичный ключ своего принципала. Когда вы удаляете принципал, каждый внешний ключ зависимой записи, который на него указывал, теперь ссылается на несуществующую строку. Это нарушение ссылочной целостности, и реляционная база данных пресекает его на уровне ограничения.

Есть только два допустимых выхода, и база данных может выбрать один из них только если вы укажете какой:

1. Удалить и зависимые записи (каскадное удаление).
2. Установить внешний ключ зависимых записей в null (возможно только если столбец допускает null).

Если вы удаляете принципал, не организовав ни то, ни другое, база данных выбрасывает ошибку. Причина, по которой это всплывает так часто, в том, что *поведение по умолчанию* в EF Core зависит от того, является ли связь обязательной или необязательной, и от того, загружены ли зависимые записи в контекст в момент вызова `SaveChanges`. Эти два переключателя определяют, наводит ли EF Core порядок в памяти перед отправкой SQL, или передаёт проблему напрямую базе данных, которая затем её отклоняет.

Тонкий усугубляющий фактор: SQLite вообще не обеспечивает соблюдение внешних ключей без `PRAGMA foreign_keys = ON`, который `Microsoft.Data.Sqlite` устанавливает по умолчанию. Разработчики, тестировавшие на старой конфигурации или на in-memory провайдере EF Core (который не обеспечивает соблюдение ограничений), часто удивляются, когда реальная база данных SQLite или SQL Server впервые отклоняет удаление.

## Минимальное воспроизведение

Обязательная связь "один ко многим": у `Blog` много `Post`, и `Post.BlogId` не допускает null, поэтому связь обязательная.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, Microsoft.Data.Sqlite 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = new();
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }            // non-nullable => required relationship
    public Blog Blog { get; set; } = null!;
}

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

Теперь удалим блог, у которого есть посты, не загружая эти посты:

```csharp
// .NET 11, EF Core 11.0.0 -- throws DbUpdateException -> "FOREIGN KEY constraint failed"
var blog = await db.Blogs.SingleAsync(b => b.Id == 1);   // no Include(b => b.Posts)
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

EF Core знает только о блоге. Он выдаёт один-единственный `DELETE FROM Blogs WHERE Id = 1`. Посты всё ещё ссылаются на блог 1, и база данных прерывает выполнение оператора. Ошибка корректна: вы попросили удалить строку, от которой зависят другие строки, и не сказали, что с ними делать.

Обратите внимание на контраст. При обязательной связи поведение удаления по умолчанию равно `Cascade`, но "каскад" можно применить двумя способами: силами EF Core (в памяти, требует, чтобы дочерние записи были загружены) или силами базы данных (требует `ON DELETE CASCADE` на ограничении). Если схема была создана без `ON DELETE CASCADE`, а дочерние записи не загружены, не срабатывает ни один механизм, и вы получаете эту ошибку.

## Решение 1: загрузить зависимые записи, чтобы EF Core выполнил каскад

Самое переносимое решение, и единственное, которое работает независимо от того, как было создано ограничение базы данных. Подтяните дочерние записи в контекст с помощью `Include`, и EF Core выдаст для них операторы `DELETE` перед удалением родителя.

```csharp
// .NET 11, EF Core 11.0.0 -- EF Core deletes posts, then the blog
var blog = await db.Blogs
    .Include(b => b.Posts)
    .SingleAsync(b => b.Id == 1);

db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

Когда посты отслеживаются, EF Core видит, что удаление блога разрывает обязательную связь, применяет каскад в памяти и упорядочивает SQL правильно: сначала удалить посты, затем блог. Это работает потому, что EF Core "всегда применяет настроенное каскадное поведение к отслеживаемым сущностям", независимо от схемы базы данных.

Цена очевидна: вы загружаете каждую зависимую строку в память только для того, чтобы её удалить. Для блога с десятью постами это нормально. Для родителя со ста тысячами дочерних записей это проблема памяти и сетевых обращений, и здесь нужно Решение 3 (каскад на стороне базы данных) или множественное массовое удаление. В EF Core 11 [`ExecuteDelete` для массовых записей](/ru/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) удаляет дочерние записи одним оператором SQL без их материализации, что является правильным инструментом, когда набор дочерних записей велик. Только помните, что `ExecuteDelete` обходит трекер изменений, поэтому вы удаляете дочерние записи явно перед родителем, а не полагаетесь на каскад.

## Решение 2: сделать связь необязательной, чтобы внешний ключ можно было обнулить

Используйте это, когда дочерняя запись может законно существовать без родителя. Сделайте внешний ключ допускающим null, и поведение по умолчанию для необязательной связи станет `ClientSetNull`: EF Core устанавливает внешний ключ зависимых записей в null вместо их удаления.

```csharp
// .NET 11, EF Core 11.0.0 -- optional relationship
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int? BlogId { get; set; }           // nullable => optional relationship
    public Blog? Blog { get; set; }
}
```

После миграции, делающей столбец `BlogId` допускающим null, удаление блога с загруженными постами порождает `UPDATE Posts SET BlogId = NULL ...` для каждого поста, а затем `DELETE FROM Blogs ...`. Посты выживают, отвязанные от какого-либо блога.

```csharp
// .NET 11, EF Core 11.0.0 -- posts kept, FK set to null
var blog = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

Две оговорки. Во-первых, это смысловое решение, а не трюк для подавления ошибки: делайте связь необязательной только если осиротевшая дочерняя запись действительно допустима в вашей предметной области. `Post` без `Blog` может быть бессмыслицей. Во-вторых, при `ClientSetNull` (по умолчанию) EF Core всё равно нужны загруженные зависимые записи, чтобы обнулить их внешние ключи; если они не загружены, вы снова получите `DbUpdateException`. Чтобы перенести обнуление в базу данных, чтобы оно работало без загрузки, настройте `OnDelete(DeleteBehavior.SetNull)`, который выдаёт `ON DELETE SET NULL` на ограничении.

```csharp
// .NET 11, EF Core 11.0.0 -- database nulls the FK on delete, no need to load children
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.SetNull);
}
```

## Решение 3: настроить базу данных на каскадное удаление

Используйте это, когда дочерние записи должны умирать вместе с родителем и вы не хотите загружать их предварительно. Настройте `DeleteBehavior.Cascade` и создайте или мигрируйте схему так, чтобы ограничение несло `ON DELETE CASCADE`. Тогда база данных сама удалит зависимые записи при удалении принципала.

```csharp
// .NET 11, EF Core 11.0.0 -- ON DELETE CASCADE in the database
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.Cascade);
}
```

Для обязательной связи это уже соглашение по умолчанию, но ограничение несёт `ON DELETE CASCADE` только если база данных была *создана или мигрирована с этой настройкой на месте*. Это ловушка, в которую попадает большинство: они добавляют `OnDelete(Cascade)` (или полагаются на значение по умолчанию), сборка проходит успешно, а удаление всё равно не работает, потому что работающая база данных была создана до настройки каскада, и у существующего ограничения нет каскадного предложения. Конфигурация в `OnModelCreating` меняет модель, а не живую базу данных. Вы должны сгенерировать и применить миграцию:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef migrations add ConfigurePostCascade
dotnet ef database update
```

Убедитесь, что ограничение действительно несёт каскад. На SQLite просмотрите список внешних ключей:

```sql
-- run against the SQLite database file
SELECT * FROM pragma_foreign_key_list('Posts');
-- the "on_delete" column should read CASCADE, not NO ACTION
```

После этого `db.Blogs.Remove(blog); await db.SaveChangesAsync();` удаляет блог без `Include`, и база данных удаляет посты в той же операции.

Одно ограничение платформы, о котором стоит знать, прежде чем хвататься за каскад везде: SQL Server отвергает несколько каскадных путей к одной и той же таблице. Если две обязательные связи каскадно удаляли бы в одну таблицу, создание схемы завершается ошибкой `Introducing FOREIGN KEY constraint '...' on table '...' may cause cycles or multiple cascade paths`. Решение здесь в том, чтобы сделать одну связь необязательной, или установить одной из них `ClientCascade`, чтобы EF Core (а не SQL Server) обрабатывал эту ветвь каскада с загруженными дочерними записями. У SQLite и PostgreSQL такого ограничения нет.

## Варианты, приводящие к той же ошибке

### Самоссылающиеся иерархии (таблицы-деревья)

`Category` с допускающим null `ParentId`, указывающим обратно на `Category`, натыкается на это постоянно. Удаление родительской категории, чьи дочерние записи не загружены, проваливает проверку внешнего ключа. Поскольку SQL Server запрещает самоссылающийся каскад, который мог бы зациклиться, вы обычно вообще не можете полагаться на `ON DELETE CASCADE` здесь; загрузите поддерево и позвольте EF Core удалить его, или удаляйте снизу вверх с помощью `ExecuteDelete`.

### Строки соединительной таблицы "многие ко многим"

При skip-навигации (у `Blog` много `Tag` через неявную соединительную таблицу) удаление `Blog` требует, чтобы сначала ушли строки соединения. EF Core делает это автоматически, когда блог загружен со своими `Tags`, но голый `Remove` без загрузки навигации оставляет строки соединения сиротами, и удаление не срабатывает. Либо загрузите skip-навигацию, либо примените `ExecuteDelete` к строкам соединения. Механика соединительных сущностей рассмотрена в статье [заполнение связи "многие ко многим" в EF Core 11](/ru/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/).

### "На in-memory провайдере работало"

In-memory база данных EF Core не обеспечивает соблюдение внешних ключей или каскадных удалений, поэтому удаление, которое "проходит" в модульном тесте, может провалиться на реальной базе данных SQLite или SQL Server. Это одна из нескольких причин, по которым in-memory провайдер плохо заменяет реляционное поведение; предпочитайте SQLite in-memory или реальную базу данных для тестов пути удаления. См. [мокирование DbContext без нарушения отслеживания изменений](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) для тестовых паттернов с учётом отслеживания и учтите, что правила восстановления связей здесь взаимодействуют с [AsNoTracking против AsNoTrackingWithIdentityResolution](/ru/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/): запрос без отслеживания не позволит EF Core выполнить каскад в памяти, потому что нечего отслеживать для каскада.

### Ошибка срабатывает только после обновления

Если удаление, которое раньше работало, начинает выбрасывать ошибку после перехода на другие версии среды выполнения или провайдера, проверьте, не изменилось ли в снимке вашей модели поведение `DeleteBehavior` по умолчанию или допустимость null у внешнего ключа. Поверхность критических изменений каталогизирована в статье [миграция с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/); сравните ваши сгенерированные миграции, чтобы увидеть, переместилось ли каскадное предложение.

### Удаление находится внутри стратегии выполнения с повторами

Если вы оборачиваете удаление в ручную транзакцию при использовании `EnableRetryOnFailure`, вы можете получить *другое* исключение, которое маскирует это. Это взаимодействие является самостоятельной ошибкой, рассмотренной в статье [стратегия выполнения не поддерживает транзакции, инициированные пользователем](/ru/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/).

## Подтверждение исправления

Воспроизведите удаление на реальном провайдере, а не на in-memory, и понаблюдайте за сгенерированным SQL. Включите подробное журналирование чувствительных данных в разработке, чтобы значения параметров и порядок операторов были видны:

```csharp
// .NET 11, EF Core 11.0.0 -- dev only; never enable sensitive logging in production
var options = new DbContextOptionsBuilder<AppDb>()
    .UseSqlite("Data Source=app.db")
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging()
    .Options;
```

Если исправление сработало, вы увидите либо `DELETE FROM Posts ...` перед `DELETE FROM Blogs ...` (Решение 1 или Решение 3), либо `UPDATE Posts SET BlogId = NULL ...` перед удалением блога (Решение 2). Если вы по-прежнему видите одинокий `DELETE FROM Blogs ...`, за которым следует исключение, то зависимые записи не были ни загружены, ни обработаны базой данных, и вы применили конфигурацию к модели, но не к живой схеме. Перезапустите `dotnet ef database update` и перепроверьте `pragma_foreign_key_list`.

Полезная мысленная модель: эта ошибка это просьба базы данных решить судьбу дочерних записей прежде, чем вы удалите родителя. Удалите их вместе с ним (каскад), сохраните их и разорвите связь (установить null) или подтяните их в контекст, чтобы EF Core мог решать построчно. Ошибка это не вредность EF Core; это ссылочная целостность, делающая ровно свою работу.

## Источники

- [Cascade Delete](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete), документация EF Core, о `DeleteBehavior`, значениях по умолчанию для обязательных и необязательных связей и таблицах поведения "загружено против не загружено".
- [Relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships), документация EF Core, о том, как обязательные и необязательные связи выводятся из допустимости null у внешнего ключа.
- [Microsoft.Data.Sqlite foreign keys](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/foreign-keys), о соблюдении `PRAGMA foreign_keys`.
- [SQLite result and error codes](https://www.sqlite.org/rescode.html), о `SQLITE_CONSTRAINT_FOREIGNKEY` (расширенный код 787).
