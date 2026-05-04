---
title: "Как преобразовать T[] в ReadOnlyMemory<T> в C# (неявный оператор и явный конструктор)"
description: "Три способа обернуть T[] в ReadOnlyMemory<T> в .NET 11: неявное преобразование, явный конструктор и AsMemory(). Когда что выбрать."
pubDate: 2026-05-04
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
template: "how-to"
lang: "ru"
translationOf: "2026/05/how-to-convert-array-to-readonlymemory-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-04
---

Если вам нужно просто получить представление `ReadOnlyMemory<T>` поверх существующего массива, кратчайший путь это неявное преобразование: `ReadOnlyMemory<byte> rom = bytes;`. Если нужен срез, предпочтительнее `bytes.AsMemory(start, length)` или `new ReadOnlyMemory<byte>(bytes, start, length)`. Все три варианта не выполняют аллокаций, но только конструктор и `AsMemory` принимают смещение и длину, и только конструктор делает преобразование явным в месте вызова (что важно при код-ревью).

Версии, упоминаемые в этой статье: .NET 11 (среда выполнения), C# 14. `System.Memory` поставляется как часть `System.Runtime` в современном .NET, поэтому дополнительный пакет не нужен.

## Почему существует более одного пути преобразования

`ReadOnlyMemory<T>` присутствует в BCL начиная с .NET Core 2.1 (и в NuGet-пакете `System.Memory` для .NET Standard 2.0). Microsoft намеренно добавила несколько точек входа: удобную для 90% случаев, явный конструктор для кода, где преобразование нужно подчеркнуть, и метод-расширение, который повторяет `AsSpan()`, чтобы вы могли мысленно переключаться между span и memory без смены контекста.

Конкретно, BCL предоставляет:

1. Неявное преобразование `T[]` в `Memory<T>` и `T[]` в `ReadOnlyMemory<T>`.
2. Неявное преобразование `Memory<T>` в `ReadOnlyMemory<T>`.
3. Конструктор `new ReadOnlyMemory<T>(T[])` и перегрузку для среза `new ReadOnlyMemory<T>(T[] array, int start, int length)`.
4. Методы-расширения `AsMemory<T>(this T[])`, `AsMemory<T>(this T[], int start)`, `AsMemory<T>(this T[], int start, int length)` и `AsMemory<T>(this T[], Range)`, определённые на `MemoryExtensions`.

Все пути не выполняют аллокаций. Выбор в основном стилистический, с двумя реальными отличиями: только конструктор и `AsMemory` принимают срез, и только неявное преобразование позволяет аргументу типа `T[]` передаваться в параметр `ReadOnlyMemory<T>` без того, чтобы вызывающий что-либо писал.

## Минимальный пример

```csharp
// .NET 11, C# 14
using System;

byte[] payload = "hello"u8.ToArray();

// Path 1: implicit operator
ReadOnlyMemory<byte> a = payload;

// Path 2: explicit constructor, full array
ReadOnlyMemory<byte> b = new ReadOnlyMemory<byte>(payload);

// Path 3: explicit constructor, slice
ReadOnlyMemory<byte> c = new ReadOnlyMemory<byte>(payload, start: 1, length: 3);

// Path 4: AsMemory extension, full array
ReadOnlyMemory<byte> d = payload.AsMemory();

// Path 5: AsMemory extension, slice with start + length
ReadOnlyMemory<byte> e = payload.AsMemory(start: 1, length: 3);

// Path 6: AsMemory extension, range
ReadOnlyMemory<byte> f = payload.AsMemory(1..4);
```

Все шесть вариантов создают экземпляры `ReadOnlyMemory<byte>`, указывающие на один и тот же базовый массив. Ни один из них не копирует массив. Все шесть безопасны в плотных циклах, потому что цена это копирование маленькой структуры, а не копирование буфера.

## Когда неявный оператор это правильный выбор

Неявное преобразование `T[]` в `ReadOnlyMemory<T>` выглядит чище всего в местах вызова, где целевой тип уже является параметром `ReadOnlyMemory<T>`:

```csharp
// .NET 11
public Task WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
{
    // ...
    return Task.CompletedTask;
}

byte[] payload = GetPayload();
await WriteAsync(payload); // implicit conversion happens here
```

Вы не пишете `payload.AsMemory()` или `new ReadOnlyMemory<byte>(payload)`. Компилятор сам выполняет преобразование. Это важно с двух сторон: место вызова остаётся читаемым в горячем коде, и ваш API может принимать `ReadOnlyMemory<T>`, не заставляя каждого вызывающего изучать новый тип.

Компромисс в том, что преобразование невидимо. Если вы хотите, чтобы ревьюер заметил "этот код теперь передаёт представление `ReadOnlyMemory<T>` вместо массива", неявный оператор это скрывает.

## Когда конструктор стоит своей многословности

`new ReadOnlyMemory<byte>(payload, start, length)` это явная форма. К ней обращаются в трёх ситуациях:

1. **Нужен срез со смещением и длиной.** Неявное преобразование всегда охватывает массив целиком.
2. **Нужно сделать преобразование заметным в месте вызова.** Поле вида `private ReadOnlyMemory<byte> _buffer;`, инициализированное конструктором, проще найти grep'ом, чем неявный оператор.
3. **Нужно, чтобы компилятор проверил границы смещения и длины один раз, при создании.** Все пути в итоге проверяют границы, но конструктор принимает `start` и `length` как параметры и сразу выбрасывает `ArgumentOutOfRangeException`, если они выходят за пределы массива, до того как любой потребитель обратится к памяти.

```csharp
// .NET 11
byte[] frame = ReceiveFrame();
const int headerLength = 16;

// Skip the header. Bounds-checked here, not when the consumer reads.
var payload = new ReadOnlyMemory<byte>(frame, headerLength, frame.Length - headerLength);

await ProcessAsync(payload);
```

Если `frame.Length < headerLength`, `ArgumentOutOfRangeException` выбрасывается в месте создания, где локальные переменные ещё в области видимости и отладчик может показать вам, чему на самом деле равен `frame.Length`. Если вы откладываете срез до `ProcessAsync`, эта локальность теряется, и сбой проявляется там, где срез наконец материализуется.

## Когда использовать `AsMemory()`

`AsMemory()` это то же самое, что и конструктор, но с двумя эргономическими преимуществами: читается слева направо (`payload.AsMemory(1, 3)`, а не `new ReadOnlyMemory<byte>(payload, 1, 3)`), и есть перегрузка для `Range`, поэтому работает синтаксис срезов C#:

```csharp
// .NET 11, C# 14
byte[] payload = GetPayload();
const int headerLength = 16;

ReadOnlyMemory<byte> body = payload.AsMemory(headerLength..);
ReadOnlyMemory<byte> first16 = payload.AsMemory(..headerLength);
ReadOnlyMemory<byte> middle = payload.AsMemory(8..24);
```

`AsMemory(Range)` возвращает `Memory<T>`, и приведение к `ReadOnlyMemory<T>` здесь идёт через неявное преобразование `Memory<T>` в `ReadOnlyMemory<T>`. Оно тоже не выполняет аллокаций.

Если вы уже мысленно приняли `AsSpan()` (тот же шаблон для `Span<T>`), то `AsMemory()` это та же привычка, которая выживает через `await`.

## Что происходит с `null`-массивами

Передача `null`-массива в неявное преобразование или в `AsMemory()` не выбрасывает исключение. Получается `ReadOnlyMemory<T>` по умолчанию, что семантически эквивалентно `ReadOnlyMemory<T>.Empty` (`IsEmpty == true`, `Length == 0`):

```csharp
// .NET 11
byte[]? maybeNull = null;

ReadOnlyMemory<byte> a = maybeNull;            // default, not a NullReferenceException
ReadOnlyMemory<byte> b = maybeNull.AsMemory(); // also default
// new ReadOnlyMemory<byte>(maybeNull) also returns default
```

Конструктор с одним аргументом `new ReadOnlyMemory<T>(T[]? array)` явно документирует это: ссылка `null` даёт `ReadOnlyMemory<T>` со значением по умолчанию. Конструктор с тремя аргументами `new ReadOnlyMemory<T>(T[]? array, int start, int length)` действительно выбрасывает `ArgumentNullException`, если массив равен `null` и вы указываете ненулевые `start` или `length`, потому что границы нельзя удовлетворить относительно `null`.

Эта терпимость к `null` удобна для необязательных полезных нагрузок, но это и подвох: вызывающий, который передаёт `null`, молча получит пустой буфер вместо краха, что может замаскировать ошибку выше по стеку. Если ваш метод зависит от того, что массив не равен `null`, проверяйте до оборачивания.

## Срез результата тоже бесплатный

Когда у вас есть `ReadOnlyMemory<T>`, вызов `.Slice(start, length)` создаёт ещё один `ReadOnlyMemory<T>` поверх того же базового хранилища. Никакого второго копирования и никакой второй аллокации:

```csharp
// .NET 11
ReadOnlyMemory<byte> all = payload.AsMemory();

ReadOnlyMemory<byte> head = all.Slice(0, 16);
ReadOnlyMemory<byte> body = all.Slice(16);
```

Структура `ReadOnlyMemory<T>` хранит ссылку на исходный `T[]` (или на `MemoryManager<T>`), смещение в этом хранилище и длину. Срез просто возвращает новую структуру со скорректированным смещением и длиной. Поэтому все шесть путей преобразования выше безопасны для использования даже в плотных циклах: цена это копирование структуры, а не копирование буфера.

## Возврат от `ReadOnlyMemory<T>` к `Span<T>`

Внутри синхронного метода обычно нужен span, а не memory:

```csharp
// .NET 11
public int CountZeroBytes(ReadOnlyMemory<byte> data)
{
    ReadOnlySpan<byte> span = data.Span; // allocation-free
    int count = 0;
    foreach (byte b in span)
    {
        if (b == 0) count++;
    }
    return count;
}
```

`.Span` это свойство `ReadOnlyMemory<T>`, которое возвращает `ReadOnlySpan<T>` поверх той же памяти. Используйте span во внутреннем цикле, держите memory в полях и через границы `await`. Обратное преобразование (span в memory) намеренно не предоставляется, потому что span'ы могут жить на стеке, куда `Memory<T>` дотянуться не может.

## Чего нельзя сделать (и обходные пути)

`ReadOnlyMemory<T>` действительно доступен только для чтения с точки зрения публичного API. Публичного `ToMemory()`, возвращающего изменяемый `Memory<T>`, нет. Лазейка живёт в `MemoryMarshal`:

```csharp
// .NET 11
using System.Runtime.InteropServices;

ReadOnlyMemory<byte> ro = payload.AsMemory();
Memory<byte> rw = MemoryMarshal.AsMemory(ro);
```

Это небезопасно в смысле "система типов вам что-то говорила". Прибегайте к этому только когда уверены, что ни один другой потребитель не полагается на контракт только-для-чтения, который вы только что нарушили, например в модульном тесте или в коде, который владеет буфером целиком.

`ReadOnlyMemory<T>` также не может указывать в `string` через пути преобразования из массива. `string.AsMemory()` возвращает `ReadOnlyMemory<char>`, оборачивающий саму строку, а не `T[]`. Пути преобразования из `T[]`, рассмотренные выше, к строкам не применимы, но остальная часть API (срезы, `Span`, равенство) ведёт себя одинаково.

## Какой выбрать в вашей кодовой базе

Разумный выбор по умолчанию в кодовой базе на .NET 11:

- **В сигнатурах API**: принимайте `ReadOnlyMemory<T>`. Вызывающие с `T[]` передадут его как есть (неявный оператор), вызывающие со срезом передадут `array.AsMemory(start, length)`. Вы ничего не теряете.
- **В местах вызова с целым массивом**: используйте неявное преобразование, не пишите `.AsMemory()`. Это шум.
- **В местах вызова со срезом**: используйте `array.AsMemory(start, length)` или `array.AsMemory(range)`. Избегайте `new ReadOnlyMemory<T>(array, start, length)`, если только явность в месте вызова не является самой целью.
- **В горячих путях**: для производительности это не важно. JIT приводит все шесть путей к одной и той же конструкции структуры. Выбирайте то, что читается лучше.

## Связанное

- [Как корректно использовать `SearchValues<T>` в .NET 11](/ru/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) для поиска, дружественного к span, который естественно сочетается с `ReadOnlyMemory<T>.Span`.
- [Как использовать Channels вместо `BlockingCollection` в C#](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) когда нужны асинхронные конвейеры, передающие полезные нагрузки `ReadOnlyMemory<T>`.
- [Как использовать `IAsyncEnumerable<T>` с EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) для шаблонов потоковой передачи, которые хорошо сочетаются с представлениями памяти.
- [Как читать большой CSV в .NET 11 без исчерпания памяти](/ru/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) которая сильно опирается на срезы без копирования.
- [Как использовать новый тип `System.Threading.Lock` в .NET 11](/ru/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) для примитива синхронизации, который понадобится вокруг изменяемого `Memory<T>`, разделяемого между потоками.

## Источники

- [`ReadOnlyMemory<T>` reference (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.readonlymemory-1)
- [`MemoryExtensions.AsMemory` reference (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.memoryextensions.asmemory)
- [Memory<T> and Span<T> usage guidelines (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-span/)
- [`MemoryMarshal.AsMemory` reference (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.memorymarshal.asmemory)
