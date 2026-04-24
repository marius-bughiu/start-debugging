---
title: "GitHub Copilot Modernization: o relatório de assessment é o produto real"
description: "GitHub Copilot Modernization é vendido como um loop Assess, Plan, Execute pra migrar apps .NET legacy. A fase de assessment é onde o valor mora: um relatório de inventário, blockers categorizados, e orientação de remediação no nível de arquivo que você pode diffar como código."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/04/github-copilot-modernization-assessment-dotnet"
translatedBy: "claude"
translationDate: 2026-04-24
---

O post da Microsoft de 7 de abril ["Your Migration's Source of Truth: The Modernization Assessment"](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) descreve [GitHub Copilot Modernization](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) como um loop "Assess, Plan, Execute" pra puxar cargas legacy .NET Framework e Java pra frente. Se você só lembrar de uma coisa do post, que seja essa: o assessment não é um dashboard reluzente, é um relatório escrito pra `.github/modernize/assessment/` que você commita ao lado do seu código.

## Por que colocar o relatório no repo

Migrações morrem quando o plano vive num doc do Word que ninguém atualiza. Escrevendo o assessment no repo, toda mudança vira revisável via pull request, e a história do branch mostra como a "lista de blockers" encolheu no tempo. Também significa que o assessment pode ser regenerado no CI e diffado, então você nota quando alguém reintroduz uma API depreciada.

O relatório em si quebra os achados em três baldes:

1. Mandatory: blockers que precisam ser resolvidos antes da migração compilar ou rodar.
2. Potential: mudanças de comportamento que geralmente precisam de update de código, por exemplo APIs removidas entre .NET Framework e .NET 10.
3. Optional: melhorias ergonômicas tipo trocar pra `System.Text.Json` ou `HttpClientFactory`.

Cada achado é amarrado a um arquivo e range de linhas, então um reviewer pode abrir o relatório, clicar no código, e entender a remediação sem rerrodar a ferramenta.

## Rodando um assessment

Dá pra disparar um assessment da extensão do VS Code, mas a superfície interessante é a CLI, porque é a que encaixa em CI:

```bash
# Run a recommended assessment against a single repo
modernize assess --path ./src/LegacyApi --target dotnet10

# Multi-repo batch mode for a portfolio
modernize assess --multi-repo ./repos --target dotnet10 --coverage deep
```

A flag `--target` é onde os presets de cenário moram: `dotnet10` dispara o caminho de upgrade .NET Framework pra .NET 10, enquanto `java-openjdk21` cobre o equivalente Java. A flag `--coverage` troca runtime por profundidade, e deep coverage é a que de fato inspeciona referências transitivas de NuGet.

## Tratando o assessment como código

Porque o relatório é um conjunto de arquivos Markdown e JSON, dá pra lintar. Aqui um script pequeno que falha o CI quando o assessment ganha novos issues Mandatory:

```csharp
using System.Text.Json;

var report = JsonSerializer.Deserialize<AssessmentReport>(
    File.ReadAllText(".github/modernize/assessment/summary.json"));

var mandatory = report.Issues.Count(i => i.Severity == "Mandatory");
Console.WriteLine($"Mandatory issues: {mandatory}");

if (mandatory > report.Baseline.Mandatory)
{
    Console.Error.WriteLine("New Mandatory blockers introduced since baseline.");
    Environment.Exit(1);
}

record AssessmentReport(Baseline Baseline, Issue[] Issues);
record Baseline(int Mandatory);
record Issue(string Severity, string File, int Line, string Rule);
```

Isso converte um assessment one-off numa catraca: uma vez que um blocker é resolvido, não pode voltar silenciosamente.

## Onde encaixa ao lado do ASP.NET Core 2.3

O mesmo lote de posts de 7 de abril incluiu o [aviso de fim de suporte do ASP.NET Core 2.3](https://devblogs.microsoft.com/dotnet/aspnet-core-2-3-end-of-support/), que coloca 13 de abril de 2027 como a data hard. Copilot Modernization é a resposta da Microsoft pra shops que ainda têm pacotes ASP.NET Core 2.3 montados em .NET Framework: rode o assessment, commite, e trabalhe a lista Mandatory antes do relógio zerar.

A ferramenta não é mágica. Não vai reescrever uma extensão `HttpContext` pra você ou decidir se containerizar via App Service ou AKS. O que ela faz é te dar um inventário repo-nativo e diffável do trabalho, que é a primeira conversa honesta que a maioria das codebases .NET de longa vida teve em anos.
