---
title: "C# 11 - Обобщённые атрибуты"
description: "Узнайте, как определять и использовать обобщённые атрибуты в C# 11, включая ограничения на аргументы типов и распространённые сообщения об ошибках."
pubDate: 2023-03-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ru"
translationOf: "2023/03/c-sharp-11-generic-attributes"
translatedBy: "claude"
translationDate: 2026-05-01
---
Друзья, обобщённые атрибуты наконец-то появились в C#! 🥳

Их можно определить так же, как и любой другой обобщённый класс:

```cs
public class GenericAttribute<T> : Attribute { }
```

И использовать как любой другой атрибут:

```cs
[GenericAttribute<string>]
public class MyClass { }
```

## Ограничения обобщённых атрибутов

При применении атрибута необходимо указать все аргументы обобщённого типа. Иначе говоря, обобщённый атрибут должен быть полностью сконструирован.

Например, такое работать не будет:

```cs
public class MyGenericType<T>
{
    [GenericAttribute<T>()]
    public string Foo { get; set; }
}
```

Типы, требующие аннотаций в метаданных, не допускаются в качестве аргументов типов обобщённого атрибута. Рассмотрим примеры того, что не разрешено, и альтернативы:

-   `dynamic` не разрешён. Используйте `object`
-   ссылочные типы, допускающие null, не разрешены. Вместо `string?` можно просто использовать `string`
-   типы кортежей с использованием синтаксиса C# не разрешены. Вместо них можно использовать `ValueTuple` (например, `ValueTuple<string, int>` вместо `(string foo, int bar)`)

## Ошибки

> CS8968 'T': an attribute type argument cannot use type parameters

Эта ошибка означает, что вы указали не все аргументы типов для атрибута. Обобщённые атрибуты должны быть полностью сконструированы, то есть нельзя использовать параметры **T** при их применении (см. примеры выше).

> CS8970 Type 'string' cannot be used in this context because it cannot be represented in metadata.

Ссылочные типы, допускающие null, не разрешены в качестве параметров типа в обобщённых атрибутах. Используйте `string` вместо `string?`.

> CS8970 Type 'dynamic' cannot be used in this context because it cannot be represented in metadata.

`dynamic` нельзя использовать в качестве аргумента типа для обобщённого атрибута. Используйте `object`.

> CS8970 Type '(string foo, int bar)' cannot be used in this context because it cannot be represented in metadata.

Кортежи не разрешены в качестве параметра типа в обобщённых атрибутах. Используйте эквивалентный `ValueTuple`.
