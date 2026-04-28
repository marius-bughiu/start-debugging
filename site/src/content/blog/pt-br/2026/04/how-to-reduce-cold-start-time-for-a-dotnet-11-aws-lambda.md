---
title: "Como reduzir o tempo de partida fria de uma AWS Lambda em .NET 11"
description: "Um manual prático e específico de versão para cortar partidas frias de Lambda em .NET 11. Cobre Native AOT em provided.al2023, ReadyToRun, SnapStart no runtime gerenciado dotnet10, ajuste de memória, reuso estático, segurança de trim, e como ler de fato INIT_DURATION."
pubDate: 2026-04-27
template: how-to
tags:
  - "aws"
  - "aws-lambda"
  - "dotnet-11"
  - "native-aot"
  - "performance"
lang: "pt-br"
translationOf: "2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda"
translatedBy: "claude"
translationDate: 2026-04-29
---

Uma Lambda típica em .NET vai de um `dotnet new lambda.EmptyFunction` padrão com partida fria de 1500-2500 ms para abaixo de 300 ms empilhando quatro alavancas: escolher o runtime certo (Native AOT em `provided.al2023` ou SnapStart no runtime gerenciado), dar à função memória suficiente para que init rode em uma vCPU completa, içar tudo o que é reutilizável para a inicialização estática, e parar de carregar código que você não precisa. Este guia caminha por cada alavanca para uma Lambda em .NET 11 (`Amazon.Lambda.RuntimeSupport` 1.13.x, `Amazon.Lambda.AspNetCoreServer.Hosting` 1.7.x, .NET 11 SDK, C# 14), explica a ordem em que aplicá-las e mostra como verificar cada passo a partir da linha `INIT_DURATION` no CloudWatch.

## Por que uma Lambda .NET padrão tem partida fria tão lenta

Uma partida fria com runtime gerenciado na Lambda executa quatro coisas em sequência, e uma função .NET padrão paga por todas. Primeiro, a **microVM Firecracker** sobe e a Lambda baixa seu pacote de deploy. Segundo, o **runtime inicializa**: para um runtime gerenciado, isso significa que o CoreCLR carrega, o JIT do host se aquece, e os assemblies da sua função são mapeados em memória. Terceiro, sua **classe de handler é construída**, incluindo qualquer injeção via construtor, carregamento de configuração e construção de clientes do AWS SDK. Só depois de tudo isso a Lambda chama seu `FunctionHandler` para a primeira invocação.

O custo específico de .NET aparece nos passos dois e três. O CoreCLR JIT-compila cada método na primeira chamada. ASP.NET Core (quando você usa a ponte de hosting do API Gateway) constrói um host completo com logging, configuração e uma pipeline de option-binding. Os clientes padrão do AWS SDK resolvem credenciais preguiçosamente percorrendo a cadeia de credential providers, o que na Lambda é rápido mas ainda assim aloca. Serializadores pesados em reflexão como os caminhos padrão do `System.Text.Json` inspecionam cada propriedade de cada tipo que veem pela primeira vez.

Você pode puxar quatro alavancas, nesta ordem, com retornos decrescentes:

1. **Native AOT** envia um binário pré-compilado, então o custo de JIT vai a zero e o runtime inicializa um pequeno executável autocontido.
2. **SnapStart** tira um snapshot de uma fase de init já aquecida e restaura do disco em partida fria.
3. **Tamanho de memória** te compra CPU proporcional, o que acelera tudo no init.
4. **Reuso estático e trimming** encolhem o que roda durante o init e o que é refeito por partida fria.

## Alavanca 1: Native AOT em provided.al2023 (a maior vitória individual)

Native AOT compila sua função e o runtime do .NET em um único binário estático, elimina o JIT, e corta a partida fria aproximadamente para o tempo que a Lambda leva para subir um processo. A AWS publica [orientação de primeira classe](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) para isso no runtime customizado `provided.al2023`. No .NET 11 a toolchain bate com o que veio no .NET 8, mas o analisador de trim é mais rigoroso e avisos `ILLink` que estavam verdes no .NET 8 podem acender.

A função mínima pronta para AOT fica assim:

```csharp
// .NET 11, C# 14
// PackageReference: Amazon.Lambda.RuntimeSupport 1.13.0
// PackageReference: Amazon.Lambda.Serialization.SystemTextJson 2.4.4
using System.Text.Json.Serialization;
using Amazon.Lambda.Core;
using Amazon.Lambda.RuntimeSupport;
using Amazon.Lambda.Serialization.SystemTextJson;

var serializer = new SourceGeneratorLambdaJsonSerializer<LambdaFunctionJsonContext>();

var handler = static (Request req, ILambdaContext ctx) =>
    new Response($"hello {req.Name}", DateTimeOffset.UtcNow);

await LambdaBootstrapBuilder.Create(handler, serializer)
    .Build()
    .RunAsync();

public record Request(string Name);
public record Response(string Message, DateTimeOffset At);

[JsonSerializable(typeof(Request))]
[JsonSerializable(typeof(Response))]
public partial class LambdaFunctionJsonContext : JsonSerializerContext;
```

As chaves do `csproj` que importam:

```xml
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <PublishAot>true</PublishAot>
  <StripSymbols>true</StripSymbols>
  <InvariantGlobalization>true</InvariantGlobalization>
  <RootNamespace>MyFunction</RootNamespace>
  <AssemblyName>bootstrap</AssemblyName>
  <TieredCompilation>false</TieredCompilation>
</PropertyGroup>
```

`AssemblyName` igual a `bootstrap` é exigido pelo runtime customizado. `InvariantGlobalization=true` remove o ICU, economizando tamanho de pacote e evitando a temida inicialização do ICU na partida fria. Se você precisar de dados de cultura reais, troque por `<PredefinedCulturesOnly>false</PredefinedCulturesOnly>` e aceite o aumento de tamanho.

Compile no Amazon Linux (ou em um container Linux) para o linker bater com o ambiente da Lambda:

```bash
# .NET 11 SDK
dotnet lambda package --configuration Release \
  --framework net11.0 \
  --msbuild-parameters "--self-contained true -r linux-x64 -p:PublishAot=true"
```

A ferramenta global `Amazon.Lambda.Tools` empacota o binário `bootstrap` em um ZIP que você sobe como runtime customizado. Com uma função de 256 MB e o boilerplate acima, espere partidas frias na faixa de **150 ms a 300 ms**, descendo de 1500-2000 ms no runtime gerenciado.

A contrapartida: cada biblioteca pesada em reflexão que você puxar vira um aviso de trim. Geradores de código de `System.Text.Json` cuidam da serialização, mas se você usa qualquer coisa que reflete sobre tipos genéricos em runtime (AutoMapper antigo, Newtonsoft, handlers do MediatR baseados em reflexão), vai pegar avisos do ILLink ou uma exceção em runtime. Trate cada aviso como um bug real. Uma alternativa de mediator amigável a trim é coberta em [SwitchMediator v3, um mediator zero-alloc que continua amigável a AOT](/2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot/).

## Alavanca 2: SnapStart no runtime gerenciado dotnet10

Se seu código não é amigável a AOT (reflexão pesada, plugins dinâmicos, EF Core 11 com construção de modelo em runtime), Native AOT não é viável. A próxima melhor opção é o **Lambda SnapStart**, suportado hoje no **runtime gerenciado `dotnet10`**. Em abril de 2026, o runtime gerenciado `dotnet11` ainda não está GA, então o alvo "gerenciado" prático para código .NET 11 é multi-targetar `net10.0` e rodar no runtime `dotnet10` habilitado para SnapStart, ou usar o runtime customizado descrito acima. A AWS anunciou o runtime .NET 10 no fim de 2025 ([blog AWS: .NET 10 runtime agora disponível na AWS Lambda](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/)) e o suporte SnapStart para runtimes .NET gerenciados está documentado em [Melhorando a performance de inicialização com Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html).

SnapStart congela a função depois do init, tira um snapshot da microVM Firecracker, e na partida fria restaura o snapshot em vez de rodar o init de novo. Para .NET, onde o init é a parte cara, isso tipicamente reduz partidas frias em 60-90%.

Duas coisas importam para a correção do SnapStart:

1. **Determinismo após o restore.** Qualquer coisa capturada durante o init (sementes aleatórias, tokens específicos da máquina, sockets de rede, caches derivados de tempo) é compartilhada entre cada instância restaurada. Use os hooks de runtime que a AWS fornece:

```csharp
// .NET 10 target multi-targeted with .NET 11
using Amazon.Lambda.RuntimeSupport;

Core.SnapshotRestore.RegisterBeforeSnapshot(() =>
{
    // flush anything that should not be captured
    return ValueTask.CompletedTask;
});

Core.SnapshotRestore.RegisterAfterRestore(() =>
{
    // re-seed RNG, refresh credentials, reopen sockets
    return ValueTask.CompletedTask;
});
```

2. **Faça pre-JIT do que você quer aquecido.** SnapStart captura o estado JITeado. A compilação por tiers não terá promovido métodos quentes a tier-1 ainda durante o init, então você obtém um snapshot de código majoritariamente tier-0 a menos que você empurre. Caminhe pelo caminho quente uma vez durante o init (chame seu handler com um payload sintético de aquecimento, ou invoque métodos-chave explicitamente) para que o snapshot inclua suas formas JITeadas. Com `<TieredPGO>true</TieredPGO>` (o padrão no .NET 11), isso importa um pouco menos, mas ainda ajuda mensuravelmente.

SnapStart é gratuito para runtimes .NET gerenciados hoje, com a ressalva de que a criação do snapshot adiciona um pequeno atraso aos deploys.

## Alavanca 3: tamanho de memória compra CPU

A Lambda aloca CPU proporcionalmente à memória. Em 128 MB você ganha uma fração de uma vCPU. Em 1769 MB você ganha uma vCPU completa, e acima disso mais que uma. **Init roda na mesma CPU proporcional**, então uma função configurada com 256 MB paga uma conta de JIT e DI bem mais lenta do que o mesmo código em 1769 MB.

Números concretos para uma pequena Lambda de API mínima do ASP.NET Core:

| Memória | INIT_DURATION (gerenciado dotnet10) | INIT_DURATION (Native AOT) |
| ------- | ----------------------------------- | -------------------------- |
| 256 MB  | ~1800 ms                            | ~280 ms                    |
| 512 MB  | ~1100 ms                            | ~200 ms                    |
| 1024 MB | ~700 ms                             | ~180 ms                    |
| 1769 MB | ~480 ms                             | ~160 ms                    |

A lição não é "use sempre 1769 MB". É que você não pode concluir nada sobre partida fria em 256 MB. Bench em cima do tamanho de memória que você de fato pretende deployar, e lembre que **a [state machine AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning)** encontra o tamanho de memória custo-ótimo para sua workload em poucos minutos.

## Alavanca 4: reuso estático e trimming do grafo do init

Depois de escolher runtime e memória, as vitórias restantes vêm de fazer menos trabalho durante o init e reusar mais entre invocações. Três padrões cobrem a maior parte do que vale a pena fazer.

### Iça clientes e serializadores para campos estáticos

A Lambda reutiliza o mesmo ambiente de execução entre invocações até esfriar. Qualquer coisa em campo estático sobrevive. O erro clássico é alocar um `HttpClient` ou cliente do AWS SDK dentro do handler:

```csharp
// .NET 11 - bad: per-invocation construction
public async Task<Response> Handler(Request req, ILambdaContext ctx)
{
    using var http = new HttpClient(); // pays DNS, TCP, TLS every time
    var s3 = new AmazonS3Client();      // re-resolves credentials chain
    // ...
}
```

Mova para cima:

```csharp
// .NET 11 - good: shared across warm invocations
public sealed class Function
{
    private static readonly HttpClient Http = new();
    private static readonly AmazonS3Client S3 = new();

    public async Task<Response> Handler(Request req, ILambdaContext ctx)
    {
        // reuses Http and S3 across warm invocations on the same instance
    }
}
```

Esse padrão está documentado em [Como testar unitariamente código que usa HttpClient](/pt-br/2026/04/how-to-unit-test-code-that-uses-httpclient/), que cobre o ângulo de testabilidade. Para Lambda a regra é simples: qualquer coisa cara de construir e segura de reusar vai como estática.

### Use geradores de código do System.Text.Json, sempre

O `System.Text.Json` padrão reflete sobre seus tipos DTO no primeiro uso, o que infla o tempo de init e é incompatível com Native AOT. Geradores de código fazem o trabalho em build:

```csharp
// .NET 11
[JsonSerializable(typeof(APIGatewayProxyRequest))]
[JsonSerializable(typeof(APIGatewayProxyResponse))]
[JsonSerializable(typeof(MyDomainObject))]
public partial class LambdaJsonContext : JsonSerializerContext;
```

Passe o context gerado para `SourceGeneratorLambdaJsonSerializer<T>`. Isso recorta centenas de milissegundos das partidas frias do runtime gerenciado e é obrigatório para AOT.

### Evite ASP.NET Core completo quando você não precisa

O adapter `Amazon.Lambda.AspNetCoreServer.Hosting` deixa você rodar uma API mínima real do ASP.NET Core atrás do API Gateway. É uma vitória grande de DX, mas ele sobe o host inteiro do ASP.NET Core: provedores de configuração, provedores de logging, validação de options, o grafo de roteamento. Para uma Lambda de 5 endpoints, isso são centenas de milissegundos de init. Compare com um handler escrito à mão com `LambdaBootstrapBuilder`, que sobe em dezenas de milissegundos.

Escolha de propósito:

-   **Muitos endpoints, pipeline complexa, quer middleware**: o hosting do ASP.NET Core está bom, vá pelo caminho do SnapStart.
-   **Um handler, uma rota, performance importa**: escreva um handler cru contra `Amazon.Lambda.RuntimeSupport`. Se você também quer formas de requisição HTTP, aceite `APIGatewayHttpApiV2ProxyRequest` direto.

### ReadyToRun quando AOT é restritivo demais

Se você não consegue enviar Native AOT por causa de uma dependência pesada em reflexão, mas também não pode usar SnapStart (talvez porque você mira em um runtime gerenciado que ainda não suporta), habilite **ReadyToRun**. R2R pré-compila IL para código nativo que o JIT pode usar sem recompilar na primeira chamada. Ele corta o custo de JIT em aproximadamente 50-70% na partida fria ao custo de um pacote maior:

```xml
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
  <PublishReadyToRunComposite>true</PublishReadyToRunComposite>
</PropertyGroup>
```

R2R costuma ser uma vitória de 100-300 ms na partida fria do runtime gerenciado. Empilha com tudo o mais e é essencialmente gratuito, então é a primeira coisa a tentar se você não consegue ir para AOT ou SnapStart.

## Lendo INIT_DURATION corretamente

A linha `REPORT` do CloudWatch para uma invocação com partida fria tem o formato:

```
REPORT RequestId: ... Duration: 12.34 ms Billed Duration: 13 ms
Memory Size: 512 MB Max Memory Used: 78 MB Init Duration: 412.56 ms
```

`Init Duration` é o custo da partida fria: boot da VM + init do runtime + seu construtor estático e construção da classe handler. Algumas regras para lê-lo:

-   `Init Duration` **não é cobrado** no runtime gerenciado. É cobrado em runtimes customizados AOT via o modelo `provided.al2023`.
-   A primeira invocação por instância concorrente o mostra. Invocações quentes o omitem.
-   Funções SnapStart reportam `Restore Duration` em vez de `Init Duration`. Essa é sua métrica de partida fria no SnapStart.
-   `Max Memory Used` é o pico. Se ficar abaixo de ~30% de `Memory Size`, você está provavelmente superprovisionado e poderia tentar um tamanho menor, mas só depois de medir naquele tamanho menor já que CPU cai com memória.

A ferramenta que torna isso legível: uma query CloudWatch Log Insights como

```
fields @timestamp, @initDuration, @duration
| filter @type = "REPORT"
| sort @timestamp desc
| limit 200
```

Para traces mais profundos, [Como fazer profile de um app .NET com dotnet-trace e ler a saída](/pt-br/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) cobre como capturar e ler um flame graph do init a partir de uma sessão local de emulador da Lambda.

## Concorrência provisionada é a saída de emergência, não a resposta

Concorrência provisionada mantém `N` instâncias quentes permanentemente. Partidas frias nessas instâncias são zero, porque elas não estão frias. É a resposta certa quando você tem um SLO de latência rígido que as alavancas acima não conseguem atender, ou quando a semântica de restore do SnapStart conflita com seu código. É a resposta errada como substituto para de fato otimizar o init: você está pagando por capacidade quente 24/7 para mascarar um problema que pode ser corrigido, e a conta escala com o número de instâncias que você mantém quentes. Use Application Auto Scaling para escalar a concorrência provisionada num cronograma se seu tráfego é previsível.

## A ordem em que aplico isso em produção

Em torno de uma dúzia de Lambdas .NET que ajustei:

1. **Sempre**: JSON com source generator, campos estáticos para clientes, R2R ligado, `InvariantGlobalization=true` se for independente de locale.
2. **Se livre de reflexão**: Native AOT em `provided.al2023`. Sozinho, normalmente vence cada outra alavanca combinada.
3. **Se reflexão é inevitável**: runtime gerenciado `dotnet10` com SnapStart, mais uma chamada sintética de aquecimento durante o init para pré-JITear o caminho quente.
4. **Verifique** com INIT_DURATION no tamanho de memória de deploy real. Use Power Tuning se a curva custo-vs-latência importa.
5. **Concorrência provisionada** só depois disso, e só com auto-scaling.

O resto da história de Lambda em .NET 11 (versões de runtime, formato de deploy, o que muda se você girar de `dotnet10` para um futuro runtime gerenciado `dotnet11`) está coberto em [AWS Lambda suporta .NET 10: o que verificar antes de virar o runtime](/2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime/), que é o companheiro deste post.

## Fontes

-   [Compile o código de função Lambda em .NET para um formato de runtime nativo](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) - docs AWS.
-   [Melhorando a performance de inicialização com Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) - docs AWS.
-   [.NET 10 runtime agora disponível na AWS Lambda](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/) - blog AWS.
-   [Visão geral dos runtimes da Lambda](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) - incluindo `provided.al2023`.
-   [aws/aws-lambda-dotnet](https://github.com/aws/aws-lambda-dotnet) - a fonte de `Amazon.Lambda.RuntimeSupport`.
-   [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) - o tuner custo-vs-latência.
