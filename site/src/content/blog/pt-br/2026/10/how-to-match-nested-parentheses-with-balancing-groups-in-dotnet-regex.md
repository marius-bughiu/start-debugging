---
title: "Como casar parênteses aninhados e tags balanceadas com balancing groups no Regex do .NET"
description: "Balancing groups (?<name>) e (?<-name>) transformam um grupo de captura do Regex do .NET em uma pilha, então um único padrão consegue casar parênteses ou tags <div> aninhados em qualquer profundidade. O padrão completo, como a pilha funciona, a captura do conteúdo interno com (?<inner-open>) e as armadilhas verificadas no .NET 11 RC1: a checagem de pilha vazia, backtracking catastrófico, NonBacktracking e tipos de colchetes misturados."
pubDate: 2026-10-10
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "regex"
  - "how-to"
lang: "pt-br"
translationOf: "2026/10/how-to-match-nested-parentheses-with-balancing-groups-in-dotnet-regex"
translatedBy: "claude"
translationDate: 2026-10-10
---

**Resposta curta:** no .NET, todo grupo de captura mantém uma pilha das suas capturas, e um balancing group permite empilhar e desempilhar nessa pilha de dentro do próprio padrão. `(?<depth>)` empilha ao encontrar um colchete de abertura, `(?<-depth>)` desempilha ao encontrar um de fechamento, e o condicional `(?(depth)(?!))` no final faz o casamento falhar se ainda sobrar algo na pilha. Juntando tudo, `\((?>[^()]+|\((?<depth>)|\)(?<-depth>))*(?(depth)(?!))\)` casa um grupo entre parênteses completo, com aninhamento de profundidade arbitrária. Todos os exemplos abaixo foram executados no .NET 11 RC1 (`11.0.100-rc.1.26425.128`), mas o recurso existe em `System.Text.RegularExpressions` sem alterações desde o .NET Framework 1.0, então os padrões funcionam também no .NET 8, 9 e 10.

A maioria dos engines de regex não consegue fazer isso. Expressões regulares clássicas descrevem linguagens regulares, e "parênteses balanceados" é o exemplo de livro-texto de uma linguagem que não é regular: você precisa de um contador, e um autômato finito não tem um. PCRE e Perl resolvem com recursão (`(?R)`). O .NET tomou outro caminho e deu a você a pilha diretamente. Quando você enxerga a pilha, a sintaxe deixa de parecer ruído de linha.

## Por que `\(.*\)` e `\(.*?\)` dão a resposta errada

Pegue a entrada `f(a(b)c) + g(d)` e experimente os dois padrões que todo mundo tenta primeiro:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var input = "f(a(b)c) + g(d)";

Console.WriteLine(Regex.Match(input, @"\(.*\)").Value);
// (a(b)c) + g(d)    greedy: runs to the LAST ')'

Console.WriteLine(Regex.Match(input, @"\(.*?\)").Value);
// (a(b)             lazy: stops at the FIRST ')'
```

Nenhum dos dois é "o `)` correspondente". O guloso engole dois grupos separados, o preguiçoso corta o grupo aninhado ao meio. O que você realmente quer é "o `)` em que o número de aberturas menos o número de fechamentos volta a zero", e isso exige contagem. Esse contador é o que os balancing groups oferecem.

## Como um grupo de captura do .NET vira uma pilha

Quando um grupo nomeado participa de um casamento mais de uma vez (por exemplo, dentro de um laço `*`), o .NET não descarta as capturas anteriores. `Match.Groups["name"].Captures` guarda todas, em ordem, e o engine trata a mais recente como o topo de uma pilha. É por isso que backreferences como `\k<name>` sempre enxergam a última captura.

A sintaxe de balancing group manipula essa pilha:

| Sintaxe | Efeito |
|---|---|
| `(?<open>...)` | Captura nomeada normal. Empilha uma captura na pilha de `open`. `(?<open>)` com corpo vazio empilha uma captura de largura zero, que funciona como um simples incremento de contador. |
| `(?<-open>...)` | Desempilha a captura do topo da pilha de `open`. Se a pilha estiver vazia, essa alternativa **falha** e o engine faz backtracking. |
| `(?<inner-open>...)` | Desempilha `open` e empilha em `inner` uma captura que vai do fim da captura desempilhada até o início da posição atual. É assim que você obtém o conteúdo entre um par casado. |
| `(?(open)yes\|no)` | Condicional: segue o ramo `yes` se `open` tiver pelo menos uma captura na pilha. |
| `(?!)` | Um lookahead negativo vazio. Ele nunca pode ter sucesso, então significa "falhe aqui". |

As formas com aspas simples `(?'open')`, `(?'-open')` e `(?'inner-open')` são idênticas; elas existem para que você possa escrever padrões dentro de atributos XML sem escapar os sinais de menor e maior. Grupos numerados também funcionam: `(?<-1>\))` desempilha o grupo 1.

Uma regra de parse: o grupo que você desempilha precisa existir em algum lugar do padrão. `^\)(?<-d>)` sozinho lança `RegexParseException: Reference to undefined group name 'd'` a partir do construtor de `Regex`, e não um casamento que falha.

## Casar um grupo balanceado de parênteses, passo a passo

Este é o padrão canônico, escrito com `RegexOptions.IgnorePatternWhitespace` para poder conter comentários:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var balanced = new Regex(@"
    \(                      # the outer opening paren
    (?>
        [^()]+              # a run of anything that is not a paren
      | \( (?<depth>)       # an inner '(' pushes onto 'depth'
      | \) (?<-depth>)      # an inner ')' pops 'depth' (fails if empty)
    )*
    (?(depth)(?!))          # if 'depth' is not empty, fail
    \)                      # the outer closing paren
", RegexOptions.IgnorePatternWhitespace);

foreach (Match m in balanced.Matches("f(a(b)c) + g(d) + h((x)"))
    Console.WriteLine($"{m.Value} @{m.Index}");

// (a(b)c) @1
// (d) @12
// (x) @20
```

Acompanhe `(a(b)c)`:

1. O literal `\(` consome o `(` externo. A pilha `depth` está vazia.
2. `[^()]+` consome `a`.
3. O `(` interno cai na segunda alternativa, e `(?<depth>)` empilha uma captura. A profundidade é 1.
4. `[^()]+` consome `b`.
5. O `)` cai na terceira alternativa, e `(?<-depth>)` desempilha. A profundidade é 0.
6. `[^()]+` consome `c`.
7. O `)` final seria desempilhado pela terceira alternativa, mas a pilha está vazia, então `(?<-depth>)` falha. O laço termina e devolve esse `)`.
8. `(?(depth)(?!))` vê uma pilha vazia e não segue nenhum ramo, então tem sucesso.
9. O literal `\)` consome o `)` externo. Casamento concluído.

O passo 7 é o mais sutil. A falha do desempilhamento com a pilha vazia é o que impede o laço de comer o parêntese de fechamento externo, então o padrão para naturalmente no `)` correto.

Observe a última entrada, `h((x)`. O primeiro `(` nunca é fechado, então nenhum casamento pode começar ali. O engine segue adiante, começa no segundo `(` e retorna o `(x)` bem formado no índice 20. Em geral é isso que você quer quando está procurando grupos completos em um texto.

## Por que a checagem `(?(depth)(?!))` não é opcional

É tentador remover o condicional porque o `\(...\)` externo parece delimitar tudo. Não delimita. Compare os dois padrões em `((a)`:

```csharp
// .NET 11, C# 14
var noCheck   = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*\)");
var withCheck = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)");

Console.WriteLine(noCheck.Match("((a)").Value);    // ((a)   unbalanced!
Console.WriteLine(withCheck.Match("((a)").Value);  // (a)
```

Sem a checagem, o `\(` externo pega o primeiro `(`, o laço empilha o segundo `(`, consome `a` e desempilha no `)`. Agora o `\)` final não tem mais nada para casar, então o engine faz backtracking: o laço devolve sua última iteração (desfazendo o desempilhamento), e o `\)` final pega esse `)`. O casamento tem sucesso com um `(` ainda na pilha. A pilha só garante "nunca feche mais do que você abriu". "Feche tudo o que você abriu" é trabalho do condicional.

## Validar que uma string inteira está balanceada

Para responder "esta string está balanceada?" em vez de "encontre grupos balanceados nela", ancore as duas pontas e remova os parênteses literais externos:

```csharp
// .NET 11, C# 14
var valid = new Regex(@"^(?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))$");

foreach (var s in new[] { "a(b(c)d)e", "a(b(c)d", "a)b(c", "", "())(" })
    Console.WriteLine($"'{s}': {valid.IsMatch(s)}");

// 'a(b(c)d)e': True
// 'a(b(c)d': False    one '(' left on the stack
// 'a)b(c': False      ')' with an empty stack
// '': True
// '())(': False
```

## Capturar o conteúdo entre cada par casado

A forma com dois nomes `(?<inner-open>\))` desempilha `open` e registra o texto entre o `(` desempilhado e o `)` atual como uma captura de `inner`. Você obtém o conteúdo de cada nível aninhado, do mais interno para o mais externo:

```csharp
// .NET 11, C# 14
var inner = new Regex(@"(?>[^()]+|(?<open>\()|(?<inner-open>\)))*(?(open)(?!))");

Match m = inner.Match("x(a(b)c)(d)");
foreach (Capture c in m.Groups["inner"].Captures)
    Console.WriteLine($"{c.Value} @{c.Index}");

// b @4
// a(b)c @2
// d @9
```

A ordem é aquela em que os pares **fecham**, e é por isso que `b` vem antes de `a(b)c`. Se você precisa apenas dos grupos mais externos, filtre verificando que nenhum outro intervalo de captura contém este, ou volte ao padrão de grupo único da seção anterior e use `Matches`.

## Casar tags `<div>` aninhadas

A mesma estrutura funciona para qualquer par de delimitadores, inclusive os de vários caracteres. A única mudança está no ramo "qualquer outra coisa": em vez de uma classe de caracteres, use `(?!</?div\b).` para que ele consuma um caractere por vez, mas nunca o início de uma tag `div` de abertura ou de fechamento.

```csharp
// .NET 11, C# 14
var divs = new Regex(@"
    <div\b[^>]*>
    (?>
        <div\b[^>]*>  (?<depth>)
      | </div>        (?<-depth>)
      | (?!</?div\b) .
    )*
    (?(depth)(?!))
    </div>",
    RegexOptions.IgnorePatternWhitespace | RegexOptions.Singleline | RegexOptions.IgnoreCase);

var html = "<p>x</p><div class=\"a\">1<div>2</div>3</div><div>4</div>";
foreach (Match m in divs.Matches(html))
    Console.WriteLine(m.Value);

// <div class="a">1<div>2</div>3</div>
// <div>4</div>
```

`RegexOptions.Singleline` é importante aqui: sem ele, `.` não casa `\n` e o padrão falha silenciosamente em qualquer `div` que ocupe várias linhas.

Isso serve para trechos de template, saída de log ou marcação que você mesmo gera. Não é um parser de HTML. Comentários contendo `<div>`, atributos contendo `>`, CDATA e elementos void não fechados vão enganá-lo. Para HTML do mundo real, use AngleSharp ou HtmlAgilityPack.

## Armadilhas que você vai encontrar

### Esquecer o grupo atômico causa backtracking catastrófico

O `(?>...)` em volta da alternância não é decoração. Se você escrever `(?:...)` e `[^()]*` em vez de `[^()]+`, o engine pode dividir uma sequência de caracteres comuns de um número exponencial de maneiras quando o casamento falha, e vai tentar todas antes de desistir. Medi isso no .NET 11 RC1 com um timeout de casamento de 2 segundos e uma entrada de 29 caracteres:

```csharp
// .NET 11, C# 14
var input = "(" + new string('a', 25) + "(((";
var timeout = TimeSpan.FromSeconds(2);

var bad  = new Regex(@"^\((?:[^()]*|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);
var good = new Regex(@"^\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);

// bad.IsMatch(input)  -> RegexMatchTimeoutException after 2000 ms
// good.IsMatch(input) -> False in 0 ms
```

Duas correções, use as duas: envolva a alternância em `(?>...)` para que cada iteração se comprometa com o que consumiu, e use `+` em vez de `*` dentro de um laço para que uma iteração nunca possa casar vazio. Se o padrão roda sobre entrada não confiável, passe também um timeout de casamento ou defina `REGEX_DEFAULT_MATCH_TIMEOUT` para o domínio da aplicação.

### `RegexOptions.NonBacktracking` recusa balancing groups

O engine de tempo linear adicionado no .NET 7 não tem pilhas, então rejeita esses padrões no construtor:

```text
System.NotSupportedException: RegexOptions.NonBacktracking is not supported in
conjunction with expressions containing: 'balancing group (?<name1-name2>subexpression)
or (?'name1-name2' subexpression)'.
```

Ele rejeita grupos atômicos `(?>...)` e condicionais de grupo de captura `(?(name)...)` com a mesma exceção, então você não consegue contornar reescrevendo o padrão. Se você precisa de tempo linear garantido sobre entrada hostil, escreva o laço de pilha de 15 linhas mostrado mais abaixo. A equipe do OpenTelemetry caiu em uma armadilha relacionada com esse engine, descrita em [o artigo sobre a correção da NotSupportedException com wildcard no OpenTelemetry .NET 1.19.1](/pt-br/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/).

### `[GeneratedRegex]` funciona normalmente

O gerador de código-fonte suporta balancing groups, grupos atômicos e condicionais, então você pode mover esses padrões para tempo de compilação sem alterações:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

Console.WriteLine(Patterns.Call().Match("call(foo(1, bar(2)), 3);").Value);
// call(foo(1, bar(2)), 3)

static partial class Patterns
{
    [GeneratedRegex(@"\w+\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)")]
    public static partial Regex Call();
}
```

Se você ainda não migrou, [o guia para substituir new Regex(...) por [GeneratedRegex]](/pt-br/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/) cobre o analisador e o code fix que fazem isso por você.

### Pilhas separadas não impõem a ordem dos colchetes

A extensão óbvia para `()`, `[]` e `{}` é uma pilha por tipo de colchete:

```csharp
// .NET 11, C# 14
var multi = new Regex(@"^(?>
      [^()\[\]{}]+
    | (?<p>\() | (?<-p>\))
    | (?<b>\[) | (?<-b>\])
    | (?<c>\{) | (?<-c>\})
  )*(?(p)(?!))(?(b)(?!))(?(c)(?!))$", RegexOptions.IgnorePatternWhitespace);

Console.WriteLine(multi.IsMatch("{[()]}"));  // True
Console.WriteLine(multi.IsMatch("(]"));      // False
Console.WriteLine(multi.IsMatch("{[(])}"));  // True   <- wrong
```

Cada pilha conta corretamente o seu próprio tipo, mas nada as liga entre si, então `{[(])}` passa: o `]` desempilha a pilha `b` mesmo que o último abridor tenha sido `(`. Impor o entrelaçamento correto exige saber qual tipo está no topo de uma única pilha compartilhada, e é aí que a regex deixa de ser a ferramenta certa. Um simples `Stack<char>` resolve em uma única passada, e qualquer pessoa consegue ler:

```csharp
// .NET 11, C# 14
static bool IsBalanced(ReadOnlySpan<char> s)
{
    var stack = new Stack<char>();
    foreach (char ch in s)
    {
        switch (ch)
        {
            case '(' or '[' or '{': stack.Push(ch); break;
            case ')': if (!stack.TryPop(out var a) || a != '(') return false; break;
            case ']': if (!stack.TryPop(out var b) || b != '[') return false; break;
            case '}': if (!stack.TryPop(out var c) || c != '{') return false; break;
        }
    }
    return stack.Count == 0;
}

// IsBalanced("{[()]}") -> True
// IsBalanced("{[(])}") -> False
```

Se o caminho crítico só precisa encontrar o próximo colchete em uma string longa, [SearchValues<char> com IndexOfAny](/pt-br/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) é a forma rápida de pular os trechos de texto comum entre eles.

### Aspas e escapes dentro dos colchetes

`f("(", x)` contém um `(` não balanceado dentro de um literal de string. Para pular strings entre aspas, adicione uma alternativa antes das outras que consuma uma string inteira, por exemplo `"(?:[^"\\]|\\.)*"`, e exclua `"` da classe "qualquer outra coisa": `[^()"]+`. Cada regra léxica extra (comentários, literais de char, strings verbatim) é mais uma alternativa, e depois de duas ou três delas um tokenizador escrito à mão é mais fácil de manter.

### Âncoras baseadas em linha

Se você valida entrada de várias linhas com `^...$` e `RegexOptions.Multiline`, lembre-se de que `$` só reconhece `\n` por padrão. [O RegexOptions.AnyNewLine do .NET 11](/pt-br/2026/04/regex-anynewline-dotnet-11-preview-3/) resolve os casos de `\r\n` e de separadores de linha Unicode sem gambiarras com `\r?`.

## Quando recorrer a balancing groups

Balancing groups são a ferramenta certa quando você já está em um problema com formato de regex: uma busca e substituição em arquivos de código-fonte, um filtro de log, um atributo de validação, uma caixa de busca de editor que aceita padrões do .NET. Eles permitem que uma única expressão lide com um aninhamento que de outra forma o empurraria para um parser. Quando você precisar de ordenação entre vários tipos de colchetes, tratamento de escapes ou posições de erro ("`)` inesperado na coluna 14"), escreva o laço. A pilha que você estava simulando dentro da regex é uma linha em C#.

## Fontes

- [Grouping constructs: balancing group definitions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/grouping-constructs-in-regular-expressions#balancing-group-definitions), MS Learn
- [Alternation constructs: conditional matching with a named group](https://learn.microsoft.com/en-us/dotnet/standard/base-types/alternation-constructs-in-regular-expressions), MS Learn
- [Regular expression options: NonBacktracking mode](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-options#nonbacktracking-mode), MS Learn
- [Backtracking in regular expressions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/backtracking-in-regular-expressions), MS Learn
- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), MS Learn
