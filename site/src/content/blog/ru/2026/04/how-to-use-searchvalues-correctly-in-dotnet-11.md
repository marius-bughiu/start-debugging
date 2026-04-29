---
title: "Как правильно использовать SearchValues<T> в .NET 11"
description: "SearchValues<T> обгоняет IndexOfAny в 5-250 раз, но только если использовать его так, как ожидает среда выполнения. Правило кеширования через static, ловушка StringComparison, когда не стоит и недокументированный трюк инверсии через IndexOfAnyExcept."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "csharp"
  - "searchvalues"
lang: "ru"
translationOf: "2026/04/how-to-use-searchvalues-correctly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

`SearchValues<T>` живёт в `System.Buffers`. Это предварительно вычисленное неизменяемое множество значений, используемое с методами расширения `IndexOfAny`, `IndexOfAnyExcept`, `ContainsAny`, `LastIndexOfAny` и `LastIndexOfAnyExcept` для `ReadOnlySpan<T>`. Правило, которое нарушают в 90% случаев использования, простое: создайте экземпляр `SearchValues<T>` один раз, сохраните в поле `static readonly` и переиспользуйте. Если строить его внутри горячего метода, вы сохраняете все затраты (выбор стратегии SIMD, аллокация bitmap, автомат Aho-Corasick для перегрузки со строками) и теряете всю выгоду. Второе правило: не тянитесь к `SearchValues<T>` для множеств из одного-двух значений. `IndexOf` уже векторизован для тривиальных случаев и работает быстрее.

Этот пост ориентирован на .NET 11 (preview 4) на x64 и ARM64. Перегрузки `SearchValues.Create` для byte и char стабильны с .NET 8. Перегрузка для string (`SearchValues<string>`) стабильна с .NET 9 и не менялась в .NET 10 и .NET 11. Описанное ниже поведение идентично на Windows, Linux и macOS, потому что SIMD-пути кода общие для всех платформ и откатываются на скалярный код только там, где AVX2 / AVX-512 / NEON недоступны.

## Зачем нужен SearchValues

`ReadOnlySpan<char>.IndexOfAny('a', 'b', 'c')` -- одиночный вызов. Среда выполнения не может знать, будет ли следующий вызов использовать тот же набор или другой, поэтому вынуждена выбирать стратегию поиска на месте каждый раз. Для трёх символов JIT встраивает вручную настроенный векторизованный путь, так что накладные расходы малы, но как только набор превышает четыре или пять элементов, `IndexOfAny` откатывается на обобщённый цикл с проверкой принадлежности к hash-set для каждого символа. Этот цикл годится для коротких входов и катастрофичен для длинных.

`SearchValues<T>` отделяет шаг планирования от шага поиска. Когда вы вызываете `SearchValues.Create(needles)`, среда выполнения один раз анализирует искомые значения: образуют ли они непрерывный диапазон? разреженное множество? разделяют ли префиксы (для перегрузки со строками)? Она выбирает одну из нескольких стратегий (bitmap с `Vector256` shuffle, `IndexOfAnyAsciiSearcher`, `ProbabilisticMap`, `Aho-Corasick`, `Teddy`) и зашивает метаданные в экземпляр. Каждый последующий вызов на этом экземпляре пропускает планирование и сразу идёт в выбранное ядро. Для множества из 12 элементов вы обычно увидите ускорение в 5-50 раз по сравнению с соответствующей перегрузкой `IndexOfAny`. Для строковых множеств из 5 и более искомых значений вы увидите 50-250 раз по сравнению с ручным циклом `Contains`.

Эта асимметрия и есть суть: планировать дорого, искать дёшево. Если вы строите свежий `SearchValues<T>` на каждый вызов, вы платите за планировщик, но не амортизируете его.

## Правило кеширования через static

Это канонический шаблон. Обратите внимание на `static readonly`:

```csharp
// .NET 11, C# 14
using System.Buffers;

internal static class CsvScanner
{
    private static readonly SearchValues<char> Delimiters =
        SearchValues.Create(",;\t\r\n\"");

    public static int FindNextDelimiter(ReadOnlySpan<char> input)
    {
        return input.IndexOfAny(Delimiters);
    }
}
```

Неправильный вариант, который я вижу в PR каждую неделю:

```csharp
// .NET 11 -- BROKEN, do not ship
public static int FindNextDelimiter(ReadOnlySpan<char> input)
{
    var delims = SearchValues.Create(",;\t\r\n\"");
    return input.IndexOfAny(delims);
}
```

Выглядит безобидно. Аллоцирует на каждом вызове, и планировщик работает на каждом вызове. Бенчмарки, которые я гонял на .NET 11 preview 4 с помощью `BenchmarkDotNet`:

```
| Method                     | Mean       | Allocated |
|--------------------------- |-----------:|----------:|
| StaticSearchValues_1KB     |    71.4 ns |       0 B |
| RebuiltSearchValues_1KB    |   312.0 ns |     208 B |
| LoopWithIfChain_1KB        |   846.0 ns |       0 B |
```

Аллокация -- более опасная половина. Неудачно поставленный `Create` в горячем пути превращается в постоянный поток мусора, близкого к LOH. На сервисе с 100k запросов в секунду это гигабайты в минуту, давящие на сборщик мусора ради значения, которое стоило бы переиспользовать.

Если вы не можете использовать `static readonly`, потому что искомые значения задаёт пользователь при старте, постройте экземпляр один раз во время инициализации и сохраните его в singleton-сервисе:

```csharp
// .NET 11, C# 14
public sealed class TokenScanner
{
    private readonly SearchValues<string> _tokens;

    public TokenScanner(IEnumerable<string> tokens)
    {
        _tokens = SearchValues.Create(tokens.ToArray(), StringComparison.Ordinal);
    }

    public bool ContainsAny(ReadOnlySpan<char> input) => input.ContainsAny(_tokens);
}
```

Регистрируйте его как singleton во внедрении зависимостей. Не регистрируйте как transient. Transient даёт ту же ловушку перестроения на каждом вызове с лишними шагами.

## Ловушка StringComparison

`SearchValues<string>` (перегрузка для нескольких строк, добавленная в .NET 9) принимает аргумент `StringComparison`:

```csharp
private static readonly SearchValues<string> Forbidden =
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);
```

Поддерживаются всего четыре значения: `Ordinal`, `OrdinalIgnoreCase`, `InvariantCulture` и `InvariantCultureIgnoreCase`. Передадите `CurrentCulture` или `CurrentCultureIgnoreCase` -- конструктор бросит `ArgumentException` при старте. Это правильно: чувствительный к культуре поиск по нескольким строкам пришлось бы аллоцировать на каждый вызов, чтобы учитывать культуру текущего потока, что свело бы на нет всю предварительную обработку.

Два следствия:

- Для ASCII-данных всегда используйте `Ordinal` или `OrdinalIgnoreCase`. Они в 5-10 раз быстрее инвариантных вариантов, потому что среда выполнения переходит к Teddy-ядру, работающему с сырыми байтами. Инвариантные варианты платят за Unicode case-folding даже на чисто ASCII входах.
- Если вам нужна локально-корректная нечувствительность к регистру (турецкая I с точкой, греческая сигма), `SearchValues<string>` -- не ваш инструмент. Откатитесь на `string.Contains(needle, StringComparison.CurrentCultureIgnoreCase)` в цикле и примите эту цену. Локально-чувствительное сопоставление строк фундаментально не векторизуемо.

Перегрузки для `char` и `byte` не имеют параметра `StringComparison`. Они сопоставляют точно. Если вам нужно ASCII-сопоставление без учёта регистра с `SearchValues<char>`, включите оба регистра в множество:

```csharp
// case-insensitive ASCII vowels in .NET 11, C# 14
private static readonly SearchValues<char> Vowels =
    SearchValues.Create("aeiouAEIOU");
```

Дешевле, чем сначала вызывать `ToLowerInvariant` на входе.

## Принадлежность множеству: SearchValues.Contains не то, что вы думаете

`SearchValues<T>` предоставляет метод `Contains(T)`:

```csharp
SearchValues<char> set = SearchValues.Create("abc");
bool isInSet = set.Contains('b'); // true
```

Прочтите внимательно: это проверяет, лежит ли единичное значение в множестве. Эквивалент `HashSet<T>.Contains`, а не поиск подстроки. Люди тянутся к нему, ожидая семантику `string.Contains`, и выкатывают код, который спрашивает "лежит ли символ 'h' в моём множестве запрещённых токенов" вместо "содержит ли мой вход какой-нибудь запрещённый токен". Этот тип ошибки проходит проверку типов и работает.

Правильные вызовы для "содержит ли вход что-то из этого":

- `ReadOnlySpan<char>.ContainsAny(SearchValues<char>)` для множеств char.
- `ReadOnlySpan<char>.ContainsAny(SearchValues<string>)` для множеств string.
- `ReadOnlySpan<byte>.ContainsAny(SearchValues<byte>)` для множеств byte.

Используйте `SearchValues<T>.Contains(value)` только когда у вас действительно одно значение и вам нужен поиск по множеству, например внутри собственного токенизатора, решающего, является ли текущий символ разделителем.

## Трюк инверсии через IndexOfAnyExcept

`IndexOfAnyExcept(SearchValues<T>)` возвращает индекс первого элемента, которого **нет** в множестве. Это способ найти начало значимого содержимого в строке после ведущих пробелов, padding или шума за один SIMD-проход:

```csharp
// .NET 11, C# 14
private static readonly SearchValues<char> WhitespaceAndQuotes =
    SearchValues.Create(" \t\r\n\"'");

public static ReadOnlySpan<char> TrimStart(ReadOnlySpan<char> input)
{
    int firstReal = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    return firstReal < 0 ? ReadOnlySpan<char>.Empty : input[firstReal..];
}
```

Это побеждает `string.TrimStart(' ', '\t', '\r', '\n', '"', '\'')` на входах с длинными ведущими последовательностями, потому что `TrimStart` откатывается на цикл по символам для множеств свыше четырёх. Для типичного случая "снять 64 пробела отступа" ожидайте ускорения в 4-8 раз.

`LastIndexOfAnyExcept` -- правый аналог. Вместе они дают векторизованный `Trim`:

```csharp
public static ReadOnlySpan<char> TrimBoth(ReadOnlySpan<char> input)
{
    int start = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    if (start < 0) return ReadOnlySpan<char>.Empty;

    int end = input.LastIndexOfAnyExcept(WhitespaceAndQuotes);
    return input[start..(end + 1)];
}
```

Два среза, два SIMD-сканирования, ноль аллокаций. Наивная перегрузка `string.Trim(charsToTrim)` в .NET 11 внутри аллоцирует временный массив, даже когда вход не нуждается в обрезке.

## Когда использовать byte вместо char

Для разбора протоколов (HTTP, JSON, ASCII CSV, строки лога) вход часто `ReadOnlySpan<byte>`, а не `ReadOnlySpan<char>`. Построить `SearchValues<byte>` из ASCII-байтовых значений заметно быстрее, чем сначала декодировать в UTF-16:

```csharp
// .NET 11, C# 14 -- HTTP header value sanitiser
private static readonly SearchValues<byte> InvalidHeaderBytes =
    SearchValues.Create([(byte)'\0', (byte)'\r', (byte)'\n', (byte)'\t']);

public static bool IsValidHeaderValue(ReadOnlySpan<byte> value)
{
    return value.IndexOfAny(InvalidHeaderBytes) < 0;
}
```

Байтовый путь тянет 32 байта за цикл AVX2 против 16 char; на железе с AVX-512 -- 64 байта против 32 char. Для ASCII-данных вы удваиваете пропускную способность, пропуская крюк через UTF-16.

Компилятор не предупредит, если вы случайно используете `char`-кодпоинты выше 127 так, что это сломается. Но планировщик SearchValues намеренно выходит на медленный путь, когда множество char выходит за пределы BMP-ASCII диапазона со смешанными bidi-свойствами. Если ваш бенчмарк говорит "это стало медленнее, чем я ожидал", проверьте, не положили ли вы не-ASCII символ в множество, которое предполагалось чисто ASCII.

## Когда НЕ использовать SearchValues

Короткий список случаев, где правильный ответ -- "не стоит":

- **Одно искомое значение**. `span.IndexOf('x')` уже векторизован. `SearchValues.Create("x")` добавляет накладные расходы.
- **Два-три char-значения, вызываемые редко**. `span.IndexOfAny('a', 'b', 'c')` сойдёт. Точка безубыточности около четырёх значений для char и около двух для string.
- **Входы короче 16 элементов**. У SIMD-ядер есть стоимость setup. Для span из 8 символов выигрывает скалярное сравнение.
- **Искомые значения меняются на каждом вызове**. Весь смысл `SearchValues` -- амортизация. Если множество -- пользовательский ввод на каждый вызов, оставайтесь на перегрузках `IndexOfAny` или `Regex` с `RegexOptions.Compiled`.
- **Нужна групповая фиксация или обратные ссылки**. `SearchValues` делает только литеральное сопоставление. Это не замена regex, а просто более быстрый `Contains`.

## Статическая инициализация без аллокаций

Перегрузки `Create` принимают `ReadOnlySpan<T>`. Можно передать строковый литерал (компилятор C# конвертирует строковые литералы в `ReadOnlySpan<char>` через `RuntimeHelpers.CreateSpan` начиная с .NET 7), массив или collection expression. Все три производят один и тот же экземпляр `SearchValues<T>`; компилятор не генерирует промежуточные массивы для формы со строковым литералом.

```csharp
// .NET 11, C# 14 -- all three are equivalent in cost at runtime
private static readonly SearchValues<char> A = SearchValues.Create("abc");
private static readonly SearchValues<char> B = SearchValues.Create(['a', 'b', 'c']);
private static readonly SearchValues<char> C = SearchValues.Create(new[] { 'a', 'b', 'c' });
```

Для перегрузки со string вход должен быть массивом (`string[]`) или collection expression, нацеленным на массив:

```csharp
private static readonly SearchValues<string> Tokens =
    SearchValues.Create(["select", "insert", "update"], StringComparison.OrdinalIgnoreCase);
```

Конструктор копирует искомые значения во внутреннее состояние, поэтому исходный массив не удерживается. Изменение массива после конструирования никак не влияет на экземпляр `SearchValues<string>`. Это противоположность `Regex` с кешированными шаблонами, где исходная строка удерживается.

## Шаблон, дружественный к генератору исходного кода

Если у вас `partial`-класс и генератор кода (свой или `System.Text.RegularExpressions.GeneratedRegex`), генерация поля `static readonly SearchValues<char>` в составе сгенерированного вывода -- чистый шаблон. Trim-безопасный, AOT-безопасный, без рефлексии, без аллокаций в куче на каждый вызов.

```csharp
// .NET 11, C# 14 -- hand-rolled equivalent of what a generator would emit
internal static partial class IdentifierScanner
{
    private static readonly SearchValues<char> NonIdentifierChars =
        SearchValues.Create(GetNonIdentifierAscii());

    private static ReadOnlySpan<char> GetNonIdentifierAscii()
    {
        // Build a 96-element set of non-[A-Za-z0-9_] ASCII chars at type init.
        Span<char> buffer = stackalloc char[96];
        int i = 0;
        for (int c = ' '; c <= '~'; c++)
        {
            if (!(char.IsAsciiLetterOrDigit((char)c) || c == '_'))
                buffer[i++] = (char)c;
        }
        return buffer[..i].ToArray();
    }
}
```

`stackalloc` выполняется один раз, потому что `static readonly` инициализируется ровно однажды инициализатором типа среды выполнения. `.ToArray()` -- единственная аллокация за время жизни типа. После этого каждый поиск свободен от аллокаций.

## Native AOT и предупреждения trim

`SearchValues<T>` полностью совместим с Native AOT. Внутри нет рефлексии, нет динамической генерации кода во время выполнения. Ваш AOT-публикованный бинарник содержит те же SIMD-ядра, что и JIT-версия, выбранные на этапе AOT-компиляции по указанной целевой ISA (`-r linux-x64` по умолчанию включает базовый x64 с путями SSE2 + AVX2; `-p:TargetIsa=AVX-512` расширяет до AVX-512). Никаких trim-предупреждений, не нужны аннотации `[DynamicallyAccessedMembers]`.

Если вы публикуете для `linux-arm64`, NEON-ядра подбираются автоматически. Один и тот же исходник компилируется под обе цели без условного кода.

## Связанное чтение

- [Span<T> vs ReadOnlySpan<T> и когда что оправдывает себя](/2026/01/net-10-performance-searchvalues/) описывает более ранний срез `SearchValues` времён .NET 10; вернитесь к нему за SIMD-контекстом.
- [Channels вместо BlockingCollection](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- правильный транспорт, когда вы сканируете входы в воркере.
- [Как читать большой CSV в .NET 11, не упираясь в память](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) использует `SearchValues<char>` для сканирования разделителей в парсере.
- [Как обнаружить, что файл дописан в .NET](/ru/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) естественно сочетается с CSV-сканером выше при потреблении файлов из inbox.

## Источники

- [Справочник `SearchValues<T>`, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues-1) -- каноническая поверхность API, включая перегрузки `Create` для byte / char / string.
- [`SearchValues.Create(ReadOnlySpan<string>, StringComparison)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues.create) -- документирует четыре поддерживаемых значения `StringComparison` и `ArgumentException`, бросаемое для остальных.
- [.NET runtime PR 90395 -- первоначальный `SearchValues<T>`](https://github.com/dotnet/runtime/pull/90395) -- введение перегрузок byte и char в .NET 8 с таблицей SIMD-стратегий.
- [.NET runtime PR 96570 -- `SearchValues<string>`](https://github.com/dotnet/runtime/pull/96570) -- добавление в .NET 9 ядер Aho-Corasick / Teddy для нескольких строк.
- [Boosting string search performance in .NET 8.0 with SearchValues, endjin](https://endjin.com/blog/2024/01/dotnet-8-searchvalues-string-search-performance-boost) -- самый чистый внешний бенчмарк по char-пути.
