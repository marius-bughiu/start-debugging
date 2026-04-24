---
title: "RegexOptions.AnyNewLine aterriza en .NET 11 Preview 3: anchors Unicode-aware sin los hacks de \\r?"
description: ".NET 11 Preview 3 agrega RegexOptions.AnyNewLine para que ^, $, \\Z, y . reconozcan toda secuencia de newline Unicode, incluyendo \\r\\n, NEL, LS, y PS, con \\r\\n tratado como un break atómico."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "csharp"
lang: "es"
translationOf: "2026/04/regex-anynewline-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Si alguna vez escribiste un regex multilínea en .NET y recurriste a `\r?$` para estar seguro en archivos Windows y Unix, el workaround finalmente se va. .NET 11 Preview 3 introduce `RegexOptions.AnyNewLine`, que enseña al engine sobre el conjunto completo de terminadores de línea Unicode sin forzarte a deletrear cada uno a mano.

La opción fue pedida en el issue dotnet/runtime [25598](https://github.com/dotnet/runtime/issues/25598) y salió con el drop de Preview 3 el 14 de abril de 2026. Los detalles están en el [anuncio de .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).

## Qué cambia realmente la opción

Con `RegexOptions.AnyNewLine` seteado, los anchors `^`, `$`, y `\Z`, más `.` cuando `Singleline` no está activo, reconocen toda secuencia común de newline definida por Unicode TR18 RL1.6:

- `\r\n` (CR+LF)
- `\r` (CR)
- `\n` (LF)
- `\u0085` (NEL, Next Line)
- `\u2028` (Line Separator)
- `\u2029` (Paragraph Separator)

Crucialmente, `\r\n` se trata como una secuencia atómica. Eso significa que `^` no se disparará entre el `\r` y el `\n`, y `.` no consume solo el `\r` dejando el `\n` colgando. Ese único comportamiento borra una clase de bugs cross-platform que los parsers regex-heavy han cargado por años.

## Antes vs después

Imagina que quieres cada línea no-vacía de un archivo mixto que fue editado en Windows, luego Linux, y luego enviado a través de una herramienta vieja de Mac. En .NET 10 compensas por cada sabor de newline:

```csharp
// .NET 10 style: opt in to every flavor manually
var legacy = new Regex(
    @"^(?<line>.+?)(?:\r?\n|\u2028|\u2029|\u0085|\z)",
    RegexOptions.Multiline);
```

En .NET 11 Preview 3 la misma intención se comprime a:

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

Cada línea imprime limpiamente, sin compensación manual, y `\r` nunca se filtra al grupo capturado sobre input de Windows.

## Qué se niega a combinar

Dos combinaciones son rechazadas en tiempo de construcción. Ambas lanzan `ArgumentOutOfRangeException`:

```csharp
// Both throw at construction
new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.NonBacktracking);

new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.ECMAScript);
```

El engine `NonBacktracking` hornea su propio modelo de newline en la DFA, y el sabor `ECMAScript` está intencionalmente lockeado a semántica ECMA-262. Dejar que cualquiera heredase silenciosamente el conjunto Unicode cambiaría el comportamiento de matching de formas que los callers no pueden detectar fácilmente, así que el runtime falla ruidosamente en construcción en lugar de producir matches sorprendentes en runtime.

`RegexOptions.Singleline` es la combinación amigable. Con ambos `Singleline` y `AnyNewLine` seteados, `.` matchea todo carácter incluyendo newlines, y `^`, `$`, y `\Z` mantienen el comportamiento completo de anchor Unicode.

## Por qué esto importa para parsers de logs y contenido

La mayoría de los shims home-grown `\r?\n` en codebases .NET existen porque el comportamiento default de regex trata solo a `\n` como line break. Logs, CSVs, headers RFC 822, y contenido pegado de terminales todos golpean esto al momento en que un `\r\n` o un `\u2028` extraviado aparece. Cada split defensivo, cada check "es esto un archivo Windows", cada off-by-one cuando un separador Unicode se cuela al buffer, ha estado pagando ese impuesto.

`RegexOptions.AnyNewLine` es una API pequeña, pero remueve una fuente largamente establecida de bugs regex cross-platform. Si mantienes un parser, log shipper, o text indexer en .NET, Preview 3 es la release donde finalmente puedes empezar a podar esos workarounds.
