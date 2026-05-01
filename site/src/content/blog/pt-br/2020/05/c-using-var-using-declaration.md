---
title: "C# using var (using declaration)"
description: "Use as using declarations do C# 8 (`using var`) para descartar objetos IDisposable sem chaves aninhadas. Sintaxe, regras de escopo e quando preferir blocos `using`."
pubDate: 2020-05-01
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2020/05/c-using-var-using-declaration"
translatedBy: "claude"
translationDate: 2026-05-01
---
Já desejou poder declarar algo que seja descartado automaticamente quando seu escopo terminar, sem adicionar mais um par de chaves e indentação ao seu código? Você não está sozinho. Diga olá às using declarations do C# 8 🥰.

Com using var agora você pode fazer:

```cs
void Foo()
{
    using var file = new System.IO.StreamWriter("myFile.txt");
    // code using file
}
```

em vez de:

```cs
void Foo()
{
    using (var file = new System.IO.StreamWriter("myFile.txt"))
    {
        // code using file
    }
}
```

Sem mais chaves desnecessárias, sem mais indentação. O escopo do disposable corresponde ao escopo do pai.

Agora, um exemplo mais completo de using var:

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

Como você pode notar no exemplo acima, o escopo que contém o using não precisa ser um método. Pode ser o interior de um `for`, `foreach` ou `while`, por exemplo, ou até mesmo um bloco `using`, se você for radical assim. Em cada um desses casos o objeto será descartado ao final do escopo que o contém.

## Erro CS1674

As using var declarations também trazem erros em tempo de compilação caso a expressão após `using` não seja um `IDisposable`.

> Error CS1674 'string': type used in a using statement must be implicitly convertible to 'System.IDisposable'.

## Boas práticas

Em termos de boas práticas para `using var`, basicamente siga as mesmas diretrizes que valem para using statements. Além delas, você pode:

-   declarar suas variáveis disposable no início do escopo, separadas das demais, para que se destaquem e sejam fáceis de identificar ao percorrer o código
-   prestar atenção em qual escopo as cria, pois elas viverão durante todo esse escopo. Se o valor disposable é necessário apenas dentro de um escopo filho de vida curta, pode fazer sentido criá-lo lá.
