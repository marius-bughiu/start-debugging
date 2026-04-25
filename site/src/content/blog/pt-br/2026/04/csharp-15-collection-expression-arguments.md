---
title: "Argumentos em expressões de coleção do C# 15: passe construtores inline com with(...)"
description: "C# 15 adiciona o elemento with(...) às expressões de coleção, permitindo que você passe capacidade, comparadores, e outros argumentos do construtor diretamente no inicializador."
pubDate: 2026-04-13
tags:
  - "csharp-15"
  - "dotnet-11"
  - "collection-expressions"
lang: "pt-br"
translationOf: "2026/04/csharp-15-collection-expression-arguments"
translatedBy: "claude"
translationDate: 2026-04-25
---

Expressões de coleção chegaram no C# 12 e têm absorvido novos recursos desde então. C# 15, que vem com o [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), adiciona uma peça que faltava: você pode agora passar argumentos para o construtor ou método de fábrica da coleção com um elemento `with(...)` colocado no início da expressão.

## Por que isto importa

Antes do C# 15, expressões de coleção inferiam o tipo alvo e chamavam seu construtor padrão. Se você precisasse de um `HashSet<string>` insensível a maiúsculas/minúsculas ou de um `List<T>` pré-dimensionado para uma capacidade conhecida, tinha que recorrer a um inicializador tradicional ou a uma configuração em dois passos:

```csharp
// C# 14 and earlier: no way to pass a comparer via collection expression
var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Hello", "HELLO" };

// Or the awkward two-step
List<string> names = new(capacity: 100);
names.AddRange(source);
```

Ambos os padrões quebram o fluxo conciso para o qual as expressões de coleção foram projetadas.

## Argumentos de construtor inline com `with(...)`

C# 15 permite que você escreva isto em vez:

```csharp
string[] values = ["one", "two", "three"];

// Pre-allocate capacity
List<string> names = [with(capacity: values.Length * 2), .. values];

// Case-insensitive set in a single expression
HashSet<string> set = [with(StringComparer.OrdinalIgnoreCase), "Hello", "HELLO", "hello"];
// set.Count == 1
```

O elemento `with(...)` deve aparecer primeiro. Depois dele, o resto da expressão funciona exatamente como qualquer outra expressão de coleção: literais, spreads, e expressões aninhadas todas se compõem normalmente.

## Dicionários recebem o mesmo tratamento

O recurso realmente brilha com `Dictionary<TKey, TValue>`, onde comparadores são comuns mas antes te forçavam a abandonar as expressões de coleção completamente:

```csharp
Dictionary<string, int> headers = [
    with(StringComparer.OrdinalIgnoreCase),
    KeyValuePair.Create("Content-Length", 512),
    KeyValuePair.Create("content-length", 1024)  // overwrites the first entry
];
// headers.Count == 1
```

Sem `with(...)`, você não poderia passar um comparador através de uma expressão de coleção de jeito nenhum. A única opção era uma chamada de construtor seguida de adições manuais.

## Restrições a saber

Algumas regras para ter em mente:

- `with(...)` deve ser o **primeiro** elemento na expressão.
- Não é suportado em arrays ou tipos span (`Span<T>`, `ReadOnlySpan<T>`), já que esses não têm construtores com parâmetros de configuração.
- Argumentos não podem ter tipo `dynamic`.

## Uma evolução natural

C# 12 nos deu a sintaxe. C# 13 estendeu `params` para aceitar expressões de coleção. C# 14 ampliou as conversões implícitas de span. Agora C# 15 remove a última razão comum para abandonar as expressões de coleção: configuração do construtor. Se você já está no [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) ou posterior, pode experimentar isto hoje com `<LangVersion>preview</LangVersion>` no seu arquivo de projeto.

Spec completa: [Proposta de argumentos em expressões de coleção](https://github.com/dotnet/csharplang/blob/main/proposals/collection-expression-arguments.md).
