---
title: "Нативный столбец json или nvarchar(max) для хранения JSON в SQL Server с EF Core 11"
description: "Используйте нативный тип json в SQL Server 2025 и Azure SQL: благодаря ему EF Core 11 получает JSON_CONTAINS, типизированный JSON_VALUE, обновление на месте через modify() и JSON-индексы. Оставайтесь на nvarchar(max) для SQL Server 2019/2022, устаревших инструментов или схемы, которую нужно уметь откатить."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "json"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

Коротко: если ваша база данных работает на SQL Server 2025 или Azure SQL, храните JSON в нативном типе `json`. С ним EF Core 11 генерирует типизированный `JSON_VALUE(... RETURNING int)`, транслирует `Contains` по примитивной коллекции в `JSON_CONTAINS`, выполняет `ExecuteUpdate` через метод `.modify()` с обновлением на месте и умеет создавать `CREATE JSON INDEX`. Ничего из этого не работает с `nvarchar(max)`. Оставайтесь на `nvarchar(max)`, если у вас SQL Server 2019 или 2022, есть инструменты, читающие столбец напрямую (native-формат bcp, старые ODBC-клиенты), или вам нужно изменение схемы, которое можно откатить: SQL Server не позволяет выполнить `ALTER` столбца `json` обратно в строковый тип.

Всё описанное ниже проверено на `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 с .NET 11 RC 1 SDK (11.0.100-rc.1.26425.128) и C# 14. Поведение на стороне сервера взято из документации SQL Server 2025 (17.x).

## Сравнение в двух словах

| | `json` (нативный) | `nvarchar(max)` |
| --- | --- | --- |
| Доступен в | SQL Server 2025, Azure SQL Database, Azure SQL MI, SQL database in Fabric | Любой версии SQL Server |
| По умолчанию в EF Core 11 при | `UseAzureSql` или `UseCompatibilityLevel(170)` | `UseSqlServer` (уровень по умолчанию 160) |
| Хранение | Разобранный бинарный формат, UTF-8 (`Latin1_General_100_BIN2_UTF8`), до 2 ГБ | Текст UTF-16 |
| Проверка при записи | Всегда; верхний уровень должен быть объектом или массивом | Нет, если не добавить `CHECK (ISJSON(...) = 1)` |
| SQL для скалярного фильтра | `JSON_VALUE(col, '$.x' RETURNING int)` | `CAST(JSON_VALUE(col, '$.x') AS int)` |
| `tags.Contains("x")` | `JSON_CONTAINS(col, N'x') = 1` | `N'x' IN (SELECT ... FROM OPENJSON(col) ...)` |
| `ExecuteUpdate` по одному свойству | `SET [col].modify('$.x', ...)` | `SET col = JSON_MODIFY(col, '$.x', ...)` |
| `CREATE JSON INDEX` | Да (SQL Server 2025, предварительная версия) | Нет |
| Тип параметра, который отправляет EF | `SqlDbType.Json` | `SqlDbType.NVarChar` |
| Обратное преобразование через `ALTER COLUMN` | Не допускается | Неприменимо |
| Что видят старые клиенты | `varchar(max)` или `nvarchar(max)` | `nvarchar(max)` |

## Что меняется, когда EF Core 11 выбирает тип json

EF не принимает решение по базе данных, к которой подключается. Он решает по уровню совместимости, который вы настроили, и делает это на этапе построения модели. Я написал небольшую пробу, которая настраивает одну и ту же модель четырьмя способами и выводит DDL и SQL, а перехватчик подавляет подключение, так что база данных не нужна:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string[] Tags { get; set; } = [];          // primitive collection, always JSON
    public required Shipping Shipping { get; set; }   // complex type mapped with ToJson()
}

public class Shipping
{
    public string City { get; set; } = "";
    public int Priority { get; set; }
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<Order>().ComplexProperty(o => o.Shipping, s => s.ToJson());
```

С обычным `UseSqlServer(connectionString)` EF Core 11 работает на уровне совместимости 160. Это значение по умолчанию изменилось в EF Core 11: EF Core 10 использовал 150. Оба JSON-столбца получаются `nvarchar(max)`:

```sql
-- UseSqlServer, default level 160
CREATE TABLE [Orders] (
    [Id] int NOT NULL,
    [Customer] nvarchar(max) NOT NULL,
    [Tags] nvarchar(max) NOT NULL,
    [Shipping] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Переключитесь на `UseSqlServer(cs, o => o.UseCompatibilityLevel(170))` или на `UseAzureSql(cs)` (где по умолчанию 170), и та же модель даёт `[Tags] json NOT NULL` и `[Shipping] json NOT NULL`. Больше в вашем коде ничего не меняется. Это первое, что нужно усвоить: **переход с `UseSqlServer` на `UseAzureSql` меняет тип столбцов**, хотели вы этого или нет.

Запросы тоже меняются. Вот три самые важные формы LINQ в том виде, в каком они генерируются на каждом уровне:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
ctx.Orders.Where(o => o.Shipping.Priority > 2);
ctx.Orders.Where(o => o.Tags.Contains("gift"));
await ctx.Orders.Where(o => o.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Shipping.Priority, o => o.Shipping.Priority + 1));
```

На уровне 160 (`nvarchar(max)`):

```sql
WHERE CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) > 2

WHERE N'gift' IN (
    SELECT [t].[value]
    FROM OPENJSON([o].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)

UPDATE [o]
SET [o].[Shipping] = JSON_MODIFY([o].[Shipping], '$.Priority', CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

На уровне 170 (`json`):

```sql
WHERE JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) > 2

WHERE JSON_CONTAINS([o].[Tags], N'gift') = 1

UPDATE [o]
SET [Shipping].modify('$.Priority', JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

При записи `SaveChanges` по-прежнему отправляет весь документ при изменении одного свойства (`UPDATE [Orders] SET [Shipping] = @p0`), на обоих уровнях. Разница в параметре: на уровне 170 `Microsoft.Data.SqlClient` 7.0.2, который подтягивает EF Core 11 RC 1, отправляет его как `SqlDbType.Json` вместо `SqlDbType.NVarChar`. Частичное обновление на месте получает только `ExecuteUpdate`. Если хотите перехватить этот SQL в собственном приложении, варианты описаны в статье о [журналировании SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Когда выбирать нативный тип json

- **Вы работаете с Azure SQL Database или Managed Instance.** Там тип общедоступен при политике обновления SQL Server 2025 или Always-up-to-date, и `UseAzureSql` уже выбирает его. Отказ от него лишает вас `JSON_CONTAINS` и типизированного предложения `RETURNING` и ничего не даёт взамен.
- **Вы на SQL Server 2025 и фильтруете по содержимому документов.** `JSON_VALUE`, `JSON_PATH_EXISTS` и `JSON_CONTAINS` могут использовать JSON-индекс, и EF Core 11 теперь умеет создавать его из модели (следующий раздел). С `nvarchar(max)` единственный вариант индексации: вычисляемый столбец для каждого пути.
- **Вы массово обновляете поля внутри документов.** `ExecuteUpdate` превращается в `.modify()`, который, согласно документации Microsoft, обновляет данные на месте, если новое значение помещается: строка не длиннее старой или число того же типа или диапазона. `JSON_MODIFY` над текстом перезаписывает значение.
- **Вы хотите, чтобы база данных отвергала мусор.** Столбец `json` отклоняет всё, что не является корректно сформированным объектом или массивом. С `nvarchar(max)` такая проверка есть, только если вы добавите её сами.

## Когда оставаться на nvarchar(max)

- **Ваш рабочий сервер: SQL Server 2019 или 2022.** Там этого типа нет, и EF использует его только при повышении уровня совместимости, поэтому оставьте уровень по умолчанию 160 или явно задайте 150.
- **Столбец читает что-то помимо EF.** В документации SQL Server по `json` отмечено, что `sp_describe_first_result_set` не сообщает тип `json`. Клиенты на TDS 7.4 и новее видят `varchar(max)` с кодировкой UTF-8, а более старые видят `nvarchar(max)`. Native-формат bcp записывает документ как текст, поэтому для обратной загрузки нужен файл форматирования. Обычно страдают ETL-пакеты с жёстко заданными метаданными столбцов.
- **Вам нужна обратимая миграция.** Выполнить `ALTER` из `nvarchar(max)` в `json` можно, но SQL Server не позволяет с помощью `ALTER TABLE` превратить столбец `json` обратно в строковый или бинарный тип. Метод `Down()`, который EF генерирует для этого преобразования, представляет собой обычный `ALTER COLUMN ... nvarchar(max)`, поэтому откат означает добавление нового столбца, копирование данных и замену вручную.
- **Ваши запросы используют формы, которые тип пока не поддерживает.** В заметке о критическом изменении EF Core 10 упомянута одна из них: `DISTINCT` по JSON-массивам не поддерживается для `json`, и такие запросы завершаются ошибкой.

## Доказательства: что я измерил и чего не измерял

Я не запускал бенчмарк хранения или задержки. В моей тестовой среде нет экземпляра SQL Server 2025, и я не собираюсь приводить цифру ускорения для типа, который я не замерял. Что проба выше действительно показывает для EF Core 11 RC 1:

1. Тип столбца определяется только `UseAzureSql` или уровнем совместимости 170 и выше. `UseSqlServer` по умолчанию использует 160 (подтверждено в `SqlServerOptionsExtension`, где `SqlServerDefaultCompatibilityLevel = 160` и `AzureSqlDefaultCompatibilityLevel = 170`).
2. Каждое различие в трансляции из таблицы выше представляет собой точный сгенерированный SQL, а не пересказ заметок к выпуску.
3. Миграция, которую EF генерирует для перехода с 160 на 170, состоит из одного `ALTER COLUMN` на каждый JSON-столбец (обработка ограничений по умолчанию опущена):

```sql
-- EF Core 11.0.0-rc.1, model diff from level 160 to level 170
ALTER TABLE [Orders] ALTER COLUMN [Tags] json NOT NULL;
ALTER TABLE [Orders] ALTER COLUMN [Shipping] json NOT NULL;
```

Утверждения о хранении и чтении принадлежат Microsoft. В [справочнике по типу данных json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type) сказано, что чтение эффективнее, потому что документ уже разобран, запись может обновлять отдельные значения, а бинарный формат "оптимизирован для сжатия". Измерьте на собственных документах, прежде чем обещать кому-либо цифры. Небольшие плоские документы выигрывают гораздо меньше, чем большие вложенные, по которым вы фильтруете.

## Подвох, который решает за вас: JSON-индексы

EF Core 11 добавляет `HasIndex` по путям внутри сложных типов, отображённых в JSON, что превращается в `CREATE JSON INDEX` из SQL Server 2025. Это самый веский довод в пользу перехода на `json`, и в нём есть ловушка. Вот что вывела проба, когда я добавил индекс в модель выше:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
mb.Entity<Order>().HasIndex("Shipping.City");
```

На уровне 170 вы получаете то, что нужно:

```sql
CREATE JSON INDEX [IX_Orders_Shipping_City] ON [Orders]([Shipping]) FOR (N'$.City');
```

На уровне 160 EF генерирует **точно такую же инструкцию**, хотя только что созданный им столбец имеет тип `nvarchar(max)`. Генератор SQL для миграций не проверяет тип хранения перед записью `CREATE JSON INDEX`. [Справочник по CREATE JSON INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) требует столбец `json`, поэтому такая миграция при применении завершится ошибкой. Именно поэтому в собственном примере Microsoft тип закреплён явно:

```csharp
// .NET 11, EF Core 11 - make the column type independent of the compatibility level
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Contact, b => b.ToJson().HasColumnType("json"));

modelBuilder.Entity<Customer>()
    .HasIndex("Contact.Address.City");
```

Ещё три ограничения идут со стороны SQL. JSON-индексы находятся в предварительной версии и задокументированы только для SQL Server 2025, но не для Azure SQL. Таблице нужен кластеризованный первичный ключ. И индекс можно создать только в автономном режиме, с блокировкой изменения схемы на всё время создания. Планируйте окно миграции соответственно; [рабочий процесс с migrations bundle для продакшена](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) позволяет выполнить её безопасно.

Связанное замечание для Azure SQL: в документации по типу `json` метод `.modify()` всё ещё указан как возможность в предварительной версии, доступная только в SQL Server 2025, но EF генерирует его для каждого столбца `json`, в том числе при `UseAzureSql`. Эту комбинацию я проверить не смог. Прежде чем полагаться на `ExecuteUpdate` в JSON-свойства в Azure SQL, запустите его хотя бы раз на реальной базе данных. Такое несоответствие уже подводило EF: [ошибка `AS JSON` в Azure SQL](/ru/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/) возникала из-за того, что EF генерировал `json` в предложении `OPENJSON`, которое принимает только SQL Server 2025. Это исправили в EF Core 10.0.11.

## Отказ от json: для отдельных столбцов или глобально

Если вы на Azure SQL, но пока не готовы к преобразованию, у вас есть два переключателя. Глобальный понижает уровень совместимости, который предполагает EF:

```csharp
// .NET 11, EF Core 11 - keep every JSON column on nvarchar(max) on Azure SQL
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

При этом отключаются и все остальные трансляции уровня 170, включая `JSON_CONTAINS`. Точечный закрепляет отдельные столбцы и оставляет остальную модель на 170:

```csharp
// .NET 11, EF Core 11 - pin specific columns to text, verified to emit nvarchar(max) at level 170
modelBuilder.Entity<Order>()
    .ComplexProperty(o => o.Shipping, s => s.ToJson().HasColumnType("nvarchar(max)"));
modelBuilder.Entity<Order>()
    .PrimitiveCollection(o => o.Tags).HasColumnType("nvarchar(max)");
```

Чтобы пойти в обратную сторону на существующей базе данных, повысьте уровень, выполните `dotnet ef migrations add ConvertJsonColumns` и прочитайте сгенерированную миграцию, прежде чем применять её. Она затрагивает сразу все JSON-столбцы модели, включая примитивные коллекции, о чём легко забыть, если вы отобразили через `ToJson()` только один сложный тип. О стороне моделирования этого решения рассказывает статья [сложные типы или owned-сущности в EF Core 11](/ru/2026/07/complex-types-vs-owned-entities-in-ef-core-11/): в ней объясняется, почему перед преобразованием стоит перейти именно на отображение `ComplexProperty(...).ToJson()`. `ExecuteUpdate` в JSON работает только со сложными типами.

## Рекомендация ещё раз

Выбирайте `json` в SQL Server 2025 и Azure SQL. Именно туда движется EF Core 11: `JSON_CONTAINS`, типизированный `JSON_VALUE`, `.modify()` и JSON-индексы зависят от этого типа, а `UseAzureSql` уже предполагает его. Явно задавайте `HasColumnType("json")` для каждого JSON-столбца, который вы индексируете, чтобы изменение уровня совместимости никогда не породило миграцию, завершающуюся ошибкой. Оставайтесь на `nvarchar(max)`, если сервер старше 2025, если необработанный столбец читают инструменты помимо EF или если вы пока не можете принять одностороннее изменение схемы. В последнем случае закрепляйте тип для отдельных столбцов, а не понижайте уровень совместимости для всего контекста. О стороне запросов после преобразования продолжает разбор [отображения JSON-столбцов и запросов к ним в EF Core 11](/ru/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/), который начинается там, где заканчивается эта статья.

## Источники

- [json data type (SQL Server 2025, Azure SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type): формат хранения, `modify`, правила преобразования, ограничения
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [What's New in EF Core 11: JSON-индексы, JSON_CONTAINS, уровень совместимости 160 по умолчанию](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: поддержка типа JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Критическое изменение EF Core 10: тип данных json по умолчанию в Azure SQL и уровень совместимости 170](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [Поддержка типа данных JSON в SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/json-data-sql-server)
- [dotnet/efcore#29623: SQL Server, поддержка JSON-индексов](https://github.com/dotnet/efcore/issues/29623)
