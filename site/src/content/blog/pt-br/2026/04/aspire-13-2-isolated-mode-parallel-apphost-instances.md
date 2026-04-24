---
title: "Aspire 13.2 --isolated: rode instâncias paralelas do AppHost sem colisões de porta"
description: "Aspire 13.2 traz um flag --isolated que dá a cada aspire run suas próprias portas aleatórias e store de secrets. Desbloqueia trabalho multi-checkout, worktrees de agent, e testes de integração que precisam de um AppHost vivo."
pubDate: 2026-04-18
tags:
  - "aspire"
  - "dotnet-11"
  - "dotnet"
  - "tooling"
lang: "pt-br"
translationOf: "2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances"
translatedBy: "claude"
translationDate: 2026-04-24
---

Rodar duas cópias da mesma app Aspire ao mesmo tempo sempre significou brigar com `address already in use`. Aspire 13.2, [anunciado essa semana](https://devblogs.microsoft.com/aspire/aspire-13-2-announcement/), adiciona um flag pequeno mas útil que tira a briga: `--isolated`. Toda invocação ganha suas próprias portas aleatórias, seu próprio user secrets store, e sua própria URL de dashboard, então dois AppHosts conseguem viver lado a lado sem remapeamento manual de portas.

## De onde vinham as colisões

Por padrão `aspire run` vincula a portas fixas: o dashboard em 18888, OTLP em 4317/4318, e bindings previsíveis pra cada recurso. Isso é fino pra um único dev numa única branch. Assim que você adiciona uma segunda worktree, um coding agent subindo outra instância, ou um teste de integração que quer um AppHost vivo, tudo colide. Times vêm remendando isso com tweaks de `launchSettings.json` ou port maps custom, e nada disso compõe.

## O que `--isolated` realmente muda

`--isolated` no `aspire run` ou `aspire start` faz duas coisas por invocação. Primeiro, toda porta que normalmente vincularia a um número fixo (dashboard, OTLP, endpoints de recurso) passa a vincular a uma porta livre aleatória. Service discovery pega os valores dinâmicos, então a app em si não precisa saber o que seus irmãos escolheram. Segundo, o backing store de user secrets é chaveado por um instance ID único ao run, então connection strings e API keys não vazam entre AppHosts paralelos.

Um workflow típico de duas branches agora se parece assim:

```bash
# Terminal 1 - feature branch worktree
cd ~/src/my-app-feature
aspire run --isolated

# Terminal 2 - bug fix worktree
cd ~/src/my-app-bugfix
aspire run --isolated
```

Os dois processos sobem, os dois dashboards são alcançáveis em URLs diferentes, e nenhum sabe nem se importa com o outro. Derrubar um não perturba as reservas de porta do outro.

## Por que isso importa além de "múltiplos terminais"

O consumidor mais interessante é tooling. [Modo detached](https://devblogs.microsoft.com/aspire/aspire-detached-mode-and-process-management/) deixa um coding agent iniciar um AppHost com `--detach` e recuperar o terminal. Combinado com `--isolated`, o mesmo agent pode subir N AppHosts entre N git worktrees em paralelo, rodar probes HTTP ou testes de integração contra cada um, e derrubá-los, tudo sem contabilidade manual de portas. Esse é o padrão que os background agents do VS Code já usam ao criar worktrees pra trabalho exploratório.

Suites de teste de integração ganham o mesmo benefício. Antes, rodar o AppHost do `dotnet test` no CI enquanto um dev tinha a app aberta localmente precisava de overrides de environment. Com `--isolated`, o test fixture pode apenas fazer:

```csharp
[Fact]
public async Task ApiReturnsHealthy()
{
    var apphost = await DistributedApplicationTestingBuilder
        .CreateAsync<Projects.MyApp_AppHost>(["--isolated"]);

    await using var app = await apphost.BuildAsync();
    await app.StartAsync();

    var client = app.CreateHttpClient("api");
    var response = await client.GetAsync("/health");

    response.StatusCode.Should().Be(HttpStatusCode.OK);
}
```

Sem port map estático, sem limpeza entre runs de teste, sem surpresas de "deixei a app rodando?".

## Pareando com --detach e aspire wait

O loop agent-friendly completo no 13.2 parece com `aspire run --isolated --detach` pra iniciar em background, `aspire wait api --status healthy --timeout 120` pra bloquear até o recurso subir, e `aspire resource api restart` pra ciclar peças sem derrubar o grafo inteiro. `--isolated` é a peça que deixa esses loops componíveis entre N cópias.

Pra lista completa de adições de CLI do 13.2, veja a [documentação de modo isolated](https://devblogs.microsoft.com/aspire/aspire-isolated-mode-parallel-development/).
