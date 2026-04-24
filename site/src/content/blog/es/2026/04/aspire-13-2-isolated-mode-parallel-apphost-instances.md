---
title: "Aspire 13.2 --isolated: corre instancias paralelas de AppHost sin colisiones de puertos"
description: "Aspire 13.2 incluye un flag --isolated que le da a cada aspire run sus propios puertos random y su store de secrets. Desbloquea trabajo multi-checkout, worktrees de agentes, y tests de integración que necesitan un AppHost vivo."
pubDate: 2026-04-18
tags:
  - "aspire"
  - "dotnet-11"
  - "dotnet"
  - "tooling"
lang: "es"
translationOf: "2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances"
translatedBy: "claude"
translationDate: 2026-04-24
---

Correr dos copias de la misma app Aspire a la vez siempre significó pelearse con `address already in use`. Aspire 13.2, [anunciado esta semana](https://devblogs.microsoft.com/aspire/aspire-13-2-announcement/), agrega un flag pequeño pero útil que quita esa pelea: `--isolated`. Cada invocación obtiene sus propios puertos random, su propio user secrets store, y su propia URL de dashboard, así que dos AppHosts pueden vivir lado a lado sin remapeo manual de puertos.

## De dónde venían las colisiones

Por default `aspire run` se bindea a puertos fijos: el dashboard en 18888, OTLP en 4317/4318, y bindings predecibles para cada recurso. Eso está bien para un solo developer en un solo branch. Apenas agregas un segundo worktree, un coding agent levantando otra instancia, o un test de integración que quiere un AppHost vivo, todo colisiona. Los equipos han estado parchando esto con tweaks de `launchSettings.json` o port maps custom, y nada de eso compone.

## Qué cambia `--isolated` realmente

`--isolated` sobre `aspire run` o `aspire start` hace dos cosas por invocación. Primero, cada puerto que normalmente se bindearía a un número fijo (dashboard, OTLP, endpoints de recursos) se bindea a un puerto libre random en su lugar. Service discovery recoge los valores dinámicos, así que la app misma no necesita saber qué eligieron sus hermanos. Segundo, el store backend de user secrets se keya por un instance ID único a la corrida, así que las connection strings y API keys no se filtran entre AppHosts paralelos.

Un workflow típico de dos-branches ahora se ve así:

```bash
# Terminal 1 - feature branch worktree
cd ~/src/my-app-feature
aspire run --isolated

# Terminal 2 - bug fix worktree
cd ~/src/my-app-bugfix
aspire run --isolated
```

Ambos procesos levantan, ambos dashboards son alcanzables en URLs distintas, y ninguno sabe ni le importa el otro. Bajar uno no perturba las reservaciones de puerto del otro.

## Por qué importa más allá de "múltiples terminales"

El consumidor más interesante es el tooling. [Modo detached](https://devblogs.microsoft.com/aspire/aspire-detached-mode-and-process-management/) deja que un coding agent arranque un AppHost con `--detach` y recupere el terminal. Combinado con `--isolated`, el mismo agente puede levantar N AppHosts a través de N git worktrees en paralelo, correr probes HTTP o tests de integración contra cada uno, y tumbarlos, todo sin contabilidad manual de puertos. Ese es el patrón que los background agents de VS Code ya usan cuando crean worktrees para trabajo exploratorio.

Los suites de tests de integración obtienen el mismo beneficio. Anteriormente, correr el AppHost desde `dotnet test` en CI mientras un developer tenía la app abierta localmente necesitaba overrides de environment. Con `--isolated`, el test fixture puede hacer:

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

Sin port map estático, sin limpieza entre runs de tests, sin sorpresas de "¿dejé la app corriendo?".

## Emparejando con --detach y aspire wait

El loop agent-friendly completo en 13.2 se ve como `aspire run --isolated --detach` para arrancar en background, `aspire wait api --status healthy --timeout 120` para bloquear hasta que el recurso esté arriba, y `aspire resource api restart` para ciclar piezas sin bajar el grafo completo. `--isolated` es la pieza que hace esos loops composables a través de N copias.

Para la lista completa de adiciones CLI de 13.2, ver la [documentación de modo isolated](https://devblogs.microsoft.com/aspire/aspire-isolated-mode-parallel-development/).
