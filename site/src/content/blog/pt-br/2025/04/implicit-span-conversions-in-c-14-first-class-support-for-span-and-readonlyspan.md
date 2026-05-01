---
title: "Conversões implícitas de Span em C# 14: suporte de primeira classe para Span e ReadOnlySpan"
description: "C# 14 adiciona conversões implícitas integradas entre Span, ReadOnlySpan, arrays e strings, possibilitando APIs mais limpas, melhor inferência de tipos e menos chamadas manuais a AsSpan()."
pubDate: 2025-04-06
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan"
translatedBy: "claude"
translationDate: 2026-05-01
---
**C# 14** introduz uma melhoria significativa para código de alto desempenho: suporte de primeira classe para spans no nível da linguagem. Em particular, ele adiciona novas **conversões implícitas** entre **`Span<T>`**, **`ReadOnlySpan<T>`** e arrays (`T[]`). Essa mudança torna muito mais fácil trabalhar com esses tipos, que representam fatias contíguas e seguras de memória sem alocações extras. Neste artigo vamos ver o que são as conversões de span, como o C# 14 mudou as regras e por que isso importa para o seu código.

## Contexto: o que são `Span<T>` e `ReadOnlySpan<T>`

`Span<T>` e `ReadOnlySpan<T>` são estruturas exclusivas de pilha (por referência) que permitem se referir a uma região contígua de memória (por exemplo, um segmento de um array, string ou memória não gerenciada) de forma segura. Foram introduzidos no C# 7.2 e se tornaram amplamente usados no .NET para cenários de **alto desempenho e zero alocação**. Por serem implementados como tipos **`ref struct`**, os spans só podem existir na pilha (ou dentro de outro ref struct), o que garante que **não podem sobreviver à memória para a qual apontam**, preservando a segurança. Na prática, `Span<T>` é usado para fatias mutáveis de memória, enquanto `ReadOnlySpan<T>` é usado para fatias somente leitura.

**Por que usar spans?** Eles permitem trabalhar com sub-arrays, substrings ou buffers **sem copiar dados nem alocar nova memória**. Isso traz melhor desempenho e menor pressão sobre o GC, mantendo a **segurança de tipos e a verificação de limites** (diferente de ponteiros brutos). Por exemplo, analisar um texto grande ou um buffer binário pode ser feito com spans para evitar criar várias strings pequenas ou arrays de bytes. Muitas APIs do .NET (E/S de arquivos, parsers, serializadores etc.) agora oferecem sobrecargas baseadas em span por eficiência. No entanto, até o C# 14, a própria linguagem não compreendia totalmente a relação entre spans e arrays, o que gerava algum código repetitivo.

## Antes do C# 14: conversões manuais e sobrecargas

Em versões anteriores do C#, os spans tinham operadores de conversão definidos pelo usuário de e para arrays. Por exemplo, você podia **converter implicitamente** um array `T[]` em um `Span<T>` ou em um `ReadOnlySpan<T>` usando as sobrecargas definidas no runtime do .NET. Da mesma forma, um `Span<T>` podia se converter implicitamente em um `ReadOnlySpan<T>`. _Então qual era o problema?_ A questão é que essas eram conversões definidas em biblioteca, não conversões nativas da linguagem. O compilador C# **não** tratava `Span<T>`, `ReadOnlySpan<T>` e `T[]` como tipos relacionados em determinados cenários. Isso causava algumas dores de cabeça para os desenvolvedores antes do C# 14:

-   **Métodos de extensão sobre Spans/arrays:** Se você escrevesse um método de extensão que recebesse um `ReadOnlySpan<T>` como parâmetro `this`, não podia chamá-lo diretamente em um array ou em uma variável `Span<T>`. O compilador não considerava a conversão de array para span ao fazer o binding do receptor do método de extensão. Na prática, isso significava que muitas vezes era preciso fornecer **sobrecargas duplicadas** para arrays e spans, ou chamar a extensão convertendo o array antes manualmente. Por exemplo, a BCL (Base Class Library) tinha que oferecer certos métodos utilitários (como os de `MemoryExtensions`) em várias formas, uma para `ReadOnlySpan<T>`, outra para `Span<T>` e outra para `T[]`, para garantir que fossem usáveis em todos os casos.
-   **Métodos genéricos e inferência de tipos:** Existia uma fricção semelhante com métodos genéricos. Se você tinha um método genérico `Foo<T>(Span<T> data)` e tentava passar um array (digamos, `int[]`), o compilador não conseguia inferir `T`, porque não via um `Span<T>` exato no local da chamada: você precisava especificar o parâmetro de tipo explicitamente ou chamar `.AsSpan()` no array. A conversão implícita definida pelo usuário de `T[]` para `Span<T>` não era considerada durante a **inferência de tipos**, deixando o código menos ergonômico.
-   **Conversões explícitas necessárias:** Em muitos casos, os desenvolvedores tinham que inserir conversões manuais como chamar `myArray.AsSpan()` ou `new ReadOnlySpan<char>(myString)` para obter um span a partir de um array ou string. Embora não sejam terrivelmente complicadas, elas adicionam ruído ao código e dependem de o desenvolvedor saber quando converter. As IDEs nem sempre sugeriam isso, já que as relações de tipo não eram conhecidas pelas regras de conversão do compilador.

## Conversões implícitas de Span no C# 14

O C# 14 resolve esses problemas introduzindo **conversões implícitas de span integradas** no nível da linguagem. Agora o compilador reconhece diretamente certas conversões entre arrays e tipos span, frequentemente chamadas de **"suporte de span de primeira classe"**. Em termos práticos, isso significa que você pode passar livremente arrays ou até strings para APIs que esperam spans, e vice-versa, sem casts explícitos ou sobrecargas. A especificação da linguagem descreve a nova _conversão implícita de span_ permitindo que `T[]`, `Span<T>`, `ReadOnlySpan<T>` e até `string` sejam convertidos entre si de formas específicas. As conversões implícitas suportadas incluem:

-   **Array para Span:** Qualquer array unidimensional `T[]` pode ser convertido implicitamente em `Span<T>`. Por exemplo, um `int[]` será aceito onde um `Span<int>` é esperado, sem sintaxe extra.
-   **Array para ReadOnlySpan:** Qualquer `T[]` também pode ser convertido implicitamente em `ReadOnlySpan<T>` (ou em um equivalente covariante `ReadOnlySpan<U>` se `T` for conversível em `U`). Isso significa que você pode fornecer um array a um método que queira um span somente leitura do mesmo tipo de elemento. (A covariância aqui é semelhante à covariância de arrays, por exemplo, um `String[]` pode ser convertido em `ReadOnlySpan<object>` porque `string` é um `object`, mas esse é um cenário mais avançado.)
-   **Span para ReadOnlySpan:** Um `Span<T>` pode ser tratado implicitamente como `ReadOnlySpan<T>` (ou `ReadOnlySpan<U>` para tipos de referência compatíveis). Em outras palavras, você pode passar um span mutável para algo que apenas o lê. Essa conversão já era possível antes, mas agora é uma conversão padrão que o compilador considerará em mais contextos (não apenas via um operador definido pelo usuário).
-   **String para ReadOnlySpan:** Um `string` agora pode ser convertido implicitamente em `ReadOnlySpan<char>`. Isso é extremamente útil para tratar dados de string como spans somente leitura de caracteres. (Por baixo dos panos, isso é seguro porque o span aponta para a memória interna da string, e strings são imutáveis em C#.) No passado, era preciso chamar `.AsSpan()` em uma string ou usar `MemoryExtensions` para obter o mesmo efeito; agora isso acontece automaticamente quando necessário.

Essas conversões agora fazem parte das **regras de conversão integradas do compilador** (adicionadas ao conjunto de _conversões implícitas padrão_ na especificação da linguagem). Crucialmente, como o compilador entende essas relações, ele as considerará durante a **resolução de sobrecargas**, o **binding de métodos de extensão** e a **inferência de tipos**. Em resumo, o C# 14 "sabe" que `T[]`, `Span<T>` e `ReadOnlySpan<T>` são, em certa medida, intercambiáveis, o que resulta em código mais intuitivo. Como diz a documentação oficial: o C# 14 reconhece a relação entre esses tipos e permite uma programação mais natural com eles, tornando os tipos span utilizáveis como receptores de métodos de extensão e melhorando a inferência genérica.

## Antes e depois do C# 14

Vamos ver como o código fica mais limpo com as conversões implícitas de span em comparação com versões anteriores do C#.

### 1\. Métodos de extensão em Span vs Array

Considere um método de extensão definido para `ReadOnlySpan<T>` (por exemplo, uma verificação simples para ver se um span começa com um determinado elemento). No C# 13 ou anterior, você **não podia chamar** essa extensão diretamente em um array, mesmo que um array possa ser visto como um span, porque o compilador não aplicava a conversão para o receptor da extensão. Era preciso chamar `.AsSpan()` ou escrever uma sobrecarga separada. No C# 14, isso funciona naturalmente:

```cs
// Extension method defined on ReadOnlySpan<T>
public static class SpanExtensions {
    public static bool StartsWith<T>(this ReadOnlySpan<T> span, T value) 
        where T : IEquatable<T>
    {
        return span.Length != 0 && EqualityComparer<T>.Default.Equals(span[0], value);
    }
}

int[] arr = { 1, 2, 3 };
Span<int> span = arr;        // Array to Span<T> (always allowed)
// C# 13 and earlier:
// bool result1 = arr.StartsWith(1);    // Compile-time error (not recognized)
// bool result2 = span.StartsWith(1);   // Compile-time error for Span<T> receiver
// (Had to call arr.AsSpan() or define another overload for arrays/spans)
bool result = arr.StartsWith(1);       // C# 14: OK - arr converts to ReadOnlySpan<int> implicitly
Console.WriteLine(result);            // True, since 1 is the first element
```

No trecho acima, `arr.StartsWith(1)` não compilaria em C# antigo (erro CS8773) porque o método de extensão espera um **receptor** `ReadOnlySpan<int>`. O C# 14 permite ao compilador converter implicitamente o `int[]` (`arr`) para um `ReadOnlySpan<int>` para satisfazer o parâmetro receptor da extensão. O mesmo vale para uma variável `Span<int>` chamando uma extensão de `ReadOnlySpan<T>`: o `Span<T>` pode ser convertido em `ReadOnlySpan<T>` na hora. Isso significa que não precisamos mais escrever métodos de extensão duplicados (um para `T[]`, outro para `Span<T>` etc.) nem converter manualmente para chamá-los. O código fica mais claro e enxuto.

### 2\. Inferência de tipos em métodos genéricos com Spans

As conversões implícitas de span também ajudam com **métodos genéricos**. Suponha um método genérico que opera em um span de qualquer tipo:

```cs
// A generic method that prints the first element of a span
void PrintFirstElement<T>(Span<T> data) {
    if (data.Length > 0)
        Console.WriteLine($"First: {data[0]}");
}

// Before C# 14:
int[] numbers = { 10, 20, 30 };
// PrintFirstElement(numbers);        // ❌ Cannot infer T in C# 13 (array isn't Span<T>)
PrintFirstElement<int>(numbers);      // ✅ Had to explicitly specify <int>, or do PrintFirstElement(numbers.AsSpan())

// In C# 14:
PrintFirstElement(numbers);           // ✅ Implicit conversion allows T to be inferred as int
```

Antes do C# 14, a chamada `PrintFirstElement(numbers)` não compilava porque o argumento de tipo `T` não podia ser inferido: o parâmetro é `Span<T>` e um `int[]` não é diretamente um `Span<T>`. Você precisava fornecer o parâmetro de tipo `<int>` ou converter o array em `Span<int>` por conta própria. Com o C# 14, o compilador percebe que `int[]` pode ser convertido em `Span<int>` e, portanto, infere `T` = `int` automaticamente. Isso torna utilitários genéricos que trabalham com spans muito mais convenientes de usar, especialmente quando se lida com entradas de array.

### 3\. Passando strings para APIs de Span

Outro cenário comum é lidar com strings como spans somente leitura de caracteres. Muitas APIs de parsing e processamento de texto usam `ReadOnlySpan<char>` por eficiência. Em versões anteriores do C#, se quisesse chamar uma API dessas com uma `string`, era preciso chamar `.AsSpan()` na string. O C# 14 elimina essa exigência:

```cs
void ProcessText(ReadOnlySpan<char> text)
{
    // Imagine this method parses or examines the text without allocating.
    Console.WriteLine(text.Length);
}

string title = "Hello, World!";
// Before C# 14:
ProcessText(title.AsSpan());   // Had to convert explicitly.
// C# 14 and later:
ProcessText(title);            // Now implicit: string -> ReadOnlySpan<char>

ReadOnlySpan<char> span = title;         // Implicit conversion on assignment
ReadOnlySpan<char> subSpan = title[7..]; // Slicing still yields a ReadOnlySpan<char>
Console.WriteLine(span[0]);   // 'H'
```

A capacidade de tratar implicitamente uma `string` como `ReadOnlySpan<char>` faz parte do novo suporte às conversões de span. Isso é especialmente útil em código real: por exemplo, métodos como `int.TryParse(ReadOnlySpan<char>, ...)` ou `Span<char>.IndexOf` agora podem ser chamados diretamente com um argumento de string. Isso melhora a legibilidade do código removendo ruído (chamadas a `AsSpan()`) e garante que nenhuma alocação ou cópia desnecessária de string ocorra. A conversão acontece sem custo: ela apenas oferece uma janela para a memória da string original.

## Casos de uso reais que se beneficiam das conversões de Span

As conversões implícitas de span no C# 14 não são apenas um ajuste teórico de linguagem: elas têm impacto prático em vários cenários de programação:

-   **Parsing de alto desempenho e processamento de texto:** Bibliotecas ou aplicações que fazem parsing de texto (por exemplo, parsers de CSV/JSON, compiladores) frequentemente usam `ReadOnlySpan<char>` para evitar criar substrings. Com a conversão implícita, essas APIs podem aceitar entrada `string` sem fricção. Por exemplo, um parser JSON pode ter um único método `Parse(ReadOnlySpan<char> json)` que agora os chamadores podem alimentar com uma `string`, um `char[]` ou uma fatia de um buffer maior, tudo sem sobrecargas extras nem cópias.
-   **APIs eficientes em memória:** No .NET, é comum encontrar APIs que processam dados em pedaços, por exemplo, lendo de um arquivo ou rede para um buffer. Essas APIs podem usar `Span<byte>` para entrada/saída para evitar alocações. Graças ao C# 14, se você tiver dados existentes em um `byte[]`, pode passá-los diretamente a uma API baseada em span. Inversamente, se uma API retornar um `Span<T>` ou `ReadOnlySpan<T>`, você pode facilmente passá-lo a outro componente que espere um array ou um span somente leitura. A **ergonomia** incentiva os desenvolvedores a usar spans, resultando em menos churn de memória. Em resumo, você pode projetar uma única API centrada em spans que funcione naturalmente com arrays e strings, deixando sua base de código mais limpa.
-   **Interop e cenários unsafe:** Ao interagir com código não gerenciado ou interfaces de hardware, você costuma lidar com buffers brutos. Spans são uma forma segura de representá-los em C#. Por exemplo, você pode chamar um método nativo que preenche um array de bytes; com conversões implícitas, sua assinatura P/Invoke pode usar `Span<byte>` e ainda assim ser chamada com um `byte[]` comum. Isso oferece a segurança dos spans (evitando estouros de buffer etc.) mantendo a conveniência. Em cenários de baixo nível (como parsing de protocolos binários ou dados de imagem), poder tratar diferentes fontes de memória uniformemente como spans simplifica o código.
-   **Uso geral da biblioteca .NET:** A própria BCL do .NET se beneficiará. A equipe agora pode fornecer uma única sobrecarga para métodos que lidam com spans, em vez de várias sobrecargas para arrays, spans e spans somente leitura. Por exemplo, a extensão `.StartsWith()` para spans (como vimos) ou métodos em `System.MemoryExtensions` podem ser definidos uma vez sobre `ReadOnlySpan<T>` e funcionar automaticamente para entradas `T[]` e `Span<T>`. Isso reduz a superfície da API e o potencial de inconsistências. Como desenvolvedor, ao ver uma assinatura como `public void Foo(ReadOnlySpan<byte> data)`, você não precisa mais se perguntar se há uma versão de `Foo` para arrays: no C# 14 basta passar um `byte[]` e funcionará.

## Benefícios das conversões implícitas de Span

**Melhor legibilidade:** O benefício mais imediato é um código mais limpo. Você escreve o que parece natural, passar um array ou string para uma API que consome spans, e simplesmente funciona. Há menos carga cognitiva, pois você não precisa lembrar de chamar helpers de conversão ou incluir várias sobrecargas. O encadeamento de métodos de extensão fica mais intuitivo. No geral, código que usa spans fica mais fácil de ler e escrever, parecendo mais com C# "comum". Isso incentiva boas práticas (usar spans para desempenho) ao reduzir a fricção para fazê-lo.

**Menos erros:** Ao deixar o compilador cuidar das conversões, há menos margem para erro. Por exemplo, um desenvolvedor pode esquecer de chamar `.AsSpan()` e acabar chamando uma sobrecarga menos eficiente; no C# 14, a sobrecarga de span pretendida é escolhida automaticamente sempre que aplicável. Também significa comportamento consistente: a conversão é garantidamente segura (sem cópia de dados, sem problemas de null exceto quando apropriado). Ferramentas e IDEs agora podem sugerir corretamente sobrecargas baseadas em span porque os tipos são compatíveis. Todas as conversões implícitas são projetadas para serem inofensivas: não alteram os dados nem adicionam custo em tempo de execução, apenas reinterpretam um buffer de memória existente em um wrapper span.

**Segurança e desempenho:** Spans foram criados para melhorar o desempenho **com segurança**, e a atualização do C# 14 mantém essa filosofia. As conversões implícitas não comprometem a segurança de tipos: você ainda não pode converter implicitamente tipos incompatíveis (por exemplo, `int[]` para `Span<long>` só seria permitido explicitamente, se tanto, pois requer reinterpretação real). Os próprios tipos span garantem que você não modifique acidentalmente algo que deveria ser somente leitura (se converter um array em `ReadOnlySpan<T>`, a API que você chama não pode modificar seu array). Além disso, como os spans são apenas de pilha, o compilador garante que você não os armazene em variáveis de longa duração (como campos) que possam sobreviver aos dados. Ao tornar os spans mais fáceis de usar, o C# 14 efetivamente promove a escrita de código de alto desempenho sem recorrer a ponteiros unsafe, mantendo as garantias de segurança de memória que os desenvolvedores C# esperam.

**Métodos de extensão e genéricos:** Como já destacado, os spans agora podem participar plenamente da resolução de métodos de extensão e da inferência de tipos genéricos. Isso significa que APIs fluentes e padrões estilo LINQ que possam usar métodos de extensão funcionam diretamente com spans/arrays de maneira intercambiável. Algoritmos genéricos (para ordenação, busca etc.) podem ser escritos com spans e ainda assim invocados com argumentos de array sem complicação. O resultado final é que você pode unificar caminhos de código: não precisa de um caminho para arrays e outro para spans; uma única implementação baseada em span cobre tudo, o que é tanto mais seguro (menos código para errar) quanto mais rápido (um único caminho de código otimizado).

## O que isso significa para seu código

A introdução das conversões implícitas de span no C# 14 é uma bênção para desenvolvedores que escrevem código sensível a desempenho. Ela **fecha a lacuna** entre arrays, strings e tipos span ensinando o compilador a entender suas relações. Comparado a versões anteriores, você não precisa mais salpicar seu código com chamadas manuais a `.AsSpan()` nem manter sobrecargas paralelas para spans e arrays. Em vez disso, você escreve uma única API clara e confia que a linguagem fará a coisa certa quando você passar diferentes tipos de dados.

Na prática, isso significa código mais expressivo e conciso ao manipular fatias de memória. Seja parseando texto, processando dados binários ou apenas tentando evitar alocações desnecessárias no dia a dia, o suporte de span de primeira classe do C# 14 torna a programação baseada em Span mais _natural_. É um ótimo exemplo de um recurso de linguagem que melhora tanto a produtividade do desenvolvedor quanto o desempenho em runtime, mantendo o código seguro e robusto. Com os spans agora se convertendo sem fricção a partir de arrays e strings, você pode adotar esses tipos de alto desempenho em toda a sua base de código com ainda menos atrito do que antes.

**Fontes:**

-   [C# 14 Feature Specification – _First-class Span types_](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/first-class-span-types#:~:text=recognize%20the%20relationship%20between%20%60ReadOnlySpan,a%20lot%20of%20duplicate%20surface)
-   [_What's new in C# 14: More implicit conversions for Span<T>_](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14#implicit-span-conversions#:~:text=%60Span,with%20generic%20type%20inference%20scenarios)
-   [What's new in C# 14](/2024/12/csharp-14/)
