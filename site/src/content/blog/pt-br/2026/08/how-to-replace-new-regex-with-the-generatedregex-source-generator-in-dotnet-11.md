---
title: "Como substituir new Regex(...) pelo gerador de código-fonte [GeneratedRegex] no .NET 11"
description: "Um guia completo para converter new Regex(pattern, RegexOptions.Compiled) em [GeneratedRegex] no .NET 11: a reescrita mecânica, métodos parciais versus propriedades parciais, números medidos de inicialização e throughput, os diagnósticos SYSLIB1040-1045 e os dois padrões em que o gerador silenciosamente recai para um Regex em cache."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "source-generators"
  - "performance"
  - "native-aot"
lang: "pt-br"
translationOf: "2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Se o seu padrão é uma constante em tempo de compilação, apague `new Regex(pattern, RegexOptions.Compiled)` e coloque `[GeneratedRegex(pattern)]` sobre um método parcial ou uma propriedade parcial que retorna `Regex`. O gerador de código-fonte emite um tipo derivado de `Regex` em tempo de compilação, então você não paga nenhum custo de análise, otimização ou reflection-emit em runtime, o código é adequado para trimming e compatível com Native AOT, e você consegue entrar no motor de correspondência pelo depurador. Nas minhas medições no .NET 10.0.201, o motor gerado ficou marginalmente mais rápido que `RegexOptions.Compiled` em regime estável (35 ns contra 37 ns por `IsMatch`) e chegou à primeira correspondência em cerca de metade do tempo (5,8 ms contra 12,2 ms em um processo frio).

Tudo abaixo tem como alvo o .NET 11 (Preview 6 no momento em que escrevo, SDK `11.0.100-preview.6`) com C# 14, mas o atributo e o gerador são estáveis desde o .NET 7, e os números deste artigo foram medidos no SDK .NET 10.0.201 porque é o SDK mais recente do qual tenho um runtime completo. Nada da superfície da API mudou entre os dois.

## A conversão, do início ao fim

1. Confirme que o padrão é uma constante em tempo de compilação. Se ele é montado a partir de entrada do usuário ou de configuração, pare aqui: o gerador não pode ajudar você.
2. Marque o tipo que contém o membro como `partial`, junto com todo tipo dentro do qual ele está aninhado.
3. Substitua o campo `static readonly Regex` por um método `static partial Regex` (ou uma propriedade `static partial Regex` somente leitura no .NET 9 e posteriores).
4. Mova o padrão, as opções e qualquer tempo limite para um atributo `[GeneratedRegex]` sobre esse membro.
5. Remova `RegexOptions.Compiled` das opções. O gerador ignora essa flag.
6. Reescreva os pontos de chamada de `s_myRegex.IsMatch(text)` para `MyRegex().IsMatch(text)`.
7. Abra o arquivo gerado e verifique o comentário XML da classe emitida. Se disser "Caches a `Regex` instance", o gerador desistiu e você não ganhou nada.

O passo 7 é o que todo mundo pula, e é o que decide se o exercício inteiro valeu a pena.

## Por que o interpretador e RegexOptions.Compiled custam algo a você

Quando você escreve `new Regex("somepattern")`, o padrão é analisado e vira uma árvore, a árvore é otimizada, e o resultado é escrito como opcodes para o interpretador de expressões regulares. Cada correspondência então percorre esses opcodes. Funciona em todo lugar e é barato de construir, mas cada despacho de opcode é um desvio que a CPU precisa prever.

`RegexOptions.Compiled` paga uma conta de construção bem maior para eliminar esse despacho. Ele faz tudo o que o interpretador faz e depois passa a árvore de nós resultante por um compilador baseado em `System.Reflection.Emit` que escreve IL em um punhado de objetos `DynamicMethod`. Esse IL ainda precisa ser compilado pelo JIT no primeiro uso. Como [a documentação da Microsoft coloca](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), `RegexOptions.Compiled` "representa um compromisso fundamental entre as sobrecargas do primeiro uso e as sobrecargas de todo uso subsequente". Pior ainda, ele depende de geração de código em runtime, então em plataformas que proíbem código gerado dinamicamente, e sob Native AOT, `Compiled` vira silenciosamente uma operação nula e você volta para o interpretador sem nenhum aviso.

O gerador de código-fonte elimina o compromisso em vez de negociar dentro dele. O mesmo trabalho de análise e otimização acontece, mas acontece na máquina de compilação, e o que chega ao seu assembly é C# comum que o compilador transforma em IL comum.

## A reescrita

Este é o formato que quase toda base de código tem:

```csharp
// .NET 11, C# 14 - the pattern you are replacing
private static readonly Regex s_email = new(
    @"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$",
    RegexOptions.Compiled);

public static bool IsEmail(string s) => s_email.IsMatch(s);
```

E o equivalente com geração de código-fonte:

```csharp
// .NET 11, C# 14
internal static partial class EmailRules
{
    [GeneratedRegex(@"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$")]
    private static partial Regex Email();

    public static bool IsEmail(string s) => Email().IsMatch(s);
}
```

Três coisas a notar. A classe passou a ser `partial`. `RegexOptions.Compiled` sumiu, porque o gerador ignora essa flag e a presença dela só engana o próximo leitor. E o método não tem corpo: você declara, o gerador implementa.

Você não precisa colocar nada em cache por conta própria. A implementação gerada retorna um singleton `static readonly`, o que você pode conferir você mesmo no código-fonte emitido.

### Propriedades parciais, se uma chamada de método soa estranha

Desde o .NET 9 e o C# 13, `[GeneratedRegex]` também se aplica a propriedades parciais somente leitura, o que lê melhor quando a expressão regular é conceitualmente um valor e não uma operação:

```csharp
// .NET 11, C# 14 - requires C# 13 or later for partial properties
internal static partial class PhoneRules
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

A propriedade precisa ser somente leitura. Dê a ela um setter e o gerador a rejeita. Não há diferença de comportamento entre as duas formas; escolha uma e seja consistente.

### Opções, cultura e tempos limite

O atributo tem cinco sobrecargas de construtor, adicionando em camadas as opções, um nome de cultura e um tempo limite de correspondência em milissegundos:

```csharp
// .NET 11, C# 14
[GeneratedRegex(
    pattern: "abc|def",
    options: RegexOptions.IgnoreCase | RegexOptions.Multiline,
    cultureName: "en-US",
    matchTimeoutMilliseconds: 1000)]
private static partial Regex AbcOrDef();
```

`cultureName` só importa para correspondência sem diferenciar maiúsculas de minúsculas. Se você passar `RegexOptions.CultureInvariant`, não pode passar também um nome de cultura, e o modo de falha aí é genuinamente confuso. Veja os detalhes mais abaixo.

## Como os números realmente ficam

Eu medi isso em vez de repetir o folclore. A configuração: um aplicativo de console no .NET 10.0.201, Windows 11 x64, build em Release, comparando o padrão de e-mail ancorado acima contra 1.000 strings, um terço das quais não corresponde. Três motores: o interpretador, `RegexOptions.Compiled` e `[GeneratedRegex]`.

Throughput em regime estável, 200.000 chamadas a `IsMatch` por rodada, a melhor de dez rodadas após três rodadas completas de aquecimento de todos os motores:

| Motor | Tempo | Por chamada |
| --- | --- | --- |
| Interpretador | 22,1 ms | 111 ns |
| `RegexOptions.Compiled` | 7,4 ms | 37 ns |
| `[GeneratedRegex]` | 7,0 ms | 35 ns |

Primeira correspondência em processo frio, cada motor medido no próprio processo para que nada esteja pré-aquecido, quatro execuções:

| Motor | Construção mais primeiro `IsMatch` |
| --- | --- |
| Interpretador | 3,7 a 4,0 ms |
| `RegexOptions.Compiled` | 12,0 a 12,7 ms |
| `[GeneratedRegex]` | 5,7 a 6,1 ms |

Leia as duas tabelas juntas. Contra `Compiled`, o gerador é um ganho pequeno de throughput e um ganho grande de inicialização: mesmo regime estável, menos da metade do tempo para chegar lá. Contra o interpretador, é um ganho de throughput de 3,2x que custa cerca de 2 ms de inicialização extra em um processo frio, a maior parte disso tempo de JIT para o motor emitido, e que desaparece completamente sob Native AOT porque não sobra JIT para pagar.

Um aviso sobre medir isso você mesmo: minha primeira tentativa mostrava o interpretador duas vezes mais rápido que `Compiled`, o que é absurdo. A causa era que os três motores compartilhavam um único método de medição, então o que rodava primeiro absorvia o custo de JIT em camadas do próprio arcabouço de medição. Aqueça cada motor através do arcabouço antes de medir qualquer um deles.

## O analisador já sabe

Você não precisa achar esses pontos de chamada na mão. O SDK do .NET traz o `SYSLIB1045`, um analisador de nível informativo que marca qualquer uso de `Regex` convertível para geração de código-fonte, junto com uma correção de código que faz a conversão por você. Severidade informativa significa que ele aparece como uma lâmpada na IDE e em nenhum outro lugar, então eleve isso:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.SYSLIB1045.severity = warning
```

Agora `dotnet build` lista cada ponto de chamada restante, e `dotnet format analyzers` consegue aplicar a correção em massa. Coloque a severidade em `error` assim que a base de código estiver limpa, para que ninguém adicione um novo.

## Quando o gerador desiste em silêncio

Esta é a parte que morde, porque não é um erro nem um aviso. Duas construções fazem o gerador se recusar a emitir um motor de correspondência personalizado, e nos dois casos ele recai para emitir uma instância `Regex` simples em cache. Seu código compila, seus testes passam e você não ganhou nada do benefício.

A primeira é `RegexOptions.NonBacktracking`, que nem o gerador de código-fonte nem o `RegexCompiler` suportam. A segunda são retrorreferências sem diferenciar maiúsculas de minúsculas: casar retrorreferências com `IgnoreCase` exige uma tabela interna de maiúsculas e minúsculas que vive dentro de `System.Text.RegularExpressions.dll` e não é acessível ao código gerado. Essa é a única construção que o `RegexCompiler` trata e o gerador de código-fonte não.

Você pode ver as duas diretamente. Adicione isto ao seu arquivo de projeto:

```xml
<PropertyGroup>
  <EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>
  <CompilerGeneratedFilesOutputPath>generated</CompilerGeneratedFilesOutputPath>
</PropertyGroup>
```

Depois compile estes três membros e leia `generated/System.Text.RegularExpressions.Generator/.../RegexGenerator.g.cs`:

```csharp
// .NET 11, C# 14
internal static partial class NonBt
{
    [GeneratedRegex(@"\d+", RegexOptions.NonBacktracking)]
    internal static partial Regex Digits();
}

internal static partial class IgnoreCaseBackref
{
    [GeneratedRegex(@"(\w)\1", RegexOptions.IgnoreCase)]
    internal static partial Regex Doubled();
}

internal static partial class Fine
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

O arquivo emitido é inequívoco sobre qual dos três funcionou:

```csharp
/// <summary>Caches a <see cref="Regex"/> instance for the Digits method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because RegexOptions.NonBacktracking isn't supported.</remarks>
file sealed class Digits_0 : Regex
{
    internal static readonly Regex Instance = new("\\d+", RegexOptions.NonBacktracking);
}

/// <summary>Caches a <see cref="Regex"/> instance for the Doubled method.</summary>
/// <remarks>A custom Regex-derived type could not be generated because the expression contains case-insensitive backreferences which are not supported by the source generator.</remarks>
file sealed class Doubled_1 : Regex
{
    internal static readonly Regex Instance = new("(\\w)\\1", RegexOptions.IgnoreCase);
}

/// <summary>Custom <see cref="Regex"/>-derived type for the Phone method.</summary>
file sealed class Phone_2 : Regex
{
    internal static readonly Phone_2 Instance = new();
    // ... RunnerFactory, Runner, TryMatchAtCurrentPosition, and so on
}
```

"Caches a `Regex` instance" é o fallback. "Custom `Regex`-derived type" é a coisa real. O gerador também reporta `SYSLIB1044` para os casos de fallback, mas a severidade dele é **Info**, então ele não vai aparecer em um log de build normal nem quebrar o CI. Se você se importa, eleve isso no `.editorconfig`:

```ini
dotnet_diagnostic.SYSLIB1044.severity = warning
```

O fallback não é inútil. Você ainda ganha o cache e os comentários XML descritivos. Mas se você converteu um caminho quente esperando um ganho de velocidade, precisa saber que não obteve nenhum.

## Os diagnósticos, com suas mensagens reais

Estas são as strings exatas que o SDK do .NET 10 emite, não paráfrases:

| ID | Severidade | Mensagem |
| --- | --- | --- |
| `SYSLIB1040` | Error | Invalid `GeneratedRegexAttribute` usage. |
| `SYSLIB1041` | Error | Multiple `GeneratedRegexAttribute` attributes were applied to the same method, but only one is allowed. |
| `SYSLIB1042` | Error | The specified regex is invalid. |
| `SYSLIB1043` | Error | `GeneratedRegexAttribute` method or property must be partial, parameterless, non-generic, non-abstract, and return `Regex`. If a property, it must also be get-only. |
| `SYSLIB1044` | Info | The regex generator couldn't generate a complete source implementation for the specified regular expression due to an internal limitation. |
| `SYSLIB1045` | Info | Use `GeneratedRegexAttribute` to generate the regular expression implementation at compile time. |

## Detalhes que custam tempo real

**Um tipo contêiner não parcial não te dá um erro SYSLIB.** O gerador emite a metade dele do tipo parcial de qualquer jeito, e é o compilador de C# que reclama, com `CS0260: Missing partial modifier on declaration of type 'NotPartial'; another partial declaration of this type exists`. Se você está aninhado a três tipos de profundidade, os três precisam de `partial`.

**`CultureInvariant` mais um nome de cultura explícito produz uma mensagem enganosa.** Esta combinação:

```csharp
[GeneratedRegex(@"abc", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, "en-US")]
internal static partial Regex Abc();
```

falha com `error SYSLIB1042: The specified regex is invalid. 'cultureName'`. O padrão `abc` está obviamente correto. O problema é que `CultureInvariant` e uma cultura nomeada são mutuamente exclusivos, e o diagnóstico reaproveita a mensagem de padrão inválido com o nome do argumento problemático como carga. Remova o nome de cultura, ou remova `CultureInvariant`.

**Um `LangVersion` fixado quebra o build no arquivo gerado, não no seu.** O gerador emite tipos com escopo `file`, um recurso do C# 11. Force `LangVersion` para 10 e você recebe `CS8936: Feature 'file types' is not available in C# 10.0. Please use language version 11.0 or greater`, apontando para `RegexGenerator.g.cs`. Propriedades parciais sobem o piso para C# 13: `CS8703: The modifier 'partial' is not valid for this item in C# 10.0. Please use language version '13.0' or greater`. SDKs modernos definem `LangVersion` por padrão de acordo com o target framework, então isso só morde bases de código que fixam o valor explicitamente.

**A correspondência sem diferenciar maiúsculas e minúsculas fica congelada em tempo de compilação.** Para uma expressão regular insensível a maiúsculas, os motores expandem o padrão usando uma tabela Unicode interna de maiúsculas e minúsculas, de modo que `abc` vira o equivalente de `[Aa][Bb][Cc]`. Os outros motores fazem essa expansão em runtime, usando a tabela do runtime em que você estiver. O gerador de código-fonte faz em tempo de compilação, usando a tabela do target framework contra o qual você compilou. Se uma revisão futura do Unicode mudar uma equivalência, uma expressão regular gerada mantém o comportamento antigo até você recompilar. Isso está documentado nas [observações de `GeneratedRegexAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute) e quase nunca é um problema, mas "quase nunca" não é "nunca".

**As verificações de tempo limite são compiladas para dentro ou para fora, globalmente.** O código gerado lê o padrão ambiente uma única vez:

```csharp
internal static readonly TimeSpan s_defaultTimeout =
    AppContext.GetData("REGEX_DEFAULT_MATCH_TIMEOUT") is TimeSpan timeout
        ? timeout
        : Regex.InfiniteMatchTimeout;

internal static readonly bool s_hasTimeout = s_defaultTimeout != Regex.InfiniteMatchTimeout;
```

e protege cada chamada a `base.CheckTimeout()` dentro dos laços com retrocesso atrás de `s_hasTimeout`. Isso é bom para o throughput no caminho padrão, e significa que se você nunca configurar `REGEX_DEFAULT_MATCH_TIMEOUT` e nunca passar `matchTimeoutMilliseconds`, um padrão com retrocesso catastrófico diante de entrada hostil vai rodar até a morte térmica do seu pipeline de requisições. Se um padrão toca entrada não confiável, defina `matchTimeoutMilliseconds` no atributo, ou mude aquele padrão específico para `RegexOptions.NonBacktracking` e aceite o fallback.

**O tamanho do código cresce.** O gerador emite C# real por padrão, e um padrão grande gera bastante código. Se você tem centenas de expressões regulares e só um punhado é quente, converter todas troca tamanho de binário por throughput que você não vai observar. O interpretador é a resposta certa para um padrão que roda duas vezes durante a inicialização.

## Onde isso mais importa: trimming e Native AOT

O argumento mais forte a favor do gerador não são os 2 ns por chamada. É que `RegexOptions.Compiled` depende de `System.Reflection.Emit`, que é exatamente o tipo de dependência que o [código trim-safe](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) evita e que o [Native AOT](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/) remove por completo. Sob AOT, `Compiled` é uma operação nula silenciosa e o seu caminho quente cuidadosamente otimizado está rodando no interpretador.

A geração de código-fonte inverte isso. Como o motor de correspondência é C# comum que o linker enxerga, o trimmer consegue remover o `RegexCompiler` e potencialmente o próprio reflection-emit da saída publicada, e o motor gerado é compilado antecipadamente junto com todo o resto. Se você publica com AOT, converter cada padrão constante não é uma otimização, é uma correção de uma suposição que o seu código está fazendo silenciosamente.

## Relacionados

- [O que é um gerador de código-fonte e quando eu preciso de um?](/pt-br/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [RegexOptions.AnyNewLine chega no .NET 11 Preview 3](/pt-br/2026/04/regex-anynewline-dotnet-11-preview-3/)
- [Como usar SearchValues corretamente no .NET 11](/pt-br/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)
- [O que é Native AOT e quanto ele custa para você?](/pt-br/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [O que é código trim-safe e como eu escrevo isso?](/pt-br/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)

## Fontes

- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators) no Microsoft Learn
- [Referência da API de `GeneratedRegexAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute), incluindo as observações sobre a tabela de maiúsculas e minúsculas em tempo de compilação
- [Diagnósticos SYSLIB para geração de código-fonte de expressões regulares](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib1040-1049)
- [Regular Expression Improvements in .NET 7](https://devblogs.microsoft.com/dotnet/regular-expression-improvements-in-dotnet-7/) no blog do .NET
- [`DiagnosticDescriptors.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.RegularExpressions/gen/DiagnosticDescriptors.cs) no dotnet/runtime, para a severidade de cada diagnóstico

Os números de desempenho e o texto dos diagnósticos deste artigo foram produzidos localmente no SDK .NET 10.0.201, Windows 11 x64, configuração Release.
