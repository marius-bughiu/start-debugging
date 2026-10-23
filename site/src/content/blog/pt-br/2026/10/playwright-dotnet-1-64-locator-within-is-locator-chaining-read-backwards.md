---
title: "Playwright .NET 1.64 adiciona Locator.Within(), e é o encadeamento de Locator lido de trás para frente"
description: "Microsoft.Playwright 1.64 adiciona Locator.Within() para você escrever 'este botão, dentro daquele diálogo'. Um teste rápido mostra que ele monta exatamente o mesmo locator que parent.Locator(child), incluindo a resolução de Nth() por pai."
pubDate: 2026-10-23
tags:
  - "dotnet"
  - "playwright"
  - "testing"
  - "csharp"
lang: "pt-br"
translationOf: "2026/10/playwright-dotnet-1-64-locator-within-is-locator-chaining-read-backwards"
translatedBy: "claude"
translationDate: 2026-10-23
---

[Microsoft.Playwright 1.64.0](https://github.com/microsoft/playwright-dotnet/releases/tag/v1.64.0) chegou ao NuGet em 2026-10-21, seguido pela 1.64.1 um dia depois com uma atualização do Node.js 24.22.1 embutido. A versão traz Chromium 156, Firefox 157 e WebKit 27.2, testes de WebMCP e screencasts em VP9, mas a API que a maioria das suítes de teste vai usar primeiro é [`Locator.Within()`](https://playwright.dev/dotnet/docs/api/class-locator#locator-within).

## Primeiro o filho, depois o pai

`Within(ILocator)` retorna um locator que encontra os elementos do locator atual dentro de cada elemento correspondente ao argumento. O ponto é a ordem de leitura. Quando você já tem dois locators, agora pode dizer "este botão, dentro daquele diálogo" em vez de montar a cadeia de fora para dentro:

```csharp
var save = page.GetByRole(AriaRole.Button, new() { Name = "Save" });
var dialog = page.GetByTestId("settings-dialog");

// 1.64+
await save.Within(dialog).ClickAsync();

// Before 1.64
await dialog.Locator(save).ClickAsync();
```

Locators relativos como `Nth()` e `First` são resolvidos separadamente dentro de cada pai, e é isso que faz consultas por coluna funcionarem:

```csharp
var thirdColumn = page.GetByRole(AriaRole.Cell).Nth(2)
    .Within(page.GetByRole(AriaRole.Row));

await Expect(thirdColumn).ToHaveTextAsync(new[] { "Apple", "Banana", "Cherry" });
```

## No que ele se transforma

Rodei as duas formas no Chromium 156 com `Microsoft.Playwright` 1.64.1 no .NET SDK 10.0.302, usando uma tabela de três linhas e uma página com dois botões "Save" (um em um diálogo e outro em um formulário). Os resultados:

| Locator | Correspondências |
| --- | --- |
| `cells.Nth(2)` | `Apple` |
| `cells.Nth(2).Within(rows)` | `Apple, Banana, Cherry` |
| `rows.Locator(cells.Nth(2))` | `Apple, Banana, Cherry` |
| `rows.Locator("td").Nth(2)` | `Apple` |
| `save` | `Save, Save` |
| `save.Within(dialog)` | `Save` |

`ToString()` resolve a questão: `cells.Nth(2).Within(rows)` imprime `GetByRole(AriaRole.Row).Locator(GetByRole(AriaRole.Cell).Nth(2))`, caractere por caractere igual à cadeia antiga. `Within()` não é um novo mecanismo de correspondência. É a sobrecarga existente `Locator(ILocator)` com os argumentos invertidos, e mensagens de erro e entradas do trace viewer vão mostrar a forma encadeada.

Isso tem duas consequências práticas:

- **Não há mudança de comportamento para migrar.** Se a sua suíte já usa `parent.Locator(childLocator)`, a semântica de `Nth()` por pai já estava lá. Trocar para `Within()` é apenas uma questão de legibilidade, principalmente em page objects que expõem locators filhos e deixam quem chama escolher o escopo.
- **A armadilha real continua sendo onde fica o `Nth()`.** `rows.Locator("td").Nth(2)` aplica `Nth(2)` ao resultado achatado e devolve uma única célula. Coloque `Nth()` no locator interno (ou use `Within()`, que empurra você nessa direção) quando quiser uma correspondência por pai.

## A breaking change na mesma versão

A 1.64 também muda a visibilidade: elementos dentro de um iframe que por sua vez não está visível, por exemplo com `visibility: hidden`, agora são considerados ocultos por ações, `IsVisibleAsync()` e `ToBeVisibleAsync()`. Se um teste clicava através de um frame oculto por acidente, agora vai estourar o tempo esperando a visibilidade. Isso merece mais atenção antes de atualizar do que `Within()`.

Atualize com:

```bash
dotnet add package Microsoft.Playwright --version 1.64.1
pwsh bin/Debug/net10.0/playwright.ps1 install
```

Observe que a etapa de instalação remove builds de navegadores de versões antigas do Playwright que ela considera sem uso, então outro projeto em uma versão anterior pode precisar rodar a própria instalação de novo. Se você usa Playwright para testes de UI conduzidos por agentes, a disciplina de seletores de [testes E2E que se autocorrigem quando um agente de código renomeia seletores](/2026/09/self-healing-e2e-tests-when-a-coding-agent-renames-selectors/) combina bem com locators com escopo como estes.
