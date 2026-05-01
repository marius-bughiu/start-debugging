---
title: "C# 13: o fim das alocações de `params`"
description: "O C# 13 finalmente elimina a alocação oculta de array por trás de params. Agora você pode usar params com Span, ReadOnlySpan, List e outros tipos de coleção para métodos variádicos sem alocação."
pubDate: 2026-01-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "pt-br"
translationOf: "2026/01/c-13-the-end-of-params-allocations"
translatedBy: "claude"
translationDate: 2026-05-01
---
Por mais de duas décadas, a palavra-chave `params` no C# trouxe junto um imposto oculto: alocações implícitas de array. Toda vez que você chamava um método como `string.Format` ou um helper próprio com um número variável de argumentos, o compilador criava silenciosamente um novo array. Em cenários de alto desempenho (hot paths), essas alocações somavam, gerando pressão desnecessária sobre a coleta de lixo (GC).

Com C# 13 e .NET 9, esse imposto está finalmente sendo revogado. Agora você pode usar `params` com tipos de coleção que não sejam arrays, incluindo `Span<T>` e `ReadOnlySpan<T>`.

## O imposto do array

Considere um método de logging típico antes do C# 13.

```cs
// Old C# way
public void Log(string message, params object[] args)
{
    // ... logic
}

// Usage
Log("User {0} logged in", userId); // Allocates new object[] { userId }
```

Mesmo passando um único inteiro, o runtime precisava alocar um array no heap. Para bibliotecas como Serilog ou logging do ASP.NET Core, isso significava bolar soluções criativas ou sobrecarregar métodos com 1, 2, 3... argumentos para evitar o array.

## Zero alocações com `params ReadOnlySpan<T>`

O C# 13 permite o modificador `params` em qualquer tipo que suporte expressões de coleção. A mudança de maior impacto é o suporte a `ReadOnlySpan<T>`.

```cs
// C# 13 way
public void Log(string message, params ReadOnlySpan<object> args)
{
    // ... logic using span
}

// Usage
// Compiler uses stack allocation or shared buffers!
Log("User {0} logged in", userId);
```

Quando você chama esse novo método, o compilador é esperto o bastante para passar os argumentos via um buffer alocado na pilha (com `stackalloc`) ou outras otimizações, ignorando completamente o heap.

## Além dos arrays

Não é só sobre desempenho. `params` agora suporta `List<T>`, `HashSet<T>` e `IEnumerable<T>`. Isso melhora a flexibilidade da API, permitindo definir a _intenção_ da estrutura de dados em vez de forçar um array.

```cs
public void ProcessTags(params HashSet<string> tags) 
{
    // O(1) lookups immediately available
}

ProcessTags("admin", "editor", "viewer");
```

## Quando migrar

Se você mantém uma biblioteca ou uma aplicação sensível a desempenho rodando no .NET 9, audite seus métodos `params`.

1.  Troque `params T[]` por `params ReadOnlySpan<T>` se só precisa ler os dados.
2.  Troque para `params IEnumerable<T>` se precisa de execução adiada ou flexibilidade genérica.

Essa pequena mudança na assinatura pode reduzir significativamente o tráfego de memória ao longo do ciclo de vida da sua aplicação.
