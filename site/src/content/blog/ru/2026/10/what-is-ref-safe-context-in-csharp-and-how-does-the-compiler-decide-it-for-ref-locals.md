---
title: "Что такое ref-safe-context в C# и как компилятор определяет его для ref-локальных переменных?"
description: "Правила выхода ссылок C# на проверенных компилятором примерах: ref-локальные, переприсваивание, scoped и Span с памятью в куче или стеке."
pubDate: 2026-10-15
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "ref-locals"
  - "span"
  - "compiler-errors"
lang: "ru"
translationOf: "2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals"
translatedBy: "claude"
translationDate: 2026-10-15
---
Ссылка не должна выходить за время жизни памяти, на которую указывает. C# проверяет эту связь при компиляции. Локальную `ref`-переменную, инициализированную из локальной переменной метода, нельзя вернуть лишь потому, что позже ей переприсвоили ссылку на элемент массива.

**Исправление — 2 ноября 2026 года:** прежнее утверждение о проверке на .NET 11 RC1 не было подкреплено сохранёнными доказательствами и удалено. Положительные и отрицательные примеры здесь скомпилированы с SDK 10.0.302, `net10.0` и `LangVersion` 14. Коды ошибок относятся к этим точным формам кода; похожие выражения могут давать другие диагностические сообщения.

## Ref-safe-context и safe-context

`ref-safe-context` относится к ссылке на память. Связанный `safe-context` — к значению, которое само может содержать ссылки, например `Span<T>`. Локальная переменная со span и описываемая им память — разные вещи.

Спецификация языка описывает четыре вложенных контекста:

| Контекст | Типичный пример |
| --- | --- |
| declaration-block | Ссылка на обычную локальную переменную |
| function-member | Параметр по значению или scoped-параметр |
| return-only | Обычный `ref`-параметр, который можно вернуть |
| caller-context | Элемент массива или подходящее поле класса |

Эти названия не означают, что любая память живёт до возврата из метода. Вложенные блоки и ограничения `scoped` всё ещё важны. [Спецификация](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/variables#972-ref-safe-contexts) содержит полные правила, включая параметры и вызовы.

## Инициализатор ограничивает ref-локальную без scoped

Этот отрицательный пример даёт CS8157 в проверенной сборке:

```csharp
class Example
{
    static ref int CannotReturn(int[] array)
    {
        int local = 1;
        ref int reference = ref local;
        reference = ref array[0];
        return ref reference; // CS8157
    }
}
```

Последующее переприсваивание разрешено, но не превращает ссылку, полученную из локальной переменной, в возвращаемую. Непосредственный возврат обычной локальной переменной даёт CS8168:

```csharp
class Example
{
    static ref int CannotReturn()
    {
        int local = 1;
        return ref local; // CS8168
    }
}
```

## Переприсваивание не принимает более узкую ссылку

Если начать со ссылки на элемент массива и затем присвоить ссылку на локальную переменную, возникает CS8374:

```csharp
class Example
{
    static void CannotNarrow(int[] array)
    {
        ref int reference = ref array[0];
        int local = 1;
        reference = ref local; // CS8374
    }
}
```

У `ref`-параметра другой контракт выхода, чем у элемента массива. Инициализация из массива с последующим присваиванием параметра даёт CS9079:

```csharp
class Example
{
    static ref int CannotAssign(int[] array, ref int parameter)
    {
        ref int reference = ref array[0];
        reference = ref parameter; // CS9079
        return ref reference;
    }
}
```

Обратный порядок успешно скомпилировался в той же проверке:

```csharp
class Example
{
    static ref int CanReturn(int[] array, ref int parameter)
    {
        ref int reference = ref parameter;
        reference = ref array[0];
        return ref reference;
    }
}
```

Выбирайте инициализатор с контрактом, подходящим для всех предполагаемых применений. Перенос объявлений или добавление `scoped` не является универсальным исправлением ошибок выхода ссылок.

## Scoped-ссылки остаются локальными

Это изменение внутри одного блока успешно скомпилировалось:

```csharp
class Example
{
    static void LocalUse(int[] array)
    {
        scoped ref int reference = ref array[0];
        int local = 1;
        reference = ref local;
        reference = 5;
    }
}
```

Возврат этой scoped-ссылки запрещён. Отдельная проверка, где `local` объявлена в более узком вложенном блоке, также отклонила переприсваивание с CS8374. `scoped` не отменяет ограничения времени жизни блоков и не делает ссылку возвращаемой.

Scoped-параметр также может сообщать, что аргумент не выходит через результат метода. Это контракт сигнатуры; компилятору не требуется изучать реализацию произвольного вспомогательного метода. Подробные правила и случаи `[UnscopedRef]` описаны в [предложении C# 11](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-11.0/low-level-struct-improvements.md).

## Span не обязательно ссылается на стек

Оба примера объявляют локальный span, но выйти наружу может только первый результат:

```csharp
using System;

class Example
{
    static ref int HeapBacked()
    {
        Span<int> values = new int[2];
        return ref values[0]; // Compiles in the verified probe
    }

    static ref int StackBacked()
    {
        Span<int> values = stackalloc int[2];
        return ref values[0]; // CS8352 in this exact probe
    }
}
```

Span на основе массива описывает память управляемой кучи. Вернуть ссылку в эту память — не то же самое, что вернуть ссылку на саму локальную переменную span. Управляемые ссылки сохраняют достижимость своих объектов; это не означает, что объекты кучи бессмертны.

Для практического алгоритма с ref-результатом используйте span от вызывающей стороны и обработайте пустой вход:

```csharp
using System;

static ref int MaxRef(Span<int> values)
{
    if (values.IsEmpty)
        throw new ArgumentException("At least one element is required", nameof(values));

    ref int best = ref values[0];
    for (int i = 1; i < values.Length; i++)
        if (values[i] > best) best = ref values[i];
    return ref best;
}

int[] data = { 3, 9, 4 };
MaxRef(data) = 0;
Console.WriteLine(string.Join(",", data)); // 3,0,4
```

## Читайте диагностику в контексте

Проверки различают прямой возврат локальной переменной (CS8168), невозвращаемую ref-локальную (CS8157), присваивание более узкой ссылки (CS8374) и return-only-параметр, присваиваемый более широкой ссылке (CS9079). Прямое выражение со стековым span выше дало CS8352. Дополнительный псевдоним или вспомогательный вызов может поменять диагностику, не меняя проблему времени жизни.

Ограничения async/итераторов — отдельный вопрос: ссылку нельзя сохранять через точку приостановки, когда язык это запрещает. Не объясняйте любой отказ компилятора только правилом инициализатора.

Связанные материалы: [Span<T> и его память](/ru/2026/06/what-is-span-and-when-does-it-make-my-code-faster/), [List, Span и ReadOnlySpan](/ru/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) и [объявления ссылочных переменных](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/declarations#reference-variables).
