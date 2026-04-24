---
title: "RegexOptions.AnyNewLine chega no .NET 11 Preview 3: anchors Unicode-aware sem os hacks de \\r?"
description: ".NET 11 Preview 3 adiciona RegexOptions.AnyNewLine para que ^, $, \\Z, e . reconheçam toda sequência de newline Unicode, incluindo \\r\\n, NEL, LS, e PS, com \\r\\n tratado como um break atômico."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "csharp"
lang: "pt-br"
translationOf: "2026/04/regex-anynewline-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Se você já escreveu um regex multilinha em .NET e apelou pra `\r?$` pra ficar seguro entre arquivos Windows e Unix, o workaround finalmente sai de cena. O .NET 11 Preview 3 introduz `RegexOptions.AnyNewLine`, que ensina ao engine o conjunto completo de terminadores de linha Unicode sem te forçar a soletrar cada um na mão.

A opção foi pedida lá no issue dotnet/runtime [25598](https://github.com/dotnet/runtime/issues/25598) e saiu com o drop do Preview 3 em 14 de abril de 2026. Detalhes estão no [anúncio do .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).

## O que a opção de fato muda

Com `RegexOptions.AnyNewLine` setado, os anchors `^`, `$`, e `\Z`, mais `.` quando `Singleline` não está ativo, reconhecem toda sequência comum de newline definida pelo Unicode TR18 RL1.6:

- `\r\n` (CR+LF)
- `\r` (CR)
- `\n` (LF)
- `\u0085` (NEL, Next Line)
- `\u2028` (Line Separator)
- `\u2029` (Paragraph Separator)

Crucialmente, `\r\n` é tratado como uma sequência atômica. Isso significa que `^` não vai disparar entre o `\r` e o `\n`, e `.` não consome só o `\r` deixando o `\n` pendurado. Esse comportamento sozinho apaga uma classe de bugs cross-platform que parsers regex-heavy carregam há anos.

## Antes vs depois

Imagine que você quer cada linha não-vazia de um arquivo misto editado no Windows, depois Linux, e depois passado por uma ferramenta Mac antiga. No .NET 10 você compensa por cada sabor de newline:

```csharp
// .NET 10 style: opt in to every flavor manually
var legacy = new Regex(
    @"^(?<line>.+?)(?:\r?\n|\u2028|\u2029|\u0085|\z)",
    RegexOptions.Multiline);
```

No .NET 11 Preview 3 a mesma intenção comprime pra:

```csharp
using System.Text.RegularExpressions;

var modern = new Regex(
    @"^(?<line>.+)$",
    RegexOptions.Multiline | RegexOptions.AnyNewLine);

string input = "first\r\nsecond\nthird\u2028fourth\u2029fifth\u0085sixth";

foreach (Match m in modern.Matches(input))
{
    Console.WriteLine(m.Groups["line"].Value);
}
```

Toda linha imprime limpa, sem compensação manual, e `\r` nunca vaza pro grupo capturado em input do Windows.

## Com o que ele se recusa a combinar

Duas combinações são rejeitadas na hora da construção. Ambas lançam `ArgumentOutOfRangeException`:

```csharp
// Both throw at construction
new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.NonBacktracking);

new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.ECMAScript);
```

O engine `NonBacktracking` assa o próprio modelo de newline no DFA, e o sabor `ECMAScript` está intencionalmente travado na semântica ECMA-262. Deixar qualquer um dos dois herdar silenciosamente o conjunto Unicode mudaria o comportamento de matching de formas que os callers não conseguem detectar facilmente, então o runtime falha alto na construção em vez de produzir matches surpreendentes em runtime.

`RegexOptions.Singleline` é a combinação amigável. Com ambos `Singleline` e `AnyNewLine` setados, `.` matcha todo caractere incluindo newlines, e `^`, `$`, e `\Z` mantêm o comportamento completo de anchor Unicode.

## Por que isso importa pra parsers de log e conteúdo

A maioria dos shims caseiros `\r?\n` em codebases .NET existe porque o comportamento padrão do regex trata só `\n` como quebra de linha. Logs, CSVs, headers RFC 822, e conteúdo colado de terminais todos batem nisso assim que um `\r\n` ou um `\u2028` perdido aparece. Todo split defensivo, todo check "isso é um arquivo Windows", todo off-by-one quando um separador Unicode entra no buffer, vem pagando esse imposto.

`RegexOptions.AnyNewLine` é uma API pequena, mas remove uma fonte de longa data de bugs regex cross-platform. Se você mantém um parser, log shipper, ou text indexer em .NET, o Preview 3 é a release onde você pode finalmente começar a podar esses workarounds.
