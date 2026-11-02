---
title: "C# UnsafeAccessor: приватные члены без рефлексии (.NET 8)"
description: "Доступ к известным приватным конструкторам, методам, свойствам и полям через UnsafeAccessor в .NET 8: проверенные примеры и ограничения версий."
pubDate: 2023-10-31
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
`UnsafeAccessorAttribute`, появившийся в .NET 8, связывает метод `static extern` с известным недоступным членом. Реализацию предоставляет среда выполнения. Это полезно, когда объявляющий тип и сигнатура известны при компиляции; для поиска членов во время выполнения рефлексия по-прежнему нужна.

**Исправление — 2 ноября 2026 года:** исходная статья ошибочно исключала перегрузки и требовала экземпляр для статического доступа. Ниже это исправлено. Восстановленный пример выполнен на .NET 8.0.33; производительность рассматривается отдельно, без обещания универсальных нулевых накладных расходов.

## Скачать полный пример

[Скачайте исполняемый исходный проект ZIP](/examples/unsafe-accessor.zip) или откройте [инструкции](/examples/#unsafe-accessor). Включены проект, объявляющие типы, импорты и проверки всех приведённых способов доступа.

```sh
dotnet run -c Release
```

Программа проверяет ожидаемые значения и завершается с ошибкой при несовпадении. Успешный запуск выводит:

```text
PASS: constructors, instance/static members, field access, readonly accessor observation
```

## Приватные конструкторы и перегрузки

В классе-помощнике разрешены обычные перегрузки методов C#. Аксессор конструктора возвращает объявляющий тип и принимает параметры целевого конструктора:

```cs
using System.Runtime.CompilerServices;

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create();

    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create(string value);
}
```

Эти объявления связываются с `Foo()` и `Foo(string)`. Полный тип `Foo` находится в ZIP. У локальных функций верхнего уровня и методов класса-помощника разные правила имён C#; это не ограничение `UnsafeAccessor`.

## Методы экземпляра и свойства

Первый параметр задаёт объявляющий тип и передаёт экземпляр. Остальные типы параметров и результата должны соответствовать цели. Доступ к свойствам осуществляется через методы-аксессоры:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
internal static extern string CallInstance(Foo instance, int value);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
internal static extern string GetProperty(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
internal static extern void SetProperty(Foo instance, string value);
```

Пример проверяет результат приватного метода, читает исходное значение свойства, изменяет его и читает снова. Для членов экземпляра структуры первый параметр нужно передавать по `ref`.

## Статические члены

Используйте `StaticMethod` или `StaticField`. Первый параметр по-прежнему определяет объявляющий тип, но **его значение не используется** и может быть null:

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
internal static extern string CallStatic(Foo? typeMarker, int value);

var result = Accessors.CallStatic(null, 42);
```

Здесь объявляющий тип — нестатический класс. C# не допускает статические классы в качестве типов параметров; нельзя заключать, что этим приёмом .NET 8 доступен любой API статического класса.

## Поля

Аксессор поля возвращает ссылку. Пример читает и изменяет поля экземпляра и статические поля:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
internal static extern ref int InstanceField(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
internal static extern ref int StaticField(Foo? typeMarker);
```

Для readonly-полей см. [отдельный пример](/ru/2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor/). Получение ссылки на поле не делает произвольную мутацию неизменяемого состояния поддерживаемым подходом.

## Ограничения и производительность

Поиск выполняется только в указанном объявляющем типе; иерархия наследования не обходится. Отсутствующие привязки к полям и методам вызывают ошибку при использовании. Неверные сигнатуры и ограничения могут приводить к другим ошибкам связывания. Поддержка generic-параметров появилась в .NET 9, поэтому для таких примеров нужна отдельная проверка версии.

Аксессор может избежать поиска через рефлексию и обработки аргументов `Invoke`, но стоимость целевой операции и сгенерированного кода сохраняется. [Восстановленный benchmark](/ru/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) включает прямой вызов, кешированную рефлексию и кешированный делегат с наблюдаемой работой.

Источник: [справочник Microsoft по UnsafeAccessorAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute).
