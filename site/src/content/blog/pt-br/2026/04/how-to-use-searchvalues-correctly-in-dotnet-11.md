---
title: "Como usar SearchValues<T> corretamente no .NET 11"
description: "SearchValues<T> supera IndexOfAny em 5x a 250x, mas só quando você o usa do jeito que o runtime espera. A regra de cachear como static, a pegadinha do StringComparison, quando não vale a pena e o truque de inversão com IndexOfAnyExcept que ninguém documenta."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "csharp"
  - "searchvalues"
lang: "pt-br"
translationOf: "2026/04/how-to-use-searchvalues-correctly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

`SearchValues<T>` mora em `System.Buffers`. É um conjunto imutável e pré-computado de valores usado com os métodos de extensão `IndexOfAny`, `IndexOfAnyExcept`, `ContainsAny`, `LastIndexOfAny` e `LastIndexOfAnyExcept` em `ReadOnlySpan<T>`. A regra que 90% do uso erra é simples: construa a instância de `SearchValues<T>` uma vez, guarde em um campo `static readonly` e reutilize. Se construir dentro do método quente, você mantém todo o custo (a seleção da estratégia SIMD, a alocação do bitmap, o autômato Aho-Corasick para a sobrecarga de string) e perde todo o benefício. A outra regra: não recorra a `SearchValues<T>` para conjuntos de um ou dois valores. `IndexOf` já é vetorizado para os casos triviais e é mais rápido.

Este post mira o .NET 11 (preview 4) em x64 e ARM64. As sobrecargas de byte e char de `SearchValues.Create` são estáveis desde o .NET 8. A sobrecarga de string (`SearchValues<string>`) é estável desde o .NET 9 e segue inalterada no .NET 10 e no .NET 11. O comportamento descrito a seguir é idêntico em Windows, Linux e macOS, porque os caminhos de código SIMD são compartilhados entre plataformas, recorrendo a código escalar somente onde AVX2 / AVX-512 / NEON não estão disponíveis.

## Por que SearchValues existe

`ReadOnlySpan<char>.IndexOfAny('a', 'b', 'c')` é uma chamada única. O runtime não pode saber se a próxima chamada vai usar o mesmo conjunto ou outro, então tem que escolher uma estratégia de busca na hora, toda vez. Para três caracteres o JIT inlina um caminho vetorizado feito à mão, então o overhead é pequeno, mas no momento em que o conjunto cresce além de quatro ou cinco elementos, `IndexOfAny` cai para um loop genérico com verificação de pertinência a hash-set por caractere. Esse loop é OK para entradas curtas e desastroso para longas.

`SearchValues<T>` desacopla o passo de planejamento do passo de busca. Quando você chama `SearchValues.Create(needles)`, o runtime inspeciona os valores buscados uma vez: são uma faixa contígua? um conjunto esparso? compartilham prefixos (para a sobrecarga de string)? Ele escolhe uma de várias estratégias (bitmap com shuffle de `Vector256`, `IndexOfAnyAsciiSearcher`, `ProbabilisticMap`, `Aho-Corasick`, `Teddy`) e grava os metadados na instância. Toda chamada subsequente contra essa instância pula o planejamento e despacha direto para o kernel escolhido. Para um conjunto de 12 elementos você vê tipicamente um speedup de 5x a 50x sobre a sobrecarga correspondente de `IndexOfAny`. Para conjuntos de strings com 5 ou mais elementos você vê de 50x a 250x sobre um loop manual de `Contains`.

A assimetria é o ponto: planejar é caro, buscar é barato. Se você constrói um `SearchValues<T>` novo por chamada, está pagando o planejador sem amortizar.

## A regra de cachear como static

Este é o padrão canônico. Repare no `static readonly`:

```csharp
// .NET 11, C# 14
using System.Buffers;

internal static class CsvScanner
{
    private static readonly SearchValues<char> Delimiters =
        SearchValues.Create(",;\t\r\n\"");

    public static int FindNextDelimiter(ReadOnlySpan<char> input)
    {
        return input.IndexOfAny(Delimiters);
    }
}
```

A versão errada, que vejo em PRs toda semana:

```csharp
// .NET 11 -- BROKEN, do not ship
public static int FindNextDelimiter(ReadOnlySpan<char> input)
{
    var delims = SearchValues.Create(",;\t\r\n\"");
    return input.IndexOfAny(delims);
}
```

Parece inocente. Aloca a cada chamada, e o planejador roda a cada chamada. Benchmarks que rodei no .NET 11 preview 4 com `BenchmarkDotNet`:

```
| Method                     | Mean       | Allocated |
|--------------------------- |-----------:|----------:|
| StaticSearchValues_1KB     |    71.4 ns |       0 B |
| RebuiltSearchValues_1KB    |   312.0 ns |     208 B |
| LoopWithIfChain_1KB        |   846.0 ns |       0 B |
```

A alocação é a metade mais perigosa. Um `Create` mal posicionado em um caminho quente vira um fluxo constante de lixo próximo do LOH. Em um serviço de 100k requisições/seg isso são gigabytes por minuto pressionando o GC por um valor que você deveria estar reusando.

Se você não pode usar `static readonly` porque os valores buscados são fornecidos pelo usuário na inicialização, construa a instância uma vez durante a inicialização e guarde em um serviço singleton:

```csharp
// .NET 11, C# 14
public sealed class TokenScanner
{
    private readonly SearchValues<string> _tokens;

    public TokenScanner(IEnumerable<string> tokens)
    {
        _tokens = SearchValues.Create(tokens.ToArray(), StringComparison.Ordinal);
    }

    public bool ContainsAny(ReadOnlySpan<char> input) => input.ContainsAny(_tokens);
}
```

Registre como singleton na injeção de dependência. Não registre como transient. Transient te dá a mesma armadilha de reconstrução por chamada com passos extras.

## A pegadinha do StringComparison

`SearchValues<string>` (a sobrecarga multi-string adicionada no .NET 9) recebe um argumento `StringComparison`:

```csharp
private static readonly SearchValues<string> Forbidden =
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);
```

Apenas quatro valores são suportados: `Ordinal`, `OrdinalIgnoreCase`, `InvariantCulture` e `InvariantCultureIgnoreCase`. Passe `CurrentCulture` ou `CurrentCultureIgnoreCase` e o construtor lança `ArgumentException` na inicialização. Isso é correto: uma busca multi-string sensível à cultura teria que alocar por chamada para honrar a cultura da thread atual, o que anularia a pré-computação.

Duas consequências:

- Para dados ASCII, sempre use `Ordinal` ou `OrdinalIgnoreCase`. Eles são de 5x a 10x mais rápidos que as variantes invariantes porque o runtime despacha para um kernel Teddy que opera em bytes brutos. As variantes invariantes pagam por dobramento de caixa Unicode mesmo em entradas exclusivamente ASCII.
- Se você precisa de insensibilidade a maiúsculas/minúsculas correta por idioma (I com ponto turco, sigma grego), `SearchValues<string>` não é a sua ferramenta. Recorra a `string.Contains(needle, StringComparison.CurrentCultureIgnoreCase)` em loop e aceite o custo. Correspondência de strings sensível ao idioma é fundamentalmente não vetorizável.

As sobrecargas de `char` e `byte` não têm parâmetro `StringComparison`. Elas combinam exatamente. Se você quer correspondência ASCII insensível a maiúsculas/minúsculas com `SearchValues<char>`, inclua ambas as formas no conjunto:

```csharp
// case-insensitive ASCII vowels in .NET 11, C# 14
private static readonly SearchValues<char> Vowels =
    SearchValues.Create("aeiouAEIOU");
```

Mais barato do que chamar `ToLowerInvariant` na entrada antes.

## Pertinência a conjunto: SearchValues.Contains não é o que você pensa

`SearchValues<T>` expõe um método `Contains(T)`:

```csharp
SearchValues<char> set = SearchValues.Create("abc");
bool isInSet = set.Contains('b'); // true
```

Leia com cuidado: isso verifica se um único valor está no conjunto. É o equivalente de `HashSet<T>.Contains`, não uma busca de substring. As pessoas recorrem a ele esperando a semântica de `string.Contains` e mandam para produção código que pergunta "o caractere 'h' está no meu conjunto de tokens proibidos?" em vez de "minha entrada contém algum token proibido?". Esse tipo de bug passa pela checagem de tipos e roda.

As chamadas certas para "a entrada contém algum destes?":

- `ReadOnlySpan<char>.ContainsAny(SearchValues<char>)` para conjuntos de char.
- `ReadOnlySpan<char>.ContainsAny(SearchValues<string>)` para conjuntos de string.
- `ReadOnlySpan<byte>.ContainsAny(SearchValues<byte>)` para conjuntos de byte.

Use `SearchValues<T>.Contains(value)` apenas quando você realmente tem um único valor e quer uma consulta de conjunto, por exemplo dentro de um tokenizador customizado decidindo se o caractere atual é um delimitador.

## O truque de inversão com IndexOfAnyExcept

`IndexOfAnyExcept(SearchValues<T>)` retorna o índice do primeiro elemento que **não** está no conjunto. É a forma de encontrar o início do conteúdo significativo em uma string depois de espaços em branco iniciais, padding ou ruído, em uma única passada SIMD:

```csharp
// .NET 11, C# 14
private static readonly SearchValues<char> WhitespaceAndQuotes =
    SearchValues.Create(" \t\r\n\"'");

public static ReadOnlySpan<char> TrimStart(ReadOnlySpan<char> input)
{
    int firstReal = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    return firstReal < 0 ? ReadOnlySpan<char>.Empty : input[firstReal..];
}
```

Isso bate `string.TrimStart(' ', '\t', '\r', '\n', '"', '\'')` em entradas com longas sequências iniciais porque `TrimStart` cai para um loop por caractere com conjuntos acima de quatro. Para o caso típico de "remover 64 espaços de indentação", espere um speedup de 4x a 8x.

`LastIndexOfAnyExcept` é o equivalente do lado direito. Juntos te dão um `Trim` vetorizado:

```csharp
public static ReadOnlySpan<char> TrimBoth(ReadOnlySpan<char> input)
{
    int start = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    if (start < 0) return ReadOnlySpan<char>.Empty;

    int end = input.LastIndexOfAnyExcept(WhitespaceAndQuotes);
    return input[start..(end + 1)];
}
```

Duas fatias, dois scans SIMD, zero alocações. A sobrecarga ingênua `string.Trim(charsToTrim)` aloca um array temporário internamente no .NET 11 mesmo quando a entrada não precisa de trim.

## Quando usar byte em vez de char

Para parseamento de protocolo (HTTP, JSON, CSV ASCII, linhas de log), a entrada frequentemente é `ReadOnlySpan<byte>`, não `ReadOnlySpan<char>`. Construir `SearchValues<byte>` a partir dos valores de byte ASCII é notavelmente mais rápido do que decodificar para UTF-16 antes:

```csharp
// .NET 11, C# 14 -- HTTP header value sanitiser
private static readonly SearchValues<byte> InvalidHeaderBytes =
    SearchValues.Create([(byte)'\0', (byte)'\r', (byte)'\n', (byte)'\t']);

public static bool IsValidHeaderValue(ReadOnlySpan<byte> value)
{
    return value.IndexOfAny(InvalidHeaderBytes) < 0;
}
```

O caminho de byte puxa 32 bytes por ciclo AVX2 vs 16 chars; em hardware capaz de AVX-512 puxa 64 bytes vs 32 chars. Para dados ASCII você dobra o throughput pulando o desvio para UTF-16.

O compilador não te avisa se você acidentalmente usa codepoints `char` acima de 127 de um jeito que quebra. Mas o planejador de SearchValues emite um caminho lento deliberado quando o conjunto de char ultrapassa a faixa BMP-ASCII com propriedades bidi mistas. Se seu benchmark diz "isso ficou mais lento do que eu esperava", verifique se você colocou um caractere não ASCII em um conjunto que era para ser apenas ASCII.

## Quando NÃO usar SearchValues

Uma lista curta de casos onde a resposta certa é "não vale a pena":

- **Um único valor buscado**. `span.IndexOf('x')` já é vetorizado. `SearchValues.Create("x")` adiciona overhead.
- **Dois ou três chars buscados, chamados raramente**. `span.IndexOfAny('a', 'b', 'c')` está OK. O ponto de equilíbrio é por volta de quatro valores para char e por volta de dois para string.
- **Entradas mais curtas que 16 elementos**. Os kernels SIMD têm custo de setup. Para um span de 8 caracteres, comparação escalar vence.
- **Valores buscados que mudam a cada chamada**. O ponto inteiro de `SearchValues` é amortização. Se o conjunto é entrada do usuário por chamada, fique com as sobrecargas de `IndexOfAny` ou `Regex` com `RegexOptions.Compiled`.
- **Você precisa de captura de grupo ou referências para trás**. `SearchValues` faz apenas correspondência literal. Não é um substituto de regex, só um `Contains` mais rápido.

## Inicialização estática sem alocação

As sobrecargas de `Create` aceitam `ReadOnlySpan<T>`. Você pode passar um literal de string (o compilador C# converte literais de string para `ReadOnlySpan<char>` via `RuntimeHelpers.CreateSpan` desde o .NET 7), um array, ou uma expressão de coleção. Os três produzem a mesma instância de `SearchValues<T>`; o compilador não gera arrays intermediários para a forma com literal de string.

```csharp
// .NET 11, C# 14 -- all three are equivalent in cost at runtime
private static readonly SearchValues<char> A = SearchValues.Create("abc");
private static readonly SearchValues<char> B = SearchValues.Create(['a', 'b', 'c']);
private static readonly SearchValues<char> C = SearchValues.Create(new[] { 'a', 'b', 'c' });
```

Para a sobrecarga de string, a entrada precisa ser um array (`string[]`) ou uma expressão de coleção que aponte para um:

```csharp
private static readonly SearchValues<string> Tokens =
    SearchValues.Create(["select", "insert", "update"], StringComparison.OrdinalIgnoreCase);
```

O construtor copia os valores buscados para o estado interno, então o array de origem não é retido. Mutar o array depois da construção não faz nada com a instância de `SearchValues<string>`. Isso é o oposto de `Regex` com padrões cacheados, onde a string de origem é retida.

## Padrão amigável a gerador de código-fonte

Se você tem uma classe `partial` e um gerador de código (próprio ou `System.Text.RegularExpressions.GeneratedRegex`), gerar um campo `static readonly SearchValues<char>` como parte da saída gerada é um padrão limpo. Seguro para trim, seguro para AOT, sem reflexão, sem alocação no heap por chamada.

```csharp
// .NET 11, C# 14 -- hand-rolled equivalent of what a generator would emit
internal static partial class IdentifierScanner
{
    private static readonly SearchValues<char> NonIdentifierChars =
        SearchValues.Create(GetNonIdentifierAscii());

    private static ReadOnlySpan<char> GetNonIdentifierAscii()
    {
        // Build a 96-element set of non-[A-Za-z0-9_] ASCII chars at type init.
        Span<char> buffer = stackalloc char[96];
        int i = 0;
        for (int c = ' '; c <= '~'; c++)
        {
            if (!(char.IsAsciiLetterOrDigit((char)c) || c == '_'))
                buffer[i++] = (char)c;
        }
        return buffer[..i].ToArray();
    }
}
```

O `stackalloc` roda uma vez porque `static readonly` é inicializado exatamente uma vez pelo inicializador de tipo do runtime. O `.ToArray()` é a única alocação no tempo de vida do tipo. Depois disso, toda busca é livre de alocação.

## Native AOT e avisos de trim

`SearchValues<T>` é totalmente compatível com Native AOT. Não há reflexão por dentro, nem geração de código dinâmica em runtime. Seu binário publicado em AOT contém os mesmos kernels SIMD da versão JIT, selecionados em tempo de compilação AOT com base na ISA alvo que você especificou (`-r linux-x64` por padrão inclui x64 base com caminhos SSE2 + AVX2; `-p:TargetIsa=AVX-512` estende para AVX-512). Sem avisos de trim, sem necessidade de anotações `[DynamicallyAccessedMembers]`.

Se você publica para `linux-arm64`, os kernels NEON são escolhidos automaticamente. O mesmo código-fonte compila para ambos os alvos sem código condicional.

## Leitura relacionada

- [Span<T> vs ReadOnlySpan<T> e quando cada um se justifica](/2026/01/net-10-performance-searchvalues/) cobre uma fotografia anterior de `SearchValues` da época do .NET 10; revisite pelo contexto SIMD.
- [Channels em vez de BlockingCollection](/pt-br/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) é o transporte certo quando você escaneia entradas em um worker.
- [Como ler um CSV grande no .NET 11 sem estourar a memória](/pt-br/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) usa `SearchValues<char>` para varredura de delimitadores no parser.
- [Como detectar quando um arquivo termina de ser escrito no .NET](/pt-br/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) se encaixa naturalmente com o scanner CSV acima ao consumir arquivos de caixa de entrada.

## Fontes

- [Referência de `SearchValues<T>`, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues-1) -- a superfície de API canônica, incluindo as sobrecargas de byte / char / string de `Create`.
- [`SearchValues.Create(ReadOnlySpan<string>, StringComparison)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues.create) -- documenta os quatro valores de `StringComparison` suportados e a `ArgumentException` lançada para os outros.
- [.NET runtime PR 90395 -- `SearchValues<T>` inicial](https://github.com/dotnet/runtime/pull/90395) -- a introdução das sobrecargas de byte e char no .NET 8 com a tabela de estratégias SIMD.
- [.NET runtime PR 96570 -- `SearchValues<string>`](https://github.com/dotnet/runtime/pull/96570) -- a adição no .NET 9 dos kernels Aho-Corasick / Teddy multi-string.
- [Boosting string search performance in .NET 8.0 with SearchValues, endjin](https://endjin.com/blog/2024/01/dotnet-8-searchvalues-string-search-performance-boost) -- o benchmark externo mais limpo para o caminho de char.
