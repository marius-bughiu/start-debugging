---
title: "Как исправить: 'Point' не имеет предопределённого размера, поэтому sizeof можно использовать только в unsafe-контексте"
description: "Исправление ошибки C#, когда sizeof нельзя использовать с Point вне unsafe-контекста. Два решения: включить unsafe-код или использовать Marshal.SizeOf."
pubDate: 2023-11-09
tags:
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2023/11/how-to-fix-point-does-not-have-a-predefined-size-therefore-sizeof-can-only-be-used-in-an-unsafe-context"
translatedBy: "claude"
translationDate: 2026-05-01
---
Эта ошибка возникает потому, что в C# оператор `sizeof` можно применять только к типам с предопределённым размером, известным во время компиляции, а структура `Point` к таким типам не относится, если только вы не находитесь в unsafe-контексте.

Решить это можно двумя способами.

## Использовать `unsafe`-код

Это позволит применять оператор `sizeof` к типам любого размера. Для этого нужно пометить метод ключевым словом `unsafe`, а также включить поддержку unsafe-кода в настройках сборки проекта.

По сути, сигнатура вашего метода изменится так:

```cs
public static unsafe void YourMethod()
{
    // ... your unsafe code
    // IntPtr sizeOfPoint = (IntPtr)sizeof(Point);
}
```

Чтобы разрешить unsafe-код, откройте свойства проекта, перейдите на вкладку `Build` и установите флажок "Allow unsafe code". После этого ошибка компиляции должна исчезнуть.

## Использовать `Marshal.SizeOf`

`Marshal.SizeOf` безопасен и не требует unsafe-контекста. Метод `SizeOf` возвращает неуправляемый размер объекта в байтах.

Нужно лишь заменить `sizeof(Point)` на `Marshal.SizeOf(typeof(Point))`. Вот так:

```cs
IntPtr sizeOfPoint = (IntPtr)Marshal.SizeOf(typeof(Point));
```

`Marshal.SizeOf` входит в пространство имён `System.Runtime.InteropServices`, поэтому убедитесь, что в начале файла есть соответствующая using-директива:

```cs
using System.Runtime.InteropServices;
```

Стоит учесть, что `Marshal.SizeOf` имеет очень небольшое снижение производительности по сравнению с unsafe-`sizeof`. Это может быть важно при выборе решения, которое лучше всего подходит вашим задачам.
