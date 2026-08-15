---
title: "Zstandard vs Brotli vs Gzip para compressão de respostas no .NET 11"
description: "Zstandard é o padrão certo para respostas dinâmicas de API no .NET 11, mas não na qualidade com que o provider do ASP.NET Core vem configurado. Benchmarks sobre payloads JSON reais mostrando por que a qualidade 1 supera a qualidade 3 padrão tanto em tamanho quanto em CPU, quando o Brotli ainda vence e por que o Gzip sobrevive apenas como alternativa de compatibilidade."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "compression"
  - "performance"
lang: "pt-br"
translationOf: "2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

Para respostas dinâmicas de API no .NET 11, use Zstandard, que já é o padrão, mas defina `Quality = 1` explicitamente em vez de aceitar o padrão do provider. Nos payloads JSON que medi, o Zstandard com qualidade 1 comprimiu 7.37x enquanto a qualidade 3 padrão do provider chegou só a 6.66x, e a qualidade 1 fez isso com quase o dobro de throughput. O Brotli só vence quando você pode comprimir uma vez e servir muitas vezes, e mesmo assim apenas na qualidade 11, que custa 3,2 segundos por resposta de 3 MB. O Gzip agora é puramente uma alternativa de compatibilidade.

Tudo abaixo tem como alvo o .NET 11 (Preview 7 no momento em que escrevo, GA em novembro de 2026) e o C# 14. O provider Zstandard é novo no ASP.NET Core 11; Brotli e Gzip estão no middleware desde o ASP.NET Core 2.1 e se comportam de forma idêntica no .NET 8, 9 e 10.

## A matriz

| | Zstandard | Brotli | Gzip |
| --- | --- | --- | --- |
| Token `Accept-Encoding` | `zstd` | `br` | `gzip` |
| Especificação | [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878) | [RFC 7932](https://datatracker.ietf.org/doc/html/rfc7932) | [RFC 1952](https://www.ietf.org/rfc/rfc1952.txt) |
| Incluído no `System.IO.Compression` desde | .NET 11 | .NET Core 2.1 | .NET Framework 2.0 |
| Registrado por padrão no ASP.NET Core 11 | Sim, primeiro | Sim, segundo | Sim, terceiro |
| Nível padrão do provider | qualidade 3 | `CompressionLevel.Fastest` | `CompressionLevel.Fastest` |
| Faixa de níveis | `MinQuality` (negativo) até 22 | 0 até 11 | 0 até 9 |
| Ratio em JSON de 292 KB (melhor nível razoável) | 7.26x | 7.01x | 6.55x |
| Throughput de compressão nesse nível | 572 MB/s | 215 MB/s | 208 MB/s |
| Throughput de descompressão | 3103 MB/s | 1134 MB/s | 1575 MB/s |
| Funciona no Blazor WebAssembly | Não | Sim | Sim |
| Suporte a dicionários | Treinável (`ZstandardDictionary`) | Apenas estático embutido | Não |

As duas linhas que decidem a maioria das discussões são o throughput de descompressão e a linha do WebAssembly. Todo o resto está próximo o bastante para você tirar cara ou coroa.

## O que o .NET 11 registra de fato, e em que ordem

Se você chamar `AddResponseCompression()` sem nomear providers, o ASP.NET Core 11 registra três, e a ordem em [`ResponseCompressionProvider`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs) é a ordem de preferência do servidor:

```csharp
// ASP.NET Core 11, from ResponseCompressionProvider.cs
_providers = new ICompressionProvider[]
{
    new CompressionProviderFactory(typeof(ZstandardCompressionProvider)),
    new CompressionProviderFactory(typeof(BrotliCompressionProvider)),
    new CompressionProviderFactory(typeof(GzipCompressionProvider)),
};
```

Então um navegador que envia `Accept-Encoding: gzip, deflate, br, zstd` recebe `Content-Encoding: zstd` de uma aplicação ASP.NET Core 11 que você nunca configurou. No .NET 10 a mesma requisição recebia `br`. Essa é toda a mudança visível para o usuário, e ela acontece na atualização sem nenhuma edição de código.

No momento em que você adiciona um provider na mão, os padrões são desligados por completo e apenas a sua lista fica ativa. Essa é a forma mais comum de desativar o Zstandard sem querer, achando que você estava apenas habilitando compressão sobre HTTPS.

## A qualidade padrão é a qualidade errada

Aqui está a parte que não aparece nas notas de versão. `BrotliCompressionProviderOptions` e `GzipCompressionProviderOptions` usam ambos `CompressionLevel.Fastest` por padrão. O provider Zstandard não tem uma propriedade `Level`. Ele tem isto:

```csharp
// ASP.NET Core 11, from ZstandardCompressionProviderOptions.cs
public ZstandardCompressionOptions CompressionOptions { get; set; } = new();
```

Um `ZstandardCompressionOptions` recém-criado deixa `Quality` em `0`, e `0` significa "padrão definido pela implementação", que o libzstd resolve como nível 3. Então os providers Brotli e Gzip vêm ajustados para latência enquanto o provider Zstandard vem no padrão equilibrado do libzstd. Ninguém escreveu essa assimetria em lugar nenhum, mas é o que o código-fonte diz.

Isso seria um detalhe menor se a qualidade 3 fosse simplesmente uma opção mais lenta e menor. Não é. Nos payloads JSON que medi, a qualidade 3 é pior que a qualidade 1 em **ambos** os eixos:

| Qualidade zstd | Tamanho do JSON de 2.88 MB | Ratio | Throughput de compressão |
| --- | --- | --- | --- |
| 1 | 409,809 B | 7.37x | 806 MB/s |
| 2 | 427,111 B | 7.07x | - |
| 3 (padrão do provider) | 453,130 B | 6.66x | 425 MB/s |
| 4 | 460,813 B | 6.55x | - |
| 5 | 449,750 B | 6.71x | - |
| 6 | 436,263 B | 6.92x | 159 MB/s |
| 9 | 422,148 B | 7.15x | - |
| 12 | 416,795 B | 7.24x | 54 MB/s |
| 19 | 362,100 B | 8.34x | - |

Leia essa coluna de novo. O ratio cai do nível 1 ao nível 4, depois volta a subir, e só supera o nível 1 novamente no nível 9. Pagar 1,9x de CPU para obter um corpo 11% maior é um mau negócio em qualquer direção.

Isso não é um bug e não é específico do .NET. Os níveis do Zstandard não são um único botão: cada nível seleciona uma estratégia diferente de busca de correspondências, além dos seus próprios parâmetros de janela, cadeia, hash e correspondência mínima. Perguntar diretamente ao libzstd quais parâmetros ele usa mostra a descontinuidade:

```
level  1: strategy=1 (fast)   windowLog=19 chainLog=13 hashLog=14 minMatch=7
level  2: strategy=1 (fast)   windowLog=20 chainLog=15 hashLog=16 minMatch=6
level  3: strategy=2 (dfast)  windowLog=21 chainLog=16 hashLog=17 minMatch=5
level  4: strategy=2 (dfast)  windowLog=21 chainLog=18 hashLog=18 minMatch=5
level  5: strategy=3 (greedy) windowLog=21 chainLog=18 hashLog=19 minMatch=5
level  6: strategy=4 (lazy)   windowLog=21 chainLog=18 hashLog=19 minMatch=5
```

O salto do nível 2 para o nível 3 baixa `minMatch` de 6 para 5 e troca de estratégia. Em texto com trechos longos e altamente repetitivos (chaves JSON repetidas uma vez por elemento do array, uma string `notes` idêntica em cada registro), a configuração do nível 1 encontra correspondências menos numerosas porém mais longas, que são codificadas por entropia com mais eficiência. Essas tabelas de níveis foram ajustadas contra um corpus geral, então a ordenação vale na média, não no seu payload.

A regra prática: o nível padrão de qualquer codec é um chute sobre dados que ele nunca viu. Meça os dois ou três formatos reais dos seus endpoints e fixe a qualidade.

## O benchmark

Payload: um array JSON de registros de clientes, o formato que um endpoint de listagem realmente devolve. Determinístico, para você reproduzir:

```csharp
// .NET 10 / .NET 11, C# 14
static Guid NextGuid(Random rnd)
{
    var b = new byte[16];
    rnd.NextBytes(b);
    return new Guid(b);
}

static byte[] MakeListPayload(int count, int seed)
{
    var rnd = new Random(seed);
    string[] cities = ["Bucharest", "Berlin", "Lisbon", "Warsaw", "Dublin", "Madrid", "Helsinki"];
    string[] statuses = ["active", "pending", "suspended", "closed"];
    var items = Enumerable.Range(1, count).Select(i => new
    {
        id = i,
        externalId = NextGuid(rnd).ToString(),
        name = $"Customer {i}",
        email = $"user{i}@example.com",
        city = cities[rnd.Next(cities.Length)],
        status = statuses[rnd.Next(statuses.Length)],
        balance = Math.Round(rnd.NextDouble() * 10000, 2),
        createdAt = new DateTime(2024, 1, 1).AddMinutes(i * 7).ToString("O"),
        tags = new[] { "vip", "eu", "newsletter" }.Take(rnd.Next(1, 4)).ToArray(),
        notes = "Imported from the legacy CRM during the 2024 migration."
    });
    return JsonSerializer.SerializeToUtf8Bytes(items);
}
```

Método: cada codec envolve um `MemoryStream` exatamente como o middleware de compressão de respostas envolve o corpo da resposta, de modo que a preparação do encoder por resposta fica dentro da medição. Três iterações de aquecimento, depois 60 iterações cronometradas para o payload de 292 KB e 15 para o de 2.88 MB, reportando a mediana. Máquina: Intel Core Ultra 7 265KF, Windows 11, .NET 10.0.5 x64.

Uma ressalva honesta sobre o ambiente. Minha máquina tem apenas o SDK 10.0.201, então `System.IO.Compression.ZstandardStream` não estava disponível para compilar. As linhas do Zstandard vêm do [ZstdSharp.Port](https://www.nuget.org/packages/ZstdSharp.Port) 0.8.8, um port gerenciado da implementação de referência. Duas coisas tornam essa substituição defensável. Primeiro, o .NET 11 incorpora o [libzstd 1.5.7](https://github.com/dotnet/runtime/blob/main/src/native/external/zstd/lib/zstd.h), e eu verifiquei cada tamanho de saída do ZstdSharp contra o libzstd 1.5.7 nativo nos mesmos bytes: eles batem dentro de 0,05% (41,132 contra 41,135 bytes na qualidade 1, 43,644 contra 43,647 na qualidade 3). Os tamanhos comprimidos são, portanto, o que o .NET 11 vai produzir. Segundo, o throughput é o número que não é transferível: o libzstd nativo atingiu 1092 MB/s na qualidade 1 neste hardware onde o port gerenciado atingiu 806 MB/s, então trate a coluna de velocidade do Zstandard como um piso, não como um teto.

**JSON de 292 KB (1.000 registros), 298,727 bytes brutos:**

| codec | nível | comprimido | ratio | comp MB/s | descomp MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 69,832 | 4.28x | 743 | 1488 |
| gzip | Optimal | 45,586 | 6.55x | 208 | 1575 |
| brotli | Fastest | 44,606 | 6.70x | 564 | 808 |
| brotli | Optimal | 42,610 | 7.01x | 215 | 1134 |
| brotli | q11 (SmallestSize) | 34,025 | 8.78x | 1 | 728 |
| zstd | q1 | 41,132 | 7.26x | 572 | 3103 |
| zstd | q3 (padrão do provider) | 43,644 | 6.84x | 276 | 1796 |
| zstd | q6 | 41,009 | 7.28x | 112 | 1735 |
| zstd | q12 | 38,881 | 7.68x | 20 | 1320 |

**JSON de 2.88 MB (10.000 registros), 3,018,756 bytes brutos:**

| codec | nível | comprimido | ratio | comp MB/s | descomp MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 697,252 | 4.33x | 712 | 1443 |
| gzip | Optimal | 452,661 | 6.67x | 204 | 1620 |
| brotli | Fastest | 447,954 | 6.74x | 786 | 726 |
| brotli | Optimal | 429,060 | 7.04x | 186 | 1088 |
| brotli | q11 (SmallestSize) | 341,338 | 8.84x | 1 | 842 |
| zstd | q1 | 409,805 | 7.37x | 806 | 3158 |
| zstd | q3 (padrão do provider) | 454,007 | 6.65x | 425 | 1914 |
| zstd | q6 | 436,263 | 6.92x | 159 | 1846 |
| zstd | q12 | 416,792 | 7.24x | 54 | 1891 |

Três resultados sustentam toda a comparação.

**Zstandard na qualidade 1 domina o Brotli `Fastest`.** Saída menor (41,132 contra 44,606 bytes), o mesmo throughput de compressão (572 contra 564 MB/s) e 3,8x o throughput de descompressão. Não existe eixo no qual a configuração rápida do Brotli seja a melhor escolha para uma resposta dinâmica.

**Gzip `Fastest` não é competitivo em tamanho.** 69,832 bytes contra os 41,132 do Zstandard é um corpo 70% maior sem vantagem de throughput. Se você ainda emite `gzip` para clientes modernos, está pagando por isso em banda.

**Brotli q11 é uma armadilha no caminho da requisição.** É genuinamente a menor saída da tabela, 8.78x, cerca de 17% melhor que o Zstandard na qualidade 1. Também levou 272 milissegundos para o payload de 292 KB e 3,2 segundos para o de 2.88 MB. Isso é por resposta. Quem medir "o Brotli comprime melhor" e configurar `SmallestSize` em uma API em produção terá adicionado três segundos de latência limitada por CPU a cada resposta grande.

## Quando escolher cada um

**Zstandard, qualidade 1** para qualquer coisa calculada por requisição. Endpoints de listagem JSON, respostas GraphQL, HTML renderizado no servidor, respostas de ingestão de logs. Esse é o padrão no .NET 11 e a única mudança de que você precisa é fixar a qualidade.

**Zstandard, qualidade 12 a 19** para conteúdo comprimido uma vez e cacheado, quando você armazena os bytes comprimidos e os serve repetidamente. A qualidade 19 chegou a 8.34x no payload grande, fechando a maior parte da distância para o Brotli q11 por uma fração do custo. Combine com [output caching](/pt-br/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) para que a CPU seja paga uma vez por entrada de cache em vez de uma vez por requisição.

**Brotli, qualidade 11** para assets estáticos comprimidos em tempo de build. Seu bundle de JS, seu CSS, seu payload WASM. O tempo de compressão não importa quando acontece no CI, e o dicionário estático embutido do Brotli é ajustado exatamente para esse conteúdo. Não faça isso no middleware de compressão de respostas; pré-comprima e sirva o arquivo `.br`.

**Brotli, `Optimal`** quando você precisa de suporte amplo de clientes e não pode usar Zstandard. Notavelmente, isso inclui o Blazor WebAssembly, discutido abaixo.

**Gzip** apenas como última entrada da lista de providers, para clientes que não anunciam mais nada. Mantenha registrado; nunca prefira.

## Os detalhes que decidem por você

**Zstandard não existe no navegador nem no WASI.** O runtime marca toda a família de tipos com `[UnsupportedOSPlatform("browser")]` e `[UnsupportedOSPlatform("wasi")]`. Se o seu cliente é uma aplicação Blazor WebAssembly fazendo a própria descompressão, ou você está rodando em `wasi-wasm`, o Zstandard não é uma opção e o analisador vai avisar em tempo de build. A compressão do lado do servidor para um navegador não é afetada: o suporte a `zstd` do próprio navegador lida com `Content-Encoding: zstd` nativamente, e isso já está disponível há um tempo no Chrome, no Edge e no Firefox. Isso só afeta código que chama `ZstandardStream` dentro de um runtime WASM.

**`CompressionLevel.NoCompression` não significa "sem compressão" para o Zstandard.** O runtime mapeia o enum sobre a qualidade do zstd assim:

```csharp
// .NET 11, from ZstandardUtils.cs
CompressionLevel.NoCompression => Quality_Min,   // ZSTD_minCLevel(), a large negative number
CompressionLevel.Fastest       => 1,
CompressionLevel.Optimal       => Quality_Default,  // 3
CompressionLevel.SmallestSize  => Quality_Max,      // 22
```

`NoCompression` mapeia para a *qualidade mínima*, que ainda é uma configuração que comprime, apenas extremamente rápida e fraca. Para Gzip e Brotli, `NoCompression` realmente significa blocos armazenados. Passar o mesmo valor do enum para os três codecs dá três comportamentos diferentes.

**Qualidades negativas são válidas, e a documentação do ASP.NET Core não as menciona.** [A página de compressão de respostas](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0) diz que o nível de qualidade "vai de 1 a 22". O código-fonte do runtime é mais amplo: `Quality` aceita qualquer valor de `MinQuality` até `MaxQuality`, com os negativos documentados como uma extensão da faixa velocidade/ratio. Raramente são o que você quer para JSON. A qualidade -5 levou a compressão a 1635 MB/s mas o ratio desabou de 7.37x para 3.81x, o que para uma resposta de 3 MB significa mandar cerca de 375 KB a mais pela rede para economizar um milissegundo de CPU. Recorra à qualidade 1, não aos negativos.

**Habilitar compressão sobre HTTPS continua sendo opcional e com um risco real embutido.** `EnableForHttps` é `false` por padrão porque comprimir uma resposta que mistura um segredo com entrada influenciada por um atacante vaza esse segredo através do tamanho comprimido ([CRIME](https://en.wikipedia.org/wiki/CRIME) e [BREACH](https://en.wikipedia.org/wiki/BREACH)). Trocar de codec não muda isso: o Zstandard é exatamente tão vulnerável quanto o Gzip era. Se você quer o raciocínio e a lista de mitigações, o [guia completo de configuração da compressão de respostas](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) cobre isso.

**Respostas pequenas perdem com qualquer codec.** A resposta de um único registro no meu conjunto de testes tem 179 bytes. O Gzip `Fastest` a transformou em 188 bytes, maior que a entrada, e o Zstandard na qualidade 1 em 157 bytes, um "ganho" de 1.14x que é inteiramente consumido pelo overhead de enquadramento e pela preparação do encoder por resposta. A orientação do próprio framework é não comprimir abaixo de aproximadamente 150 a 1.000 bytes, e a escolha do codec não move esse limiar.

## Como configurar

A configuração completa para uma API JSON, com a qualidade fixada:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 1
    };
});

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/customers", () => Results.Ok(GetCustomers()));

app.Run();
```

Adicionar os três providers explicitamente é redundante com os padrões, mas documenta a ordem de preferência para a próxima pessoa e sobrevive a alguém adicionar um quarto provider mais tarde.

Mais dois ajustes em `ZstandardCompressionOptions` valem ser conhecidos para respostas em streaming. `TargetBlockSize` (faixa válida de 1.340 a 131.072 bytes) sugere com que frequência o encoder emite um bloco; valores menores significam menor latência para uma resposta que sai aos poucos, com algum custo em ratio. `EnableLongDistanceMatching` melhora os ratios em corpos grandes ao custo de memória. Nenhum dos dois vale a pena mexer antes de você ter fixado a qualidade e medido.

Se as suas respostas são pequenas, uniformes e repetitivas, o recurso que realmente vale investigar é o `ZstandardDictionary`. Treinar um dicionário sobre amostras representativas permite ao Zstandard comprimir payloads que individualmente são pequenos demais para construir uma janela útil, que é o único caso em que a resposta de 179 bytes acima se torna compressível. Brotli e Gzip não têm um equivalente que você mesmo possa treinar.

## A recomendação, repetida

Pegue o padrão do .NET 11 e fixe uma propriedade. O Zstandard na qualidade 1 deu o melhor ratio de qualquer nível que rode rápido o bastante para um caminho de requisição, empatou com a configuração mais rápida do Brotli em throughput de compressão e descomprimiu cerca de 3x mais rápido que qualquer outra coisa da tabela, que é o número que os seus clientes móveis sentem. Deixe Brotli e Gzip registrados abaixo dele para que clientes antigos ainda recebam algo.

Não aceite a qualidade padrão do provider, que é 3. É a única configuração desta comparação que perde em tamanho e em velocidade ao mesmo tempo, e é o que você recebe se não mudar nada.

## Relacionado

- [Como adicionar compressão de respostas a uma API ASP.NET Core 11](/pt-br/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) cobre por completo a configuração do middleware, os tipos MIME e a decisão de segurança sobre HTTPS.
- [.NET 11 adiciona compressão Zstandard nativa ao System.IO.Compression](/pt-br/2026/04/dotnet-11-zstandard-compression-system-io/) apresenta a API `ZstandardStream` fora do contexto HTTP.
- [Output caching vs response caching no ASP.NET Core 11](/pt-br/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/) é como você torna um nível alto de compressão viável.
- [Compressão Deflate e Gzip baseada em spans no .NET 11](/pt-br/2026/05/dotnet-11-span-based-deflate-gzip-compression/) cobre as APIs de uma única passada e sem alocação para os codecs mais antigos.
- [Como transmitir um arquivo de um endpoint ASP.NET Core sem buffering](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) explica onde compressão e streaming interagem mal.

## Fontes

- [Compressão de respostas no ASP.NET Core 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionProvider.cs, ordem padrão de providers (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs)
- [ZstandardCompressionProviderOptions.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ZstandardCompressionProviderOptions.cs)
- [ZstandardCompressionOptions.cs, semântica de qualidade e janela (dotnet/dotnet)](https://github.com/dotnet/dotnet/blob/main/src/runtime/src/libraries/System.IO.Compression.Zstandard/src/System/IO/Compression/ZstandardCompressionOptions.cs)
- [Referência da classe ZstandardCompressionOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardcompressionoptions?view=net-11.0)
- [Support zstd Content-Encoding (dotnet/aspnetcore issue 50643)](https://github.com/dotnet/aspnetcore/issues/50643)
- [RFC 8878: Zstandard Compression and the application/zstd Media Type](https://datatracker.ietf.org/doc/html/rfc8878)
- [Implementação de referência do Zstandard](https://github.com/facebook/zstd)
