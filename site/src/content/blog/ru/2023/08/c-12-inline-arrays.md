---
title: "C# 12 Inline arrays"
description: "Inline arrays позволяют создать массив фиксированного размера внутри struct. Такая структура с inline-буфером по производительности сравнима с unsafe fixed size buffer. Inline arrays в первую очередь рассчитаны на команду runtime и некоторых авторов библиотек для улучшения производительности в определённых сценариях. Скорее всего..."
pubDate: 2023-08-31
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ru"
translationOf: "2023/08/c-12-inline-arrays"
translatedBy: "claude"
translationDate: 2026-05-01
---
Inline arrays позволяют создать массив фиксированного размера внутри типа `struct`. Такая структура с inline-буфером по производительности сравнима с unsafe-буфером фиксированного размера.

Inline arrays в первую очередь рассчитаны на команду runtime и некоторых авторов библиотек для улучшения производительности в определённых сценариях. Скорее всего, вы не будете объявлять свои inline arrays, но будете использовать их прозрачно, когда runtime будет отдавать их в виде `Span<T>` или `ReadOnlySpan<T>`.

## Как объявить inline array

Inline array объявляется созданием struct и применением к ней атрибута `InlineArray`, в конструктор которого передаётся длина массива.

```cs
[System.Runtime.CompilerServices.InlineArray(10)]
public struct MyInlineArray
{
    private int _element;
}
```

Примечание: имя приватного члена неважно. Можно использовать `private int _abracadabra`;, если хотите. Важен тип — он определяет тип вашего массива.

## Использование InlineArray

Inline array можно использовать примерно так же, как любой другой массив, но с небольшими отличиями. Возьмём пример:

```cs
var arr = new MyInlineArray();

for (int i = 0; i < 10; i++)
{
    arr[i] = i;
}

foreach (var item in arr)
{
    Console.WriteLine(item);
}
```

Первое, что бросается в глаза: при инициализации мы не указываем размер. Inline arrays имеют фиксированный размер, и их длина задаётся через атрибут `InlineArray`, применённый к `struct`. В остальном выглядит как обычный массив, но это ещё не всё.

### У InlineArray нет свойства Length

Некоторые могли заметить, что в цикле `for` выше мы шли до `10`, а не до `arr.Length`, и причина в том, что у inline arrays нет свойства `Length`, как у обычных массивов.

И становится ещё страннее...

### InlineArray не реализует IEnumerable

Как следствие, вы не можете вызвать `GetEnumerator` на inline array. Основной минус: LINQ на inline arrays не работает, по крайней мере пока, в будущем это может измениться.

Несмотря на то что они не реализуют `IEnumerable`, их всё ещё можно использовать в цикле `foreach`.

```cs
foreach (var item in arr) { }
```

Аналогично, inline arrays можно использовать вместе с оператором spread.

```cs
int[] m = [1, 2, 3, ..arr];
```
