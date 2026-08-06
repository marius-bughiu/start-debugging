---
title: "gRPC vs REST vs SignalR para chamadas entre serviços no .NET 11"
description: "Para chamadas internas entre serviços no .NET 11, escolha gRPC por padrão quando você controla as duas pontas do contrato e a chamada é ponto a ponto. Use REST com JSON quando algo que você não controla precisa chamar o serviço. SignalR não é um transporte RPC entre serviços: recorra a ele apenas quando um produtor precisa distribuir uma mensagem para muitos consumidores de longa duração."
pubDate: 2026-08-06
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "grpc"
  - "signalr"
  - "csharp"
lang: "pt-br"
translationOf: "2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-06
---

Se o serviço A chama o serviço B e nada mais chama B, use gRPC. Você controla as duas pontas, então um cliente gerado e um contrato binário não custam nada e entregam um payload com aproximadamente metade do tamanho do equivalente em JSON, além de propagação real de deadlines. Use REST com JSON no momento em que algo que você não controla precisar chamar o serviço: um navegador, um parceiro, um comando curl em um runbook. SignalR é o elemento fora de lugar aqui, e o erro mais comum nessa comparação é tratá-lo como uma terceira opção de RPC. Ele não é. SignalR é uma camada de gerenciamento de conexões e distribuição, e só justifica seu lugar quando um produtor precisa enviar mensagens para muitos consumidores de longa duração. Tudo abaixo tem como alvo o .NET 11 (Preview 6, SDK `11.0.100-preview.6.26359.118`, GA prevista para novembro de 2026) e C# 14, com `Grpc.AspNetCore` 2.83.0.

## A decisão em uma tabela

| Recurso | gRPC | REST com JSON | SignalR |
| --- | --- | --- | --- |
| Formato da chamada | RPC ponto a ponto | Requisição/resposta ponto a ponto | Um produtor, muitos consumidores |
| Contrato | Obrigatório, `.proto` | Opcional, OpenAPI | Nenhum, nomes de método por string |
| Protocolo | HTTP/2 (obrigatório) | HTTP/1.1, HTTP/2, HTTP/3 | WebSockets, SSE, long polling |
| Payload | Protobuf, binário | JSON, texto | JSON ou MessagePack |
| Cliente | Gerado a partir do `.proto` | Escrito à mão ou gerado por OpenAPI | Escrito à mão, strings para nomes de método |
| Streaming | Cliente, servidor, bidirecional | Servidor (chunked / SSE) | Servidor, cliente, bidirecional |
| Cancelamento do chamador chega ao chamado | Sim, mais um deadline nativo | Apenas como aborto de conexão | Sim a partir do .NET 11, invocações sem streaming |
| Pode ser chamado de um navegador | Não, precisa de gRPC-Web ou transcodificação | Sim | Sim, esse é o objetivo |
| Funciona atrás de um balanceador L4 | Mal | Sim | Precisa de sessões persistentes ou de um backplane |
| Legível por humanos no tráfego | Não | Sim | Sim com JSON, não com MessagePack |
| Vem junto com o ASP.NET Core | Não, pacote NuGet separado | Sim | Sim |

Duas linhas decidem quase todos os casos reais. "Formato da chamada" separa o SignalR dos outros dois, e "contrato" separa gRPC de REST. Se você está pesando linhas mais abaixo na tabela, provavelmente já tomou a decisão e está procurando permissão.

## Por que o SignalR continua aparecendo nessa comparação, e por que normalmente perde

O SignalR aparece nas buscas sobre comunicação entre serviços porque um método de hub se parece exatamente com um RPC:

```csharp
// .NET 11, C# 14 -- looks like RPC, is not built for it
public sealed class PricingHub : Hub
{
    public Task<decimal> GetPrice(string sku) => _pricing.LookupAsync(sku);
}
```

Um chamador pode perfeitamente executar `InvokeAsync<decimal>("GetPrice", sku)` de outro serviço e obter uma resposta. Funciona. O que você construiu, porém, é um canal RPC em cima de uma tecnologia cujo centro de design inteiro é o gerenciamento do ciclo de vida de conexões para clientes que vão e vêm. Você herda os custos desse design sem precisar de nenhum dos seus benefícios.

Os custos concretos: nomes de método são strings resolvidas por reflexão no momento do despacho, então uma renomeação é uma falha em tempo de execução em vez de uma falha de compilação. Não há esquema, então nada gera um cliente e nada valida o formato do payload. Escalar horizontalmente significa que todo servidor do pool precisa alcançar toda conexão, o que exige um backplane Redis ou o Azure SignalR Service, mais sessões persistentes se você não estiver sobre WebSockets. E uma conexão de hub tem estado: seu chamador agora precisa raciocinar sobre uma máquina de estados de reconexão para o que antes era uma requisição sem estado.

O SignalR é a resposta certa quando o tráfego realmente é distribuição para muitos. Um serviço de preços que precisa enviar atualizações de cotação para quarenta processos worker é um problema de SignalR, porque o SignalR tem grupos, broadcast e um backplane, e o gRPC não tem nenhum deles. A própria [comparação entre gRPC e APIs HTTP](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison) da Microsoft diz isso diretamente: o gRPC suporta streaming mas não tem o conceito de transmitir para conexões registradas, então cada chamada gRPC precisa transmitir para o seu cliente individualmente.

A distinção é a distribuição para muitos, não "tempo real". O streaming bidirecional do gRPC é tempo real. Ele só é ponto a ponto.

## O que cada um realmente coloca no tráfego

O argumento de desempenho a favor do gRPC costuma ser enunciado como "Protobuf é menor que JSON" sem nenhum número anexado. Aqui está o número, para uma mensagem com o formato de uma resposta interna típica:

```protobuf
// proto3
message OrderStatus {
  string order_id   = 1;  // "8f14e45f-ceea-467a-9c1d-2b7f2f0c3a11"
  int32  status     = 2;  // 3
  int64  updated_at = 3;  // 1786060800
  double total      = 4;  // 129.95
  string currency   = 5;  // "EUR"
}
```

| Codificação | Bytes da mensagem | Bytes com framing | Proporção vs JSON |
| --- | --- | --- | --- |
| JSON (`System.Text.Json`, opções padrão) | 116 | 116 | 100% |
| MessagePack (protocolo binário de hub do SignalR) | 66 | n/d | 56.9% |
| Protobuf (`Google.Protobuf` 3.35.1) | 60 | 65 | 51.7% |
| Invocação do protocolo JSON de hub do SignalR | n/d | 165 | 142% |

**Metodologia**: cada codificação dos mesmos cinco campos foi serializada e os bytes contados, medido no Windows 11 com o runtime .NET 10.0.5 (SDK 10.0.201), `Google.Protobuf` 3.35.1 e `MessagePack` 3.1.8. Os formatos de tráfego são especificados independentemente da versão do runtime, então as contagens de bytes são idênticas no .NET 11; apenas o runtime que faz a codificação muda. "Bytes com framing" acrescenta o prefixo de comprimento de cinco bytes do gRPC (um byte de flag de compressão mais quatro bytes de comprimento big-endian) e, para o SignalR, o envelope de invocação JSON mais o separador de registro `0x1E`.

Leia essa tabela com atenção antes de usá-la para justificar qualquer coisa. O Protobuf economiza 56 bytes em uma mensagem de 116 bytes. Em um serviço que atende dez mil chamadas por segundo isso dá 560 KB/s de saída, o que importa se você paga por tráfego entre zonas e é ruído se não paga. A linha do SignalR é a interessante: o envelope do protocolo JSON de hub faz uma única invocação ficar *maior* que o equivalente REST simples, porque você paga por `type`, `target` e `arguments` além do payload. Trocar um hub para MessagePack recupera a maior parte disso, ao custo da legibilidade humana que era a razão para considerar um protocolo de texto em primeiro lugar.

O tamanho da serialização também é a mais fraca das vantagens do gRPC. As mais fortes são o cliente gerado e o deadline.

## Quando escolher gRPC

- **Interno, ponto a ponto, e você controla os dois repositórios.** O arquivo `.proto` é o contrato, os dois lados geram a partir dele, e um campo renomeado quebra a compilação nos dois lados no mesmo pull request. Esse é o argumento inteiro, e vale mais que a contagem de bytes.
- **Você precisa de deadlines que cheguem ao chamado.** Um deadline do gRPC viaja com a chamada, então o serviço B sabe por quanto tempo o serviço A ainda está disposto a esperar e pode abandonar a própria consulta ao banco de dados. HTTP não tem equivalente: cancelar uma requisição do `HttpClient` aborta a conexão e o servidor observa `HttpContext.RequestAborted`, mas nada informa ao servidor o orçamento original.
- **Chamadores em várias linguagens.** Um serviço em Go ou Python que consome seu `.proto` ganha um cliente de verdade de graça. Entregar ao mesmo time um documento OpenAPI e desejar boa sorte é uma experiência pior.
- **Rotas quentes e conversadeiras.** Uma vez que um stream bidirecional está aberto, as mensagens trafegam sobre uma requisição HTTP/2 existente em vez de pagar por uma nova a cada chamada. O [guia de desempenho do gRPC](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance) da Microsoft recomenda isso explicitamente como técnica avançada para rotas de alto throughput, com a ressalva de que `RequestStream.WriteAsync` não é seguro para múltiplas threads e você precisa de um `Channel<T>` para ordenar as escritas.

```csharp
// .NET 11, C# 14 -- Grpc.AspNetCore 2.83.0
// Server
builder.Services.AddGrpc();
app.MapGrpcService<OrderService>();

// Client: register through the factory so channels are reused.
builder.Services
    .AddGrpcClient<Orders.OrdersClient>(o => o.Address = new Uri("https://orders"))
    .AddStandardResilienceHandler();

// Call site: the deadline is the point.
var reply = await client.GetStatusAsync(
    new OrderRequest { OrderId = id },
    deadline: DateTime.UtcNow.AddSeconds(2),
    cancellationToken: ct);
```

Use `AddGrpcClient` em vez de `GrpcChannel.ForAddress` no código de aplicação. Criar um canal por chamada força um socket novo, um handshake TCP, uma negociação TLS e um preâmbulo de conexão HTTP/2 toda vez, e a factory reutiliza o canal por você. Se você está sobrepondo retentativas, o mesmo [handler de resiliência que envolve o HttpClient](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) se aplica aqui, porque um canal gRPC é um `SocketsHttpHandler` por baixo.

## Quando escolher REST com JSON

- **Qualquer coisa para a qual você não pode regenerar um cliente chama o serviço.** Navegadores não falam gRPC de jeito nenhum, e tanto gRPC-Web quanto a transcodificação JSON são acréscimos reais à sua topologia de implantação. Se a resposta para "quem chama isso" inclui alguém fora da sua compilação, publique JSON.
- **A chamada é rara.** Um job noturno de reconciliação chamando um endpoint não justifica um arquivo `.proto`, um passo de geração de código no CI e um segundo protocolo no seu service mesh.
- **Você quer depurar com as ferramentas que já tem.** Protobuf no tráfego é opaco sem o esquema. Um 500 às 3 da manhã é mais fácil de diagnosticar quando você pode repetir a requisição com curl.
- **Seu balanceador de carga é L4.** Isso não é preferência, e está coberto abaixo.

```csharp
// .NET 11, C# 14 -- minimal API + typed client
app.MapGet("/orders/{id}", async (string id, IOrderStore store, CancellationToken ct)
    => await store.FindAsync(id, ct) is { } o
        ? Results.Ok(o)
        : Results.NotFound());

// Caller
builder.Services
    .AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders"))
    .AddStandardResilienceHandler();
```

Para algo mais estruturado que isso, [retornar uma união Results tipada](/pt-br/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) dá verificação em tempo de compilação dos formatos de resposta e um documento OpenAPI correto sem atributos escritos à mão, o que recupera parte da disciplina de contrato que tornava o gRPC atraente.

## Quando o SignalR é genuinamente a escolha certa

- **Um produtor, muitos consumidores de longa duração, e todo consumidor precisa da mesma mensagem.** Cotações de preço, estado de fila de jobs, invalidação de configuração. Grupos e broadcast são os recursos que você está comprando.
- **O conjunto de consumidores muda em tempo de execução.** O SignalR cuida de conexão, desconexão e reconexão. Reimplementar isso em cima de streams gRPC é um projeto.
- **Alguns dos consumidores são navegadores.** Se um painel e um conjunto de serviços worker precisam do mesmo feed, um único hub serve os dois, e nenhuma configuração de gRPC serve o navegador sem um proxy.

O .NET 11 torna o SignalR significativamente melhor para conexões de longa duração de duas formas. O endpoint `/refresh` mais `EnableAuthenticationRefresh` faz com que uma conexão de hub não caia mais quando o token bearer expira, o que era a maior fonte individual de reconexões espúrias em implantações autenticadas por token. E os [clientes do SignalR finalmente podem cancelar um método de hub em execução](/pt-br/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/), então cancelar o `CancellationToken` que você passou para `InvokeAsync` de fato chega ao servidor. Os dois recursos são apenas para o cliente .NET no Preview 6; o suporte ao cliente JavaScript e ao Azure SignalR Service ainda está em andamento.

## Os detalhes que decidem por você

**Balanceadores de carga L4 quebram o gRPC.** Um canal gRPC é uma conexão HTTP/2, e toda chamada é multiplexada sobre ela. Um balanceador L4 distribui conexões TCP, então toda chamada daquele canal cai no mesmo backend para sempre. Sua frota fica com uma instância quente e muitas ociosas. Corrigir isso significa balanceamento de carga do lado do cliente ou um proxy L7 como Envoy, Linkerd ou YARP, e essa decisão normalmente pertence a um time de plataforma, não a você. Se você não pode fazer essa mudança, a comparação acabou e o REST vence. A mesma classe de atrito de infraestrutura aparece ao [rodar gRPC em contêineres](/pt-br/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/), onde um proxy que só fala HTTP/1.1 produz falhas que não se parecem em nada com uma incompatibilidade de protocolo.

**O gRPC é publicado fora do ciclo do .NET, e a lista de TFM prova isso.** `Grpc.AspNetCore` 2.83.0, publicado em 2026-08-03, tem como alvo `net8.0`, `net9.0` e `net10.0`. Não existe target framework `net11.0`, e não existe nenhuma seção sobre gRPC nas notas de versão [Novidades do ASP.NET Core no .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11). Isso não é uma lacuna de suporte: um assembly `net10.0` carrega e roda no .NET 11. É uma diferença de cadência. O gRPC no .NET é mantido em `grpc/grpc-dotnet` com o próprio cronograma de publicação, então um recurso do .NET 11 que beneficiaria o gRPC chega quando o grpc-dotnet publicá-lo, não em novembro. Planeje suas notas de atualização de acordo.

**HTTP/2 é obrigatório para o gRPC e opcional para todo o resto.** Isso é uma restrição real em qualquer salto onde você não controla os intermediários. Também significa que o gRPC não se beneficia de HTTP/3 hoje, enquanto um endpoint REST se beneficia: [configurar o Kestrel para servir HTTP/3](/pt-br/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/) é uma mudança de uma linha no endpoint, e o Kestrel do .NET 11 agora começa a processar requisições HTTP/3 sem esperar pelo stream de controle e pelo frame SETTINGS, cortando a latência da primeira requisição em conexões novas.

**A escalabilidade horizontal do SignalR é uma dependência, não uma configuração.** Mais de uma instância de servidor significa um backplane Redis ou o Azure SignalR Service, e transportes que não sejam WebSocket precisam ainda de sessões persistentes. Compare isso com um endpoint REST sem estado atrás de um balanceador round-robin antes de decidir que a distribuição para muitos vale a pena.

**A observabilidade não é igual.** Os três emitem traces de `ActivitySource` que fluem através do OpenTelemetry, então [conectar os traces a um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) cobre todos eles. O que difere é o que você consegue ver em uma captura de rede: JSON é legível, Protobuf e MessagePack precisam do esquema e de ferramentas.

## A recomendação, repetida

Trace a fronteira primeiro pela distribuição para muitos. Se um serviço precisa notificar muitos consumidores de longa duração, isso é SignalR, e nenhum dos outros dois tem substituto para grupos e um backplane. Todo o resto é ponto a ponto, e aí a pergunta é quem é dono do contrato. Se você controla as duas pontas e pode regenerar clientes no mesmo pull request que muda o esquema, o gRPC se paga através do cliente gerado e dos deadlines propagados, com o payload menor como bônus e não como razão. Se alguém fora da sua compilação chama o serviço, publique REST com JSON e pare de otimizar bytes que você não está pagando.

O modo de falha que vale a pena evitar é escolher gRPC para um serviço com três chamadas por minuto porque um benchmark mostrou 51.7% de tamanho de payload, e depois descobrir que seu balanceador L4 fixa toda chamada em um único pod. Cinquenta e seis bytes por mensagem não valem uma migração de plataforma.

## Relacionados

- [gRPC em contêineres parece difícil no .NET 9 e no .NET 10: 4 armadilhas que você pode corrigir](/pt-br/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- [Clientes do SignalR finalmente podem cancelar um método de hub em execução no .NET 11 Preview 6](/pt-br/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/)
- [Como configurar o Kestrel para servir HTTP/3 no ASP.NET Core 11](/pt-br/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/)
- [Polly vs handlers de resiliência no .NET 11: qual você deve usar?](/pt-br/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)
- [Minimal APIs vs controllers no ASP.NET Core 11](/pt-br/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Como usar OpenTelemetry com .NET 11 e um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)

## Fontes

- [Compare gRPC services with HTTP APIs](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison), Microsoft Learn
- [Performance best practices with gRPC](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance), Microsoft Learn
- [Overview of ASP.NET Core SignalR](https://learn.microsoft.com/en-us/aspnet/core/signalr/introduction), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11), Microsoft Learn
- [Grpc.AspNetCore 2.83.0](https://www.nuget.org/packages/Grpc.AspNetCore), NuGet
- [SignalR Hub Protocol specification](https://github.com/dotnet/aspnetcore/blob/main/src/SignalR/docs/specs/HubProtocol.md), dotnet/aspnetcore
- [gRPC over HTTP/2 protocol specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md), grpc/grpc
