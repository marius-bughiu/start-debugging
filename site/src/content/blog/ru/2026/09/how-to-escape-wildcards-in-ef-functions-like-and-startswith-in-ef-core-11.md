---
title: "Как экранировать подстановочные символы % и _ в запросах с EF.Functions.Like и StartsWith в EF Core 11"
description: "StartsWith, EndsWith и Contains в EF Core 11 уже сами экранируют % и _, а EF.Functions.Like этого не делает. Разбираем SQL, который генерирует EF, переиспользуемый помощник для экранирования и перегрузку с escapeCharacter, благодаря которой всё работает в SQL Server, SQLite и PostgreSQL."
pubDate: 2026-09-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "linq"
lang: "ru"
translationOf: "2026/09/how-to-escape-wildcards-in-ef-functions-like-and-startswith-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

**Коротко:** в EF Core 11 для `string.StartsWith`, `EndsWith` и `Contains` ничего экранировать не нужно. EF сам переписывает искомое значение в шаблон вида `50\%%` и добавляет `ESCAPE N'\'`. С `EF.Functions.Like` всё иначе: шаблон передаётся как есть, поэтому пользователь, введший `50%` или `a_b`, получит совпадения по подстановочным символам. Экранируйте пользовательскую часть сами (сначала обратную косую черту, затем `%`, `_`, а в SQL Server ещё и `[`) и вызывайте перегрузку с тремя аргументами, `EF.Functions.Like(p.Name, pattern, "\\")`. Если экранировать, но забыть третий аргумент, SQL Server и SQLite воспримут обратные косые черты как обычные символы, и запрос молча ничего не вернёт.

Всё описанное ниже измерено на .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`) с `Microsoft.EntityFrameworkCore.SqlServer` и `Microsoft.EntityFrameworkCore.Sqlite` `11.0.0-rc.1.26425.128`. Вывод для SQL Server получен через `ToQueryString()`. Запросы к SQLite действительно выполнялись на базе данных в памяти, так что списки строк представляют собой реальные результаты.

## Почему знак процента в строке поиска возвращает не те строки

У SQL `LIKE` есть собственный маленький язык шаблонов. Для SQL Server [справочник по `LIKE`](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql) определяет четыре подстановочных символа: `%` (любая последовательность символов), `_` (любой одиночный символ), `[abc]` (набор или диапазон символов) и `[^abc]` (исключающий набор). В SQLite и PostgreSQL есть только `%` и `_`. Любой из этих символов в поисковом запросе меняет смысл запроса.

Поиск товаров, собирающий шаблон конкатенацией строк, сразу демонстрирует проблему:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite in-memory
var term = "50%";   // what the user typed
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, "%" + term + "%"))
    .Select(p => p.Name)
    .ToListAsync();
```

Если в таблице есть строки `50% off sale`, `500 widgets`, `done 50%` и `done 500`, этот запрос вернёт **все четыре**. Шаблон получается `%50%%`, что означает "содержит 50", и введённый пользователем знак процента теряется. Подчёркивание работает так же: поиск `a_b` через `$"%{term}%"` нашёл и `a_b adapter`, и `axb adapter`. В SQL Server символ `[` в запросе добавляет третий подстановочный символ: `[x]` представляет собой класс символов, совпадающий с одиночным символом `x`, поэтому поиск `[x]` превращается в `%[x]%` и находит все имена, содержащие `x`.

Это не SQL-инъекция. Значение по-прежнему передаётся как параметр (`DECLARE @p nvarchar(4000) = N'%50%%'`), так что выйти за пределы строки никто не сможет. Проблема в том, что шаблон означает не то, о чём просил пользователь, и при этом никакой ошибки не возникает.

## Что EF Core 11 уже экранирует за вас

Прежде чем писать помощник для экранирования, проверьте, нужен ли он вообще. Обычные строковые методы LINQ обрабатываются за вас. Вот что EF Core 11 RC 1 генерирует для SQL Server, когда искомое значение представляет собой захваченную переменную:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer
var term = "50%";
var q = db.Products.Where(p => p.Name.StartsWith(term));
Console.WriteLine(q.ToQueryString());
```

```sql
DECLARE @term_startswith nvarchar(4000) = N'50\%%';

SELECT [p].[Id], [p].[Name], [p].[Sku]
FROM [Products] AS [p]
WHERE [p].[Name] LIKE @term_startswith ESCAPE N'\'
```

EF вычислил переменную на клиенте, экранировал её, дописал `%` и отправил результат как новый параметр с именем `@term_startswith`. `EndsWith` даёт `N'%50\%'` в `@term_endswith`, а `Contains` даёт `N'%a\_b%'` в `@under_contains`. Константа вроде `StartsWith("50%")` экранируется так же и встраивается как `LIKE N'50\%%' ESCAPE N'\'`.

Экранирование находится в `SqlServerSqlTranslatingExpressionVisitor`. В [теге `v11.0.0-rc.1.26425.128`](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs) набор специальных символов умещается в одну строку:

```csharp
// EF Core 11.0.0-rc.1, SqlServerSqlTranslatingExpressionVisitor.cs
private static bool IsLikeWildChar(char c)
    => c is '%' or '_' or '['; // See https://docs.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql
```

`EscapeLikePattern` ставит обратную косую черту перед каждым из этих символов и перед любой обратной косой чертой, уже присутствующей в значении. В провайдере SQLite тот же код, только его `IsLikeWildChar` проверяет лишь `%` или `_`, потому что классов в квадратных скобках в SQLite нет.

Две особенности провайдеров могут застать врасплох:

- **SQLite вообще не использует `LIKE` для `Contains`.** Он транслирует `p.Name.Contains(term)` в `instr("p"."Name", @term) > 0`, так что экранирование там не требуется. `StartsWith` и `EndsWith` по-прежнему превращаются в `LIKE ... ESCAPE '\'`.
- **Сравнения столбца со столбцом обходятся без `LIKE`.** `p.Name.StartsWith(p.Sku)` превращается в `LEFT([p].[Name], LEN([p].[Sku])) = [p].[Sku]` в SQL Server и в `substr(...)` в SQLite. Поскольку шаблон становится известен только при чтении строки, экранировать нечего. Комментарий в исходниках EF предупреждает, что такая форма "less efficient than LIKE (i.e. StartsWith does an index scan instead of seek)".

Если вам нужно лишь "начинается с", "заканчивается на" или "содержит" для пользовательского ввода, используйте строковые методы и на этом остановитесь. `EF.Functions.Like` нужен только тогда, когда вам требуются подстановочные символы, расставленные вами самими, например `abc%def`, или когда текст пользователя стоит в середине более крупного шаблона.

## Почему EF.Functions.Like не экранирует ваш ввод

`EF.Functions.Like(matchExpression, pattern)` представляет собой прямое отображение: [страница сопоставлений функций SQL Server](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions) указывает его как `@matchExpression LIKE @pattern`, без какого-либо шага экранирования. Так сделано намеренно. Шаблон и должен содержать подстановочные символы, и EF никак не может узнать, какие `%` поставили вы, а какие пришли от пользователя. Запрос на автоматическое экранирование ввода `Like` в EF, [dotnet/efcore#19118](https://github.com/dotnet/efcore/issues/19118), был закрыт как not planned, и в EF Core 11 по-прежнему нет публичного помощника для экранирования. Нужная вам перегрузка принимает третий аргумент:

```csharp
public static bool Like(this DbFunctions _, string? matchExpression, string? pattern, string? escapeCharacter);
```

Эта перегрузка транслируется в `@matchExpression LIKE @pattern ESCAPE @escapeCharacter`. Таким образом, задача делится на две части: экранировать текст пользователя в C#, а затем сообщить базе данных, какой символ экранирования вы использовали.

## Пошаговое экранирование пользовательского ввода для EF.Functions.Like

1. **Выберите один символ экранирования и используйте его везде.** Обратная косая черта совпадает с тем, что EF использует внутри, поэтому SQL в журналах выглядит одинаково для `StartsWith` и `Like`. Подойдёт любой одиночный символ, лишь бы помощник для экранирования и аргумент `escapeCharacter` совпадали.
2. **Сначала экранируйте сам символ экранирования.** Если сначала экранировать `%`, а потом удвоить каждую обратную косую черту, удвоятся и только что добавленные. Порядок должен быть таким: символ экранирования, затем подстановочные символы.
3. **Экранируйте `%` и `_` во всех провайдерах, а `[` в SQL Server.** Экранирование `[` в других СУБД не вредит: SQLite и PostgreSQL воспринимают экранированный обычный символ как сам этот символ, поэтому один помощник работает во всех трёх.
4. **Добавляйте собственные подстановочные символы после экранирования.** Через помощник проходит только текст пользователя. Символы `%`, которые вы добавляете вокруг него, остаются активными.
5. **Всегда передавайте `escapeCharacter`.** Без него у SQL Server и SQLite вообще нет символа экранирования.

Небольшой статический класс покрывает все пять пунктов:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public static class LikePattern
{
    public const string EscapeCharacter = "\\";

    public static string Escape(string value, char escape = '\\')
    {
        ArgumentNullException.ThrowIfNull(value);
        return value
            .Replace(escape.ToString(), $"{escape}{escape}") // must be first
            .Replace("%", $"{escape}%")
            .Replace("_", $"{escape}_")
            .Replace("[", $"{escape}[");                      // SQL Server bracket classes
    }

    public static string Contains(string value) => $"%{Escape(value)}%";
    public static string StartsWith(string value) => $"{Escape(value)}%";
    public static string EndsWith(string value) => $"%{Escape(value)}";
}
```

Используйте его так:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var term = "a_b";
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, LikePattern.Contains(term), LikePattern.EscapeCharacter))
    .Select(p => p.Name)
    .ToListAsync();
```

В SQLite это даёт `.param set @Contains '%a\_b%'` и `WHERE "p"."Name" LIKE @Contains ESCAPE '\'`, а возвращается только `a_b adapter`. Тот же код для SQL Server генерирует `LIKE @Contains ESCAPE N'\'`. Вот как отработали остальные тестовые случаи:

| Поисковый запрос | Строки при наивном `Like` (SQLite) | Строки при экранированном `Like` (SQLite) |
| --- | --- | --- |
| `50%` | `50% off sale`, `500 widgets`, `done 50%`, `done 500` | `50% off sale`, `done 50%` |
| `a_b` | `a_b adapter`, `axb adapter` | `a_b adapter` |

Экранированная версия также вернула только `[x] marked` для `[x]` (шаблон `%\[x]%`) и только `C:\temp\logs` для `C:\temp` (шаблон `%C:\\temp%`, где обратная косая черта в пути удвоилась и не совпала с `C:tempxlogs`).

Помощник можно вызывать прямо внутри лямбды. Извлечение параметров в EF вычисляет на клиенте любое поддерево, не затрагивающее столбцы, поэтому `LikePattern.Contains(term)` выполняется один раз в .NET, а его результат становится параметром, названным по имени метода (`@Contains`). Ничто в помощнике не обязано быть транслируемым. Если вы предпочитаете читаемые имена параметров в [журналах SQL](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), сначала вычислите шаблон в локальную переменную. `var pattern = LikePattern.Contains(term);` отображается как `@pattern`.

## Забытый escapeCharacter молча возвращает ноль строк

Обнаружив проблему с экранированием, многие совершают следующую типичную ошибку: экранируют запрос, а затем вызывают перегрузку с двумя аргументами:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite -- WRONG
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape("a_b") + "%"));
```

```sql
WHERE "p"."Name" LIKE '%a\_b%'
```

Без предложения `ESCAPE` обратная косая черта становится обычным символом, поэтому база данных ищет буквальное `a\_b` (где `_` по-прежнему подстановочный символ) и ничего не находит. [Документация SQLite по выражениям](https://www.sqlite.org/lang_expr.html#like) прямо говорит, что символа экранирования по умолчанию нет, а справочник SQL Server сообщает, что символ экранирования "has no default". Запрос не падает, он просто возвращает пустой список, из-за чего эту ошибку трудно заметить на ревью кода.

PostgreSQL здесь исключение. Его `LIKE` [считает обратную косую черту символом экранирования по умолчанию](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE), поэтому тот же код там случайно работает. Это худшее сочетание: тесты на локальном PostgreSQL проходят, а в продакшене на SQL Server запрос ничего не возвращает. Явная передача `escapeCharacter` даёт одинаковое поведение во всех трёх СУБД.

## Выбор другого символа экранирования

Обратная косая черта не является особенной для `LIKE`, это просто соглашение. Если ваши данные полны путей Windows или фрагментов регулярных выражений, выберите более редкий символ. Помощник и аргумент должны совпадать:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite
var term = "!%";
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape(term, '!') + "%", "!"));
// .param set @p '%!!!%%'
// WHERE "p"."Name" LIKE @p ESCAPE '!'
// ROWS: Promo!%
```

`!%` превратилось в `!!!%`: буквальный `!` удвоился до `!!`, затем `%` стал `!%`. Аргумент `escapeCharacter` должен состоять ровно из одного символа. Передача `"ab"` транслируется без проблем, но падает при выполнении запроса с ошибкой SQLite `SqliteException: SQLite Error 1: 'ESCAPE expression must be a single character'`. SQL Server тоже его отвергает, поскольку его символ экранирования "must evaluate to only one character". Сделайте его `const`, как это сделано в `LikePattern.EscapeCharacter`, чтобы никто не смог передать неверное значение.

## Подводные камни, не связанные с экранированием

**Чувствительность к регистру определяется базой данных.** В SQL Server то, учитывает ли `LIKE` регистр, зависит от параметров сортировки столбца, и экранирование здесь ни при чём. В SQLite есть ловушка, которая проявилась в эксперименте выше. `StartsWith` превращается в `LIKE`, который SQLite сравнивает без учёта регистра для ASCII, а `Contains` превращается в `instr`, который регистр учитывает. Поиск `50% OFF` через `StartsWith` нашёл `50% off sale`, а `Contains` с тем же запросом не нашёл ничего. Если вы тестируете на SQLite, а разворачиваете на SQL Server, учитывайте, что каждый метод следует своим правилам регистра.

**Ведущий `%` убивает поиск по индексу.** Параметризованный `LIKE @p ESCAPE N'\'`, значение которого начинается с буквального префикса, может использовать индекс в SQL Server. `%term%` не может, экранирован он или нет. Для настоящих требований "искать в любом месте текста" на больших таблицах присмотритесь к полнотекстовому поиску SQL Server (`EF.Functions.Contains` / `FreeText`), вместо того чтобы нагружать `LIKE` ещё больше.

**Одна переменная в двух строковых методах.** В EF Core 8.0.0 была ошибка, из-за которой `b.Name.StartsWith(s) || b.Body.Contains(s)` отправлял шаблон `Contains` в оба сравнения ([dotnet/efcore#32432](https://github.com/dotnet/efcore/issues/32432), исправлено в 8.0.2). EF Core 11 генерирует два отдельных параметра, `@term_startswith = N'50\%%'` и `@term_contains = N'%50\%%'`. Если вы всё ещё на 8.0.0 или 8.0.1, обновите пакет.

**Перегрузки со `StringComparison` не транслируются.** `p.Name.StartsWith(term, StringComparison.OrdinalIgnoreCase)` выбрасывает `InvalidOperationException: The LINQ expression ... could not be translated` в обоих провайдерах в RC 1. [Руководство по ошибкам трансляции](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) описывает, как переписать такие запросы. В этом случае ответ либо в обычной перегрузке плюс параметры сортировки без учёта регистра, либо в `EF.Functions.Collate`.

**Скомпилированные запросы работают.** И автоматическое экранирование в `StartsWith`, и помощник `LikePattern` порождают обычные параметры, поэтому они работают с `EF.CompileAsyncQuery`. Экранирование происходит при каждом выполнении, а не при компиляции запроса. Загляните в статью о [скомпилированных запросах для горячих путей](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), если одна из конечных точек поиска ваша.

**Агенты и инструменты, строящие фильтры.** Если инструмент LLM или MCP-сервер превращает свободный текст в вызовы `EF.Functions.Like`, как в [примере EF Core через MCP](/2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp/), обращайтесь с аргументами модели как с любым другим пользовательским вводом и пропускайте их через тот же помощник.

## Выбор подходящего инструмента для каждого поиска

- Точное совпадение префикса, суффикса или подстроки для пользовательского ввода: `StartsWith` / `EndsWith` / `Contains`. EF Core 11 экранирует его за вас.
- Шаблон с подстановочными символами под вашим контролем вокруг пользовательского текста: `EF.Functions.Like(col, LikePattern.Contains(term), LikePattern.EscapeCharacter)`.
- Шаблон, который пользователь сознательно пишет сам: `EF.Functions.Like` с двумя аргументами, но проверяйте ввод и подумайте, что делает одиночная `[` в SQL Server.
- Текстовый поиск с ранжированием по релевантности: полнотекстовый поиск, а не `LIKE`.

Перед выпуском один раз проверьте сгенерированный SQL для каждого целевого провайдера. `ToQueryString()` занимает одну строку, и он поймал бы каждую ошибку из этой статьи раньше, чем продакшен.

### Что почитать дальше

- [Как журналировать SQL, который генерирует EF Core 11](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Исправление: "The LINQ expression could not be translated" в EF Core 11](/ru/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Как использовать скомпилированные запросы в EF Core для горячих путей](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Как хранить enum в виде строки в EF Core 11 с помощью конвертера значений](/ru/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)

### Источники

- [LIKE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql), Microsoft Learn
- [Сопоставления функций, провайдер SQL Server](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions), документация EF Core
- [`SqlServerSqlTranslatingExpressionVisitor.cs` в v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs), dotnet/efcore
- [dotnet/efcore#19118: Escape provider-specific symbols in user input when using EF.Functions.Like](https://github.com/dotnet/efcore/issues/19118)
- [dotnet/efcore#32432: Incorrect parameter rewriting for StartsWith/EndsWith/Contains](https://github.com/dotnet/efcore/issues/32432)
- [SQLite: оператор LIKE](https://www.sqlite.org/lang_expr.html#like)
- [PostgreSQL: сопоставление с шаблоном через LIKE](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE)
