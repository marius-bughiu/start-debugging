---
title: "Playwright .NET 1.64 добавляет Locator.Within(), и это цепочка Locator, прочитанная задом наперёд"
description: "Microsoft.Playwright 1.64 добавляет Locator.Within(), чтобы можно было написать 'эта кнопка внутри того диалога'. Быстрая проверка показывает, что он строит ровно тот же локатор, что и parent.Locator(child), включая разрешение Nth() для каждого родителя."
pubDate: 2026-10-23
tags:
  - "dotnet"
  - "playwright"
  - "testing"
  - "csharp"
lang: "ru"
translationOf: "2026/10/playwright-dotnet-1-64-locator-within-is-locator-chaining-read-backwards"
translatedBy: "claude"
translationDate: 2026-10-23
---

[Microsoft.Playwright 1.64.0](https://github.com/microsoft/playwright-dotnet/releases/tag/v1.64.0) появился в NuGet 2026-10-21, а через день вышел 1.64.1 с обновлением встроенного Node.js до 24.22.1. В релизе Chromium 156, Firefox 157 и WebKit 27.2, тестирование WebMCP и скринкасты в VP9, но API, с которым большинство тестовых наборов столкнётся первым, это [`Locator.Within()`](https://playwright.dev/dotnet/docs/api/class-locator#locator-within).

## Сначала дочерний элемент, потом родитель

`Within(ILocator)` возвращает локатор, который находит элементы текущего локатора внутри каждого элемента, подходящего под аргумент. Главное здесь порядок чтения. Если у вас уже есть два локатора, теперь можно сказать "эта кнопка внутри того диалога", а не строить цепочку снаружи внутрь:

```csharp
var save = page.GetByRole(AriaRole.Button, new() { Name = "Save" });
var dialog = page.GetByTestId("settings-dialog");

// 1.64+
await save.Within(dialog).ClickAsync();

// Before 1.64
await dialog.Locator(save).ClickAsync();
```

Относительные локаторы вроде `Nth()` и `First` разрешаются отдельно внутри каждого родителя, и именно благодаря этому работают запросы по столбцам:

```csharp
var thirdColumn = page.GetByRole(AriaRole.Cell).Nth(2)
    .Within(page.GetByRole(AriaRole.Row));

await Expect(thirdColumn).ToHaveTextAsync(new[] { "Apple", "Banana", "Cherry" });
```

## Во что это превращается

Я запустил обе формы в Chromium 156 с `Microsoft.Playwright` 1.64.1 на .NET SDK 10.0.302, на таблице из трёх строк и странице с двумя кнопками "Save" (одна в диалоге, другая в форме). Результаты:

| Локатор | Совпадения |
| --- | --- |
| `cells.Nth(2)` | `Apple` |
| `cells.Nth(2).Within(rows)` | `Apple, Banana, Cherry` |
| `rows.Locator(cells.Nth(2))` | `Apple, Banana, Cherry` |
| `rows.Locator("td").Nth(2)` | `Apple` |
| `save` | `Save, Save` |
| `save.Within(dialog)` | `Save` |

`ToString()` ставит точку: `cells.Nth(2).Within(rows)` выводит `GetByRole(AriaRole.Row).Locator(GetByRole(AriaRole.Cell).Nth(2))`, символ в символ как старая цепочка. `Within()` не новый механизм сопоставления. Это существующая перегрузка `Locator(ILocator)` с переставленными аргументами, и сообщения об ошибках, и записи в trace viewer будут показывать форму цепочки.

Отсюда два практических следствия:

- **Мигрировать нечего.** Если ваш набор тестов уже использует `parent.Locator(childLocator)`, семантика `Nth()` для каждого родителя там уже была. Переход на `Within()` нужен только ради читаемости, особенно в page objects, которые отдают дочерние локаторы и позволяют вызывающему коду выбрать область поиска.
- **Настоящая ловушка по-прежнему в том, где стоит `Nth()`.** `rows.Locator("td").Nth(2)` применяет `Nth(2)` к плоскому результату и даёт одну ячейку. Ставьте `Nth()` на внутренний локатор (или используйте `Within()`, который к этому подталкивает), когда нужно одно совпадение на каждого родителя.

## Breaking change в том же релизе

1.64 также меняет видимость: элементы внутри iframe, который сам не виден, например из-за `visibility: hidden`, теперь считаются скрытыми для действий, `IsVisibleAsync()` и `ToBeVisibleAsync()`. Если тест случайно кликал через скрытый фрейм, теперь он упадёт по таймауту в ожидании видимости. Это стоит проверить перед обновлением в первую очередь, раньше, чем `Within()`.

Обновление:

```bash
dotnet add package Microsoft.Playwright --version 1.64.1
pwsh bin/Debug/net10.0/playwright.ps1 install
```

Учтите, что шаг установки удаляет сборки браузеров от старых версий Playwright, которые он считает неиспользуемыми, так что другому проекту на более старой версии может понадобиться снова запустить свою установку. Если вы используете Playwright для UI-тестов под управлением агентов, дисциплина селекторов из статьи [о самовосстанавливающихся E2E-тестах, когда агент переименовывает селекторы](/2026/09/self-healing-e2e-tests-when-a-coding-agent-renames-selectors/) хорошо сочетается с такими ограниченными по области локаторами.
