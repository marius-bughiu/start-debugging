---
title: "Queryable Encryption и векторный поиск в провайдере MongoDB EF Core (и почему это важно для .NET 9 и .NET 10)"
description: "Провайдер MongoDB EF Core теперь поддерживает Queryable Encryption и векторный поиск. Что это значит для приложений на .NET 9 и .NET 10, уже использующих EF Core."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/01/queryable-encryption-vector-search-in-the-mongodb-ef-core-provider-and-why-it-matters-for-net-9-and-net-10"
translatedBy: "claude"
translationDate: 2026-04-30
---
7 января 2026 года Microsoft опубликовала приятное обновление, в котором безопасность встречается с поиском: провайдер MongoDB EF Core теперь поддерживает **Queryable Encryption** (равенство и диапазон) и **векторный поиск** через LINQ-поверхность в стиле EF Core. Если ваше приложение на .NET 9 или .NET 10 уже свободно говорит на EF Core, это одна из тех функций, которые могут уменьшить количество "специального MongoDB-кода", протекающего в ваш доменный слой.

### Зашифрованные запросы, которые по-прежнему похожи на LINQ

Queryable Encryption интересна тем, что это не просто "шифрование на диске". Суть в том, что вы по-прежнему можете выражать предикаты _равенства_ и _диапазона_, оставляя чувствительные поля зашифрованными.

Маппинг задаётся явно в `OnModelCreating`. В посте показана конфигурация шифрования так:

```cs
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Employee>(entity =>
    {
        entity.Property(e => e.TaxPayerId)
            .IsEncryptedForEquality(<Your Data Encryption Key GUID>));

        entity.Property(e => e.Salary)
            .HasBsonRepresentation(BsonType.Decimal128)
            // Salaries from 0 to 10 million, no decimal place precision
            .IsEncryptedForRange(0m, 10000000m, 0,
                <Your Data Encryption Key GUID>));              
    });
}
```

После маппинга запросы читаются как обычные запросы EF Core:

```cs
// Encrypted Equality Query
var specificEmployee = db.Employees.Where(e => e.TaxPayerId == "45678");

// Encrypted Range Query
var seniorEmployees = db.Employees.Where(e => e.Salary >= 100000m && e.Salary < 200000m);
```

Главный выигрыш -- архитектурный: намерение запроса остаётся видимым в код-ревью (кто фильтрует по зарплате, кто сопоставляет по налоговому идентификатору) без того, чтобы по приложению расползалась ad hoc-обвязка шифрования.

### Векторный поиск из вашего DbContext

Векторный поиск появляется повсюду, потому что поиск смещается от совпадений по ключевым словам к совпадениям по сходству. Провайдер добавляет маппинг для векторных полей и API запроса векторного поиска.

Из поста DevBlogs: вы маппите массив float как бинарный вектор:

```cs
b.Property(e => e.PlotEmbedding)
   .HasElementName("plot_embedding_voyage_3_large")
   .HasBinaryVectorDataType(BinaryVectorDataType.Float32);

// OR in the model:
[BinaryVector(BinaryVectorDataType.Float32)]
public float[]? PlotEmbedding { get; set; }
```

Затем можно делать запрос по сходству:

```cs
var similarMovies = await db.Movies.VectorSearch(
        e => e.PlotEmbedding,
        myCustom.PlotEmbedding,
        limit: 10)
    .ToListAsync();
```

Если вы строите на .NET 9 или .NET 10, это позволяет держать логику "рекомендаций/поиска" ближе к существующим паттернам EF Core, при меньшем числе кастомных пайплайнов запросов, которые приходится сопровождать.

Если хочется полного контекста и деталей провайдера, прочитайте оригинальный пост: [Secure and Intelligent: Queryable Encryption and Vector Search in MongoDB EF Core Provider](https://devblogs.microsoft.com/dotnet/mongodb-efcore-provider-queryable-encryption-vector-search/).
