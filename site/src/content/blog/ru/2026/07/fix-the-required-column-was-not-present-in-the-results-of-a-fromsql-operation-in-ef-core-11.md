---
title: "Исправление: \"The required column 'X' was not present in the results of a 'FromSql' operation\" в EF Core 11"
description: "EF Core выбрасывает это, когда ваш сырой SQL не возвращает все столбцы, на которые мапится сущность, или имена не совпадают. Верните все сопоставленные столбцы с совпадающими именами или запросите скалярный либо бесключевой тип."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "ru"
translationOf: "2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

EF Core выбрасывает `The required column 'X' was not present in the results of a 'FromSql' operation`, когда сырой SQL, переданный в `FromSql`, `FromSqlRaw` или `FromSqlInterpolated`, не возвращает столбец, на который мапится целевой тип сущности. Материализатор читает результаты по имени сопоставленного столбца, поэтому столбец каждого свойства должен присутствовать в наборе результатов, записанный так, как ожидает EF. Исправьте это, вернув все сопоставленные столбцы (`SELECT *` или явный список с совпадающими псевдонимами), либо, если вам нужно только подмножество или произвольная форма, переключитесь на `Database.SqlQuery<T>` или бесключевой тип сущности вместо полной сущности. Это относится к `Microsoft.EntityFrameworkCore` 11.0 на .NET 11 с C# 14, и правило остаётся тем же начиная с EF Core 3.0.

## Ошибка в контексте

Полное исключение времени выполнения выглядит так:

```
System.InvalidOperationException: The required column 'Description' was not present in the results of a 'FromSql' operation.
   at Microsoft.EntityFrameworkCore.Query.Internal.RelationalCommandCache...
   at lambda_method(Closure, QueryContext, DbDataReader, ResultContext, ...)
```

Тип исключения -- `System.InvalidOperationException`, и оно выбрасывается во время чтения результатов, а не когда вы строите запрос. Это значит, что трассировка стека указывает на конвейер материализации EF Core (`lambda_method` и `RelationalCommandCache`), а не на вашу SQL-строку. Единственная полезная информация -- имя столбца в кавычках: `'Description'`. Это сопоставленный столбец, который EF искал в читателе и не смог найти по имени.

## Почему это происходит

Когда `FromSql` возвращает сопоставленный тип сущности, EF Core читает столбцы не по порядковой позиции. Он читает их по имени. Для каждого свойства сущности он просит `DbDataReader` "дай мне порядковый номер столбца с именем `Description`", и если у читателя нет такого столбца, этот вызов завершается неудачей, а EF выдаёт его как эту ошибку. Документация формулирует ограничение прямо: SQL-запрос должен возвращать данные для всех свойств типа сущности, а имена столбцов в наборе результатов должны совпадать с именами столбцов, на которые сопоставлены свойства.

Три вещи вызывают это, примерно в порядке частоты:

- **В списке SELECT отсутствует столбец.** Вы написали `SELECT Id, Title FROM Articles`, но сущность `Article` также мапит свойство `Description`. EF хочет `Description`, а его нет.
- **Имя столбца не совпадает с сопоставленным именем.** SQL возвращает `article_description` (или выражение без псевдонима, или `Col2` из отсканированной хранимой процедуры), но свойство мапится на столбец `Description`. Тот же сбой, и имя в кавычках в сообщении -- то, которое хотел EF, а не то, что произвёл ваш SQL, поэтому сообщение может казаться вводящим в заблуждение.
- **Отсутствует теневой столбец или столбец owned-типа.** Внешние ключи без CLR-свойства, токены параллелизма `[Timestamp]`/rowversion и столбцы owned-типов -- все они сопоставлены и все обязательны. Их легко забыть, потому что они невидимы в классе сущности.

Это осознанное проектное решение, а не баг. EF6 игнорировал сопоставление свойство-столбец для сырого SQL и сопоставлял по имени свойства нестрого; EF Core сделал это строгим, чтобы сырой запрос сущности вёл себя точно как обычный и мог безопасно отслеживаться, корректироваться и надстраиваться.

## Минимальное воспроизведение

Вот самая маленькая программа, которая это воспроизводит. Сущность мапит три столбца; SQL возвращает два:

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new BlogContext();

// Throws: 'Description' is mapped but not in the SELECT list.
var articles = await db.Articles
    .FromSql($"SELECT Id, Title FROM Articles")
    .ToListAsync();

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
}

public class BlogContext : DbContext
{
    public DbSet<Article> Articles => Set<Article>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Blog;Trusted_Connection=True;Encrypt=False");
}
```

EF Core мапит `Article` на три столбца: `Id`, `Title`, `Description`. У читателя, возвращающегося из `SELECT Id, Title`, есть только два из них, поэтому материализация завершается сбоем в момент, когда `ToListAsync` начинает читать строки, с `'Description' was not present`.

## Исправление в деталях

Исправления упорядочены от лучшего (вернуть настоящую, полную сущность) до альтернатив, к которым вы прибегаете, когда полная сущность вам на самом деле не нужна.

### 1. Верните каждый сопоставленный столбец

Если вы хотите получить отслеживаемые сущности `Article`, SQL должен произвести каждый столбец, который мапит сущность. Простейшая корректная форма -- `SELECT *` к таблице (или к представлению/TVF, столбцы которых совпадают):

```csharp
// .NET 11, EF Core 11 -- returns Id, Title, Description: all three mapped columns
var articles = await db.Articles
    .FromSql($"SELECT * FROM Articles")
    .ToListAsync();
```

`SELECT *` здесь допустим именно потому, что EF сопоставляет по имени, так что порядок столбцов не важен, а лишние столбцы игнорируются. Если вы предпочитаете явный список (безопаснее против дрейфа схемы и понятнее при code review), перечислите каждый сопоставленный столбец и убедитесь, что ни один не пропущен:

```csharp
// .NET 11, EF Core 11 -- explicit, complete column list
var articles = await db.Articles
    .FromSql($"SELECT Id, Title, Description FROM Articles WHERE Title LIKE {'%' + term + '%'}")
    .ToListAsync();
```

Помните, что "каждый сопоставленный столбец" включает столбцы без очевидного CLR-свойства: теневые внешние ключи, токен параллелизма `RowVersion`, столбцы-дискриминаторы для наследования TPH. Если у вашей сущности есть `[Timestamp] public byte[] RowVersion` или дискриминатор наследования, этот столбец тоже должен быть в наборе результатов.

### 2. Дайте столбцам псевдонимы, чтобы имена совпали

Когда SQL не может использовать сопоставленные имена напрямую, например хранимая процедура или устаревшая таблица, возвращающая `article_desc`, дайте выходным столбцам псевдонимы с именами, которые ожидает EF. Сопоставление нечувствительно к регистру, но имя должно присутствовать:

```csharp
// .NET 11, EF Core 11 -- alias legacy names onto mapped column names
var articles = await db.Articles
    .FromSqlRaw(@"SELECT article_id AS Id,
                         article_title AS Title,
                         article_desc AS Description
                  FROM legacy_articles")
    .ToListAsync();
```

Если вы предпочитаете изменить сопоставление, а не SQL, сопоставьте свойство с реальным именем столбца через `[Column("article_desc")]` или `HasColumnName("article_desc")` в `OnModelCreating`, и тогда сырой SQL, возвращающий `article_desc`, совпадёт без псевдонима. Выберите одну сторону; не боритесь с собой на обеих.

### 3. Запросите скаляр или проекцию через `SqlQuery<T>`

Если вам нужна лишь пара полей, не принуждайте к полной сущности. `Database.SqlQuery<T>` (EF Core 7.0+, всё ещё актуальный API в 11.0) читает произвольный тип без правила "все сопоставленные столбцы". Для одного скалярного столбца:

```csharp
// .NET 11, EF Core 11 -- no entity involved, so no missing-column rule
var titles = await db.Database
    .SqlQuery<string>($"SELECT Title FROM Articles WHERE Id > {minId}")
    .ToListAsync();
```

Для формы из нескольких столбцов объявите простой record, имена свойств которого совпадают со столбцами результата (возможно, с псевдонимами), и запросите его. Этот тип не является частью вашей модели, поэтому EF ничего не требует относительно полноты:

```csharp
// .NET 11, EF Core 11 -- lightweight read model, matched by name
public record ArticleSummary(int Id, string Title);

var summaries = await db.Database
    .SqlQuery<ArticleSummary>($"SELECT Id, Title FROM Articles")
    .ToListAsync();
```

`SqlQuery<T>` никогда не отслеживает результаты, что как раз и нужно для сводки только для чтения. Это правильный инструмент в тот момент, когда вы ловите себя на желании получить частичную сущность.

### 4. Смоделируйте результат как бесключевой тип сущности

Для формы, которую вы переиспользуете по всему приложению, особенно вывода представления или отчётной хранимой процедуры, объявите бесключевой тип сущности. Он участвует в модели (так что вы можете использовать `Include` и в некоторых случаях надстраиваться над ним), но не имеет ключа и никогда не отслеживается. Настройте его через `HasNoKey`:

```csharp
// .NET 11, EF Core 11 -- keyless type mapped to a reporting shape
public class ArticleStat
{
    public string Title { get; set; } = "";
    public int ViewCount { get; set; }
}

// in OnModelCreating:
modelBuilder.Entity<ArticleStat>().HasNoKey().ToView(null);

// query:
var stats = await db.Set<ArticleStat>()
    .FromSql($"SELECT Title, COUNT(*) AS ViewCount FROM Views GROUP BY Title")
    .ToListAsync();
```

Бесключевой тип сущности всё ещё требует присутствия своих собственных сопоставленных столбцов, но этим сопоставлением управляете вы, поэтому вы задаёте его ровно под столбцы, которые возвращает ваш SQL, а не под полную табличную сущность.

## Тонкости и варианты

**Столбец в кавычках -- не тот, которого не хватает в вашем SQL.** Поскольку EF сопоставляет по имени, если ваш SQL возвращает `Desc`, а сущность мапит `Description`, сообщение говорит `'Description' was not present`, а не `'Desc' was unexpected`. Сравните список столбцов, которые ваш запрос реально возвращает, со сопоставленными столбцами сущности и ищите расхождение, а не доверяйте тому, что названный столбец буквально отсутствует. Именно эта путаница отслеживается в [dotnet/efcore issue #33748](https://github.com/dotnet/efcore/issues/33748).

**Отсканированные хранимые процедуры производят `Col1`, `Col2`.** Когда хранимая процедура возвращает вычисляемый столбец без имени (`SELECT COUNT(*)` вместо `SELECT COUNT(*) AS Total`), инструменты обратного проектирования называют его `Col0`, `Col1` и так далее, и тогда сгенерированный тип результата ожидает эти имена. Дайте каждому столбцу явный псевдоним в самой процедуре, и проблема исчезнет у источника.

**Хранимая процедура, проецирующая подмножество.** `EXECUTE dbo.GetArticleTitles`, возвращающая только `Id, Title`, не может материализовать полный `Article`. Не пропускайте её через `context.Articles.FromSql`; пропустите через `Database.SqlQuery<T>` или бесключевой тип, размеченный под то, что возвращает процедура. Помните также, что вы не можете надстраивать LINQ над вызовом хранимой процедуры, поэтому добавьте `AsEnumerable()` сразу после `FromSql`, если нужна дальнейшая работа в памяти.

**Owned-типы и разделение таблицы.** Если `Article` владеет объектом-значением вроде `Address`, хранящимся в той же таблице, столбцы owned-типа являются частью сущности и должны быть в наборе результатов. Их пропуск вызывает ту же ошибку для столбца, о существовании которого вы можете не подозревать. Включите их или разбейте чтение на бесключевую проекцию.

**Работало до обновления с EF6.** EF6 сопоставлял результаты сырого SQL по имени свойства и был нестрог к пропущенным или неправильно названным столбцам. EF Core строг. Если вы переносите кодовую базу через эту границу, это одно из нескольких изменившихся поведений сырого SQL, и оно идёт рука об руку с более широким набором [ломающих изменений, которые действительно кусают при миграции с EF Core 6 на EF Core 11](/ru/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**`NULL` в non-nullable столбце -- это другая ошибка.** Если столбец присутствует, но значение `NULL`, а свойство -- non-nullable тип значения, вы получите `System.Data.SqlTypes.SqlNullValueException` или ошибку материализации о преобразовании null, а не эту. Это проблема данных, а не формы; сделайте свойство nullable или используйте `ISNULL`/`COALESCE` в SQL.

Ментальная модель, которая навсегда убережёт вас от этой ошибки: `FromSql` на `DbSet<T>` -- это обещание вернуть полный, корректно названный `T`. Если вы не можете или не хотите сдержать это обещание, не используйте сущность. Используйте `SqlQuery<T>` для скаляров и ad-hoc record-ов или бесключевой тип для формы, которую вы именуете и переиспользуете. Оставьте `context.Set<T>().FromSql` для случая, когда SQL действительно гидратирует всю сущность целиком.

## Похожее

- [Исправление: "The LINQ expression could not be translated" в EF Core 11](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) -- родственная ошибка, с которой вы сталкиваетесь, идя другим путём и оставаясь в LINQ.
- [Скомпилированные запросы EF Core против сырого SQL против Dapper](/ru/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) взвешивает, когда сырой SQL стоит своих острых углов, с которыми вы только что познакомились.
- [Как сопоставлять и запрашивать JSON-столбцы в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) охватывает ещё один случай, где форма результата и сопоставление сущности должны совпадать.
- [AsNoTracking против AsNoTrackingWithIdentityResolution в EF Core 11](/ru/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) важен, как только ваш сырой запрос сущности работает и вы хотите сделать чтение дешёвым.
- [Как обнаружить запросы N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) стоит просмотреть, когда сырой SQL -- ваш ответ на запрос, который EF сгенерировал плохо.

## Источники

- [Сырые SQL-запросы, документация EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) (см. раздел "Limitations": должны быть возвращены все сопоставленные столбцы, а имена должны совпадать)
- [Бесключевые типы сущностей, документация EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [RelationalDatabaseFacadeExtensions.SqlQuery, справочник API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlquery)
- [dotnet/efcore issue #33748: вводящий в заблуждение текст "missing column" для неправильного столбца](https://github.com/dotnet/efcore/issues/33748)
