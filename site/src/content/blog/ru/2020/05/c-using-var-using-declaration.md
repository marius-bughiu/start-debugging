---
title: "C# using var (using-объявление)"
description: "Используйте using-объявления C# 8 (`using var`) для освобождения объектов IDisposable без вложенных фигурных скобок. Синтаксис, правила области видимости и когда лучше использовать блок `using`."
pubDate: 2020-05-01
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ru"
translationOf: "2020/05/c-using-var-using-declaration"
translatedBy: "claude"
translationDate: 2026-05-01
---
Когда-нибудь хотели объявить нечто, что автоматически освобождается по выходу из охватывающей области видимости, не добавляя в код ещё пару фигурных скобок и отступов? Вы не одиноки. Поприветствуйте using-объявления C# 8 🥰.

С using var теперь можно сделать так:

```cs
void Foo()
{
    using var file = new System.IO.StreamWriter("myFile.txt");
    // code using file
}
```

вместо:

```cs
void Foo()
{
    using (var file = new System.IO.StreamWriter("myFile.txt"))
    {
        // code using file
    }
}
```

Никаких лишних фигурных скобок, никакой лишней индентации. Область видимости disposable совпадает с областью видимости его родителя.

Теперь более полный пример using var:

```cs
static int SplitFile(string filePath)
{
    var dir = Path.GetDirectoryName(filePath);
    using var sourceFile = new StreamReader(filePath);

    int count = 0;
    while(!sourceFile.EndOfStream)
    {
        count++;

        var line = sourceFile.ReadLine();

        var linePath = Path.Combine(dir, $"{count}.txt");
        using var lineFile = new StreamWriter(linePath);

        lineFile.WriteLine(line);

    } // lineFile is disposed here, at the end of each individual while loop

    return count;

} // sourceFile is disposed here, at the end of its enclosing scope
```

Как видно из примера выше, охватывающая область не обязательно должна быть методом. Это может быть и тело `for`, `foreach` или `while`, или даже блок `using`, если вам очень хочется. В каждом случае объект будет освобождён в конце охватывающей области видимости.

## Ошибка CS1674

using-var-объявления также сопровождаются ошибками на этапе компиляции, если выражение после `using` не является `IDisposable`.

> Error CS1674 'string': type used in a using statement must be implicitly convertible to 'System.IDisposable'.

## Лучшие практики

В части лучших практик для `using var` в основном действуют те же правила, что и при работе с using statements. Помимо них, имеет смысл:

-   объявлять disposable-переменные в начале области видимости, отдельно от остальных, чтобы они выделялись и были легко заметны при чтении кода
-   обращать внимание, в какой области вы их создаёте, потому что они будут жить на протяжении всей этой области. Если disposable-значение нужно только во вложенной области с более коротким временем жизни, разумнее создавать его именно там.
