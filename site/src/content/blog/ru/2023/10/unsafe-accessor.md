---
title: "C# UnsafeAccessor: приватные члены без рефлексии (.NET 8)"
description: "Используйте атрибут `[UnsafeAccessor]` в .NET 8, чтобы читать приватные поля и вызывать приватные методы без накладных расходов: без рефлексии и с полной поддержкой AOT."
pubDate: 2023-10-31
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Рефлексия позволяет получать информацию о типах во время выполнения и с её помощью обращаться к приватным членам класса. Это особенно полезно при работе с классами, которые вы не контролируете — например, поставленными сторонним пакетом. Несмотря на свою мощь, рефлексия очень медленна, и это одна из главных причин, по которым её стараются избегать. Теперь это в прошлом.

В .NET 8 появился новый способ обращения к приватным членам без накладных расходов — через атрибут `UnsafeAccessor`. Атрибут можно применить к методу `extern static`. Реализацию метода предоставит среда выполнения на основе информации из атрибута и сигнатуры метода. Если по предоставленной информации не найдено совпадение, вызов метода выбросит либо `MissingFieldException`, либо `MissingMethodException`.

Рассмотрим несколько примеров использования `UnsafeAccessor`. Возьмём следующий класс с приватными членами:

```cs
class Foo
{
    private Foo() { }
    private Foo(string value) 
    {
        InstanceProperty = value;
    }

    private string InstanceProperty { get; set; } = "instance-property";
    private static string StaticProperty { get; set; } = "static-property";

    private int instanceField = 1;
    private static int staticField = 2;

    private string InstanceMethod(int value) => $"instance-method:{value}";
    private static string StaticMethod(int value) => $"static-method:{value}";
}
```

## Создание экземпляров объектов через приватные конструкторы

Как описано выше, начинаем с объявления методов `static extern`.

-   помечаем методы атрибутом `UnsafeAccessor`: `[UnsafeAccessor(UnsafeAccessorKind.Constructor)]`
-   и подбираем сигнатуры конструкторов. В случае с конструкторами тип возвращаемого значения должен совпадать с типом класса, на который мы перенаправляем (`Foo`). Список параметров тоже должен совпадать.
-   имя extern-метода ни с чем не обязано совпадать и не должно следовать какой-либо конвенции. Один важный момент: нельзя иметь два метода `extern static` с одинаковым именем, но разными параметрами — это похоже на перегрузку, поэтому для каждой перегрузки нужно указывать уникальное имя.

В итоге у вас должно получиться так:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructor();

[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructorWithParameters(string value);
```

После этого создание экземпляров через приватные конструкторы становится тривиальным.

```cs
var instance1 = PrivateConstructor();
var instance2 = PrivateConstructorWithParameters("bar");
```

## Вызов приватных методов экземпляра

Первым аргументом метода `extern static` будет экземпляр объекта типа, содержащего приватный метод. Остальные аргументы должны соответствовать сигнатуре целевого метода. Тип возвращаемого значения тоже должен совпадать.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
extern static string InstanceMethod(Foo @this, int value);

Console.WriteLine(InstanceMethod(instance1, 42)); 
// Output: "instance-method:42"
```

## Чтение / запись приватных свойств экземпляра

Вы заметите, что нет `UnsafeAccessorKind.Property`. Это потому, что, как и методы экземпляра, свойства экземпляра можно вызывать через их методы getter и setter:

-   `get_{PropertyName}`
-   `set_{PropertyName}`

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
extern static string InstanceGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
extern static void InstanceSetter(Foo @this, string value);

Console.WriteLine(InstanceGetter(instance1));
// Output: "instance-property"

InstanceSetter(instance1, "bar");

Console.WriteLine(InstanceGetter(instance1));
// Output: "bar"
```

## Статические методы и свойства

Они ведут себя точно так же, как члены экземпляра, с единственным отличием: в атрибуте `UnsafeAccessor` нужно указать `UnsafeAccessorKind.StaticMethod`. При вызове необходимо даже передавать экземпляр объекта этого типа.

А что насчёт `static`-классов? Статические классы пока не поддерживаются `UnsafeAccessor`. Существует предложение по API, нацеленное на закрытие этого пробела в .NET 9: [\[API Proposal\]: UnsafeAccessorTypeAttribute for static or private type access](https://github.com/dotnet/runtime/issues/90081)

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
extern static string StaticMethod(Foo @this, int value);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "get_StaticProperty")]
extern static string StaticGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "set_StaticProperty")]
extern static void StaticSetter(Foo @this, string value);
```

## Приватные поля

С полями всё немного особеннее, что касается синтаксиса метода `extern static`. У нас больше нет доступных методов getter и setter, поэтому вместо них используем ключевое слово `ref`, чтобы получить ссылку на поле, которую можно использовать как для чтения, так и для записи значения.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
extern static ref int InstanceField(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
extern static ref int StaticField(Foo @this);

// Read the field value
var x = InstanceField(instance1);
var y = StaticField(instance1);

// Update the field value
InstanceField(instance1) = 3;
StaticField(instance1) = 4;
```

Хотите попробовать этот функционал? Все приведённые выше примеры можно [найти на GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor/Program.cs).
