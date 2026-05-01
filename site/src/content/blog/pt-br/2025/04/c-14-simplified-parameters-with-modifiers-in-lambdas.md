---
title: "C# 14: Parâmetros simplificados com modificadores em lambdas"
description: "O C# 14 permite usar os modificadores ref, out, in, scoped e ref readonly em parâmetros de lambda com tipo implícito, eliminando a necessidade de declarar explicitamente os tipos dos parâmetros."
pubDate: 2025-04-09
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2025/04/c-14-simplified-parameters-with-modifiers-in-lambdas"
translatedBy: "claude"
translationDate: 2026-05-01
---
As expressões lambda são um recurso central do C# há muitos anos, permitindo que desenvolvedores escrevam funções inline ou callbacks de forma concisa. No C#, uma lambda pode ter **parâmetros com tipo explícito** (em que você especifica o tipo de cada parâmetro) ou **parâmetros com tipo implícito** (em que os tipos são inferidos pelo contexto). Antes do C# 14, se você quisesse usar certos modificadores de parâmetro em uma lambda (como passar por referência ou parâmetros de saída), era obrigado a declarar os tipos dos parâmetros explicitamente. Isso costumava resultar em uma sintaxe mais verbosa nos cenários em que esses modificadores eram necessários.

O C# 14 introduz um novo recurso que aborda essa limitação: **parâmetros simples de lambda com modificadores**. Esse recurso permite usar modificadores de parâmetro como `ref`, `in`, `out`, `scoped` e `ref readonly` em uma expressão lambda **sem** precisar escrever explicitamente os tipos dos parâmetros. Em termos mais simples, agora você pode adicionar esses modificadores a parâmetros de lambda "sem tipo" (parâmetros cujos tipos são inferidos), tornando lambdas com modos especiais de passagem de parâmetros mais fáceis de escrever e ler.

## Lambdas no C# 13 e versões anteriores

No C# 13 e em todas as versões anteriores, os parâmetros de lambda podiam ser tipados de forma explícita ou implícita, mas havia um detalhe ao usar modificadores de parâmetro. Se algum parâmetro da lambda precisasse de um modificador (por exemplo, um parâmetro `out` ou `ref`), o compilador de C# exigia que **todos** os parâmetros daquela lambda tivessem um tipo explícito declarado. Você não podia aplicar `ref`, `in`, `out`, `scoped` ou `ref readonly` a um parâmetro de lambda a menos que também escrevesse o tipo dele.

Por exemplo, imagine um tipo de delegate que tem um parâmetro `out`:

```cs
// A delegate that tries to parse a string into T, returning true on success.
delegate bool TryParse<T>(string text, out T result);
```

Se você quisesse atribuir uma lambda a esse delegate no C# 13, tinha que incluir os tipos de ambos os parâmetros explicitamente, porque um deles usa o modificador `out`. Uma atribuição de lambda válida no C# 13 ficaria assim:

```cs
// C# 13 and earlier: must explicitly specify types when using 'out'
TryParse<int> parseOld = (string text, out int result) => Int32.TryParse(text, out result);
```

Aqui escrevemos `string` para o parâmetro `text` e `int` para o parâmetro `result`. Se você tentasse omitir os tipos, o código não compilaria. Em outras palavras, algo como `(text, out result) => ...` **não** era permitido no C# 13, porque a presença do `out` em `result` exigia que o tipo de `result` (`int` neste caso) fosse declarado explicitamente. Esse requisito se aplicava a qualquer um dos modificadores `ref`, `in`, `out`, `ref readonly` e `scoped` em listas de parâmetros de lambda.

## Modificadores de parâmetros de lambda no C# 14

O C# 14 remove essa restrição e torna as lambdas mais flexíveis. Agora você pode adicionar modificadores de parâmetros aos parâmetros da lambda sem fornecer o tipo do parâmetro explicitamente. O compilador inferirá os tipos a partir do contexto (como o tipo do delegate ou da árvore de expressão para o qual a lambda está sendo convertida) sem deixar de suportar os modificadores. Essa melhoria significa menos boilerplate e código mais legível ao trabalhar com delegates ou expressões que envolvem parâmetros por referência ou scoped.

**Modificadores suportados:** Você pode usar os modificadores a seguir em parâmetros de lambda com tipo implícito a partir do C# 14:

-   `ref` -- passa o argumento por referência, permitindo que a lambda leia ou modifique a variável de quem chamou.
-   `out` -- passa o argumento por referência, designado para saída; a lambda deve atribuir um valor a esse parâmetro antes de retornar.
-   `in` -- passa o argumento por referência como somente leitura; a lambda pode ler o valor, mas não pode modificá-lo.
-   `ref readonly` -- passa por referência de forma somente leitura (essencialmente similar a `in`, introduzido para suportar certos cenários com tipos por valor).
-   `scoped` -- indica que um parâmetro (tipicamente um ref struct como `Span<T>`) está restrito ao chamador, impedindo que ele seja capturado ou armazenado além da chamada.

Antes, esses modificadores só podiam ser usados se você declarasse os tipos dos parâmetros explicitamente na lambda. Agora você pode escrevê-los na lista de parâmetros de uma lambda sem tipos.

Uma ressalva importante é que o modificador `params` **não** está incluído nesse novo recurso. Se uma lambda tiver um parâmetro `params` (para um número variável de argumentos), você ainda precisa especificar o tipo do parâmetro explicitamente. Em resumo, `params` continua exigindo uma lista de parâmetros com tipo explícito em lambdas.

Vamos revisitar o exemplo anterior usando o delegate `TryParse<T>` para ver como o C# 14 simplifica a sintaxe. Agora podemos omitir os nomes dos tipos e ainda usar o modificador `out`:

```cs
// C# 14: type inference with 'out' parameter
TryParse<int> parseNew = (text, out result) => Int32.TryParse(text, out result);
```

Essa lambda é atribuída a `TryParse<int>`, então o compilador sabe que `text` é um `string` e `result` é um `int` a partir da definição do delegate. Conseguimos escrever `(text, out result) => ...` sem especificar os tipos explicitamente, e o código compila e funciona corretamente. O modificador `out` é aplicado a `result` mesmo sem escrevermos `int`. O C# 14 infere isso para nós, o que torna a declaração da lambda mais curta e evita repetir informações que o compilador já conhece.

O mesmo princípio vale para outros modificadores. Considere um delegate que recebe um parâmetro por referência:

```cs
// A delegate that doubles an integer in place.
delegate void Doubler(ref int number);
```

No C# 13, para criar uma lambda que correspondesse a esse delegate, você teria que incluir o tipo junto com o modificador `ref`:

```cs
// C# 13: explicit type needed for 'ref' parameter
Doubler makeDoubleOld = (ref int number) => number *= 2;
```

Com o C# 14, você pode omitir o tipo e escrever apenas o modificador e o nome do parâmetro:

```cs
// C# 14: implicit type with 'ref' parameter
Doubler makeDoubleNew = (ref number) => number *= 2;
```

Aqui, o contexto (o delegate `Doubler`, que recebe um `ref int` e retorna void) diz ao compilador que `number` é um `int`, então não precisamos detalhar isso. Simplesmente usamos `ref number` na lista de parâmetros da lambda.

Você também pode usar vários modificadores juntos ou outras formas desses modificadores da mesma maneira. Por exemplo, se você tem um delegate com um parâmetro `ref readonly` ou um parâmetro `scoped`, o C# 14 permite que você os escreva sem tipos explícitos também. Por exemplo:

```cs
// A delegate with an 'in' (readonly ref) parameter
delegate void PrintReadOnly(in DateTime value);

// C# 14: using 'in' without explicit type
PrintReadOnly printDate = (in value) => Console.WriteLine(value);
```

De forma similar, se tivermos um delegate com um parâmetro `scoped`:

```cs
// A delegate that takes a scoped Span<int>
delegate int SumElements(scoped Span<int> data);

// C# 14: using 'scoped' without explicit type
SumElements sum = (scoped data) =>
{
    int total = 0;
    foreach (int x in data)
        total += x;
    return total;
};
```

Aqui, `data` é conhecido como `Span<int>` (um tipo restrito à pilha) por causa do delegate, e o marcamos como `scoped` sem escrever o nome do tipo. Isso garante que `data` não possa ser capturado fora da lambda (seguindo a semântica de `scoped`), exatamente como aconteceria se tivéssemos escrito `(scoped Span<int> data)`.

## Quais benefícios isso traz

Permitir parâmetros simples de lambda com modificadores deixa o código mais limpo e reduz repetição. Em versões anteriores do C#, usar parâmetros por referência ou scoped em lambdas significava escrever tipos que o compilador já conseguia deduzir. Agora você pode deixar o compilador cuidar dos tipos enquanto continua expressando a intenção (por exemplo, que um parâmetro é passado por referência ou é de saída). Isso resulta em lambdas mais concisas e fáceis de ler, especialmente quando as assinaturas dos delegates são complexas ou usam tipos genéricos.

Vale notar que esse recurso não muda o comportamento das lambdas em tempo de execução nem o funcionamento desses modificadores; apenas muda a sintaxe usada para declarar parâmetros de lambda. A lambda continuará seguindo as mesmas regras para `ref`, `out`, `in` etc., como se você os tivesse escrito com tipos explícitos. O modificador `scoped` continua garantindo que o valor não seja capturado além da execução da lambda. A melhoria principal é simplesmente que seu código-fonte fica menos poluído por nomes de tipos.

Esse recurso no C# 14 alinha a sintaxe das lambdas com a conveniência da inferência de tipos presente em outras partes da linguagem. Agora você pode escrever lambdas com `ref` e outros modificadores de uma forma mais natural, semelhante a como você já pode omitir tipos em lambdas há anos quando não havia modificadores envolvidos. Apenas lembre-se de que, se você precisar de um array `params` em uma lambda, ainda terá que escrever o tipo como antes.

## Referências

-   [Novidades no C# 14 | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
-   [Parâmetros simples de lambda com modificadores | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/simple-lambda-parameters-with-modifiers)
-   [Novidades no C# 14 | StartDebugging.NET](/2024/12/csharp-14/)
