---
title: "Como configurar o Kestrel para servir HTTP/3 no ASP.NET Core 11"
description: "Um guia completo para habilitar HTTP/3 no Kestrel no ASP.NET Core 11: a configuração de endpoint com HttpProtocols.Http1AndHttp2AndHttp3, os requisitos de plataforma do MsQuic no Windows, Linux e macOS, por que a primeira requisição nunca é HTTP/3, como verificar com HttpClient e middleware, o ajuste de QuicTransportOptions e as armadilhas de firewall e proxy que fazem tudo cair silenciosamente."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "kestrel"
  - "http-3"
  - "performance"
lang: "pt-br"
translationOf: "2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Para servir HTTP/3 a partir do Kestrel você configura um endpoint HTTPS com `listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3`. Essa é toda a superfície da API. Tudo o que dá errado depois é ambiental: o MsQuic está faltando no host, o UDP está bloqueado na porta, um proxy reverso encerra a conexão antes que o QUIC chegue até você, ou você está testando com um navegador que recusa o certificado de desenvolvimento sobre HTTP/3. O Kestrel não lança exceção em nenhum desses casos. Ele desabilita o HTTP/3, continua servindo HTTP/1.1 e HTTP/2, e sua saída do `curl` fica exatamente igual a antes de você mudar qualquer coisa.

Tudo aqui tem como alvo o .NET 11 (testado contra o Preview 6, SDK `11.0.100-preview.6.26359.118`) com `Microsoft.NET.Sdk.Web` e C# 14. O HTTP/3 no Kestrel tem suporte completo desde o .NET 7, então a configuração abaixo é a mesma no .NET 8, 9 e 10. A única parte genuinamente nova no .NET 11 é o processamento antecipado de requisições coberto no final.

## Os seis passos, do começo ao fim

1. Configure um endpoint HTTPS e defina `Protocols` como `HttpProtocols.Http1AndHttp2AndHttp3`.
2. Garanta que o MsQuic esteja presente no host, o que significa Windows 11 ou Windows Server 2022 ou posterior, ou o pacote `libmsquic` no Linux.
3. Abra a porta UDP com o mesmo número da sua porta TLS em todo firewall e security group no caminho.
4. Adicione uma verificação na inicialização que registre em log de forma bem visível quando `QuicListener.IsSupported` for false, para que uma dependência ausente seja uma linha de log e não um mistério.
5. Verifique com `HttpClient` fixado na versão 3.0, não com um navegador.
6. Registre `HttpContext.Request.Protocol` em um middleware para poder ver o que os clientes realmente negociaram em produção.

O restante deste artigo é sobre fazer cada um desses passos corretamente, e não apenas fazer o código compilar.

## Configurando o endpoint

Não há pacote NuGet a instalar. O transporte QUIC, `Microsoft.AspNetCore.Server.Kestrel.Transport.Quic`, vem no framework compartilhado do ASP.NET Core. Você só precisa mudar como o endpoint é declarado:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel((context, options) =>
{
    options.ListenAnyIP(5001, listenOptions =>
    {
        listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listenOptions.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", (HttpContext ctx) => new { protocol = ctx.Request.Protocol });

app.Run();
```

Dois detalhes nesse trecho fazem trabalho de verdade. `UseHttps()` não é opcional: o HTTP/3 exige TLS 1.3, então um endpoint sem ele nunca consegue negociar h3. E o valor do enum é `Http1AndHttp2AndHttp3`, não `Http3`. O padrão do Kestrel é `Http1AndHttp2`, e o valor de três protocolos é o que você quer em produção porque nem todo roteador, proxy corporativo ou operadora móvel repassa QUIC de forma limpa. `HttpProtocols.Http3` sozinho lhe dá um endpoint sem caminho de fallback: num host onde o MsQuic não está disponível, o Kestrel desabilita o HTTP/3 e não sobra nada para aquele endpoint servir.

A mesma configuração está disponível a partir da configuração da aplicação, que costuma ser o lugar melhor para ela porque permite habilitar HTTP/3 por ambiente sem recompilar:

```json
{
  "Kestrel": {
    "Endpoints": {
      "Https": {
        "Url": "https://*:5001",
        "Protocols": "Http1AndHttp2AndHttp3"
      }
    }
  }
}
```

Existe também `Kestrel:EndpointDefaults:Protocols` se você quiser aplicar a todos os endpoints. Fique atento à regra de precedência que pega as pessoas aqui: uma chamada explícita a `Listen` ou `ListenAnyIP` dentro de `ConfigureKestrel` sobrepõe `ASPNETCORE_URLS`, `--urls` e o `applicationUrl` do `launchSettings.json`. O Kestrel registra um aviso quando isso acontece ("Overriding address(es)"), e se você não notar vai passar uma tarde se perguntando por que sua aplicação não está mais na porta 7043. Escolha um mecanismo, não os dois.

## O que o MsQuic exige em cada plataforma

O ASP.NET Core não implementa QUIC por conta própria. `System.Net.Quic` se conecta ao [MsQuic](https://github.com/microsoft/msquic), e a matriz de plataformas é herdada integralmente dessa biblioteca nativa.

No **Windows**, `msquic.dll` é distribuída como parte do runtime do .NET, então não há nada a instalar, mas o sistema operacional precisa ser Windows 11 ou Windows Server 2022 ou posterior. Versões anteriores do Windows não têm as APIs criptográficas de que o QUIC precisa, e nenhuma configuração contorna isso. Esse é o motivo mais comum para o HTTP/3 não ligar num destino de implantação corporativo que ainda roda Windows Server 2019.

No **Linux**, você precisa instalar `libmsquic` por conta própria. Ele é publicado no repositório de pacotes da Microsoft em `packages.microsoft.com`, e também está no repositório community do Alpine:

```bash
# Debian / Ubuntu, after adding the packages.microsoft.com repo
sudo apt-get install libmsquic

# Alpine 3.21 and later
sudo apk add libmsquic
```

O .NET 7 e posteriores exigem libmsquic 2.2 ou mais recente. A linha 1.9.x à qual o .NET 6 estava preso não é compatível, então se você está carregando um Dockerfile antigo de um projeto .NET 6, confira a versão que está baixando. Isso também significa que uma imagem de contêiner `mcr.microsoft.com/dotnet/aspnet` comum **não** fala HTTP/3 de fábrica; você precisa adicionar o pacote na sua própria camada de imagem. Se você constrói imagens com `dotnet publish /t:PublishContainer`, esse é um `RUN` extra que não dá para expressar apenas com as propriedades de contêiner do SDK, e você vai precisar de um Dockerfile.

No **macOS**, o suporte é parcial e não oficial. Você pode fazer `brew install libmsquic`, mas o runtime não vai encontrá-lo a menos que você aponte o carregador dinâmico para o prefixo do Homebrew:

```bash
DYLD_FALLBACK_LIBRARY_PATH=$DYLD_FALLBACK_LIBRARY_PATH:$(brew --prefix)/lib dotnet run
```

Trate isso como uma conveniência de desenvolvimento local, não como uma configuração de produção suportada.

## Tornando o fallback silencioso barulhento

O comportamento de fallback do Kestrel é o padrão certo para um servidor web e o pior possível para depuração. Se o MsQuic estiver faltando, o HTTP/3 é desabilitado e a aplicação sobe normalmente. Nada na saída de log padrão no nível `Information` avisa você.

A correção é uma verificação de três linhas na inicialização, contra a mesma propriedade `IsSupported` que `System.Net.Quic` expõe:

```csharp
// .NET 11, C# 14
using System.Net.Quic;

var app = builder.Build();

if (!QuicListener.IsSupported)
{
    app.Logger.LogWarning(
        "QUIC is not supported on this host. HTTP/3 is disabled and Kestrel " +
        "will serve HTTP/1.1 and HTTP/2 only. Check for libmsquic and TLS 1.3 support.");
}
```

`QuicListener.IsSupported` retorna false pelos dois motivos que importam: a biblioteca nativa está ausente, ou o TLS 1.3 não está disponível. Use `QuicListener.IsSupported` no lado do servidor e `QuicConnection.IsSupported` no lado do cliente. Hoje eles reportam o mesmo valor, mas a orientação documentada é checar o que corresponde ao seu papel.

Se você quiser mais detalhe, suba a categoria do Kestrel para `Debug` e acompanhe o bind:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Server.Kestrel": "Debug"
    }
  }
}
```

## Por que sua primeira requisição nunca é HTTP/3

Essa é a parte que faz as pessoas acharem que a configuração está quebrada quando ela está funcionando perfeitamente.

Um cliente não tem como saber que um servidor fala HTTP/3 antes de se conectar, porque não existe registro DNS nem extensão TLS anunciando isso. A descoberta acontece pelo cabeçalho de resposta [`alt-svc`](https://developer.mozilla.org/docs/Web/HTTP/Headers/Alt-Svc): o cliente faz a primeira requisição sobre HTTP/1.1 ou HTTP/2, vê um cabeçalho nomeando um endpoint h3, e usa QUIC nas requisições seguintes para aquela origem. O Kestrel adiciona esse cabeçalho automaticamente sempre que o HTTP/3 está habilitado no endpoint, então você recebe algo assim na primeira resposta:

```text
HTTP/2 200
alt-svc: h3=":5001"
```

Ou seja, um teste de requisição única sempre vai reportar HTTP/2. Qualquer medição que você fizer precisa fazer pelo menos duas requisições pela mesma instância de cliente, e o cliente precisa ser um que respeite `alt-svc`.

O IIS é a exceção que vale conhecer. Quando você hospeda atrás do IIS, o HTTP/3 tem suporte no modelo in-process, mas o IIS não adiciona `alt-svc` por você. Você adiciona por conta própria, no começo do pipeline:

```csharp
// .NET 11, C# 14 - only needed when hosting behind IIS
app.Use((context, next) =>
{
    context.Response.Headers.AltSvc = "h3=\":443\"";
    return next(context);
});
```

O IIS também precisa de Windows Server 2022 ou Windows 11, um binding `https` e a chave de registro `EnableHttp3` definida. E note que a hospedagem out-of-process reporta `HTTP/1.1` em `HttpRequest.Protocol` mesmo numa conexão HTTP/3, porque esse é o protocolo que o IIS usa para fazer proxy até o Kestrel. Só o modelo in-process reporta `HTTP/3`.

## Verificando que funciona de verdade

Não use um navegador. Navegadores recusam certificados autoassinados sobre HTTP/3, o que inclui o certificado de desenvolvimento do ASP.NET Core, então um teste local no navegador vai reportar HTTP/2 para sempre e não vai lhe dizer nada.

Use `HttpClient` com a versão fixada. Para um teste você quer `RequestVersionExact`, porque ele falha de forma barulhenta em vez de degradar em silêncio:

```csharp
// .NET 11, C# 14
using System.Net;

using var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version30,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact
};

var response = await client.GetAsync("https://localhost:5001/ping");

Console.WriteLine($"status: {response.StatusCode}, version: {response.Version}");
// status: OK, version: 3.0
```

No código da aplicação você quer a política oposta. Defina a versão como 1.1 com `HttpVersionPolicy.RequestVersionOrHigher` para que o cliente suba para HTTP/3 quando o servidor anunciar e degrade com elegância quando não anunciar. Fixar `RequestVersionExact` em produção transforma um soluço de rede numa falha dura, que é prima próxima [das falhas de handshake TLS que aparecem como "The SSL connection could not be established"](/pt-br/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/).

No servidor, a verdade absoluta é uma linha de middleware:

```csharp
// .NET 11, C# 14
app.Use(async (context, next) =>
{
    app.Logger.LogInformation("Request served over {Protocol}", context.Request.Protocol);
    await next(context);
});
```

`HttpContext.Request.Protocol` é a string `"HTTP/3"` para uma conexão QUIC. Se você quiser ramificar com base nisso, `HttpProtocol.IsHttp3(context.Request.Protocol)` de `Microsoft.AspNetCore.Http` evita fixar o literal no código. Emitir isso como dimensão de métrica por uma semana depois do rollout é a única forma honesta de saber que fração do seu tráfego realmente chegou ao h3, e costuma ser menor do que você espera.

## Ajustando QuicTransportOptions

O transporte tem seu próprio objeto de opções, configurado por `UseQuic` no web host builder em vez de por `ConfigureKestrel`:

```csharp
// .NET 11, C# 14
builder.WebHost.UseQuic(options =>
{
    options.MaxBidirectionalStreamCount = 200;
    options.MaxUnidirectionalStreamCount = 20;
});
```

Os padrões são `MaxBidirectionalStreamCount` 100, `MaxUnidirectionalStreamCount` 10, `MaxReadBufferSize` 1 MB, `MaxWriteBufferSize` 64 KB e `Backlog` 512. A contagem de streams bidirecionais é a que vale revisitar: ela limita as requisições concorrentes por conexão, e como o QUIC não tem head-of-line blocking, um cliente que teria aberto várias conexões HTTP/2 agora pode empurrar tudo por uma só. Se você está na frente de uma single-page app tagarela ou de um cliente gRPC, 100 pode virar o teto.

Se você copiou um exemplo que envolve esse bloco em `#pragma warning disable CA2252`, isso vem da época em que `System.Net.Quic` era publicado como recurso em versão prévia. Essas APIs se tornaram estáveis no .NET 9, então normalmente você pode remover o pragma.

## As armadilhas que custam mais tempo

**O UDP não está aberto.** O QUIC roda sobre UDP no mesmo número de porta do seu endpoint TLS. Todo firewall, security group e balanceador de carga no caminho precisa permitir UDP de entrada nessa porta, e a maioria dos templates padrão abre apenas TCP. Essa é a causa número um do "funciona na minha máquina e não no Azure".

**Algo na frente encerra a conexão.** Se um balanceador de carga de camada 7, um ingress controller ou uma CDN fica entre o cliente e o Kestrel, o HTTP/3 precisa estar habilitado *lá*, e o salto daquele proxy até o Kestrel é frequentemente HTTP/1.1 de qualquer jeito. Habilitar h3 no Kestrel atrás de um proxy que não repassa QUIC não muda absolutamente nada.

**Algumas sobrecargas de `UseHttps` não são compatíveis.** Com HTTP/3 em jogo, `HandshakeTimeout` e `OnAuthenticate` em `HttpsConnectionAdapterOptions` não fazem nada, e as sobrecargas de `UseHttps` que recebem um `ServerOptionsSelectionCallback` com timeout de handshake, ou um `TlsHandshakeCallbackOptions`, lançam exceção. Se você faz seleção dinâmica de certificado por nome de host, verifique esse caminho antes de habilitar h3.

**Você está medindo a coisa errada.** Os ganhos do HTTP/3 são menos idas e voltas no handshake e a ausência de head-of-line blocking sob perda de pacotes. Numa conexão de baixa latência e sem perdas entre duas máquinas do mesmo datacenter, ele vai parecer idêntico ao HTTP/2, e um benchmark rodado em loopback não vai mostrar nada. Meça numa rede móvel real ou com perdas, ou nem se dê ao trabalho de medir. O tamanho da resposta ainda domina a maior parte dos orçamentos de latência de uma API, e é por isso que [a compressão de respostas](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) costuma ser um ganho maior e mais barato do que uma atualização de protocolo.

## O que o .NET 11 mudou

Antes do .NET 11, o Kestrel esperava receber o stream de controle QUIC do peer e seu frame `SETTINGS` inicial antes de despachar qualquer stream de requisição. Isso custava aproximadamente uma ida e volta lógica extra em toda conexão nova, que é exatamente o cenário em que o HTTP/3 deveria ganhar de uma conexão HTTP/2 já aquecida. No .NET 11, o Kestrel despacha os streams de requisição assim que chegam e aplica as configurações do peer quando o stream de controle alcança. Não há nada a configurar e nenhuma mudança de código no nível do handler: é uma mudança de comportamento no nível do fio que você ganha ao atualizar, coberta em mais detalhe no artigo sobre [o processamento antecipado de requisições HTTP/3 no Kestrel](/pt-br/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/).

O único ponto a lembrar é que o Kestrel ainda respeita o `SETTINGS_MAX_FIELD_SECTION_SIZE` final do peer antes de serializar os cabeçalhos de resposta. Mantenha pequenos os cabeçalhos de resposta da primeira requisição e você obtém o benefício completo.

Se você está subindo um serviço novo e decidindo quanto do host configurar explicitamente, a opção de protocolo é um dos poucos botões que empurram para um host construído à mão em vez do padrão; os trade-offs estão detalhados na comparação de [CreateBuilder, CreateSlimBuilder e CreateEmptyBuilder](/pt-br/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/).

## Relacionados

- [Kestrel começa a processar requisições HTTP/3 antes do frame SETTINGS no .NET 11](/pt-br/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/)
- [Como adicionar compressão de respostas a uma API ASP.NET Core 11](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Fix: The SSL connection could not be established com HttpClient](/pt-br/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/)
- [Como publicar uma aplicação .NET 11 como imagem de contêiner com dotnet publish /t:PublishContainer](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder no ASP.NET Core 11](/pt-br/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Fontes

- [Use HTTP/3 with the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/http3), Microsoft Learn
- [Configure endpoints for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/endpoints), Microsoft Learn
- [QUIC support in .NET, platform dependencies](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/quic/quic-overview#platform-dependencies), Microsoft Learn
- [Use HTTP/3 with HttpClient](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-http3), Microsoft Learn
- [Use ASP.NET Core with HTTP/3 on IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/http3), Microsoft Learn
- [RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114), IETF
- [RFC 9000: QUIC, a UDP-based multiplexed and secure transport](https://www.rfc-editor.org/rfc/rfc9000), IETF
- [microsoft/msquic](https://github.com/microsoft/msquic), GitHub
