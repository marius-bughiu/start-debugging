---
title: "RegexOptions.AnyNewLine приземляется в .NET 11 Preview 3: Unicode-aware anchors без хаков \\r?"
description: ".NET 11 Preview 3 добавляет RegexOptions.AnyNewLine так, что ^, $, \\Z и . распознают любую Unicode-последовательность newline, включая \\r\\n, NEL, LS и PS, с \\r\\n трактуемым как один атомарный разрыв."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "csharp"
lang: "ru"
translationOf: "2026/04/regex-anynewline-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Если вы когда-нибудь писали multiline regex в .NET и тянулись за `\r?$`, чтобы быть безопасными на Windows и Unix файлах, обходной путь наконец уходит. .NET 11 Preview 3 вводит `RegexOptions.AnyNewLine`, обучающий движок полному набору Unicode-терминаторов строки, не заставляя вас прописывать каждый вручную.

Опцию запросили ещё в issue dotnet/runtime [25598](https://github.com/dotnet/runtime/issues/25598), и она поставилась с Preview 3 drop 14 апреля 2026 года. Детали - в [анонсе .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).

## Что опция на самом деле меняет

С установленным `RegexOptions.AnyNewLine` anchors `^`, `$` и `\Z`, плюс `.` когда `Singleline` не активен, распознают каждую общую последовательность newline, определённую Unicode TR18 RL1.6:

- `\r\n` (CR+LF)
- `\r` (CR)
- `\n` (LF)
- `\u0085` (NEL, Next Line)
- `\u2028` (Line Separator)
- `\u2029` (Paragraph Separator)

Критически, `\r\n` трактуется как атомарная последовательность. Это значит, что `^` не сработает между `\r` и `\n`, а `.` не поглотит только `\r`, оставив `\n` висящим. Это одно поведение удаляет класс кроссплатформенных багов, которые regex-heavy парсеры таскали годами.

## До и после

Представьте, что вы хотите каждую непустую строку из смешанного файла, отредактированного в Windows, потом Linux, а потом пропущенного через старый Mac-инструмент. В .NET 10 компенсируете каждый сорт newline вручную:

```csharp
// .NET 10 style: opt in to every flavor manually
var legacy = new Regex(
    @"^(?<line>.+?)(?:\r?\n|\u2028|\u2029|\u0085|\z)",
    RegexOptions.Multiline);
```

В .NET 11 Preview 3 то же намерение сжимается до:

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

Каждая строка печатается чисто, без ручной компенсации, и `\r` никогда не утекает в захваченную группу на Windows-input.

## С чем он отказывается комбинироваться

Две комбинации отклоняются во время конструирования. Обе бросают `ArgumentOutOfRangeException`:

```csharp
// Both throw at construction
new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.NonBacktracking);

new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.ECMAScript);
```

Движок `NonBacktracking` запекает собственную модель newline в DFA, а сорт `ECMAScript` намеренно зафиксирован на семантике ECMA-262. Позволение любому молча унаследовать Unicode-набор изменило бы поведение matching способами, которые вызывающая сторона не может легко обнаружить, так что runtime громко падает при конструировании, а не производит сюрпризные матчи в runtime.

`RegexOptions.Singleline` - дружелюбная комбинация. С установленными `Singleline` и `AnyNewLine`, `.` матчит каждый символ включая newlines, а `^`, `$` и `\Z` сохраняют полное Unicode anchor-поведение.

## Почему это важно для парсеров логов и контента

Большинство самодельных `\r?\n`-шимов в .NET codebases существует потому, что дефолтное поведение regex трактует только `\n` как разрыв строки. Логи, CSV, RFC 822 headers и контент, вставленный из терминалов, бьют в это как только появляется `\r\n` или заблудший `\u2028`. Каждый защитный split, каждая проверка "это Windows-файл?", каждый off-by-one, когда Unicode-разделитель проскакивает в буфер, платили этот налог.

`RegexOptions.AnyNewLine` - маленький API, но он убирает давний источник кроссплатформенных regex-багов. Если вы поддерживаете парсер, log shipper или text indexer на .NET, Preview 3 - релиз, где вы наконец можете начать подрезать эти обходы.
