---
title: "C# 12 Interceptors"
description: "Знакомимся с interceptors из C# 12 — экспериментальной возможностью компилятора в .NET 8, позволяющей подменять вызовы методов на этапе компиляции с помощью атрибута InterceptsLocation."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2023/10/c-12-interceptors"
translatedBy: "claude"
translationDate: 2026-05-01
---
Interceptors — это экспериментальная возможность компилятора, появившаяся в .NET 8, поэтому она может измениться или вовсе исчезнуть в будущих релизах фреймворка. О том, что ещё нового в .NET 8, можно прочитать на нашей странице [What's new in .NET 8](/2023/06/whats-new-in-net-8/).

Чтобы включить эту возможность, нужно поднять feature flag, добавив `<Features>InterceptorsPreview</Features>` в `.csproj`-файл.

## Что такое interceptor?

Interceptor — это метод, который может заменить вызов перехватываемого метода вызовом самого себя. Связь между двумя методами устанавливается декларативно — через атрибут `InterceptsLocation`, а сама подмена происходит на этапе компиляции, и среда выполнения о ней ничего не знает.

Interceptors удобно сочетать с source generators, чтобы изменять существующий код, добавляя в компиляцию новый код, полностью заменяющий перехватываемый метод.

## Начало работы

Прежде чем начать использовать interceptors, нужно объявить `InterceptsLocationAttribute` в том проекте, где вы планируете перехват. Возможность всё ещё в превью, и атрибут пока не поставляется вместе с .NET 8.

Вот эталонная реализация:

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute : Attribute
    {
        public InterceptsLocationAttribute(string filePath, int line, int column)
        {
            
        }
    }
}
```

Теперь рассмотрим короткий пример того, как это работает. Начнём с очень простой схемы: класс `Foo` с методом `Interceptable` и несколько вызовов этого метода, которые мы чуть позже захотим перехватить.

```cs
var foo = new Foo();

foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(2); // "interceptable 2"
foo.Interceptable(1); // "interceptable 1"

class Foo
{
    public void Interceptable(int param)
    {
        Console.WriteLine($"interceptable {param}");
    }
}
```

Затем выполняем сам перехват:

```cs
static class MyInterceptor
{
    [InterceptsLocation(@"C:\test\Program.cs", line: 5, column: 5)]
    public static void InterceptorA(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor A: {param}");
    }

    [InterceptsLocation(@"C:\test\Program.cs", line: 6, column: 5)]
    [InterceptsLocation(@"C:\test\Program.cs", line: 7, column: 5)]
    public static void InterceptorB(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor B: {param}");
    }
}
```

Не забудьте обновить путь к файлу (`C:\test\Program.cs`) на путь к файлу с вашим перехватываемым исходным кодом. Если затем запустить всё снова, вывод вызовов `Interceptable(...)` должен превратиться в это:

```plaintext
interceptable 1
interceptor A: 1
interceptor B: 2
interceptor B: 1
```

Что за магия здесь только что произошла? Разберём детали.

### Сигнатура метода-перехватчика

Первое, что бросается в глаза, — сигнатура метода-перехватчика: это метод-расширение, у которого параметр `this` имеет тот же тип, что и владелец перехватываемого метода.

```cs
public static void InterceptorA(this Foo foo, int param)
```

Это ограничение превью, и оно будет снято до того, как функциональность выйдет из превью.

### Параметр `filePath`

Содержит путь к файлу с исходным кодом, который нужно перехватить.

Если вы применяете атрибут в source generators, нормализуйте путь к файлу так же, как это делает компилятор:

```cs
string GetInterceptorFilePath(SyntaxTree tree, Compilation compilation)
{
    return compilation.Options.SourceReferenceResolver?.NormalizePath(tree.FilePath, baseFilePath: null) ?? tree.FilePath;
}
```

### `line` и `column`

Это позиции с нумерацией от 1, указывающие точное место вызова перехватываемого метода.

В случае `column` положение вызова — это позиция первой буквы имени перехватываемого метода. Например:

-   для `foo.Interceptable(...)` это будет позиция буквы `I`. Если перед кодом нет пробелов, то `5`.
-   для `System.Console.WriteLine(...)` это будет позиция буквы `W`. Без пробелов перед кодом `column` равно `16`.

### Ограничения

Interceptors работают только с обычными методами. Сейчас перехватить конструкторы, свойства или локальные функции нельзя, но список поддерживаемых членов в будущем может измениться.
