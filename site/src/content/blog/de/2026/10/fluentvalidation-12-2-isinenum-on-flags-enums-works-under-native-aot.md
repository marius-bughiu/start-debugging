---
title: "FluentValidation 12.2 behebt den Absturz von IsInEnum() bei [Flags]-Enums in Native-AOT-Apps"
description: "FluentValidation 12.2.0, veröffentlicht am 2026-10-10, ersetzt in EnumValidator Enum.GetValues durch Enum.GetValuesAsUnderlyingType, sodass IsInEnum() auf einem [Flags]-Enum in einem Native-AOT-Binary keine NotSupportedException mehr wirft."
pubDate: 2026-10-12
tags:
  - "fluentvalidation"
  - "native-aot"
  - "dotnet"
  - "csharp"
  - "validation"
lang: "de"
translationOf: "2026/10/fluentvalidation-12-2-isinenum-on-flags-enums-works-under-native-aot"
translatedBy: "claude"
translationDate: 2026-10-12
---

[FluentValidation 12.2.0](https://github.com/FluentValidation/FluentValidation/releases/tag/12.2.0) ist am 2026-10-10 auf NuGet erschienen. Der Großteil des Changelogs ist Routinepflege (litauische und belarussische Meldungen, ein paar Korrekturen an `PropertyChain`), aber eine Zeile ist wichtig, wenn Sie mit `PublishAot` veröffentlichen: "Change EnumValidator to work under native AOT". Vor diesem Release ließ sich `RuleFor(x => x.Access).IsInEnum()` auf einem `[Flags]`-Enum kompilieren, bestand jeden JIT-basierten Test und brachte dann das veröffentlichte native Binary beim ersten Validierungsaufruf zum Absturz.

## Wie der Absturz aussah

Hier eine minimale App. Sie hat die Form, die man in jeder per AOT veröffentlichten Minimal API findet, die ein Enum für Berechtigungen oder Optionen validiert:

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

Ich habe sie mit `<PublishAot>true</PublishAot>` auf dem .NET 10.0.302 SDK (osx-arm64) veröffentlicht, einmal gegen FluentValidation 12.1.1 und einmal gegen 12.2.0. Mit 12.1.1 stirbt das Binary sofort:

```text
Unhandled exception. System.NotSupportedException: 'Access[]' is missing native code or metadata.
   at System.Array.CreateInstance(Type, Int32) + 0x5c
   at System.RuntimeType.GetEnumValues() + 0x88
```

Mit 12.2.0 gibt derselbe Code `True` und `False` aus, was die richtige Antwort für eine gültige Kombination und ein undefiniertes Bit ist.

## Warum nur [Flags]-Enums betroffen waren

`EnumValidator` kennt zwei Pfade. Enums ohne Flags laufen über `Enum.IsDefined`, das schon immer AOT-sicher war. Flags-Enums laufen über eine private Methode `EvaluateFlagEnumValues`, die aus jedem deklarierten Wert eine Maske baut, und in 12.1.x tat sie das mit `Enum.GetValues(Type)`. Diese Überladung ist mit `[RequiresDynamicCode]` markiert, weil sie zur Laufzeit ein `Access[]` allokieren muss, und ILC kann keinen Array-Typ vorab generieren, den es statisch nie gesehen hat.

Das Veröffentlichen hat Sie gewarnt, nur nicht laut. Standardmäßig fasst der Trimmer Warnungen aus Drittanbieter-Assemblies zu einer einzigen Zeile zusammen:

```text
warning IL3053: Assembly 'FluentValidation' produced AOT analysis warnings.
```

Erst mit `-p:TrimmerSingleWarn=false` sehen Sie das eigentliche `IL3050`, das auf `EnumValidator.cs(103)` und `Enum.GetValues(Type)` zeigt.

## Die Korrektur in einer Zeile

[PR #2371](https://github.com/FluentValidation/FluentValidation/pull/2371) ersetzt den Aufruf durch `Enum.GetValuesAsUnderlyingType(enumType)`, das seit .NET 8 verfügbar ist (dem minimalen Target von FluentValidation 12). Es liefert die Werte geboxt als ihren zugrunde liegenden Ganzzahltyp, sodass kein Array vom Enum-Typ entsteht, und die bestehende `Convert.ToInt64`-Schleife funktioniert unverändert weiter. Keine API-Änderung, keine Verhaltensänderung, und pro Wert entfällt sogar ein Box/Unbox-Umweg.

```csharp
// FluentValidation 12.2.0, EnumValidator.EvaluateFlagEnumValues
foreach (var enumValue in Enum.GetValuesAsUnderlyingType(enumType)) {
    var enumValueAsInt64 = Convert.ToInt64(enumValue);
    // ...
}
```

Mit 12.2.0 verschwindet die `IL3053`-Warnung für FluentValidation in diesem Beispiel vollständig aus der Ausgabe des Veröffentlichens.

## Die andere Korrektur, die Sie kennen sollten

12.2.0 behebt außerdem `context.PropertyPath` innerhalb eines `.When()` bei `RuleForEach` ([#2363](https://github.com/FluentValidation/FluentValidation/pull/2363)). Die Bedingung sah bisher den Pfad des vorherigen Elements (oder `null` beim ersten), weil der Kontext erst nach Ausführung der Bedingung aktualisiert wurde. Wenn Sie innerhalb von Bedingungen Fehlerschlüssel oder Logzeilen aus `PropertyPath` bauen, haben Sie um eins verschobene Pfade erhalten.

## Was zu tun ist

Aktualisieren Sie das Paket:

```bash
dotnet add package FluentValidation --version 12.2.0
```

Wenn Sie Native AOT ausliefern, setzen Sie in der CI außerdem mindestens einmal `TrimmerSingleWarn` auf `false`. Zusammengefasste `IL3053`-Zeilen sind der Weg, auf dem Bugs wie dieser in die Produktion gelangen. Und falls Sie noch überlegen, ob Sie FluentValidation auf ASP.NET Core 11 überhaupt brauchen: Ich habe es in [Minimal-API-Validierung vs. FluentValidation](/de/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) mit der eingebauten Option verglichen.
