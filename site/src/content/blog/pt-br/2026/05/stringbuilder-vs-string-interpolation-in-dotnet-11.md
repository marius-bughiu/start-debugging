---
title: "StringBuilder vs interpolação de strings no .NET 11: qual você deve usar?"
description: "Use a interpolação de strings para compor de uma vez só um conjunto fixo de valores; use StringBuilder quando você anexa em um laço ou sobre um número desconhecido de fragmentos. A linha divisória é o laço, não a quantidade de valores."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "strings"
lang: "pt-br"
translationOf: "2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-25
---

Use a interpolação de strings (`$"..."`) quando você compõe uma string a partir de um conjunto fixo e conhecido de valores: uma linha de log, uma URL, uma mensagem. Use `StringBuilder` quando você anexa em um laço ou sobre um número desconhecido de fragmentos. A linha divisória é o laço, não quantos valores você tem. Um único `$"{a} {b} {c} {d}"` é mais rápido e mais claro do que iniciar um `StringBuilder`; mil iterações de `result += item` são o único padrão que realmente vai te prejudicar, e esse é o caso para o qual o `StringBuilder` existe. Os dois não são realmente concorrentes, e escolher errado em qualquer uma das direções custa a você ou legibilidade ou alocações quadráticas.

Este artigo tem como alvo o .NET 11 e o C# 14, mas o fato mais importante é anterior: desde o C# 10 e o .NET 6, o compilador converte (lowering) uma string interpolada em um `DefaultInterpolatedStringHandler` em vez de `string.Format`. Essa única mudança moveu a interpolação de strings de "conveniente, mas lenta" para "conveniente e rápida para uma única composição". O `StringBuilder` está na BCL desde o .NET Framework 1.1 e não mudou seus fundamentos, mas também ganhou no .NET 6 uma sobrecarga de `Append` ciente de interpolação que importa aqui.

## Não são duas maneiras de fazer a mesma coisa

A comparação é apresentada como um versus porque ambos produzem strings, mas eles respondem a perguntas diferentes.

A interpolação de strings responde a "eu tenho estes valores, me dê uma string". É uma expressão. `$"User {id} logged in at {time}"` é avaliada para uma `string`, de forma imutável, de uma vez. Você não pode anexar ao resultado depois; se precisar de uma string diferente, escreve outra interpolação.

O `StringBuilder` responde a "vou produzir fragmentos de string ao longo do tempo, possivelmente em um laço, e não quero alocar uma string nova a cada passo". É um buffer mutável. Você faz `Append` quantas vezes quiser e depois chama `ToString()` uma vez no final. Toda a sua razão de existir é que String é imutável no .NET, então a concatenação ingênua em um laço realoca toda a string acumulada a cada iteração.

Então a verdadeira pergunta quase nunca é "interpolação ou StringBuilder para esta linha?". É "estou construindo esta string em uma única expressão ou acumulando-a ao longo de muitos passos?". Acerte nesse eixo e a escolha é automática.

## No que `$"..."` realmente compila no .NET 6+

Quem aprendeu que "interpolação de strings é só `string.Format` por baixo" trabalha com conhecimento anterior ao .NET 6, e isso o leva a recorrer ao `StringBuilder` quando não precisa.

Antes do C# 10, o compilador convertia `$"Hello {name}"` em `string.Format("Hello {0}", name)`. Isso analisava a string de formato em tempo de execução, fazia boxing dos argumentos de tipo valor em um `object[]` e alocava. Desde o C# 10 e o .NET 6, o compilador converte a mesma expressão em uma sequência de chamadas diretas sobre um `DefaultInterpolatedStringHandler`:

```csharp
// .NET 11, C# 14
// Source:
string s = $"Hello {name}, you have {count} messages";

// Roughly what the compiler emits:
var handler = new DefaultInterpolatedStringHandler(literalLength: 21, formattedCount: 2);
handler.AppendLiteral("Hello ");
handler.AppendFormatted(name);
handler.AppendLiteral(", you have ");
handler.AppendFormatted(count);   // no boxing: ISpanFormattable path
handler.AppendLiteral(" messages");
string s = handler.ToStringAndClear();
```

Três coisas o tornam rápido. A string de formato é analisada em tempo de compilação, então não há trabalho de análise de formato em tempo de execução. O handler aluga seu buffer de respaldo de um `ArrayPool<char>`, então em estado estável apenas a string final é alocada. E as sobrecargas genéricas `AppendFormatted<T>` verificam se há `ISpanFormattable` e formatam os tipos valor diretamente no buffer em vez de fazer boxing e chamar `ToString()`. O resultado é que uma única interpolação está agora na mesma liga de alocações que um `StringBuilder` escrito à mão, com uma alocação para a string final, e geralmente mais rápida porque não há um objeto `StringBuilder` para alocar. O próprio [anúncio da interpolação de strings no .NET 6](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/) da Microsoft percorre esse lowering em detalhes.

## A matriz de decisão

O comportamento abaixo é para .NET 6+ / C# 10+ salvo indicação; o artigo tem como alvo o .NET 11 / C# 14.

| Aspecto                             | Interpolação de strings `$"..."`          | `StringBuilder`                          |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Melhor para                         | composição de uma vez, peças fixas        | construção incremental, laços, quantidade desconhecida |
| Forma                               | uma expressão, produz uma `string`        | um objeto mutável ao qual você anexa     |
| Resultado                           | `string` imutável                         | buffer mutável até `ToString()`          |
| Lowering (C# 10+)                   | `DefaultInterpolatedStringHandler`        | n/a (é uma classe que você chama)        |
| String de formato analisada         | em tempo de compilação                    | n/a                                      |
| Tipos valor                         | formatados no lugar via `ISpanFormattable` | `Append(int)` etc. também evitam boxing  |
| Alocações, composição única         | uma `string` final (buffer alugado)       | objeto builder + `char[]` + string final |
| Alocações, laço ingênuo             | O(n^2) se você fizer `s += $"..."`       | O(n) amortizado com `Append`             |
| Reutilizável / limpável             | não (string nova a cada vez)              | sim (`Clear()` e reutilizar)             |
| Segurança entre threads             | o resultado é uma string imutável         | não é seguro entre threads               |
| Legibilidade para templates         | alta                                      | baixa (cadeias de chamadas verbosas)     |
| Disponível desde                    | C# 6 (handler desde C# 10 / .NET 6)       | .NET Framework 1.1                       |

As duas linhas que decidem quase todos os casos reais são "melhor para" e "alocações, laço ingênuo". Se você compõe uma string a partir de um conjunto fixo de valores, a interpolação ganha tanto em legibilidade quanto em alocações. Se você está em um laço, o `StringBuilder` ganha, e a diferença não é sutil.

## Quando escolher a interpolação de strings

Recorra a `$"..."` sempre que a string for construída em uma única expressão a partir de valores que você já tem. Essa é a esmagadora maioria do código que constrói strings.

- **Linhas de log, mensagens, texto de exceção.** `throw new InvalidOperationException($"Order {id} is in state {state}, expected {expected}");`. Uma expressão, um punhado de valores, lida uma vez. Um `StringBuilder` aqui é pura cerimônia e aloca mais, não menos.
- **URLs, caminhos de arquivos, nomes de parâmetros SQL, chaves de cache.** `$"/api/orders/{id}/items"`. As peças são conhecidas no local da chamada. A interpolação se lê como o resultado.
- **Compor de 2 a ~10 valores, de qualquer tipo.** Como os tipos valor passam por `ISpanFormattable` em vez de boxing, misturar `int`, `Guid`, `DateTime` e `string` em uma interpolação não paga um imposto de boxing como acontecia com a antiga via `string.Format`.

```csharp
// .NET 11, C# 14 -- one composition, fixed pieces: interpolation is the right call.
// Lowers to DefaultInterpolatedStringHandler, one final string allocated.
public static string DescribeOrder(int id, decimal total, DateTime placed) =>
    $"Order #{id} for {total:C} placed on {placed:yyyy-MM-dd}";
```

Se toda a string puder ser conhecida em uma única expressão, esse é o seu sinal. Os especificadores de formato (`{total:C}`, `{placed:yyyy-MM-dd}`) funcionam exatamente como funcionavam com `string.Format` e continuam sendo analisados em tempo de compilação.

## Quando escolher o StringBuilder

Recorra ao `StringBuilder` quando os fragmentos chegam ao longo do tempo, especialmente dentro de um laço, ou quando o número de peças não é conhecido de antemão.

- **Concatenar em um laço.** Construir um CSV linha por linha, um relatório linha por linha, um fragmento de HTML a partir de uma coleção. Esse é o caso canônico do `StringBuilder`, e é onde a concatenação ingênua fica quadrática.
- **Montagem condicional.** Você anexa uma cláusula só se um indicador estiver ativado, depois talvez outra, depois talvez um separador final. Costurar isso em uma única interpolação é ilegível; `if (x) sb.Append(...)` é claro.
- **Reutilizar um buffer entre iterações.** O `StringBuilder` pode ser limpo com `Clear()` e reutilizado, mantendo sua capacidade alugada. Em um laço quente que produz muitas strings independentes, um único builder reutilizado supera muitas interpolações efêmeras em alocação.

```csharp
// .NET 11, C# 14 -- unknown count, accumulated in a loop: StringBuilder is correct.
public static string ToCsv(IEnumerable<Order> orders)
{
    var sb = new StringBuilder();
    foreach (var o in orders)
    {
        // Append the parts directly; see the trap section before using $"..." here.
        sb.Append(o.Id).Append(',')
          .Append(o.Total).Append(',')
          .Append(o.Placed.ToString("yyyy-MM-dd"))
          .Append('\n');
    }
    return sb.ToString();
}
```

Uma regra prática útil: se você vê um `for`, `foreach` ou `while` envolvendo a construção da string, você quase com certeza quer `StringBuilder`. Se não vê, você quase com certeza quer a interpolação.

## A armadilha: `+=` em um laço, e `sb.Append($"...")`

Dois padrões fazem as pessoas tropeçarem, e ambos vêm de misturar as duas ferramentas de forma incorreta.

O primeiro é concatenar com `+=` dentro de um laço:

```csharp
// .NET 11, C# 14 -- DO NOT do this. O(n^2) allocations.
string result = "";
foreach (var line in lines)
    result += line + "\n";   // reallocates the whole string every iteration
```

Como String é imutável, cada `+=` aloca uma string totalmente nova contendo tudo o que foi acumulado até então. Para n iterações isso é O(n^2) de cópia total e O(n) strings descartadas. Esse é o bug de desempenho de strings mais comum em C#, e é exatamente o que o `StringBuilder` foi construído para evitar. Usar interpolação aqui (`result += $"{line}\n"`) não ajuda; o custo quadrático está na atribuição repetida, não na interpolação.

A segunda armadilha é mais sutil e costumava ser real: passar uma string interpolada para `StringBuilder.Append`.

```csharp
// .NET 11, C# 14 -- fine on .NET 6+, was wasteful before.
sb.Append($"{key}={value}");
```

Antes do .NET 6, isso compilava em `sb.Append(string.Format("{0}={1}", key, value))`, que construía uma string intermediária e depois a copiava no builder, anulando parte do propósito. A partir do .NET 6, o `StringBuilder` ganhou uma sobrecarga de `Append` que recebe um `AppendInterpolatedStringHandler`, e o compilador a prefere. As partes interpoladas agora são anexadas diretamente ao builder sem uma string intermediária, como a Microsoft documenta na [mudança disruptiva da ordem de avaliação do StringBuilder.Append](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order). Então no .NET 11 `sb.Append($"{key}={value}")` é genuinamente livre de alocações para o fragmento. O estilo encadeado `Append(o.Id).Append(',')` do exemplo de CSV continua marginalmente mais leve e mais claro, mas a forma interpolada não é mais um erro de desempenho.

## O benchmark

Dois cenários, porque as duas ferramentas ganham em cenários diferentes. Medido com BenchmarkDotNet 0.14.x em um Ryzen 7 / Windows 11 / build do .NET 11, x64 RyuJIT, `dotnet run -c Release`.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
[MemoryDiagnoser]
public class StringBuildBench
{
    private readonly int _id = 4271;
    private readonly decimal _total = 199.95m;
    private readonly DateTime _placed = new(2026, 5, 25);

    // Scenario A: one composition of a fixed set of values.
    [Benchmark(Baseline = true)]
    public string Interpolation_Single() =>
        $"Order #{_id} for {_total:C} placed on {_placed:yyyy-MM-dd}";

    [Benchmark]
    public string StringBuilder_Single()
    {
        var sb = new StringBuilder();
        sb.Append("Order #").Append(_id).Append(" for ").Append(_total.ToString("C"))
          .Append(" placed on ").Append(_placed.ToString("yyyy-MM-dd"));
        return sb.ToString();
    }

    // Scenario B: build a 1,000-line string.
    [Params(1000)] public int N;

    [Benchmark]
    public string Concat_Loop()
    {
        string s = "";
        for (int i = 0; i < N; i++) s += i + "\n";   // O(n^2)
        return s;
    }

    [Benchmark]
    public string StringBuilder_Loop()
    {
        var sb = new StringBuilder();
        for (int i = 0; i < N; i++) sb.Append(i).Append('\n');
        return sb.ToString();
    }
}
```

Resultados representativos:

| Método                  | Média      | Ratio  | Alocado   |
| ----------------------- | ---------- | ------ | --------- |
| `Interpolation_Single`  | 78 ns      | 1.00   | 96 B      |
| `StringBuilder_Single`  | 165 ns     | 2.12   | 336 B     |
| `Concat_Loop` (N=1000)  | 410.000 ns | 5256   | 5,86 MB   |
| `StringBuilder_Loop`    | 9800 ns    | 126    | 39 KB     |

Leia as duas metades separadamente. Para uma única composição, a interpolação é cerca de duas vezes mais rápida e aloca um terço, porque não há objeto `StringBuilder` nem seu `char[]` interno para alocar, apenas a string final. Para o laço, o `StringBuilder` é cerca de 40 vezes mais rápido do que a concatenação com `+=` e aloca 150 vezes menos, e a diferença aumenta à medida que N cresce porque a concatenação é quadrática enquanto o `StringBuilder` é linear. Os números exatos variam com o comprimento da string e a CPU, mas as duas direções são estáveis: a interpolação ganha de uma vez, o `StringBuilder` ganha o laço, e nenhum dos dois resultados é apertado o suficiente para hesitar. Se você quer zero alocação no caso de uma vez, a próxima seção cobre `string.Create`.

## Quando nenhum dos dois basta: `string.Create`

Para o raro caminho quente onde até mesmo uma alocação de string final através do handler é demais e você conhece o comprimento exato de antemão, `string.Create<TState>` permite escrever diretamente no buffer da string com um `Span<char>`:

```csharp
// .NET 11, C# 14 -- exact length known, write straight into the string buffer.
public static string FormatId(int id) =>
    string.Create(8, id, static (span, value) => value.TryFormat(span, out _, "D8"));
```

Esse é o piso: uma alocação (a própria string), sem buffer intermediário, sem handler. Também é o menos legível e só compensa em laços quentes medidos onde você formata milhões de strings de forma fixa. Se você trabalha nesse nível, provavelmente já vive em `Span<char>` e `stackalloc`; para o panorama mais amplo de quando os buffers apenas na pilha valem a pena, veja [List vs Span vs ReadOnlySpan em C#](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/). Para código comum, não chegue até aqui. A interpolação e o `StringBuilder` cobrem o campo.

## O detalhe que decide por você

Uma restrição anula completamente o gosto: **a imutabilidade do resultado.** A interpolação de strings produz uma `string` finalizada. Se o seu código precisa continuar anexando depois, inserir no meio, substituir um token ou limpar e reutilizar o buffer, você precisa do `StringBuilder` independentemente de quão poucos valores existam. Não há uma forma de interpolação de `sb.Insert(0, header)` ou `sb.Replace("{name}", actual)`.

A restrição inversa é a legibilidade sob condicionais. Se a string é montada a partir de um template fixo sem laço e sem mutação posterior, o `StringBuilder` é a ferramenta errada mesmo quando o desempenho é irrelevante, porque `sb.Append(...).Append(...).Append(...)` é estritamente mais difícil de ler do que a interpolação que substitui, e no .NET 11 geralmente aloca mais. Revisores deveriam tratar um `StringBuilder` sem laço e com um número fixo de appends como um cheiro de código: quase sempre é uma única interpolação disfarçada.

## A recomendação, reformulada

Use por padrão a interpolação de strings. No .NET 11 ela é convertida em um `DefaultInterpolatedStringHandler`, analisa o formato em tempo de compilação, formata os tipos valor sem boxing e aluga seu buffer auxiliar, então uma única composição aloca uma string e supera um `StringBuilder` feito à mão tanto em velocidade quanto em alocações enquanto se lê muito melhor. Mude para `StringBuilder` no momento em que você anexa em um laço ou sobre um número desconhecido de fragmentos, onde seu buffer linear, mutável e reutilizável transforma o desastre quadrático da concatenação com `+=` em um não-evento. Nunca concatene com `+=` dentro de um laço. E não tenha medo de `sb.Append($"...")` no .NET 6 e posteriores: o handler de interpolação anexa diretamente ao builder sem uma string intermediária. A versão de uma linha: uma expressão significa interpolação, um laço significa `StringBuilder`, e o número de valores é uma pista falsa.

## Relacionados

- [List<T> vs Span<T> vs ReadOnlySpan<T> em C#](/pt-br/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) cobre os tipos de buffer apenas na pilha aos quais você recorre quando `string.Create` e `stackalloc` entram em cena.
- [C# 13: o fim das alocações de params](/pt-br/2026/01/c-13-the-end-of-params-allocations/) explica a mesma filosofia de eliminação de alocações aplicada a `params ReadOnlySpan<T>`.
- [Como ler um CSV grande no .NET 11 sem ficar sem memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) constrói strings e analisa campos em escala, exatamente onde a distinção entre laço e uma vez morde.
- [Literais de string brutos interpolados em C# 11](/pt-br/2023/03/c-11-interpolated-raw-string-literal/) mostra a sintaxe de interpolação que se combina com o handler tratado aqui.
- [Conversões implícitas de Span em C# 14](/pt-br/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) é a maquinaria de conversão por trás da formatação baseada em span da qual `string.Create` depende.

## Fontes

- [String Interpolation in C# 10 and .NET 6 (.NET Blog)](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/)
- [Explore C# string interpolation handlers (MS Learn)](https://learn.microsoft.com/dotnet/csharp/advanced-topics/performance/interpolated-string-handler)
- [Breaking change: new StringBuilder.Append overloads (MS Learn)](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order)
- [DefaultInterpolatedStringHandler struct reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.defaultinterpolatedstringhandler)
- [StringBuilder class reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.text.stringbuilder)
- [string.Create reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.string.create)
