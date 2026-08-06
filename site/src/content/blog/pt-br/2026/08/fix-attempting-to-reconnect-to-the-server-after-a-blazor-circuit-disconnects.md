---
title: "Correção: Attempting to reconnect to the server depois que um circuito do Blazor Server cai"
description: "O modal de reconexão indica que o circuito do SignalR caiu, não que a aplicação quebrou. Descubra se a tentativa terminou em failed ou rejected e corrija a afinidade de sessão, a janela de retenção de 3 minutos, o limite de 32 KB ou persista o estado com [PersistentState]."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
lang: "pt-br"
translationOf: "2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects"
translatedBy: "claude"
translationDate: 2026-08-06
---

O modal não é um erro, é o Blazor avisando que o circuito do SignalR caiu e que o cliente está tentando de novo. O que importa é como a tentativa termina. Se ela termina em `failed` ("Reconnection failed", "Failed to rejoin"), o navegador nunca chegou ao servidor: verifique o caminho do WebSocket através do seu proxy, os tempos de keep-alive e o limite de 32 KB do `MaximumReceiveMessageSize`. Se termina em `rejected` ("Could not reconnect to the server", "Failed to resume the session"), o servidor foi alcançado e recusou: o circuito não existe mais porque a aplicação reiniciou, porque o balanceador mandou você para outra instância sem afinidade de sessão, ou porque o `DisconnectedCircuitRetentionPeriod` de 3 minutos expirou. No .NET 10 e no .NET 11, a resposta duradoura para esse último grupo é parar de se preocupar com a identidade do circuito e marcar o seu estado com `[PersistentState]`.

```text
Attempting to reconnect to the server: 3 of 8
Reconnection failed. Try reloading the page if you're unable to reconnect.
Could not reconnect to the server. Reload the page to restore functionality.
```

Esses são os textos do .NET 8 e anteriores, e são os que a maioria das pessoas cola na busca. No .NET 9 e posteriores os mesmos estados têm outra redação, e é por isso que os resultados parecem falar de outro problema:

```text
Rejoining the server...
Rejoin failed... trying again in 5 seconds.
Failed to rejoin. Please retry or reload the page.
The session has been paused by the server.
Failed to resume the session. Please retry or reload the page.
```

Tudo abaixo foi verificado no .NET 11 Preview 6 (SDK `11.0.100-preview.6.26359.118`) com o template Blazor Web App em renderização Interactive Server, e aponta onde o .NET 8, 9 e 10 se comportam de forma diferente. O Blazor WebAssembly não tem circuito, então se você está vendo esse modal seus componentes estão renderizando com `InteractiveServer` ou com `InteractiveAuto` resolvido no momento para o servidor.

## Por que um WebSocket derrubado gera um modal em vez de uma exceção

Uma aplicação Blazor no servidor mantém a árvore de componentes, cada campo de cada instância de componente e cada serviço de DI com escopo de circuito na memória do servidor. Esse conjunto é o circuito. O navegador guarda apenas um DOM renderizado e uma conexão SignalR; cada clique é uma chamada remota ao servidor e cada renderização é um diff enviado de volta. Quebre a conexão e o navegador não tem com o que renderizar, então o framework cobre a página e tenta se reconectar ao mesmo circuito pelo ID.

Ninguém precisa escrever essa interface. Se a sua aplicação define um elemento com `id="components-reconnect-modal"`, o Blazor aplica e remove classes CSS nele. Se não define, o Blazor injeta o próprio modal embutido, e é daí que vem o texto clássico. Essa é a parte importante para depurar: a mensagem que você vê é gerada inteiramente no cliente, a partir de estado do cliente. Ela não diz nada sobre o que o servidor acha que aconteceu. A versão do servidor está nos seus logs.

## Os três estados finais, e qual deles você realmente tem

Desde o .NET 10 o framework dispara um evento `components-reconnect-state-changed` no elemento do modal e aplica a classe CSS correspondente, então dá para ler o resultado em vez de adivinhar:

| Classe CSS | `detail.state` do evento | Significado |
| --- | --- | --- |
| `components-reconnect-show` | `show` | Conexão perdida, tentando de novo. |
| `components-reconnect-retrying` | `retrying` | Há uma tentativa de reconexão em andamento. |
| `components-reconnect-paused` | `paused` | O circuito foi pausado (pelo cliente ou pelo servidor). |
| `components-reconnect-hide` | `hide` | Reconectado. Nada foi perdido. |
| `components-reconnect-failed` | `failed` | O servidor nunca foi alcançado. Chame `Blazor.reconnect()`. |
| `components-reconnect-rejected` | `rejected` | O servidor foi alcançado e recusou. Chame `location.reload()`. |

No .NET 9 e anteriores você só tem as classes CSS, sem evento. De todo modo, `failed` e `rejected` são a bifurcação do diagnóstico, e quase não compartilham causas. Registre qual deles você recebeu antes de mudar qualquer configuração:

```javascript
// .NET 10 or .NET 11, wwwroot or a collocated ReconnectModal.razor.js
const modal = document.getElementById("components-reconnect-modal");
modal.addEventListener("components-reconnect-state-changed", e => {
  console.log("[circuit]", e.detail.state, new Date().toISOString());
});
```

## A reprodução mínima

Você não precisa de uma aplicação quebrada para ver isso. Qualquer componente Interactive Server mais um processo encerrado já basta:

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode();
app.Run();
```

Execute, abra a página do contador, clique algumas vezes e pare o processo com Ctrl+C. O modal aparece em cerca de meio segundo. Inicie o processo de novo e observe: a conexão é estabelecida, mas o ID do circuito é desconhecido para o novo processo, então você recebe `rejected` e não `hide`, e o contador volta a zero. Compare com desligar a rede (DevTools, Network, Offline): as tentativas não alcançam nada, você recebe `failed` e, ao restaurar a rede, uma tentativa cai no circuito original com o contador intacto, desde que você esteja dentro da janela de retenção.

Essa diferença é o diagnóstico inteiro em miniatura. `failed` é um problema de transporte. `rejected` é um problema de tempo de vida.

## Correção 1: afinidade de sessão, se você roda mais de uma instância

Essa é a principal causa em produção e produz `rejected` em praticamente toda reconexão. O circuito vive na memória de um processo. Uma reconexão que cai em qualquer outra instância não encontra o ID do circuito e recusa. Dois servidores atrás de um balanceador round-robin significa que cerca de metade das reconexões falha em definitivo, e parece intermitente, que é justamente por que isso sobrevive aos testes.

Ative a afinidade de sessão (sticky sessions) no balanceador: afinidade ARR no Azure App Service, `sessionAffinity` no seu ingress, `ip_hash` ou um cookie sticky no nginx. O sintoma associado para procurar nos logs é `Invocation canceled due to the underlying connection being closed`. Se você não pode usar afinidade, também não pode manter circuitos em memória entre instâncias, e o que você quer é a persistência distribuída da Correção 5.

## Correção 2: alinhe o cronograma de tentativas com a janela de retenção

O servidor mantém um circuito desconectado por `DisconnectedCircuitRetentionPeriod`, 3 minutos por padrão, e guarda no máximo `DisconnectedCircuitMaxRetained` deles, 100 por padrão. Depois disso o circuito é descartado e qualquer reconexão posterior é `rejected` por definição.

O cronograma do lado do cliente mudou no .NET 9 e agora costuma sobreviver a essa janela:

- **.NET 8 e anteriores**: `maxRetries: 8`, `retryIntervalMilliseconds: 20000`. Intervalo fixo de 20 segundos, então o cliente desiste depois de cerca de 160 segundos, logo dentro dos 3 minutos do servidor.
- **.NET 9, .NET 10, .NET 11**: `maxRetries: 30` com um backoff calculado. As 10 primeiras tentativas disparam tão rápido quanto o handshake permite, as tentativas 11 a 20 ficam a 5 segundos de distância, e tudo depois disso vai a cada 30 segundos. Isso dá cerca de 350 segundos tentando contra um circuito que o servidor apagou aos 180.

Então, no .NET 9 e posteriores, quem sai por 4 minutos recebe um modal que continua a contagem e depois rejeita. É o comportamento projetado, mas é uma experiência ruim, e vale a pena fazer os dois números concordarem. Ou você estende o servidor:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents(options =>
    {
        options.DisconnectedCircuitRetentionPeriod = TimeSpan.FromMinutes(6);
        options.DisconnectedCircuitMaxRetained = 100;
        options.JSInteropDefaultCallTimeout = TimeSpan.FromSeconds(30);
    });
```

ou encurta o cliente para que ele falhe rápido e recarregue em vez de fingir:

```html
<!-- .NET 10 or .NET 11, App.razor. Requires autostart="false" on the Blazor script. -->
<script src="_framework/blazor.web.js" autostart="false"></script>
<script>
  Blazor.start({
    circuit: {
      reconnectionOptions: {
        maxRetries: 8,
        retryIntervalMilliseconds:
          Array.prototype.at.bind([0, 0, 1000, 2000, 5000, 10000, 15000, 30000])
      }
    }
  });
</script>
```

Retornar `null` ou `undefined` de `retryIntervalMilliseconds` interrompe as tentativas, que é o que `Array.prototype.at` faz assim que você passa do fim do array. Considere o custo de memória antes de aumentar o número do servidor: cada circuito retido é uma árvore de componentes viva mais os seus serviços com escopo, e 100 deles é um número real em uma aplicação com carga.

## Correção 3: o limite de 32 KB, quando o modal entra em loop

Se o modal aparece repetidamente durante o uso normal, principalmente logo depois do upload de um arquivo, de um formulário grande ou de um payload grande de interoperabilidade com JS, você quase certamente está batendo em `HubOptions.MaximumReceiveMessageSize`, cujo padrão é 32 KB. Ultrapassar isso fecha o circuito com erro, o cliente reconecta, o usuário repete a ação e ele fecha de novo.

O console do navegador mostra um fechamento genérico:

```text
Error: Connection disconnected with error 'Error: Server returned an error on close: Connection closed with an error.'
```

A mensagem real só aparece com o log de `Microsoft.AspNetCore.SignalR` em Debug ou Trace:

```text
System.IO.InvalidDataException: The maximum message size of 32768B was exceeded.
```

Aumentar o teto funciona e custa margem contra negação de serviço:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.MaximumReceiveMessageSize = 64 * 1024;
    });
```

A correção melhor para qualquer coisa realmente grande é a interoperabilidade com JS por streaming, que fatia abaixo do limite em vez de elevá-lo. Deixe `MaximumParallelInvocationsPerClient` no padrão `1`: o Blazor depende disso, e aumentar quebra os uploads com `InputFile`.

Existe uma segunda variação do mesmo problema que acontece na primeira carga, e não na interação. Se o estado pré-renderizado enviado por `PersistentComponentState` ultrapassa o limite, o circuito nunca inicia e o log diz `Circuit host not initialized`. Persista menos, ou aumente o teto.

## Correção 4: tempos limite e proxies que matam WebSockets ociosos

Um `failed` que só acontece depois de um período ocioso, no celular ou atrás de um proxy reverso é um tempo limite de transporte. Três números precisam concordar:

```csharp
// .NET 11 preview 6. Program.cs. These are the framework defaults, stated explicitly.
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        options.HandshakeTimeout = TimeSpan.FromSeconds(15);
    });
```

A regra é que o tempo limite do servidor deve ser pelo menos o dobro do intervalo de keep-alive. Se você aumenta um, aumente o outro. Depois garanta que a sua infraestrutura tolere uma conexão ociosa entre keep-alives: `proxy_read_timeout` no nginx, o tempo limite de WebSocket ocioso no Application Gateway, e `webSocket enabled="true"` mais um `pingInterval` razoável no IIS. Um proxy que fecha aos 20 segundos vai produzir um modal de reconexão a cada 20 segundos para sempre, e nenhuma configuração do Blazor vai resolver isso.

Navegadores móveis e abas em segundo plano são a outra metade da história. Uma aba estrangulada para de executar temporizadores, o keep-alive para e o servidor descarta o circuito. O .NET 9 e posteriores reconectam imediatamente quando a aba volta a ficar visível, em vez de esperar a próxima tentativa agendada, e o `ReconnectModal.razor.js` do template do .NET 10 também tenta de novo em `visibilitychange` depois de uma falha, então atualizar é uma correção de verdade para o relato de "voltei para a minha aba e tudo tinha sumido".

## Correção 5: no .NET 10 e 11, persista o estado e pare de brigar com o circuito

Tudo acima tenta manter um circuito vivo. O .NET 10 adicionou a opção de desistir disso e manter o estado no lugar. Marque propriedades de componentes ou de serviços com escopo usando `[PersistentState]`, e o Blazor as serializa quando o circuito é removido, depois as reidrata no novo circuito quando a mesma aba reconecta:

```razor
@* .NET 10 or .NET 11, Counter.razor *@
@page "/counter"
@rendermode InteractiveServer

<p role="status">Current count: @CurrentCount</p>
<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int CurrentCount { get; set; }

    private void IncrementCount() => CurrentCount++;
}
```

Isso vem ligado por padrão quando `AddInteractiveServerComponents` é chamado. O provedor em memória guarda até 1.000 circuitos persistidos por duas horas, ambos configuráveis:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.Configure<CircuitOptions>(options =>
{
    options.PersistedCircuitInMemoryMaxRetained = 2_000;
    options.PersistedCircuitInMemoryRetentionPeriod = TimeSpan.FromHours(3);
});
```

Para várias instâncias, atribua um `HybridCache` e o estado persistido passa a ser distribuído, com o seu próprio `PersistedCircuitDistributedRetentionPeriod` de oito horas por padrão. Essa é a saída de emergência quando a afinidade de sessão não está disponível:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddHybridCache()
    .AddRedis("{CONNECTION STRING}");

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();
```

Restrições que vale conhecer antes de depender disso: só funciona com renderização Interactive Server, o estado precisa ser serializável em JSON (entidades do EF Core com ciclos não vão sobreviver), um recarregamento completo da página descarta tudo, e não há garantia de recuperação, então a aplicação volta à experiência normal de desconexão se a persistência falhar. Use `@key` ao renderizar componentes persistidos em um laço.

A mesma maquinaria alimenta a pausa. `Blazor.pauseCircuit()` e `Blazor.resumeCircuit()` permitem soltar o circuito de uma aba oculta e reconstruí-lo no retorno, e o .NET 11 acrescenta o lado servidor com `Circuit.RequestCircuitPauseAsync(CancellationToken)`, de modo que uma implantação pode pedir aos clientes conectados que pausem e persistam antes de o processo parar, em vez de entregar a cada usuário uma reconexão recusada. Os clientes podem adiar com o callback `onPauseRequested` no `Blazor.start`.

## Armadilhas que levam à correção errada

- **O modal de reconexão não é o `blazor-error-ui`.** A barra amarela com "An unhandled error has occurred" é uma exceção de componente, que também derruba o circuito. Se você vê as duas, corrija a exceção primeiro: toda exceção não tratada em um componente encerra o circuito, e a reconexão seguinte é sempre `rejected`.
- **Só o primeiro elemento correspondente recebe as classes.** Se um layout e uma página renderizam cada um um elemento com `id="components-reconnect-modal"`, o Blazor alterna apenas o primeiro que encontra, e o segundo parece quebrado.
- **O atraso de 500 ms é proposital.** O Blazor espera cerca de meio segundo antes de mostrar o modal para que uma oscilação passageira não faça a interface piscar. Aumente com CSS, `transition: visibility 0s linear 1000ms`, e não com JavaScript.
- **`Reconnection failed` e `Could not reconnect` são estados diferentes.** O primeiro deve chamar `Blazor.reconnect()`, o segundo precisa chamar `location.reload()`. Ligar os dois ao mesmo handler produz um laço infinito de tentativas ou um recarregamento que joga fora estado recuperável.
- **`_blazor` retornando 404 ou 400 não é este problema.** Isso é o endpoint do hub não mapeado ou um proxy removendo os cabeçalhos de upgrade, e nenhuma reconexão jamais vai funcionar.
- **O caso da aba esquecida agora tem solução por atualização.** Reconectar uma aba de duas horas nunca foi possível só com circuitos em memória. No .NET 10 e posteriores é, com `[PersistentState]`.

## Relacionados

- [Blazor Server vs Blazor WebAssembly vs Blazor United no .NET 11](/pt-br/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) cobre o compromisso de modelo de hospedagem que coloca você em cima de circuitos.
- [Como persistir estado através da fronteira de renderização estática para interativa do Blazor no .NET 11](/pt-br/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) é o tratamento completo de `[PersistentState]` e `PersistentComponentState`.
- [Como usar HybridCache no ASP.NET Core 11 com Redis como cache L2](/pt-br/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) monta o cache distribuído que sustenta a persistência de circuitos entre instâncias.
- [Correção: JavaScript interop calls cannot be issued at this time (pré-renderização do Blazor)](/pt-br/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) é o outro erro do Blazor que nasce de interpretar mal em qual passada de renderização você está.
- [Migrar uma aplicação Blazor Server para Blazor United (Blazor Web App) no .NET 11](/pt-br/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) é o caminho para o template que traz o componente `ReconnectModal` personalizável.

## Fontes

- Microsoft Learn, [ASP.NET Core Blazor SignalR guidance](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/signalr?view=aspnetcore-11.0) (classes CSS de reconexão, a tabela do evento `components-reconnect-state-changed`, `MaximumReceiveMessageSize`, tempos limite do hub, afinidade de sessão).
- Microsoft Learn, [ASP.NET Core Blazor server-side state management](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/server?view=aspnetcore-11.0) (padrões da persistência de estado de circuito, `PersistedCircuitInMemoryRetentionPeriod`, pausa e retomada, `Circuit.RequestCircuitPauseAsync`).
- Microsoft Learn, [CircuitOptions.DisconnectedCircuitRetentionPeriod](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.server.circuitoptions.disconnectedcircuitretentionperiod) (o padrão de 3 minutos).
- dotnet/aspnetcore, [`CircuitStartOptions.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/CircuitStartOptions.ts) (o `maxRetries` de 30 e as faixas de 0 ms / 5 s / 30 s em `computeDefaultRetryInterval`; o branch do .NET 8 tem `maxRetries: 8` e `retryIntervalMilliseconds: 20000`).
- dotnet/aspnetcore, [`DefaultReconnectDisplay.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/DefaultReconnectDisplay.ts) (os textos exatos do modal em cada estado, tanto no branch do .NET 8 quanto no atual).
- dotnet/aspnetcore, [`ReconnectModal.razor.js` no template Blazor Web App](https://github.com/dotnet/aspnetcore/blob/main/src/ProjectTemplates/Web.ProjectTemplates/content/BlazorWeb-CSharp/BlazorWebCSharp.1/Components/Layout/ReconnectModal.razor.js) (a sequência `Blazor.reconnect()`, depois `Blazor.resumeCircuit()`, depois `location.reload()`, e a nova tentativa em `visibilitychange`).
