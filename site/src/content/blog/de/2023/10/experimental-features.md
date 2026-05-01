---
title: "C# Wie Sie Features als experimentell kennzeichnen"
description: "Ab C# 12 lassen sich Typen, Methoden, Properties oder Assemblies mit dem neuen ExperimentalAttribute als experimentell markieren. Erfahren Sie, wie Sie es mit diagnosticId, pragma-Tags und UrlFormat einsetzen."
pubDate: 2023-10-29
updatedDate: 2023-11-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/experimental-features"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab C# 12 wird ein neues `ExperimentalAttribute` eingeführt, mit dem Sie Typen, Methoden, Properties oder Assemblies als experimentelle Funktionen kennzeichnen können. Bei der Verwendung wird eine Compiler-Warnung ausgelöst, die sich über ein `#pragma`-Tag deaktivieren lässt.

Das `Experimental`-Attribut erfordert einen `diagnosticId`-Parameter im Konstruktor. Diese Diagnose-ID wird Teil der Compiler-Fehlermeldung, die bei jeder Verwendung des experimentellen Features erzeugt wird. Hinweis: Sie können dieselbe diagnostic-id auf Wunsch in mehreren Attributen verwenden.

**Wichtig:** Verwenden Sie in Ihrer `diagnosticId` keine Bindestriche (`-`) oder andere Sonderzeichen, da diese die `#pragma`-Syntax brechen und Nutzer daran hindern können, die Warnung zu deaktivieren. Beispielsweise lässt sich mit `BAR-001` als Diagnose-ID die Warnung nicht unterdrücken und löst zusätzlich eine Compiler-Warnung im pragma-Tag aus.

> CS1696 Single-line comment or end-of-line expected.

[![](/wp-content/uploads/2023/10/image-3.png)](/wp-content/uploads/2023/10/image-3.png)

Sie können im Attribut auch ein `UrlFormat` angeben, um Entwickler zur Dokumentation des experimentellen Features zu führen. Möglich ist entweder eine absolute URL wie `https://acme.com/warnings/BAR001` oder eine generische String-Format-URL (`https://acme.com/warnings/{0}`), bei der das Framework den Rest übernimmt.

Sehen wir uns ein paar Beispiele an.

## Eine Methode als experimentell kennzeichnen

```cs
using System.Diagnostics.CodeAnalysis;

[Experimental("BAR001")]
void Foo() { }
```

Sie versehen die Methode einfach mit dem `Experimental`-Attribut und geben eine `diagnosticId` mit. Beim Aufruf von `Foo()` wird die folgende Compiler-Warnung erzeugt:

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.

Sie können diese Warnung mit pragma-Tags umgehen:

```cs
#pragma warning disable BAR001
Foo();
#pragma warning restore BAR001
```

## Einen Link zur Dokumentation angeben

Wie oben erwähnt, lässt sich über die `UrlFormat`-Eigenschaft des Attributs ein Link zur Dokumentation angeben. Das ist vollkommen optional.

```cs
[Experimental("BAR001", UrlFormat = "https://acme.com/warnings/{0}")]
void Foo() { }
```

Damit gelangen Sie beim Klick auf die Fehlercodes in Visual Studio direkt zur angegebenen Dokumentationsseite. Zusätzlich wird die URL auch in die Diagnose-Fehlermeldung eingefügt:

> BAR001 'Foo()' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed. (https://acme.com/warnings/BAR001)

## Weitere Einsatzorte

Das Attribut lässt sich an nahezu jeder denkbaren Stelle verwenden: an Assemblies, Modulen, Klassen, Structs, Enums, Properties, Feldern, Events und vielem mehr. Eine vollständige Liste der erlaubten Anwendungsorte zeigt die Definition selbst:

```cs
[AttributeUsage(AttributeTargets.Assembly |
                AttributeTargets.Module |
                AttributeTargets.Class |
                AttributeTargets.Struct |
                AttributeTargets.Enum |
                AttributeTargets.Constructor |
                AttributeTargets.Method |
                AttributeTargets.Property |
                AttributeTargets.Field |
                AttributeTargets.Event |
                AttributeTargets.Interface |
                AttributeTargets.Delegate, Inherited = false)]
public sealed class ExperimentalAttribute : Attribute { ... }
```
