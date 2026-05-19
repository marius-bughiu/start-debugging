---
title: "Исправление: ломающее изменение разрешения перегрузок в C# 14 со Span и ReadOnlySpan"
description: "После обновления до C# 14 / .NET 10 вызовы вроде array.Contains, x.Reverse() и MemoryMarshal.Cast внезапно привязываются к другим перегрузкам или перестают компилироваться. Вот что изменилось и как зафиксировать старое поведение там, где это важно."
pubDate: 2026-05-19
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet-10"
  - "spans"
  - "breaking-changes"
lang: "ru"
translationOf: "2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans"
translatedBy: "claude"
translationDate: 2026-05-19
---

Вы обновляете проект до C# 14 (поставляется с .NET 10, Roslyn 4.13, Visual Studio 17.13) и происходит одно из трёх: `Expression<Func<int[], int, bool>>`, которое раньше компилировалось и выполнялось, теперь бросает исключение во время выполнения, вызов `MemoryMarshal.Cast(array)` перестаёт компилироваться с ошибкой неоднозначности, или `Assert.Equal([2], myArray)` из xUnit переходит из состояния "проходит" в "неоднозначное совпадение между перегрузками Assert.Equal". Это всё одно и то же ломающее изменение. Первоклассные span-типы в C# 14 делают `T[]` неявно конвертируемым в `Span<T>` и `ReadOnlySpan<T>` во время разрешения перегрузок, вывода типов и привязки методов расширения, и это переворачивает то, какая перегрузка побеждает в коде, который ранее был однозначным.

В этой публикации разбираются четыре сценария, с которыми я реально сталкивался при обновлениях до .NET 10, показывается минимальное воспроизведение для каждого и даётся рекомендуемое исправление. Все примеры используют `<LangVersion>14.0</LangVersion>` и `<TargetFramework>net10.0</TargetFramework>`, если не указано иное.

## Почему C# 14 теперь выбирает другие перегрузки

В C# 13 и более ранних версиях пользовательские неявные преобразования из `T[]` в `Span<T>` и `ReadOnlySpan<T>` (объявленные в среде выполнения через `op_Implicit`) трактовались как библиотечные, а не языковые. Компилятор не учитывал их при разрешении перегрузок, выводе типов и привязке методов расширения. Поэтому до .NET 10 приходилось писать `myArray.AsSpan().BinarySearch(...)`, когда нужна была span-перегрузка метода, у которого также была перегрузка `IEnumerable<T>`. Компилятор молча выбирал не-span-перегрузку, потому что не видел преобразования.

Предложение [первоклассных span-типов](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md) C# 14 поднимает эти преобразования на уровень языка. Конкретно, после обновления компилятор учитывает эти преобразования при разрешении перегрузок:

- `T[]` в `Span<T>`
- `T[]` в `ReadOnlySpan<T>`
- `T[]` в `ReadOnlySpan<U>`, если `T` ссылочно конвертируем в `U`
- `Span<T>` в `ReadOnlySpan<T>`
- `string` в `ReadOnlySpan<char>`

Также добавляются правила разрешения ничьих: когда применимы и перегрузка `Span<T>`, и `ReadOnlySpan<T>` для одного и того же аргумента, предпочитается `ReadOnlySpan<T>`. Причина этого предпочтения всплывёт позже (ковариантные массивы), так что держите её в уме.

Команда Roslyn задокументировала это как [ломающее изменение поведения](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution) и ещё одну запись в списке [ломающих изменений компилятора с C# 13](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010). Нет единого кода ошибки компилятора, который срабатывает на "это разрешение изменилось". Некоторые сценарии по-прежнему молча компилируются, но привязываются по-другому, некоторые теперь выдают `CS0121` "вызов неоднозначен", а некоторые бросают исключение во время выполнения. Исправления зависят от того, в какую корзину вы попадаете.

## Корзина 1: лямбды-выражения теперь вызывают `MemoryExtensions` вместо `Enumerable`

Эта самая неприятная, потому что код компилируется нормально и ломается только во время выполнения, когда дерево выражений интерпретируется, а не компилируется в IL.

```csharp
// C# 14, .NET 10
using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;

Expression<Func<int[], int, bool>> e = (array, num) => array.Contains(num);
var fn = e.Compile(preferInterpretation: true);
fn(new[] { 1, 2, 3 }, 2); // throws at runtime
```

В C# 13 `array.Contains(num)` внутри дерева выражений привязывался к `System.Linq.Enumerable.Contains<T>(IEnumerable<T>, T)`. В C# 14 компилятор теперь видит, что `int[]` неявно преобразуется в `ReadOnlySpan<int>`, поэтому лучше подходит перегрузка `System.MemoryExtensions.Contains<T>(ReadOnlySpan<T>, T)`. Дерево выражений строится вокруг `MemoryExtensions.Contains`. Когда вы запрашиваете интерпретацию (`preferInterpretation: true`), интерпретатор выражений LINQ не умеет обрабатывать параметры `ReadOnlySpan<T>` в произвольных вызовах методов и либо бросает `NotSupportedException`, либо, в некоторых старых провайдерах EF Core, которые транслируют дерево, `System.InvalidOperationException` о неподдерживаемом методе.

Исправление состоит в том, чтобы явно привязать не-span-перегрузку внутри лямбды. Есть три идиомы, которые работают:

```csharp
// .NET 10, C# 14
M((array, num) => ((IEnumerable<int>)array).Contains(num)); // cast forces Enumerable.Contains
M((array, num) => array.AsEnumerable().Contains(num));      // ditto, slightly less ugly
M((array, num) => Enumerable.Contains(array, num));         // explicit static call, no extension lookup

void M(Expression<Func<int[], int, bool>> e) => e.Compile(preferInterpretation: true);
```

Все три заставляют компилятор привязать `Enumerable.Contains` вместо `MemoryExtensions.Contains`. Вариант с приведением самый дешёвый во время выполнения (дерево выражений содержит только узел приведения) и я начинаю именно с него.

Если вы поддерживаете библиотеку, которая строит деревья выражений от имени вызывающих, проверьте любые пути `IQueryable.Provider.Execute` и любой код, использующий `Compile(preferInterpretation: true)`. EF Core 9 и более поздние компилируют в IL, поэтому большинство запросов EF Core не затронуты, но любой сторонний интерпретатор выражений затронут.

## Корзина 2: Assert.Equal из xUnit становится неоднозначным

Если вы когда-нибудь писали такое в тесте xUnit, у вас уже стоит ловушка:

```csharp
// .NET 10, C# 14, xUnit 2.9+
var x = new long[] { 1 };
Assert.Equal([2], x);
// CS0121: The call is ambiguous between the following methods or properties:
// 'Assert.Equal<T>(T[], T[])' and 'Assert.Equal<T>(ReadOnlySpan<T>, Span<T>)'
```

Применимы обе перегрузки. Выражение коллекции `[2]` может быть приведено по целевому типу к `long[]` или `Span<long>`. Переменная `x` имеет тип `long[]`, который неявно преобразуется как в `T[]`, так и в `Span<T>`. Единственной лучшей перегрузки нет, поэтому вы получаете `CS0121`.

Рекомендуемое исправление — устранить неоднозначность одного из аргументов:

```csharp
// .NET 10, C# 14
var x = new long[] { 1 };
Assert.Equal([2], x.AsSpan());   // binds to (ReadOnlySpan<T>, Span<T>)
// or
Assert.Equal<long>([2], x);      // generic argument disambiguates to (T[], T[]) when no Span overload matches T
```

Более тонкий вариант возникает при смешивании `T[]` и `ArraySegment<T>`:

```csharp
// .NET 10, C# 14
var y = new int[] { 1, 2 };
var s = new ArraySegment<int>(y, 1, 1);
Assert.Equal(y, s); // previously bound to Assert.Equal<T>(T, T), now ambiguous with Assert.Equal<T>(Span<T>, Span<T>)
Assert.Equal(y.AsSpan(), s); // workaround
```

У `ArraySegment<int>` есть неявное преобразование и в `Span<int>`, и в `ReadOnlySpan<int>`, и теперь у `int[]` тоже, поэтому span-перегрузка становится применимой и конкурирует с обобщённой `T, T`.

Если вы контролируете поверхность API (вы автор `Assert.Equal`), правильное исправление — применить [`OverloadResolutionPriorityAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute) к одной из перегрузок, чтобы сместить разрешение. xUnit добавил это в 2.9.x именно по этой причине. Если перекомпилировать API нельзя, придётся устранять неоднозначность в месте вызова.

## Корзина 3: ковариантные массивы бросают `ArrayTypeMismatchException`

Это тот баг, который реально удаляет данные, и причина, по которой языковой комитет сделал так, чтобы `ReadOnlySpan<T>` побеждал `Span<T>` в ничьих C# 14.

```csharp
// .NET 10, C# 14
using System;
using System.Collections.Generic;
using System.Linq;

string[] s = new[] { "a" };
object[] o = s; // array variance: legal since C# 1

C.R(o);             // C# 13: prints 1 (IEnumerable overload). C# 14: ArrayTypeMismatchException
C.R(o.AsEnumerable()); // workaround

static class C
{
    public static void R<T>(IEnumerable<T> e) => Console.Write(1);
    public static void R<T>(Span<T> s)        => Console.Write(2);
}
```

Что происходит: `object[] o` под капотом действительно является `string[]`. В C# 13 единственной применимой перегрузкой была `R<T>(IEnumerable<T>)`, поэтому печаталось `1`. В C# 14 `R<T>(Span<T>)` также применима, потому что `T[]` теперь неявно преобразуется в `Span<T>`. Компилятор выбирает span-перегрузку (она "более специфична"), вставляет вызов конструктора `Span<object>(o)`, и конструктор бросает `System.ArrayTypeMismatchException` во время выполнения, потому что нельзя записать `object` в скрытый `string[]`.

Поэтому правила ничьих C# 14 предпочитают `ReadOnlySpan<T>` перед `Span<T>`: `ReadOnlySpan<T>` не может писать в скрытый массив, поэтому он безопасен с ковариантными массивами. Рекомендуемое исправление, когда вы контролируете API, — добавить перегрузку `ReadOnlySpan<T>`:

```csharp
// .NET 10, C# 14
static class C
{
    public static void R<T>(IEnumerable<T> e)    => Console.Write(1);
    public static void R<T>(Span<T> s)           => Console.Write(2);
    public static void R<T>(ReadOnlySpan<T> s)   => Console.Write(3); // wins over Span<T> in C# 14
}
```

Теперь `C.R(o)` печатает `3` (без исключения). Когда добавить перегрузку нельзя, исправление в месте вызова — `o.AsEnumerable()` или `((IEnumerable<object>)o)`.

## Корзина 4: `MemoryMarshal.Cast` и разрешение ничьи ReadOnlySpan

Предпочтение `ReadOnlySpan<T>` также ломает некоторые библиотечные шаблоны, где автор предполагал, что вы соглашаетесь на определённую перегрузку, передавая `Span<T>`:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

double[] x = new double[0];
Span<ulong> y = MemoryMarshal.Cast<double, ulong>(x);
// CS0029: Cannot implicitly convert type 'ReadOnlySpan<ulong>' to 'Span<ulong>'
Span<ulong> z = MemoryMarshal.Cast<double, ulong>(x.AsSpan()); // workaround
```

У `MemoryMarshal.Cast` есть и `Cast<TFrom, TTo>(Span<TFrom>)`, и `Cast<TFrom, TTo>(ReadOnlySpan<TFrom>)`. В C# 13 передача `double[]` разрешалась через пользовательское преобразование в `Span<TFrom>`, потому что не было разрешения ничьей и `Span<T>` был "прямой" целью. В C# 14 обе перегрузки применимы через новые встроенные преобразования, перегрузка `ReadOnlySpan<T>` побеждает в ничьей, и результат больше не присваивается локальной переменной `Span<ulong>`. Вы либо явно вызываете `.AsSpan()`, чтобы пропустить преобразование из массива в span (оно напрямую создаёт `Span<double>`, который соответствует только перегрузке `Span`), либо меняете тип локальной переменной на `ReadOnlySpan<ulong>`, если вам не нужна изменяемость.

## Угловой случай `Enumerable.Reverse` для устаревших целевых платформ

Есть ещё одна ловушка, которая влияет только на неподдерживаемую конфигурацию, но её стоит отметить, потому что она появляется в проектах миграции legacy. Если вы устанавливаете `<LangVersion>14.0</LangVersion>`, но нацеливаетесь на более старую TFM, например `net8.0`, со ссылкой на `System.Memory`, происходит следующее:

```csharp
// LangVersion 14, TargetFramework net8.0 (unsupported)
int[] x = new[] { 1, 2, 3 };
var y = x.Reverse(); // C# 13: Enumerable.Reverse, returns IEnumerable<int>
                     // C# 14: MemoryExtensions.Reverse, void in-place reverse
```

`MemoryExtensions.Reverse(Span<T>)` инвертирует на месте и возвращает `void`, тогда как `Enumerable.Reverse(IEnumerable<T>)` возвращает обращённую последовательность. Семантика переворачивается, и `y` больше не итерируется. На `net10.0` это исправлено новой перегрузкой `Enumerable.Reverse(this T[])`, которая имеет приоритет, поэтому поломка проявляется только при смешивании нового компилятора со старой BCL. Правильное исправление — обновить TFM, но если это невозможно, явно вызывайте `Enumerable.Reverse(x)` или определите своё собственное расширение `Reverse(this T[])` в своём пространстве имён.

## Как обнаружить до запуска

Несколько практических мер для обновления в процессе:

- Установите `<LangVersion>13.0</LangVersion>` для отдельных проектов, пока проводите триаж. Возможности C# 14, не связанные со span'ами (модификаторы параметров лямбд, частичные конструкторы, ключевое слово `field`), будут отключены, но разрешение останется предсказуемым.
- Включите анализатор Roslyn [CA1872](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1872) и инспекцию ReSharper/Rider ["C# 14 breaking change in overload resolution with span parameters"](https://www.jetbrains.com/help/resharper/CSharp14OverloadResolutionWithSpanBreakingChange.html). Инспекция Rider специально подсвечивает места вызовов, где новые преобразования меняют выбранную перегрузку.
- Проведите аудит `Compile(preferInterpretation: true)` и любого стороннего потребителя деревьев выражений (например, старые провайдеры EF6, Marten 6.x, Linq2DB до 5.x). Это самые рискованные места, потому что изменение во время компиляции происходит молча.
- Найдите `Assert.Equal(`, `Assert.Contains(` и подобные утверждения с типом коллекции в своём наборе тестов. Обновите xUnit до версии с аннотациями `OverloadResolutionPriorityAttribute` (xUnit 2.9.x или новее).

Если вы автор API, самое чистое долгосрочное решение — добавить перегрузки `ReadOnlySpan<T>` рядом с любыми существующими перегрузками `Span<T>` и применить `[OverloadResolutionPriority(1)]` к той, к которой должны привязываться вызывающие. Атрибут учитывается компиляторами C# 13 и C# 14 (он игнорируется в более старых настройках `LangVersion`, и это единственная оговорка), поэтому покрывает большинство сценариев миграции.

## Связанные материалы

Если хотите контекста о том, почему вообще существуют эти преобразования, глубокое погружение в [неявные преобразования Span в C# 14 и первоклассную поддержку Span и ReadOnlySpan](/ru/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) охватывает полную таблицу преобразований и мотивацию. Более широкая публикация [что нового в C# 14](/ru/2024/12/csharp-14/) перечисляет другие ломающие изменения, которых стоит ожидать при том же обновлении, включая модификатор параметра лямбды `scoped` и контекстное ключевое слово `field`. Для предварительного просмотра будущей версии языка [аргументы выражений коллекций в C# 15](/ru/2026/04/csharp-15-collection-expression-arguments/) опираются на эти правила span и заслуживают чтения, когда вы уже комфортно разбираетесь в том, как компилятор выбирает между span- и не-span-целями.

## Источники

- [Breaking change: C# 14 overload resolution with span parameters (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [C# compiler breaking changes since C# 13 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010)
- [First-class span types proposal (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [Issue dotnet/docs#43952: covariant array overload selection](https://github.com/dotnet/docs/issues/43952)
- [OverloadResolutionPriorityAttribute (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute)
- [Rider inspection: C# 14 overload resolution with span parameters (JetBrains)](https://www.jetbrains.com/help/rider/CSharp14OverloadResolutionWithSpanBreakingChange.html)
