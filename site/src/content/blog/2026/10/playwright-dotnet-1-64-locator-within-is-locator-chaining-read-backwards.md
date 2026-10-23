---
title: "Playwright .NET 1.64 adds Locator.Within(), and it is Locator chaining read backwards"
description: "Microsoft.Playwright 1.64 adds Locator.Within() so you can write 'this button, within that dialog'. A quick probe shows it builds exactly the same locator as parent.Locator(child), including per-parent Nth() resolution."
pubDate: 2026-10-23
tags:
  - "dotnet"
  - "playwright"
  - "testing"
  - "csharp"
---

[Microsoft.Playwright 1.64.0](https://github.com/microsoft/playwright-dotnet/releases/tag/v1.64.0) hit NuGet on October 21, 2026, followed by 1.64.1 a day later with a bundled Node.js 24.22.1 bump. The release ships Chromium 156, Firefox 157 and WebKit 27.2, WebMCP testing and VP9 screencasts, but the API most test suites will touch first is [`Locator.Within()`](https://playwright.dev/dotnet/docs/api/class-locator#locator-within).

## Child first, parent second

`Within(ILocator)` returns a locator that matches the current locator's elements inside each element matched by the argument. The point is reading order. When you already hold two locators, you can now say "this button, within that dialog" instead of building the chain from the outside in:

```csharp
var save = page.GetByRole(AriaRole.Button, new() { Name = "Save" });
var dialog = page.GetByTestId("settings-dialog");

// 1.64+
await save.Within(dialog).ClickAsync();

// Before 1.64
await dialog.Locator(save).ClickAsync();
```

Relative locators like `Nth()` and `First` are resolved inside each parent separately, which is what makes column queries work:

```csharp
var thirdColumn = page.GetByRole(AriaRole.Cell).Nth(2)
    .Within(page.GetByRole(AriaRole.Row));

await Expect(thirdColumn).ToHaveTextAsync(new[] { "Apple", "Banana", "Cherry" });
```

## What it compiles down to

I ran both forms against Chromium 156 with `Microsoft.Playwright` 1.64.1 on .NET SDK 10.0.302, using a three-row table and a page with two "Save" buttons (one in a dialog, one in a form). The results:

| Locator | Matches |
| --- | --- |
| `cells.Nth(2)` | `Apple` |
| `cells.Nth(2).Within(rows)` | `Apple, Banana, Cherry` |
| `rows.Locator(cells.Nth(2))` | `Apple, Banana, Cherry` |
| `rows.Locator("td").Nth(2)` | `Apple` |
| `save` | `Save, Save` |
| `save.Within(dialog)` | `Save` |

`ToString()` settles it: `cells.Nth(2).Within(rows)` prints `GetByRole(AriaRole.Row).Locator(GetByRole(AriaRole.Cell).Nth(2))`, character for character the same as the old chain. `Within()` is not a new matching engine. It is the existing `Locator(ILocator)` overload with the arguments swapped, and error messages and trace viewer entries will show the chained form.

That has two practical consequences:

- **No behavior change to migrate.** If your suite already uses `parent.Locator(childLocator)`, the per-parent `Nth()` semantics were already there. Switching to `Within()` is purely about readability, especially in page objects that expose child locators and let callers pick the scope.
- **The real trap is still where `Nth()` sits.** `rows.Locator("td").Nth(2)` applies `Nth(2)` to the flattened result and gives you one cell. Put `Nth()` on the inner locator (or use `Within()`, which nudges you to) when you want one match per parent.

## The breaking change in the same release

1.64 also changes visibility: elements inside an iframe that is itself not visible, for example `visibility: hidden`, are now considered hidden by actions, `IsVisibleAsync()` and `ToBeVisibleAsync()`. If a test clicked through a hidden frame by accident, it will now time out waiting for visibility. That is worth checking before you bump, more than `Within()` is.

Upgrade with:

```bash
dotnet add package Microsoft.Playwright --version 1.64.1
pwsh bin/Debug/net10.0/playwright.ps1 install
```

Note that the install step removes browser builds from older Playwright versions it considers unused, so another project on an older version may need to run its own install again. If you lean on Playwright for agent-driven UI tests, the selector discipline in [self-healing E2E tests when a coding agent renames selectors](/2026/09/self-healing-e2e-tests-when-a-coding-agent-renames-selectors/) pairs well with scoped locators like these.
