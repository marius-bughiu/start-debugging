---
title: "Как заменить new Regex(...) на генератор исходного кода [GeneratedRegex] в .NET 11"
description: "Полное руководство по переходу с new Regex(pattern, RegexOptions.Compiled) на [GeneratedRegex] в .NET 11: механическая переработка кода, частичные методы против частичных свойств, измеренные показатели запуска и пропускной способности, диагностики SYSLIB1040-1045 и два случая, когда генератор молча откатывается к закешированному Regex."
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
lang: "ru"
translationOf: "2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Если ваш шаблон является константой времени компиляции, удалите `new Regex(pattern, RegexOptions.Compiled)` и поставьте `[GeneratedRegex(pattern)]` на частичный метод или частичное свойство, возвращающее `Regex`. Генератор исходного кода выпускает производный от `Regex` тип на этапе сборки, поэтому в среде выполнения вы не платите ничего за разбор, анализ и reflection-emit, код пригоден для trimming и совместим с Native AOT, а в отладчике можно зайти внутрь сопоставителя. По моим измерениям на .NET 10.0.201 сгенерированный сопоставитель оказался незначительно быстрее `RegexOptions.Compiled` в установившемся режиме (35 нс против 37 нс на один `IsMatch`) и достиг первого совпадения примерно вдвое быстрее (5.8 мс против 12.2 мс в холодном процессе).

Всё изложенное ниже ориентировано на .NET 11 (на момент написания Preview 6, SDK `11.0.100-preview.6`) с C# 14, но атрибут и генератор стабильны начиная с .NET 7, а числа в этой статье измерены на SDK .NET 10.0.201, потому что это самый свежий SDK, для которого у меня есть полная среда выполнения. Поверхность API между ними не менялась.

## Переход от начала до конца

1. Убедитесь, что шаблон является константой времени компиляции. Если он собирается из пользовательского ввода или конфигурации, на этом всё: генератор вам не поможет.
2. Пометьте содержащий тип как `partial`, вместе с каждым типом, внутри которого он вложен.
3. Замените поле `static readonly Regex` на метод `static partial Regex` (или на свойство `static partial Regex` только для чтения в .NET 9 и более поздних).
4. Перенесите шаблон, параметры и любой тайм-аут в атрибут `[GeneratedRegex]` на этом члене.
5. Уберите `RegexOptions.Compiled` из параметров. Генератор его игнорирует.
6. Перепишите места вызова с `s_myRegex.IsMatch(text)` на `MyRegex().IsMatch(text)`.
7. Откройте сгенерированный файл и проверьте XML-комментарий у выпущенного класса. Если там написано "Caches a `Regex` instance", генератор сдался, и вы ничего не получили.

Шаг 7 пропускают все, и именно он определяет, стоило ли всё упражнение затраченных усилий.

## Почему интерпретатор и RegexOptions.Compiled оба чего-то вам стоят

Когда вы пишете `new Regex("somepattern")`, шаблон разбирается в дерево, дерево оптимизируется, а результат записывается как набор опкодов для интерпретатора регулярных выражений. Каждое сопоставление затем проходит по этим опкодам. Это работает везде и дёшево в построении, но каждая диспетчеризация опкода является ветвлением, которое процессору приходится предсказывать.

`RegexOptions.Compiled` платит гораздо больший счёт при построении, чтобы устранить эту диспетчеризацию. Он делает всё то же, что и интерпретатор, а затем пропускает получившееся дерево узлов через компилятор на основе `System.Reflection.Emit`, который пишет IL в горстку объектов `DynamicMethod`. Этот IL всё равно нужно скомпилировать JIT-ом при первом использовании. Как [формулирует документация Microsoft](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), `RegexOptions.Compiled` "представляет фундаментальный компромисс между накладными расходами при первом использовании и накладными расходами при каждом последующем". Хуже того, он зависит от генерации кода в среде выполнения, поэтому на платформах, запрещающих динамически генерируемый код, и под Native AOT `Compiled` тихо превращается в пустую операцию, и вы без всякого предупреждения возвращаетесь к интерпретатору.

Генератор исходного кода устраняет компромисс, а не двигается внутри него. Та же работа по анализу и оптимизации выполняется, но выполняется на сборочной машине, и в вашу сборку попадает обычный C#, который компилятор превращает в обычный IL.

## Переработка кода

Вот форма, которая есть почти в каждой кодовой базе:

```csharp
// .NET 11, C# 14 - the pattern you are replacing
private static readonly Regex s_email = new(
    @"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$",
    RegexOptions.Compiled);

public static bool IsEmail(string s) => s_email.IsMatch(s);
```

И эквивалент с генерацией исходного кода:

```csharp
// .NET 11, C# 14
internal static partial class EmailRules
{
    [GeneratedRegex(@"^(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+)\.(?<tld>[A-Za-z]{2,})$")]
    private static partial Regex Email();

    public static bool IsEmail(string s) => Email().IsMatch(s);
}
```

Стоит обратить внимание на три вещи. Класс стал `partial`. `RegexOptions.Compiled` исчез, потому что генератор его игнорирует, а его присутствие только вводит в заблуждение следующего читателя. И у метода нет тела: вы его объявляете, генератор его реализует.

Кешировать что-либо самостоятельно не нужно. Сгенерированная реализация возвращает синглтон `static readonly`, в чём можно убедиться самому в выпущенном исходном коде.

### Частичные свойства, если вызов метода читается неестественно

Начиная с .NET 9 и C# 13, `[GeneratedRegex]` применяется также к частичным свойствам только для чтения, что читается лучше, когда регулярное выражение концептуально является значением, а не операцией:

```csharp
// .NET 11, C# 14 - requires C# 13 or later for partial properties
internal static partial class PhoneRules
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    internal static partial Regex Phone { get; }
}
```

Свойство должно быть только для чтения. Добавьте ему сеттер, и генератор его отвергнет. Разницы в поведении между двумя формами нет; выберите одну и придерживайтесь её.

### Параметры, культура и тайм-ауты

У атрибута пять перегрузок конструктора, послойно добавляющих параметры, имя культуры и тайм-аут сопоставления в миллисекундах:

```csharp
// .NET 11, C# 14
[GeneratedRegex(
    pattern: "abc|def",
    options: RegexOptions.IgnoreCase | RegexOptions.Multiline,
    cultureName: "en-US",
    matchTimeoutMilliseconds: 1000)]
private static partial Regex AbcOrDef();
```

`cultureName` имеет значение только для сопоставления без учёта регистра. Если вы передаёте `RegexOptions.CultureInvariant`, то передавать вдобавок имя культуры нельзя, и режим отказа здесь по-настоящему запутанный. Смотрите подводные камни ниже.

## Как на самом деле выглядят числа

Я это измерил, а не пересказал фольклор. Стенд: консольное приложение на .NET 10.0.201, Windows 11 x64, сборка Release, сопоставление приведённого выше привязанного шаблона электронной почты с 1000 строк, треть из которых не совпадает. Три движка: интерпретатор, `RegexOptions.Compiled` и `[GeneratedRegex]`.

Пропускная способность в установившемся режиме, 200 000 вызовов `IsMatch` за раунд, лучший из десяти раундов после трёх полных прогревочных раундов каждого движка:

| Движок | Время | На вызов |
| --- | --- | --- |
| Интерпретатор | 22.1 мс | 111 нс |
| `RegexOptions.Compiled` | 7.4 мс | 37 нс |
| `[GeneratedRegex]` | 7.0 мс | 35 нс |

Первое совпадение в холодном процессе, каждый движок измерен в собственном процессе, чтобы ничего не было прогрето, четыре прогона:

| Движок | Построение плюс первый `IsMatch` |
| --- | --- |
| Интерпретатор | от 3.7 до 4.0 мс |
| `RegexOptions.Compiled` | от 12.0 до 12.7 мс |
| `[GeneratedRegex]` | от 5.7 до 6.1 мс |

Читайте эти две таблицы вместе. По сравнению с `Compiled` генератор даёт небольшой выигрыш в пропускной способности и крупный выигрыш при запуске: тот же установившийся режим, меньше половины времени, чтобы до него добраться. По сравнению с интерпретатором это выигрыш в пропускной способности в 3.2 раза ценой примерно 2 мс дополнительного запуска в холодном процессе, большая часть которых является временем JIT для выпущенного сопоставителя и полностью исчезает под Native AOT, потому что платить за JIT уже не нужно.

Предупреждение на случай, если вы будете измерять это сами: моя первая попытка показала интерпретатор вдвое быстрее `Compiled`, что является бессмыслицей. Причина была в том, что все три движка использовали один общий измерительный метод, поэтому тот, кто запускался первым, поглощал стоимость многоуровневого JIT самого измерительного каркаса. Прогрейте каждый движок через каркас, прежде чем измерять хоть один из них.

## Анализатор уже всё знает

Искать эти места вызова вручную не нужно. .NET SDK поставляется с `SYSLIB1045`, анализатором информационного уровня, который помечает любое использование `Regex`, конвертируемое в генерацию исходного кода, вместе с исправлением, выполняющим конвертацию за вас. Информационная серьёзность означает, что он появляется лампочкой в IDE и больше нигде, поэтому повысьте его:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.SYSLIB1045.severity = warning
```

Теперь `dotnet build` перечисляет каждое оставшееся место вызова, а `dotnet format analyzers` может применить исправление массово. Установите серьёзность в `error`, как только кодовая база станет чистой, чтобы никто не добавил новое место.

## Когда генератор тихо сдаётся

Это та часть, которая кусается, потому что она не является ни ошибкой, ни предупреждением. Две конструкции заставляют генератор отказаться от выпуска собственного сопоставителя, и в обоих случаях он откатывается к выпуску закешированного обычного экземпляра `Regex`. Код компилируется, тесты проходят, а выгоды вы не получили никакой.

Первая это `RegexOptions.NonBacktracking`, который не поддерживают ни генератор исходного кода, ни `RegexCompiler`. Вторая это обратные ссылки без учёта регистра: сопоставление обратных ссылок с `IgnoreCase` требует внутренней таблицы регистров, которая живёт внутри `System.Text.RegularExpressions.dll` и недоступна сгенерированному коду. Это единственная конструкция, которую `RegexCompiler` обрабатывает, а генератор исходного кода нет.

Оба случая можно увидеть напрямую. Добавьте это в файл проекта:

```xml
<PropertyGroup>
  <EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>
  <CompilerGeneratedFilesOutputPath>generated</CompilerGeneratedFilesOutputPath>
</PropertyGroup>
```

Затем скомпилируйте эти три члена и прочитайте `generated/System.Text.RegularExpressions.Generator/.../RegexGenerator.g.cs`:

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

Выпущенный файл недвусмысленно показывает, какой из трёх случаев сработал:

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

"Caches a `Regex` instance" это откат. "Custom `Regex`-derived type" это настоящая генерация. Для случаев отката генератор дополнительно сообщает `SYSLIB1044`, но его серьёзность равна **Info**, поэтому он не появится в обычном журнале сборки и не уронит CI. Если вам это важно, поднимите его в `.editorconfig`:

```ini
dotnet_diagnostic.SYSLIB1044.severity = warning
```

Откат не бесполезен. Вы всё равно получаете кеширование и описательные XML-комментарии. Но если вы переводили горячий путь в расчёте на ускорение, вам нужно знать, что ускорения вы не получили.

## Диагностики с их настоящими сообщениями

Это точные строки, которые выдаёт SDK .NET 10, а не пересказ:

| ID | Серьёзность | Сообщение |
| --- | --- | --- |
| `SYSLIB1040` | Error | Invalid `GeneratedRegexAttribute` usage. |
| `SYSLIB1041` | Error | Multiple `GeneratedRegexAttribute` attributes were applied to the same method, but only one is allowed. |
| `SYSLIB1042` | Error | The specified regex is invalid. |
| `SYSLIB1043` | Error | `GeneratedRegexAttribute` method or property must be partial, parameterless, non-generic, non-abstract, and return `Regex`. If a property, it must also be get-only. |
| `SYSLIB1044` | Info | The regex generator couldn't generate a complete source implementation for the specified regular expression due to an internal limitation. |
| `SYSLIB1045` | Info | Use `GeneratedRegexAttribute` to generate the regular expression implementation at compile time. |

## Подводные камни, стоящие реального времени

**Непартиальный содержащий тип не даёт вам ошибку SYSLIB.** Генератор всё равно выпускает свою половину частичного типа, и жалуется компилятор C#, сообщением `CS0260: Missing partial modifier on declaration of type 'NotPartial'; another partial declaration of this type exists`. Если вложенность составляет три типа, `partial` нужен всем трём.

**`CultureInvariant` вместе с явным именем культуры выдаёт вводящее в заблуждение сообщение.** Такое сочетание:

```csharp
[GeneratedRegex(@"abc", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, "en-US")]
internal static partial Regex Abc();
```

падает с `error SYSLIB1042: The specified regex is invalid. 'cultureName'`. Шаблон `abc` очевидно корректен. Проблема в том, что `CultureInvariant` и именованная культура взаимно исключают друг друга, а диагностика переиспользует сообщение о неверном шаблоне, подставляя туда имя проблемного аргумента. Уберите имя культуры либо уберите `CultureInvariant`.

**Зафиксированная `LangVersion` ломает сборку в сгенерированном файле, а не в вашем.** Генератор выпускает типы с областью видимости `file`, возможность C# 11. Принудительно задайте `LangVersion` равной 10, и вы получите `CS8936: Feature 'file types' is not available in C# 10.0. Please use language version 11.0 or greater` с указанием на `RegexGenerator.g.cs`. Частичные свойства поднимают планку до C# 13: `CS8703: The modifier 'partial' is not valid for this item in C# 10.0. Please use language version '13.0' or greater`. Современные SDK задают `LangVersion` по умолчанию в соответствии с целевым фреймворком, так что это кусает только кодовые базы, задающие её явно.

**Сопоставление без учёта регистра заморожено на этапе сборки.** Для регулярного выражения без учёта регистра движки разворачивают шаблон по внутренней таблице регистров Unicode, так что `abc` становится эквивалентом `[Aa][Bb][Cc]`. Остальные движки делают это разворачивание в среде выполнения, используя таблицу той среды, в которой вы находитесь. Генератор исходного кода делает его на этапе компиляции, используя таблицу того целевого фреймворка, против которого вы компилировали. Если будущая редакция Unicode изменит эквивалентность, сгенерированное регулярное выражение сохранит старое поведение до пересборки. Это задокументировано в [примечаниях к `GeneratedRegexAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute) и почти никогда не является проблемой, но "почти никогда" это не "никогда".

**Проверки тайм-аута компилируются внутрь или наружу глобально.** Сгенерированный код читает окружающее значение по умолчанию ровно один раз:

```csharp
internal static readonly TimeSpan s_defaultTimeout =
    AppContext.GetData("REGEX_DEFAULT_MATCH_TIMEOUT") is TimeSpan timeout
        ? timeout
        : Regex.InfiniteMatchTimeout;

internal static readonly bool s_hasTimeout = s_defaultTimeout != Regex.InfiniteMatchTimeout;
```

и прячет каждый вызов `base.CheckTimeout()` в циклах с возвратом за `s_hasTimeout`. Это хорошо для пропускной способности на пути по умолчанию, и это означает, что если вы никогда не задаёте `REGEX_DEFAULT_MATCH_TIMEOUT` и никогда не передаёте `matchTimeoutMilliseconds`, шаблон с катастрофическим возвратом на враждебном вводе будет работать до тепловой смерти вашего конвейера запросов. Если шаблон касается недоверенного ввода, задайте `matchTimeoutMilliseconds` в атрибуте либо переведите именно этот шаблон на `RegexOptions.NonBacktracking` и примите откат.

**Размер кода растёт.** Генератор выпускает настоящий C# на каждый шаблон, и крупный шаблон порождает его много. Если у вас сотни регулярных выражений и лишь горстка горячих, перевод всех обменивает размер бинарника на пропускную способность, которую вы не заметите. Интерпретатор является правильным ответом для шаблона, который отрабатывает дважды при запуске.

## Где это важнее всего: trimming и Native AOT

Самый сильный аргумент в пользу генератора это не 2 нс на вызов. Это то, что `RegexOptions.Compiled` зависит от `System.Reflection.Emit`, а именно такой зависимости избегает [trim-safe код](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) и полностью удаляет [Native AOT](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/). Под AOT `Compiled` является молчаливой пустой операцией, а ваш тщательно оптимизированный горячий путь работает на интерпретаторе.

Генерация исходного кода переворачивает это. Поскольку сопоставитель является обычным C#, который видит компоновщик, триммер может убрать `RegexCompiler`, а возможно и сам reflection-emit из публикуемого вывода, и сгенерированный сопоставитель компилируется заранее вместе со всем остальным. Если вы публикуете с AOT, перевод каждого константного шаблона это не оптимизация, а исправление предположения, которое ваш код делает молча.

## Связанные статьи

- [Что такое генератор исходного кода и когда он мне нужен?](/ru/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [RegexOptions.AnyNewLine приземляется в .NET 11 Preview 3](/ru/2026/04/regex-anynewline-dotnet-11-preview-3/)
- [Как правильно использовать SearchValues в .NET 11](/ru/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)
- [Что такое Native AOT и чего он вам стоит?](/ru/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Что такое trim-safe код и как его писать?](/ru/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)

## Источники

- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators) на Microsoft Learn
- [Справочник API `GeneratedRegexAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.regularexpressions.generatedregexattribute), включая примечания о таблице регистров времени компиляции
- [Диагностики SYSLIB для генерации исходного кода регулярных выражений](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib1040-1049)
- [Regular Expression Improvements in .NET 7](https://devblogs.microsoft.com/dotnet/regular-expression-improvements-in-dotnet-7/) в блоге .NET
- [`DiagnosticDescriptors.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.RegularExpressions/gen/DiagnosticDescriptors.cs) в dotnet/runtime, для серьёзности каждой диагностики

Показатели производительности и текст диагностик в этой статье получены локально на SDK .NET 10.0.201, Windows 11 x64, конфигурация Release.
