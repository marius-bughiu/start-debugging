---
title: "Как дефолтные nvarchar-параметры Dapper молча убивают ваши индексы SQL Server"
description: "C#-строки, отправленные через Dapper, по умолчанию становятся nvarchar(4000), заставляя SQL Server выполнять implicit conversion и полные scan индекса. Вот как починить через DbType.AnsiString."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "sql-server"
  - "dapper"
  - "performance"
lang: "ru"
translationOf: "2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes"
translatedBy: "claude"
translationDate: 2026-04-24
---

Запрос, который должен занимать миллисекунды, внезапно ползёт. Execution plan показывает index scan вместо seek, а CPU сверхурочно конвертирует каждую row. Виновник? C# `string` параметр, прошедший через Dapper против колонки `varchar`.

Этот issue опять ходит по .NET-комьюнити, и с основанием: он тонкий, распространённый, и может сделать запросы [до 268x медленнее](https://consultwithgriff.com/dapper-nvarchar-implicit-conversion-performance-trap).

## Почему nvarchar(4000) появляется в execution plans

Когда вы передаёте C# string в Dapper через anonymous object, Dapper по умолчанию мапит его на `nvarchar(4000)`:

```csharp
const string sql = "SELECT * FROM Products WHERE ProductCode = @productCode";
var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, new { productCode });
```

Если `ProductCode` - колонка `varchar(50)`, SQL Server видит type mismatch. Unicode `nvarchar` имеет более высокий precedence, чем `varchar`, так что engine применяет `CONVERT_IMPLICIT` на каждой row индекса, чтобы промоутить значение колонки в `nvarchar` перед сравнением.

Это значит никакого index seek. SQL Server сканирует весь индекс, row за row, конвертируя по ходу.

## Обнаружение проблемы

Выдающий признак - в execution plan. Ищите предупреждение на операторе index scan, упоминающее `CONVERT_IMPLICIT`. Также можно проверить:

```sql
SELECT * FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE st.text LIKE '%ProductCode%'
ORDER BY qs.total_worker_time DESC;
```

Высокий `total_worker_time` на простом lookup-запросе - красный флаг.

## Починка через DbType.AnsiString

Фикс прямолинеен: скажите Dapper использовать `DbType.AnsiString` вместо дефолтного `DbType.String`:

```csharp
var parameters = new DynamicParameters();
parameters.Add("productCode", productCode, DbType.AnsiString, size: 50);

var result = await connection.QueryFirstOrDefaultAsync<Product>(
    sql, parameters);
```

Указав `DbType.AnsiString` с правильным размером колонки, сгенерированный параметр точно соответствует типу колонки. SQL Server теперь может использовать index seek, для которого был спроектирован.

## Когда это важнее всего

Маленькие таблицы могут полностью скрыть проблему. Обрыв производительности появляется по мере роста данных: таблица с 100 000 rows может показать 176x замедление, тогда как с миллионом rows ещё хуже. Если используете Dapper с `varchar`-колонками (что распространено в legacy-базах и системах, не нуждающихся в Unicode), проведите аудит типов параметров.

Быстрый project-wide grep по anonymous objects, передаваемым в методы `Query` и `Execute` Dapper, - хорошая отправная точка. Любой `string` параметр, нацеленный на `varchar` колонку, - кандидат на `DbType.AnsiString`.
