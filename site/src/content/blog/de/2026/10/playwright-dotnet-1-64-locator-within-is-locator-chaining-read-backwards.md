---
title: "Playwright .NET 1.64 bringt Locator.Within(), und es ist Locator-Verkettung rückwärts gelesen"
description: "Microsoft.Playwright 1.64 ergänzt Locator.Within(), damit sich 'dieser Button, innerhalb jenes Dialogs' so schreiben lässt. Ein kurzer Test zeigt, dass es exakt denselben Locator wie parent.Locator(child) erzeugt, einschließlich der Nth()-Auflösung pro Elternelement."
pubDate: 2026-10-23
tags:
  - "dotnet"
  - "playwright"
  - "testing"
  - "csharp"
lang: "de"
translationOf: "2026/10/playwright-dotnet-1-64-locator-within-is-locator-chaining-read-backwards"
translatedBy: "claude"
translationDate: 2026-10-23
---

[Microsoft.Playwright 1.64.0](https://github.com/microsoft/playwright-dotnet/releases/tag/v1.64.0) erschien am 2026-10-21 auf NuGet, einen Tag später gefolgt von 1.64.1 mit einem Update des mitgelieferten Node.js auf 24.22.1. Das Release bringt Chromium 156, Firefox 157 und WebKit 27.2, WebMCP-Tests und VP9-Screencasts, doch die API, mit der die meisten Testsuites zuerst in Berührung kommen, ist [`Locator.Within()`](https://playwright.dev/dotnet/docs/api/class-locator#locator-within).

## Erst das Kind, dann das Elternelement

`Within(ILocator)` liefert einen Locator, der die Elemente des aktuellen Locators innerhalb jedes Elements findet, das auf das Argument passt. Entscheidend ist die Lesereihenfolge. Wer bereits zwei Locators hat, kann jetzt "dieser Button, innerhalb jenes Dialogs" schreiben, statt die Kette von außen nach innen aufzubauen:

```csharp
var save = page.GetByRole(AriaRole.Button, new() { Name = "Save" });
var dialog = page.GetByTestId("settings-dialog");

// 1.64+
await save.Within(dialog).ClickAsync();

// Before 1.64
await dialog.Locator(save).ClickAsync();
```

Relative Locators wie `Nth()` und `First` werden innerhalb jedes Elternelements separat aufgelöst, und genau das macht Spaltenabfragen möglich:

```csharp
var thirdColumn = page.GetByRole(AriaRole.Cell).Nth(2)
    .Within(page.GetByRole(AriaRole.Row));

await Expect(thirdColumn).ToHaveTextAsync(new[] { "Apple", "Banana", "Cherry" });
```

## Was daraus wird

Ich habe beide Formen gegen Chromium 156 mit `Microsoft.Playwright` 1.64.1 auf dem .NET SDK 10.0.302 ausgeführt, mit einer dreizeiligen Tabelle und einer Seite mit zwei "Save"-Buttons (einer in einem Dialog, einer in einem Formular). Die Ergebnisse:

| Locator | Treffer |
| --- | --- |
| `cells.Nth(2)` | `Apple` |
| `cells.Nth(2).Within(rows)` | `Apple, Banana, Cherry` |
| `rows.Locator(cells.Nth(2))` | `Apple, Banana, Cherry` |
| `rows.Locator("td").Nth(2)` | `Apple` |
| `save` | `Save, Save` |
| `save.Within(dialog)` | `Save` |

`ToString()` klärt die Frage: `cells.Nth(2).Within(rows)` gibt `GetByRole(AriaRole.Row).Locator(GetByRole(AriaRole.Cell).Nth(2))` aus, Zeichen für Zeichen identisch mit der alten Kette. `Within()` ist keine neue Matching-Engine. Es ist die bestehende Überladung `Locator(ILocator)` mit vertauschten Argumenten, und Fehlermeldungen sowie Einträge im Trace Viewer zeigen die verkettete Form.

Das hat zwei praktische Folgen:

- **Kein Verhalten, das migriert werden muss.** Wenn die Suite bereits `parent.Locator(childLocator)` nutzt, gab es die `Nth()`-Semantik pro Elternelement schon. Der Wechsel zu `Within()` dient allein der Lesbarkeit, vor allem in Page Objects, die Kind-Locators bereitstellen und den Aufrufer den Gültigkeitsbereich wählen lassen.
- **Die eigentliche Falle bleibt die Position von `Nth()`.** `rows.Locator("td").Nth(2)` wendet `Nth(2)` auf das flache Ergebnis an und liefert eine einzige Zelle. `Nth()` gehört auf den inneren Locator (oder man nutzt `Within()`, das genau dazu verleitet), wenn ein Treffer pro Elternelement gewünscht ist.

## Der Breaking Change im selben Release

1.64 ändert auch die Sichtbarkeit: Elemente in einem iframe, das selbst nicht sichtbar ist, etwa durch `visibility: hidden`, gelten jetzt für Aktionen, `IsVisibleAsync()` und `ToBeVisibleAsync()` als verborgen. Wenn ein Test versehentlich durch einen verborgenen Frame geklickt hat, läuft er nun beim Warten auf Sichtbarkeit in ein Timeout. Das sollte man vor dem Update eher prüfen als `Within()`.

Aktualisierung mit:

```bash
dotnet add package Microsoft.Playwright --version 1.64.1
pwsh bin/Debug/net10.0/playwright.ps1 install
```

Der Installationsschritt entfernt Browser-Builds älterer Playwright-Versionen, die er für ungenutzt hält. Ein anderes Projekt auf einer älteren Version muss seine eigene Installation daher eventuell erneut ausführen. Wer Playwright für agentengesteuerte UI-Tests einsetzt, findet in [selbstheilenden E2E-Tests, wenn ein Coding-Agent Selektoren umbenennt](/2026/09/self-healing-e2e-tests-when-a-coding-agent-renames-selectors/) eine Selektor-Disziplin, die gut zu solchen eingegrenzten Locators passt.
