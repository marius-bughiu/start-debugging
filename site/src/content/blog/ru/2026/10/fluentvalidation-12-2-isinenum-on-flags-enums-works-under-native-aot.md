---
title: "FluentValidation 12.2 исправляет падение IsInEnum() в приложениях native AOT на перечислениях [Flags]"
description: "FluentValidation 12.2.0, вышедший 10 октября 2026 года, заменяет Enum.GetValues на Enum.GetValuesAsUnderlyingType внутри EnumValidator, поэтому IsInEnum() на перечислении [Flags] больше не выбрасывает NotSupportedException в бинарнике native AOT."
pubDate: 2026-10-12
tags:
  - "fluentvalidation"
  - "native-aot"
  - "dotnet"
  - "csharp"
  - "validation"
lang: "ru"
translationOf: "2026/10/fluentvalidation-12-2-isinenum-on-flags-enums-works-under-native-aot"
translatedBy: "claude"
translationDate: 2026-10-12
---

[FluentValidation 12.2.0](https://github.com/FluentValidation/FluentValidation/releases/tag/12.2.0) появился в NuGet 10 октября 2026 года. Большая часть списка изменений носит служебный характер (сообщения на литовском и белорусском, пара исправлений в `PropertyChain`), но одна строка очень важна, если вы публикуете с `PublishAot`: "Change EnumValidator to work under native AOT". До этого релиза `RuleFor(x => x.Access).IsInEnum()` на перечислении `[Flags]` компилировался, проходил все тесты на JIT, а затем опубликованный нативный бинарник падал при первом же вызове валидации.

## Как выглядело падение

Вот минимальное приложение. Такую же форму можно встретить в любом minimal API, опубликованном с AOT, которое валидирует перечисление прав доступа или опций:

```csharp
using FluentValidation;

var v = new GrantValidator();
Console.WriteLine(v.Validate(new Grant(Access.Read | Access.Write)).IsValid);
Console.WriteLine(v.Validate(new Grant((Access)64)).IsValid);

[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Delete = 4 }

public record Grant(Access Access);

public class GrantValidator : AbstractValidator<Grant>
{
    public GrantValidator() => RuleFor(x => x.Access).IsInEnum();
}
```

Я опубликовал его с `<PublishAot>true</PublishAot>` на SDK .NET 10.0.302 (osx-arm64), один раз с FluentValidation 12.1.1 и один раз с 12.2.0. На 12.1.1 бинарник падает сразу:

```text
Unhandled exception. System.NotSupportedException: 'Access[]' is missing native code or metadata.
   at System.Array.CreateInstance(Type, Int32) + 0x5c
   at System.RuntimeType.GetEnumValues() + 0x88
```

На 12.2.0 тот же код выводит `True` и `False`, и это правильный ответ для допустимой комбинации и неопределённого бита.

## Почему пострадали только перечисления [Flags]

`EnumValidator` работает по двум путям. Перечисления без флагов проходят через `Enum.IsDefined`, который всегда был безопасен для AOT. Перечисления с флагами проходят через приватный метод `EvaluateFlagEnumValues`, который строит маску из всех объявленных значений, и в 12.1.x он делал это через `Enum.GetValues(Type)`. Эта перегрузка помечена `[RequiresDynamicCode]`, поскольку ей нужно выделить `Access[]` во время выполнения, а ILC не может заранее сгенерировать тип массива, который он ни разу не видел статически.

Публикация вас предупреждала, просто негромко. По умолчанию триммер сворачивает предупреждения сторонних сборок в одну строку:

```text
warning IL3053: Assembly 'FluentValidation' produced AOT analysis warnings.
```

Только с `-p:TrimmerSingleWarn=false` видно настоящее `IL3050`, указывающее на `EnumValidator.cs(103)` и `Enum.GetValues(Type)`.

## Исправление в одну строку

[PR #2371](https://github.com/FluentValidation/FluentValidation/pull/2371) заменяет этот вызов на `Enum.GetValuesAsUnderlyingType(enumType)`, доступный начиная с .NET 8 (это минимальная целевая платформа FluentValidation 12). Он возвращает значения, упакованные как их базовый целочисленный тип, поэтому массив с типом перечисления не создаётся, а существующий цикл с `Convert.ToInt64` продолжает работать без изменений. Ни изменений API, ни изменений поведения, и к тому же исчезает лишний цикл упаковки и распаковки для каждого значения.

```csharp
// FluentValidation 12.2.0, EnumValidator.EvaluateFlagEnumValues
foreach (var enumValue in Enum.GetValuesAsUnderlyingType(enumType)) {
    var enumValueAsInt64 = Convert.ToInt64(enumValue);
    // ...
}
```

С 12.2.0 предупреждение `IL3053` для FluentValidation в этом примере полностью исчезает из вывода публикации.

## Ещё одно исправление, о котором стоит знать

12.2.0 также исправляет `context.PropertyPath` внутри `.When()` у `RuleForEach` ([#2363](https://github.com/FluentValidation/FluentValidation/pull/2363)). Раньше условие видело путь предыдущего элемента (или `null` для первого), потому что контекст обновлялся уже после выполнения условия. Если вы формируете ключи ошибок или строки журнала из `PropertyPath` внутри условий, вы получали пути со смещением на один элемент.

## Что делать

Обновите пакет:

```bash
dotnet add package FluentValidation --version 12.2.0
```

Если вы поставляете native AOT, хотя бы раз установите в CI `TrimmerSingleWarn` в `false`. Именно через свёрнутые строки `IL3053` такие ошибки и попадают в продакшен. А если вы ещё решаете, нужен ли вам FluentValidation вообще в ASP.NET Core 11, я сравнил его со встроенным вариантом в статье [валидация в minimal API против FluentValidation](/ru/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/).
