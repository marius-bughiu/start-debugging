---
title: "C#: как изменить readonly-поле через UnsafeAccessor"
description: "Исполняемый пример .NET 8 с readonly-полем, открытым через UnsafeAccessor: явные ограничения изменения и наблюдаемое поведение."
pubDate: 2023-11-02
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
UnsafeAccessor в .NET 8 может предоставить ссылку на поле экземпляра, в том числе объявленное `readonly`. Запись через ссылку обходит обычные правила присваивания C#. Это не меняет объявление поля и не даёт общих гарантий для оптимизированных чтений неизменяемого состояния.

**Исправление — 2 ноября 2026 года:** недоступный пример восстановлен. Удалены общее утверждение о производительности и безусловный результат прямого чтения; проверенный пример наблюдает значение через аксессор.

## Исполняемый пример

[Скачайте полный пример](/examples/unsafe-accessor.zip). Помимо приватных членов он показывает следующий случай readonly:

```cs
using System.Runtime.CompilerServices;

var holder = new ReadonlyHolder();
Accessors.ReadonlyField(holder) = 42;
Console.WriteLine(Accessors.ReadonlyField(holder)); // 42 in the verified run

internal sealed class ReadonlyHolder
{
    public readonly int Value = 3;
}

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "Value")]
    internal static extern ref int ReadonlyField(ReadonlyHolder instance);
}
```

Запустите загруженный проект командой `dotnet run -c Release`. Полный пример проверяет исходное значение, выполняет запись и проверяет результат аксессора на .NET 8.0.33.

## Что это доказывает

Сигнатура соответствует объявляющему типу, имени и типу поля. Возврат `ref int` позволяет выполнить показанное присваивание. Это не гарантирует одинаковое поведение записей через другие ссылки, конкурентных изменений и всех оптимизаций JIT/AOT. Прямое чтение в другом месте нельзя считать универсальным обещанием поддержки мутации.

Для состояния приложения предпочтительнее инициализация в конструкторе или явно изменяемый API. Запись через рефлексию в поля экземпляра и static readonly-поля также имеет разные ограничения среды выполнения; эти случаи не взаимозаменяемы.

Обычные аксессоры описаны в [руководстве по доступу к членам](/ru/2023/10/unsafe-accessor/), измерение путей вызова — в [benchmark-проекте](/ru/2023/11/net-8-performance-unsafeaccessor-vs-reflection/). [Официальный справочник](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) объясняет сигнатуры и ограничения версий.
