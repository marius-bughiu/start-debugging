---
title: "Quartz.NET 4.2 Transforma Expressões Cron Inválidas em Erros de Compilação"
description: "O Quartz.NET 4.2.0 traz um analisador Roslyn que rejeita literais cron não interpretáveis como QZ0001 em tempo de compilação, além de um gerador de código-fonte que transforma os atributos [QuartzJob] e [CronTrigger] em um registro AddDeclaredJobs(). Veja o que ele verifica, como é o código gerado e como desativá-lo."
pubDate: 2026-09-28
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "source-generators"
  - "roslyn-analyzers"
lang: "pt-br"
translationOf: "2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors"
translatedBy: "claude"
translationDate: 2026-09-28
---

A maioria dos usuários do Quartz.NET já enviou para produção uma expressão cron que parecia correta na revisão e lançou uma `FormatException` na inicialização. O [Quartz.NET 4.2.0](https://github.com/quartznet/quartznet/releases/tag/v4.2.0), lançado em 25 de setembro de 2026 e seguido pelo patch 4.2.1 em 27 de setembro, move essa falha para o compilador. O pacote `Quartz` agora traz seu próprio analisador e gerador de código-fonte, sem nenhum pacote extra para instalar.

## QZ0001: o parser de cron é executado em tempo de compilação

O analisador inspeciona todo literal ou constante cron passado para `WithCronSchedule`, `CronScheduleBuilder.Create`, os construtores de `CronExpression`, `CronCalendar` e `CronTriggerImpl`. Ele não usa uma segunda gramática: ele vincula os próprios fontes do parser do scheduler, e um corpus de paridade com 128 expressões mantém os dois em concordância. Se o compilador aceita um literal, o scheduler também aceita.

```csharp
q.AddTrigger(t => t
    .ForJob(jobKey)
    .WithCronSchedule("0 12 * * 1-5"));
// error QZ0001, reported on the literal with the parser's own message
```

Esse exemplo é o erro clássico: uma expressão crontab de cinco campos copiada do Linux. O Quartz lê seis ou sete campos (segundos primeiro) e exige `?` em um dos dois campos de dia, então a versão do Quartz é `"0 0 12 ? * MON-FRI"`. Se você realmente quer a gramática Unix, passe `CronFormat.Unix` como literal e o analisador valida contra ela.

Três outras regras vêm junto:

- **QZ0002** (erro): um valor de `[JobTimeout("...")]` que não pode ser interpretado ou é negativo.
- **QZ0003** (aviso): `[PersistJobDataAfterExecution]` sem `[DisallowConcurrentExecution]`, situação em que duas execuções concorrentes podem sobrescrever o mapa de dados do job uma da outra.
- **QZ0004** (informativo): um método `Execute` que nunca observa seu `CancellationToken`.

## Declarando o job na própria classe

A segunda metade do recurso é um gerador que lê `[QuartzJob]` e `[CronTrigger]` dos seus tipos `IJob`:

```csharp
[QuartzJob(Name = "cleanup", Group = "maintenance")]
[CronTrigger("0 0 0/6 * * ?")]
[CronTrigger("0 0 12 ? * MON-FRI", Name = "cleanup-weekday-noon", TimeZone = "Europe/Helsinki")]
public sealed class CleanupJob : IJob
{
    public ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
        => default;
}

services.AddQuartz(q => q.AddDeclaredJobs());
services.AddQuartzHostedService();
```

`AddDeclaredJobs()` é gerado no seu assembly como uma extensão `internal` de `IQuartzBuilder`. Ele contém exatamente as chamadas `AddJob<T>` e `AddTrigger<T>` que você mesmo teria escrito manualmente, então não há varredura de assembly e nada que precise ser mantido como raiz (root) para o trimming ou o Native AOT. As strings cron nos atributos passam pelo QZ0001 como qualquer outro literal. Defina `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` se quiser ler o `QuartzDeclaredJobs.g.cs` gerado.

O gerador tem suas próprias barreiras de proteção: `QZ1001` rejeita o atributo em um tipo que não é um `IJob` concreto, `QZ1002` rejeita duas declarações com a mesma identidade, e `QZ1003` rejeita um `[CronTrigger]` sem `[QuartzJob]`. Um job sem trigger é forçado a `Durable = true` para que o store não o exclua imediatamente.

## Notas de atualização

O analisador vem habilitado por padrão, o que significa que um projeto existente com um literal quebrado para de compilar. Essa é a intenção, mas fique atento também ao QZ0003 sob `TreatWarningsAsErrors`. Para desativar tudo, defina isto no arquivo do projeto:

```xml
<PropertyGroup>
  <DisableQuartzAnalyzers>true</DisableQuartzAnalyzers>
</PropertyGroup>
```

As notas de lançamento apontam que `ExcludeAssets="analyzers"` na referência do pacote não o desativa no SDK do .NET 10. As severidades individuais ainda podem ser ajustadas no `.editorconfig`.

Se você usa um store de jobs persistente, a versão 4.2 também exige a migração `database/migrations/4.2/add_continuations_<dialect>.sql` antes que o primeiro nó 4.2 seja iniciado, por causa do novo recurso de continuações de trigger. E se você habilitar o novo histórico de execução baseado em banco de dados em um schema criado a partir de `tables_sqlServerMOT.sql` ou `tables_sqlServer_Below2016.sql`, vá direto para a [4.2.1](https://github.com/quartznet/quartznet/releases/tag/v4.2.1), que corrige a coluna `RETRY_ATTEMPT` que estava faltando.

Se você ainda está decidindo se o Quartz é o scheduler certo, eu o comparei com as alternativas em [Hangfire vs Quartz.NET vs IHostedService](/2026/06/hangfire-vs-quartz-net-vs-ihostedservice-for-scheduled-llm-jobs/).
