---
title: "Zstandard против Brotli и Gzip: сжатие ответов в .NET 11"
description: "Zstandard это правильный вариант по умолчанию для динамических ответов API в .NET 11, но не с тем уровнем качества, с которым поставляется провайдер ASP.NET Core. Бенчмарки на реальных JSON-данных показывают, почему качество 1 обгоняет качество 3 по умолчанию и по размеру, и по нагрузке на CPU, когда Brotli всё ещё выигрывает и почему Gzip остаётся только как запасной вариант ради совместимости."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "compression"
  - "performance"
lang: "ru"
translationOf: "2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

Для динамических ответов API в .NET 11 используйте Zstandard, который и так стоит по умолчанию, но задайте `Quality = 1` явно, а не полагайтесь на значение провайдера. На тех JSON-данных, которые я измерял, Zstandard с качеством 1 сжал в 7.37 раза, тогда как качество 3 по умолчанию дало лишь 6.66 раза, причём качество 1 сделало это почти с двойной пропускной способностью. Brotli выигрывает только тогда, когда можно сжать один раз и отдавать много раз, и даже тогда лишь на качестве 11, которое стоит 3.2 секунды на ответ размером 3 МБ. Gzip теперь остаётся исключительно запасным вариантом ради совместимости.

Всё изложенное ниже относится к .NET 11 (на момент написания Preview 7, релиз в ноябре 2026 года) и C# 14. Провайдер Zstandard появился в ASP.NET Core 11; Brotli и Gzip присутствуют в middleware со времён ASP.NET Core 2.1 и ведут себя одинаково в .NET 8, 9 и 10.

## Матрица

| | Zstandard | Brotli | Gzip |
| --- | --- | --- | --- |
| Токен `Accept-Encoding` | `zstd` | `br` | `gzip` |
| Спецификация | [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878) | [RFC 7932](https://datatracker.ietf.org/doc/html/rfc7932) | [RFC 1952](https://www.ietf.org/rfc/rfc1952.txt) |
| В составе `System.IO.Compression` начиная с | .NET 11 | .NET Core 2.1 | .NET Framework 2.0 |
| Регистрируется по умолчанию в ASP.NET Core 11 | Да, первым | Да, вторым | Да, третьим |
| Уровень провайдера по умолчанию | качество 3 | `CompressionLevel.Fastest` | `CompressionLevel.Fastest` |
| Диапазон уровней | от `MinQuality` (отрицательное) до 22 | от 0 до 11 | от 0 до 9 |
| Коэффициент на JSON 292 КБ (лучший разумный уровень) | 7.26x | 7.01x | 6.55x |
| Пропускная способность сжатия на этом уровне | 572 МБ/с | 215 МБ/с | 208 МБ/с |
| Пропускная способность распаковки | 3103 МБ/с | 1134 МБ/с | 1575 МБ/с |
| Работает в Blazor WebAssembly | Нет | Да | Да |
| Поддержка словарей | Обучаемые (`ZstandardDictionary`) | Только встроенный статический | Нет |

Две строки, которые решают большинство споров, это пропускная способность распаковки и строка про WebAssembly. Всё остальное настолько близко, что можно бросать монетку.

## Что .NET 11 регистрирует на самом деле и в каком порядке

Если вызвать `AddResponseCompression()` без явного указания провайдеров, ASP.NET Core 11 зарегистрирует три, и порядок в [`ResponseCompressionProvider`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs) это порядок предпочтения сервера:

```csharp
// ASP.NET Core 11, from ResponseCompressionProvider.cs
_providers = new ICompressionProvider[]
{
    new CompressionProviderFactory(typeof(ZstandardCompressionProvider)),
    new CompressionProviderFactory(typeof(BrotliCompressionProvider)),
    new CompressionProviderFactory(typeof(GzipCompressionProvider)),
};
```

Поэтому браузер, отправляющий `Accept-Encoding: gzip, deflate, br, zstd`, получит `Content-Encoding: zstd` от приложения ASP.NET Core 11, которое вы вообще не настраивали. В .NET 10 тот же запрос получал `br`. Это всё изменение, видимое пользователю, и оно происходит при обновлении без единой правки кода.

Как только вы добавляете хотя бы один провайдер вручную, значения по умолчанию отключаются полностью и активным остаётся только ваш список. Это самый частый способ случайно отключить Zstandard, полагая, что вы просто включаете сжатие поверх HTTPS.

## Качество по умолчанию выбрано неудачно

Вот часть, которой нет в примечаниях к выпуску. `BrotliCompressionProviderOptions` и `GzipCompressionProviderOptions` оба по умолчанию используют `CompressionLevel.Fastest`. У провайдера Zstandard свойства `Level` нет вообще. У него есть вот это:

```csharp
// ASP.NET Core 11, from ZstandardCompressionProviderOptions.cs
public ZstandardCompressionOptions CompressionOptions { get; set; } = new();
```

Свежесозданный `ZstandardCompressionOptions` оставляет `Quality` равным `0`, а `0` означает "значение по умолчанию, определяемое реализацией", которое libzstd превращает в уровень 3. Получается, что провайдеры Brotli и Gzip настроены на задержку, а провайдер Zstandard поставляется со сбалансированным значением libzstd. Эту асимметрию нигде не зафиксировали, но именно это говорит исходный код.

Это была бы мелочь, будь качество 3 просто более медленным и более компактным вариантом. Но это не так. На тех JSON-данных, которые я измерял, качество 3 хуже качества 1 по **обеим** осям:

| Качество zstd | Размер JSON 2.88 МБ | Коэффициент | Пропускная способность сжатия |
| --- | --- | --- | --- |
| 1 | 409,809 Б | 7.37x | 806 МБ/с |
| 2 | 427,111 Б | 7.07x | - |
| 3 (по умолчанию у провайдера) | 453,130 Б | 6.66x | 425 МБ/с |
| 4 | 460,813 Б | 6.55x | - |
| 5 | 449,750 Б | 6.71x | - |
| 6 | 436,263 Б | 6.92x | 159 МБ/с |
| 9 | 422,148 Б | 7.15x | - |
| 12 | 416,795 Б | 7.24x | 54 МБ/с |
| 19 | 362,100 Б | 8.34x | - |

Перечитайте этот столбец. Коэффициент падает с уровня 1 до уровня 4, затем снова растёт и обгоняет уровень 1 только начиная с уровня 9. Платить 1.9x процессорного времени за тело на 11% больше это плохая сделка в любую сторону.

Это не баг и это не особенность .NET. Уровни Zstandard это не единая шкала: каждый уровень выбирает свою стратегию поиска совпадений плюс собственные параметры окна, цепочки, хеша и минимального совпадения. Если спросить у libzstd напрямую, какие параметры он использует, разрыв становится виден:

```
level  1: strategy=1 (fast)   windowLog=19 chainLog=13 hashLog=14 minMatch=7
level  2: strategy=1 (fast)   windowLog=20 chainLog=15 hashLog=16 minMatch=6
level  3: strategy=2 (dfast)  windowLog=21 chainLog=16 hashLog=17 minMatch=5
level  4: strategy=2 (dfast)  windowLog=21 chainLog=18 hashLog=18 minMatch=5
level  5: strategy=3 (greedy) windowLog=21 chainLog=18 hashLog=19 minMatch=5
level  6: strategy=4 (lazy)   windowLog=21 chainLog=18 hashLog=19 minMatch=5
```

Переход с уровня 2 на уровень 3 снижает `minMatch` с 6 до 5 и меняет стратегию. На тексте с длинными и очень повторяющимися участками (ключи JSON, повторяющиеся один раз на каждый элемент массива, одинаковая строка `notes` в каждой записи) конфигурация уровня 1 находит менее многочисленные, но более длинные совпадения, которые лучше упаковываются энтропийным кодированием. Эти таблицы уровней подбирались на общем корпусе данных, поэтому порядок соблюдается в среднем, а не на ваших данных.

Практическое правило: уровень по умолчанию любого кодека это догадка о данных, которых он никогда не видел. Измерьте две-три реальные формы ваших конечных точек и зафиксируйте качество.

## Бенчмарк

Данные: массив JSON с записями клиентов, та самая форма, которую реально возвращает конечная точка со списком. Детерминированные, чтобы вы могли воспроизвести:

```csharp
// .NET 10 / .NET 11, C# 14
static Guid NextGuid(Random rnd)
{
    var b = new byte[16];
    rnd.NextBytes(b);
    return new Guid(b);
}

static byte[] MakeListPayload(int count, int seed)
{
    var rnd = new Random(seed);
    string[] cities = ["Bucharest", "Berlin", "Lisbon", "Warsaw", "Dublin", "Madrid", "Helsinki"];
    string[] statuses = ["active", "pending", "suspended", "closed"];
    var items = Enumerable.Range(1, count).Select(i => new
    {
        id = i,
        externalId = NextGuid(rnd).ToString(),
        name = $"Customer {i}",
        email = $"user{i}@example.com",
        city = cities[rnd.Next(cities.Length)],
        status = statuses[rnd.Next(statuses.Length)],
        balance = Math.Round(rnd.NextDouble() * 10000, 2),
        createdAt = new DateTime(2024, 1, 1).AddMinutes(i * 7).ToString("O"),
        tags = new[] { "vip", "eu", "newsletter" }.Take(rnd.Next(1, 4)).ToArray(),
        notes = "Imported from the legacy CRM during the 2024 migration."
    });
    return JsonSerializer.SerializeToUtf8Bytes(items);
}
```

Методика: каждый кодек оборачивает `MemoryStream` ровно так же, как middleware сжатия ответов оборачивает тело ответа, поэтому подготовка кодировщика на каждый ответ входит в измерение. Три прогрева, затем 60 замеров для данных объёмом 292 КБ и 15 для данных объёмом 2.88 МБ, приводится медиана. Машина: Intel Core Ultra 7 265KF, Windows 11, .NET 10.0.5 x64.

Честная оговорка об окружении. На моей машине установлен только SDK 10.0.201, поэтому скомпилировать код с `System.IO.Compression.ZstandardStream` было невозможно. Строки Zstandard получены с помощью [ZstdSharp.Port](https://www.nuget.org/packages/ZstdSharp.Port) 0.8.8, управляемого порта эталонной реализации. Две вещи делают такую замену допустимой. Во-первых, .NET 11 включает [libzstd 1.5.7](https://github.com/dotnet/runtime/blob/main/src/native/external/zstd/lib/zstd.h), и я сверил каждый размер вывода ZstdSharp с нативной libzstd 1.5.7 на тех же самых байтах: они совпадают с точностью до 0.05% (41,132 против 41,135 байт на качестве 1, 43,644 против 43,647 на качестве 3). Следовательно, размеры сжатых данных это именно то, что выдаст .NET 11. Во-вторых, пропускная способность это как раз тот показатель, который не переносится: нативная libzstd на этом железе выдала 1092 МБ/с на качестве 1 там, где управляемый порт выдал 806 МБ/с, так что считайте столбец скорости Zstandard нижней границей, а не верхней.

**JSON 292 КБ (1000 записей), 298,727 байт исходно:**

| кодек | уровень | сжато | коэффициент | сжатие МБ/с | распаковка МБ/с |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 69,832 | 4.28x | 743 | 1488 |
| gzip | Optimal | 45,586 | 6.55x | 208 | 1575 |
| brotli | Fastest | 44,606 | 6.70x | 564 | 808 |
| brotli | Optimal | 42,610 | 7.01x | 215 | 1134 |
| brotli | q11 (SmallestSize) | 34,025 | 8.78x | 1 | 728 |
| zstd | q1 | 41,132 | 7.26x | 572 | 3103 |
| zstd | q3 (по умолчанию у провайдера) | 43,644 | 6.84x | 276 | 1796 |
| zstd | q6 | 41,009 | 7.28x | 112 | 1735 |
| zstd | q12 | 38,881 | 7.68x | 20 | 1320 |

**JSON 2.88 МБ (10000 записей), 3,018,756 байт исходно:**

| кодек | уровень | сжато | коэффициент | сжатие МБ/с | распаковка МБ/с |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 697,252 | 4.33x | 712 | 1443 |
| gzip | Optimal | 452,661 | 6.67x | 204 | 1620 |
| brotli | Fastest | 447,954 | 6.74x | 786 | 726 |
| brotli | Optimal | 429,060 | 7.04x | 186 | 1088 |
| brotli | q11 (SmallestSize) | 341,338 | 8.84x | 1 | 842 |
| zstd | q1 | 409,805 | 7.37x | 806 | 3158 |
| zstd | q3 (по умолчанию у провайдера) | 454,007 | 6.65x | 425 | 1914 |
| zstd | q6 | 436,263 | 6.92x | 159 | 1846 |
| zstd | q12 | 416,792 | 7.24x | 54 | 1891 |

Три результата определяют всё сравнение.

**Zstandard с качеством 1 превосходит Brotli `Fastest` по всем параметрам.** Меньший размер (41,132 против 44,606 байт), такая же пропускная способность сжатия (572 против 564 МБ/с) и в 3.8 раза более высокая пропускная способность распаковки. Нет ни одной оси, по которой быстрая настройка Brotli была бы лучшим выбором для динамического ответа.

**Gzip `Fastest` неконкурентоспособен по размеру.** 69,832 байта против 41,132 у Zstandard это тело на 70% больше без выигрыша в пропускной способности. Если вы всё ещё отдаёте `gzip` современным клиентам, вы платите за это трафиком.

**Brotli q11 это ловушка на пути обработки запроса.** Он действительно даёт самый компактный вывод в таблице, 8.78x, примерно на 17% лучше Zstandard с качеством 1. Но он же занял 272 миллисекунды на данных объёмом 292 КБ и 3.2 секунды на данных объёмом 2.88 МБ. Это на каждый ответ. Тот, кто измерит "Brotli сжимает лучше всех" и настроит `SmallestSize` в рабочем API, добавит три секунды задержки, упирающейся в CPU, к каждому крупному ответу.

## Когда выбирать каждый из них

**Zstandard, качество 1** для всего, что вычисляется на каждый запрос. Конечные точки со списками JSON, ответы GraphQL, HTML, отрисованный на сервере, ответы при приёме логов. Это значение по умолчанию в .NET 11, и единственное нужное изменение это зафиксировать качество.

**Zstandard, качество от 12 до 19** для контента, который сжимается один раз и кешируется, когда вы храните сжатые байты и отдаёте их многократно. Качество 19 достигло 8.34x на крупных данных, закрыв большую часть разрыва с Brotli q11 за долю стоимости. Сочетайте это с [кешированием вывода](/ru/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/), чтобы процессорное время тратилось один раз на запись кеша, а не один раз на запрос.

**Brotli, качество 11** для статических ресурсов, сжимаемых на этапе сборки. Ваш бандл JS, ваш CSS, ваши данные WASM. Время сжатия не имеет значения, когда оно тратится в CI, а встроенный статический словарь Brotli настроен как раз на такой контент. Не делайте этого в middleware сжатия ответов; сжимайте заранее и отдавайте файл `.br`.

**Brotli, `Optimal`** когда нужна широкая поддержка клиентов и Zstandard использовать нельзя. В частности, сюда относится Blazor WebAssembly, о чём ниже.

**Gzip** только последним пунктом в списке провайдеров, для клиентов, которые не заявляют ничего другого. Оставьте его зарегистрированным; никогда не ставьте его в приоритет.

## Детали, которые решают за вас

**Zstandard не существует ни в браузере, ни в WASI.** Среда выполнения помечает всё семейство типов атрибутами `[UnsupportedOSPlatform("browser")]` и `[UnsupportedOSPlatform("wasi")]`. Если ваш клиент это приложение Blazor WebAssembly, которое само выполняет распаковку, или вы работаете на `wasi-wasm`, Zstandard использовать нельзя, и анализатор скажет вам об этом на этапе сборки. Серверного сжатия для браузера это не касается: собственная поддержка `zstd` в браузере обрабатывает `Content-Encoding: zstd` нативно, и она уже некоторое время доступна в Chrome, Edge и Firefox. Ограничение затрагивает только код, вызывающий `ZstandardStream` внутри среды выполнения WASM.

**`CompressionLevel.NoCompression` для Zstandard не означает отсутствие сжатия.** Среда выполнения отображает это перечисление на качество zstd так:

```csharp
// .NET 11, from ZstandardUtils.cs
CompressionLevel.NoCompression => Quality_Min,   // ZSTD_minCLevel(), a large negative number
CompressionLevel.Fastest       => 1,
CompressionLevel.Optimal       => Quality_Default,  // 3
CompressionLevel.SmallestSize  => Quality_Max,      // 22
```

`NoCompression` отображается на *минимальное качество*, а это по-прежнему сжимающая конфигурация, просто крайне быстрая и слабая. Для Gzip и Brotli `NoCompression` действительно означает несжатые блоки. Передача одного и того же значения перечисления трём кодекам даёт три разных поведения.

**Отрицательные значения качества допустимы, и документация ASP.NET Core о них не упоминает.** [Страница о сжатии ответов](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0) утверждает, что уровень качества "находится в диапазоне от 1 до 22". Исходный код среды выполнения шире: `Quality` принимает любое значение от `MinQuality` до `MaxQuality`, причём отрицательные значения документированы как расширение диапазона между скоростью и коэффициентом. Для JSON они редко оказываются нужны. Качество -5 подняло сжатие до 1635 МБ/с, но коэффициент обрушился с 7.37x до 3.81x, что для ответа размером 3 МБ означает отправку примерно на 375 КБ больше по сети ради экономии одной миллисекунды процессорного времени. Берите качество 1, а не отрицательные значения.

**Включение сжатия поверх HTTPS по-прежнему требует явного согласия и несёт реальный риск.** `EnableForHttps` по умолчанию равно `false`, потому что сжатие ответа, в котором секрет смешан с данными, на которые влияет атакующий, раскрывает этот секрет через размер сжатых данных ([CRIME](https://en.wikipedia.org/wiki/CRIME) и [BREACH](https://en.wikipedia.org/wiki/BREACH)). Смена кодека этого не меняет: Zstandard ровно настолько же уязвим, насколько был уязвим Gzip. Обоснование и список мер защиты приводится в [полном руководстве по настройке сжатия ответов](/ru/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/).

**Небольшие ответы проигрывают при любом кодеке.** Ответ с одной записью в моём наборе тестов занимает 179 байт. Gzip `Fastest` превратил его в 188 байт, то есть больше исходного, а Zstandard с качеством 1 в 157 байт, и этот "выигрыш" в 1.14x полностью съедается накладными расходами на обрамление и подготовкой кодировщика на каждый ответ. Рекомендация самого фреймворка не сжимать объекты меньше примерно 150-1000 байт, и выбор кодека этот порог не сдвигает.

## Как это настроить

Полная конфигурация для JSON API с зафиксированным качеством:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 1
    };
});

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/customers", () => Results.Ok(GetCustomers()));

app.Run();
```

Явное добавление всех трёх провайдеров избыточно по сравнению со значениями по умолчанию, но оно документирует порядок предпочтения для следующего человека и переживёт добавление кем-то четвёртого провайдера позже.

Ещё две настройки `ZstandardCompressionOptions` стоит знать для потоковых ответов. `TargetBlockSize` (допустимый диапазон от 1340 до 131072 байт) подсказывает, как часто кодировщик выдаёт блок; меньшие значения означают меньшую задержку для ответа, который отдаётся по капле, ценой некоторого ухудшения коэффициента. `EnableLongDistanceMatching` улучшает коэффициенты на крупных телах ответа ценой памяти. Ни то, ни другое не стоит трогать, пока вы не зафиксировали качество и не провели измерения.

Если ваши ответы небольшие, однородные и повторяющиеся, действительно стоит изучить `ZstandardDictionary`. Словарь, обученный на репрезентативных образцах, позволяет Zstandard сжимать данные, которые по отдельности слишком малы, чтобы построить полезное окно. Это как раз тот случай, когда описанный выше ответ в 179 байт становится сжимаемым. У Brotli и Gzip нет аналога, который вы могли бы обучить сами.

## Рекомендация ещё раз

Возьмите значение по умолчанию .NET 11 и зафиксируйте одно свойство. Zstandard с качеством 1 дал лучший коэффициент среди всех уровней, которые работают достаточно быстро для пути обработки запроса, сравнялся с самой быстрой настройкой Brotli по пропускной способности сжатия и распаковывался примерно в 3 раза быстрее всего остального в таблице, а это тот показатель, который чувствуют ваши мобильные клиенты. Оставьте Brotli и Gzip зарегистрированными ниже, чтобы старые клиенты всё же что-то получали.

Не соглашайтесь на качество 3, установленное провайдером по умолчанию. Это единственная конфигурация в этом сравнении, которая проигрывает одновременно и по размеру, и по скорости, и именно её вы получите, если ничего не измените.

## Похожие материалы

- [Как добавить сжатие ответов в API на ASP.NET Core 11](/ru/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) полностью разбирает настройку middleware, типы MIME и решение по безопасности для HTTPS.
- [.NET 11 добавляет нативное сжатие Zstandard в System.IO.Compression](/ru/2026/04/dotnet-11-zstandard-compression-system-io/) представляет API `ZstandardStream` вне контекста HTTP.
- [Кеширование вывода против кеширования ответов в ASP.NET Core 11](/ru/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/) показывает, как сделать высокий уровень сжатия приемлемым по стоимости.
- [Сжатие Deflate и Gzip на основе span в .NET 11](/ru/2026/05/dotnet-11-span-based-deflate-gzip-compression/) разбирает однопроходные API без выделений памяти для более старых кодеков.
- [Как передать файл из конечной точки ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) объясняет, где сжатие и потоковая передача плохо уживаются.

## Источники

- [Сжатие ответов в ASP.NET Core 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionProvider.cs, порядок провайдеров по умолчанию (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs)
- [ZstandardCompressionProviderOptions.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ZstandardCompressionProviderOptions.cs)
- [ZstandardCompressionOptions.cs, семантика качества и окна (dotnet/dotnet)](https://github.com/dotnet/dotnet/blob/main/src/runtime/src/libraries/System.IO.Compression.Zstandard/src/System/IO/Compression/ZstandardCompressionOptions.cs)
- [Справочник по классу ZstandardCompressionOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardcompressionoptions?view=net-11.0)
- [Support zstd Content-Encoding (dotnet/aspnetcore issue 50643)](https://github.com/dotnet/aspnetcore/issues/50643)
- [RFC 8878: Zstandard Compression and the application/zstd Media Type](https://datatracker.ietf.org/doc/html/rfc8878)
- [Эталонная реализация Zstandard](https://github.com/facebook/zstd)
