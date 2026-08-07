---
title: "Microsoft.Testing.Platform 2.3: --report-gh coloca as falhas de teste no diff do PR"
description: "O artigo do blog do .NET de 2026-08-06 sobre relatórios no MTP revela um conjunto de extensões que se tornaram estáveis no Microsoft.Testing.Platform 2.3.0: anotações do GitHub Actions, escrita de TRX resistente a travamentos e histórico de flakiness no Azure DevOps."
pubDate: 2026-08-07
tags:
  - "dotnet"
  - "testing"
  - "ci-cd"
  - "github-actions"
  - "msbuild"
lang: "pt-br"
translationOf: "2026/08/microsoft-testing-platform-2-3-github-actions-annotations"
translatedBy: "claude"
translationDate: 2026-08-07
---

Em 2026-08-06 o blog do .NET publicou [Test reporting in Microsoft.Testing.Platform: from red build to root cause](https://devblogs.microsoft.com/dotnet/microsoft-testing-platform-reporting/). A novidade não é o artigo em si, e sim o quanto dessa história de relatórios chegou silenciosamente no Microsoft.Testing.Platform 2.3.0 (2026-07-07, com o patch mais recente 2.3.3 em 2026-07-28) e continua desligado por padrão na maioria dos repositórios.

## Um job vermelho não deveria significar rolar o log inteiro

Sem configuração adicional, uma execução do MTP que falha em um runner do GitHub entrega um código de saída diferente de zero e uma parede de texto no console. O novo pacote `Microsoft.Testing.Extensions.GitHubActionsReport` mais o switch `--report-gh` mudam o que o runner faz com esses dados: grupos de log por assembly, anotações `::error` que aparecem na margem de **Files changed** do pull request quando a localização no código-fonte é resolvida, um resumo do job em Markdown anexado ao `GITHUB_STEP_SUMMARY` e entradas `::notice` para testes lentos.

A extensão fica inerte a menos que a variável de ambiente `GITHUB_ACTIONS` seja `true`, então um `dotnet test` local não é afetado. Cada sub-recurso vem ligado por padrão assim que `--report-gh` é definido e pode ser desligado individualmente:

```yaml
- name: Test
  run: dotnet test -- --report-gh --report-gh-slow-test-threshold 30s --report-trx
```

O limite aceita um número simples de segundos ou um valor com sufixo como `90s`, `2m` ou `1.5h`. O padrão é `60s`.

## Configurar para o repositório inteiro em vez de por invocação

Há duas maneiras de evitar colar flags em cada passo do workflow. Traga todo o conjunto de extensões da Microsoft para cada projeto de teste a partir do `Directory.Build.props`:

```xml
<PropertyGroup>
  <TestingExtensionsProfile>AllMicrosoft</TestingExtensionsProfile>
</PropertyGroup>
```

Depois defina as opções de forma declarativa no `testconfig.json` ao lado do projeto de teste:

```json
{
  "commandLineOptions": {
    "report-trx": true,
    "report-html": true,
    "report-azdo": true,
    "report-azdo-flaky-history": 14
  }
}
```

Com `Microsoft.Testing.Platform.MSBuild` no grafo de dependências (ele vem transitivamente com os runners do MSTest, NUnit e xUnit), os provedores de relatório se registram automaticamente na instalação do pacote. Chamadas manuais a `builder.AddGitHubActionsProvider()` só são necessárias se você definir `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>`.

## TRX que sobrevive a um test host morto

A mudança que eu ligaria primeiro nem é uma flag. A partir do MTP 2.3.0, os resultados TRX são gravados em disco conforme a execução avança, então um test host que trava no meio da suíte ainda deixa um TRX com tudo o que foi coletado antes do travamento. Antes, esse cenário produzia um diretório de resultados vazio e uma falha de CI sem nada para ler, o mesmo beco sem saída que faz as pessoas [recorrerem a um servidor MCP de binlog para triar builds](/pt-br/2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures/).

O nome padrão do TRX também ficou determinístico na 2.3.0: `{asm}_{tfm}_{arch}.trx` em vez de `<UserName>_<MachineName>_<timestamp>.trx`. Só isso já corrige uma classe inteira de globs frágeis de upload de artefatos.

## Separar regressões de testes instáveis no Azure DevOps

Do lado do Azure DevOps, `--report-azdo-flaky-history 14` consulta o histórico de resultados de teste dos últimos N dias (1 a 90) e anota as falhas com contexto de instabilidade. Combine com `--report-azdo-demote-known-flaky` e uma falha que ultrapasse o limiar de instabilidade (25% por padrão) cai de erro para aviso, de modo que uma regressão genuína seja a única coisa vermelha na página.

Relatórios HTML, JUnit XML e CTRF JSON também chegaram na 2.3.0 via `--report-html`, `--report-junit` e `--report-ctrf`. Os três estão marcados como experimentais, então fixe sua versão do MTP antes de ligá-los a um check obrigatório. As tabelas completas de opções estão na [documentação de relatórios do MTP](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-test-reports).
