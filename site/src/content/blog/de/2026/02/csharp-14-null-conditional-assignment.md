---
title: "Null-bedingte Zuweisung in C# 14: ?. und ?[] auf der linken Seite verwenden"
description: "C# 14 erweitert die null-bedingten Operatoren, sodass sie auf der linken Seite von Zuweisungen funktionieren und ausführliche Null-Prüfungen beim Setzen von Eigenschaften oder Indexern entfallen."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "null-safety"
lang: "de"
translationOf: "2026/02/csharp-14-null-conditional-assignment"
translatedBy: "claude"
translationDate: 2026-04-29
---

C# 14 bringt eine kleine, aber wirkungsvolle Änderung: Die null-bedingten Operatoren `?.` und `?[]` funktionieren jetzt auf der linken Seite von Zuweisungen. Das beseitigt ein verbreitetes Muster, bei dem Eigenschaftszuweisungen in Null-Prüfungen verpackt werden.

## Das ausführliche Muster, das es ersetzt

Vor C# 14 erforderte das Zuweisen an eine Eigenschaft, nur wenn ein Objekt nicht null ist, explizite Prüfungen:

```csharp
if (customer is not null)
{
    customer.LastOrderDate = DateTime.UtcNow;
}

if (settings is not null)
{
    settings["theme"] = "dark";
}
```

Bei tief verschachtelten Objekten wurde es schlimmer:

```csharp
if (order?.Customer?.Address is not null)
{
    order.Customer.Address.IsVerified = true;
}
```

## Null-bedingte Zuweisung in C# 14

C# 14 erlaubt es Ihnen, dieselbe Logik kürzer zu schreiben:

```csharp
customer?.LastOrderDate = DateTime.UtcNow;

settings?["theme"] = "dark";

order?.Customer?.Address?.IsVerified = true;
```

Die Zuweisung wird nur ausgeführt, wenn die linke Seite zu einer nicht-null Referenz ausgewertet wird. Die rechte Seite wird nie ausgewertet, wenn das Ziel null ist.

## So funktioniert es

Der Ausdruck `P?.A = B` entspricht:

```csharp
if (P is not null)
{
    P.A = B;
}
```

Mit einem wichtigen Unterschied: `P` wird nur einmal ausgewertet. Das ist relevant, wenn `P` ein Methodenaufruf ist oder Seiteneffekte hat.

## Verbund-Zuweisungsoperatoren

Null-bedingte Zuweisung funktioniert auch mit Verbundoperatoren wie `+=`, `-=`, `*=` und anderen:

```csharp
inventory?.StockLevel += restockAmount;

counter?.Value -= 1;

account?.Balance *= interestRate;
```

Jeder davon wertet die linke Seite einmal aus und wendet die Operation nur an, wenn das Ziel nicht null ist.

## Inkrement und Dekrement sind nicht erlaubt

Eine Einschränkung: Die Operatoren `++` und `--` können nicht mit der null-bedingten Zuweisung verwendet werden. Dies kompiliert nicht:

```csharp
// Error: ++ and -- not allowed
counter?.Value++;
```

Verwenden Sie stattdessen die Verbundzuweisung:

```csharp
counter?.Value += 1;
```

## Praktisches Beispiel: Ereignishandler

Ein häufiger Anwendungsfall ist das bedingte Setzen von Ereignishandlern:

```csharp
public void Initialize(Button? submitButton, Button? cancelButton)
{
    submitButton?.Click += OnSubmit;
    cancelButton?.Click += OnCancel;
}
```

Ohne null-bedingte Zuweisung bräuchten Sie separate Null-Prüfungen für jeden Button.

## Verkettung mit Indexern

Der Operator `?[]` funktioniert genauso für Indexer-Zuweisungen:

```csharp
Dictionary<string, string>? headers = GetHeaders();

headers?["Authorization"] = $"Bearer {token}";
headers?["Content-Type"] = "application/json";
```

Wenn `headers` null ist, wird keine der Zuweisungen ausgeführt und keine Ausnahme geworfen.

## Wann sollten Sie es verwenden

Null-bedingte Zuweisung funktioniert am besten, wenn:
- Sie optionale Objekte haben, die möglicherweise aktualisiert werden müssen
- Sie mit nullbaren Referenztypen arbeiten und ausführliche Null-Prüfungen vermeiden möchten
- Die Zuweisung eine Fire-and-Forget-Operation ist, bei der Sie nicht wissen müssen, ob sie ausgeführt wurde

Die Funktion ist in .NET 10 mit C# 14 verfügbar. Setzen Sie `<LangVersion>14</LangVersion>` in Ihrer Projektdatei, um sie zu aktivieren.

Die vollständige Spezifikation finden Sie unter [Null-bedingte Zuweisung auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/null-conditional-assignment).
