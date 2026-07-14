---
title: "Como adicionar compressão de respostas a uma API do ASP.NET Core 11"
description: "Um guia completo da compressão de respostas no ASP.NET Core 11: AddResponseCompression e UseResponseCompression, o novo provedor Zstandard integrado ao lado de Brotli e Gzip, níveis de compressão, EnableForHttps e o risco de CRIME/BREACH, tipos MIME personalizados, a ordem do middleware e quando deixar o proxy reverso fazer isso."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
lang: "pt-br"
translationOf: "2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api"
translatedBy: "claude"
translationDate: 2026-07-14
---

Para adicionar compressão de respostas a uma API do ASP.NET Core 11 você precisa de exatamente duas linhas: registre o middleware com `builder.Services.AddResponseCompression()` e adicione-o ao pipeline com `app.UseResponseCompression()`. Isso te dá Brotli, Gzip e (novo no .NET 11) Zstandard, negociados automaticamente a partir do cabeçalho `Accept-Encoding` do cliente. O porém é que ele não faz nada sobre HTTPS a menos que você habilite com `EnableForHttps = true`, e essa habilitação carrega um risco de segurança real que você precisa entender antes de ativá-la. Este artigo cobre o caminho completo: a configuração de duas linhas, a adição do Zstandard no .NET 11, os níveis de compressão, os tipos MIME, o problema com HTTPS e os casos em que você deveria deixar o proxy reverso fazer a compressão.

Tudo aqui tem como alvo o .NET 11 (Preview 5 no momento em que escrevo, com disponibilidade geral em novembro de 2026) com `Microsoft.NET.Sdk.Web` e C# 14. O middleware `Microsoft.AspNetCore.ResponseCompression` é estável desde o ASP.NET Core 2.1, então as partes de Brotli e Gzip funcionam sem alterações no .NET 8, 9 e 10. O provedor Zstandard é a única peça exclusiva do .NET 11 em diante.

## As duas partes móveis

A compressão de respostas vive no framework compartilhado, então não há nenhum pacote NuGet para instalar. Registre os serviços e adicione o middleware:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression();

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/data", () => Enumerable.Range(0, 1000)
    .Select(i => new { Id = i, Name = $"Item {i}", Note = "some repeated text" }));

app.Run();
```

Este é o procedimento completo, do início ao fim:

1. Chame `builder.Services.AddResponseCompression()` para registrar o middleware e seus provedores padrão (Brotli, Gzip e Zstandard no .NET 11).
2. Chame `app.UseResponseCompression()` cedo no pipeline, antes de qualquer middleware que escreva o corpo da resposta.
3. Se sua API é servida sobre HTTPS (quase sempre), defina `EnableForHttps = true` nas opções, depois de ler a seção de segurança mais abaixo.
4. Adicione quaisquer tipos MIME não padrão que você sirva (por exemplo `image/svg+xml`) a `ResponseCompressionOptions.MimeTypes`.
5. Ajuste o nível de compressão por provedor se o padrão (o mais rápido) não for o equilíbrio que você quer.
6. Verifique com um cliente que envie `Accept-Encoding` e inspecione os cabeçalhos de resposta `Content-Encoding` e `Vary`.

Esse é o recurso inteiro. O resto deste artigo trata de fazer cada passo corretamente em vez de apenas fazer compilar.

## O que muda no .NET 11: o Zstandard agora vem integrado

Se você já configurou compressão de respostas em uma versão mais antiga do .NET, a memória muscular diz "Brotli e Gzip". No .NET 11 essa lista cresceu. O Zstandard (token de codificação `zstd`, [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878)) agora é um provedor de compressão de primeira classe, integrado na pilha `System.IO.Compression` sem pacote NuGet, sem P/Invoke e sem binding de terceiros. Quando você chama `AddResponseCompression()` sem provedores explícitos, o ASP.NET Core 11 registra os três: `BrotliCompressionProvider`, `GzipCompressionProvider` e `ZstandardCompressionProvider`.

A ordem de negociação também mudou. No .NET 10 e anteriores, o middleware preferia o Brotli e depois recorria ao Gzip. No .NET 11, a preferência é Zstandard primeiro, depois Brotli e depois Gzip. Então quando um navegador moderno envia `Accept-Encoding: gzip, deflate, br, zstd`, uma API do ASP.NET Core 11 agora responde com `Content-Encoding: zstd`. A razão para o reordenamento é que o Zstandard atinge um ponto melhor na curva de velocidade/taxa para respostas dinâmicas de API: no seu nível padrão ele comprime consideravelmente mais rápido que o Brotli a uma taxa equivalente, e descomprime mais rápido que Brotli e Gzip, o que importa quando o cliente é um dispositivo móvel ou outro serviço.

A consequência operacional importante: depois de atualizar para o .NET 11, sua API começará a emitir `zstd` para qualquer cliente que o anuncie, sem que você mude uma única linha. Isso é ótimo para navegadores e clientes HTTP modernos, mas se você tem um consumidor interno antigo que dizia suportar `zstd` e não consegue de fato decodificá-lo (raro, mas acontece com clientes feitos à mão), você verá corpos corrompidos. A correção não é desabilitar a compressão globalmente, mas restringir a lista de provedores, como mostra a próxima seção.

## Escolher provedores explicitamente

No momento em que você adiciona até mesmo um provedor à mão, os padrões automáticos se desligam. Esse é o tropeço mais comum: escrever `options.Providers.Add<BrotliCompressionProvider>()` e depois se perguntar por que o Gzip parou de funcionar. Quando você adiciona provedores explicitamente, apenas os que você lista ficam ativos.

Então, para manter os três e habilitar a compressão sobre HTTPS:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});
```

A ordem em que você adiciona os provedores é a ordem de preferência do servidor quando um cliente aceita mais de um. Coloque o Zstandard primeiro se quiser que ele seja preferido, e o Gzip por último como recurso universal. Se você quiser forçar apenas o Gzip (digamos, para combinar com a configuração de um CDN legado), adicione apenas o `GzipCompressionProvider` e nenhum outro, e o middleware nunca emitirá Brotli nem Zstandard.

## Níveis de compressão, e por que o padrão é "o mais rápido"

Cada provedor tem como padrão `CompressionLevel.Fastest`, não `Optimal`. Isso surpreende quem espera o menor corpo possível de fábrica. O padrão é deliberado: para uma resposta dinâmica computada por requisição, a CPU que você gasta comprimindo está no caminho crítico de cada resposta, então o framework favorece a latência em detrimento dos últimos pontos percentuais de tamanho. `Optimal` e `SmallestSize` podem custar várias vezes a CPU por uma redução de um único dígito percentual em um JSON já pequeno.

Você define o nível por provedor através da sua classe de opções:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Fastest;
});

builder.Services.Configure<GzipCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.SmallestSize;
});
```

O enum `CompressionLevel` tem quatro valores: `NoCompression`, `Fastest`, `Optimal` e `SmallestSize`. Para uma API interativa, deixe Zstandard e Brotli em `Fastest`. Reserve `Optimal` ou `SmallestSize` para respostas que você comprime uma vez e serve muitas, o que em uma API pura geralmente significa que é melhor cachear você mesmo os bytes comprimidos do que pagar compressão ótima em cada requisição. Se você também serve ativos estáticos, note que a compressão de arquivos estáticos é um assunto separado (em tempo de build ou no CDN), não algo que este middleware deva fazer em tempo de requisição.

O Zstandard tem seu próprio botão, mais granular. A qualidade dele vai de 1 a 22, com o padrão em torno do nível 3, e você a define através de `ZstandardCompressionProviderOptions`:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 6 // 1 to 22; higher = smaller output, slower
    };
});
```

Uma qualidade mais alta significa um corpo menor e mais CPU. O nível 6 é um passo razoável acima do padrão quando suas respostas são grandes e repetitivas (pense em endpoints de listas que retornam milhares de objetos parecidos) e você tem folga de CPU.

## O problema de segurança com HTTPS que você não pode pular

`EnableForHttps` é `false` por padrão, e esse padrão é uma decisão de segurança, não um descuido. Comprimir uma resposta cujo corpo mistura um segredo (um token de sessão, um token CSRF, um número de conta) com entrada influenciada por um atacante, sobre TLS, abre a porta para os ataques [CRIME](https://en.wikipedia.org/wiki/CRIME) e [BREACH](https://en.wikipedia.org/wiki/BREACH). Esses ataques de canal lateral inferem o segredo observando como o tamanho da resposta comprimida muda conforme o atacante varia a entrada que controla. A taxa de compressão vaza informação sobre o conteúdo, e sobre HTTPS o tamanho do corpo criptografado continua observável.

Para uma API JSON típica que não retorna segredos por usuário refletidos ao lado de valores de consulta controlados pelo atacante, habilitar a compressão sobre HTTPS é algo normal e razoável, e quase todo mundo faz. Mas você deveria tomar essa decisão de forma deliberada:

- Se suas respostas nunca incorporam um token secreto no corpo ao lado de entrada refletida do usuário, habilitar a compressão sobre HTTPS é de baixo risco.
- Se elas podem fazer isso (uma página HTML com um token antifalsificação, um endpoint que devolve um termo de busca ao lado de um identificador de sessão), mitigue antes de habilitar: use tokens antifalsificação (a mitigação padrão no ASP.NET Core), evite refletir entrada não confiável em respostas que carregam segredos e considere deixar a compressão desligada para esses endpoints específicos.

A flag `EnableForHttps` é global. Se você precisa de compressão para endpoints de dados públicos mas não para um sensível, a divisão mais limpa é executar os endpoints sensíveis sem compressão segmentando o pipeline, ou servi-los com um `Content-Type` que você deliberadamente deixa de fora da lista de MIME comprimíveis.

Mais uma sutileza: mesmo com `EnableForHttps = false`, você ainda pode ver um cabeçalho `Content-Encoding` em produção. IIS, IIS Express e Azure App Service podem aplicar Gzip na camada do servidor web independentemente do seu aplicativo. Se uma resposta comprimida que você não configurou aparecer, verifique o cabeçalho de resposta `Server` antes de assumir que o middleware está se comportando mal.

## Tipos MIME: o que realmente é comprimido

O middleware só comprime respostas cujo `Content-Type` corresponde à sua lista. Os padrões cobrem os payloads habituais de API e web: `application/json`, `application/javascript`, `application/xml`, `text/css`, `text/html`, `text/json`, `text/plain` e `text/xml`. Para uma API JSON você obtém compressão sem configurar nada, porque `application/json` está na lista.

Para comprimir algo fora dos padrões, adicione a `ResponseCompressionOptions.MimeTypes`. Curingas como `text/*` não são suportados, então liste cada tipo:

```csharp
// .NET 11, C# 14
using System.Linq;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
        new[] { "image/svg+xml", "application/manifest+json" });
});
```

Não adicione formatos já comprimidos como PNG, JPEG, WebP ou ZIP. Eles são comprimidos de forma nativa, e passá-los pelo Brotli ou Zstandard queima CPU para produzir um corpo do mesmo tamanho ou ligeiramente maior. O mesmo se aplica a respostas muito pequenas: abaixo de cerca de 150 a 1000 bytes a sobrecarga da compressão pode fazer a saída ficar maior que a entrada, então respostas minúsculas não valem a pena comprimir independentemente do tipo.

## Ordem: UseResponseCompression vai cedo

A ordem do middleware decide se a compressão funciona de fato. `app.UseResponseCompression()` deve rodar antes de qualquer middleware que escreva no corpo da resposta, porque a compressão funciona envolvendo o fluxo de resposta. Se outro middleware já começou a escrever, o invólucro de compressão nunca vê esses bytes. Na prática, coloque-o perto do topo do pipeline:

```csharp
// .NET 11, C# 14
var app = builder.Build();

app.UseResponseCompression();   // first, so it wraps everything below
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

Quando a compressão é aplicada, o middleware também faz a coisa certa com os cabeçalhos de cache automaticamente: remove `Content-Length` (o comprimento do corpo mudou), remove `Content-MD5` (o hash não é mais válido) e adiciona `Vary: Accept-Encoding` para que os caches armazenem separadamente as variantes comprimida e não comprimida. Você não gerencia isso à mão.

## Quando pular o middleware por completo

O middleware de compressão de respostas é a ferramenta certa quando você hospeda diretamente no Kestrel ou HTTP.sys sem nada na frente, porque nenhum desses servidores oferece compressão integrada. Mas se sua API está atrás de IIS, Nginx, Apache ou um CDN, o proxy reverso normalmente consegue comprimir mais rápido que o middleware gerenciado, e fazer isso em um único lugar é mais fácil de raciocinar. A própria recomendação da Microsoft é preferir a compressão baseada no servidor quando ela estiver disponível.

Duas armadilhas para observar quando há um proxy envolvido:

- O Nginx remove o cabeçalho `Accept-Encoding` quando faz proxy da requisição para cima, o que silenciosamente impede o middleware do ASP.NET Core de comprimir. Se você mantiver o middleware atrás do Nginx, ou configure o Nginx para preservar o cabeçalho ou deixe o Nginx fazer a compressão e descarte o middleware.
- A dupla compressão é trabalho desperdiçado e pode corromper respostas. Se o proxy já comprime, não rode também o middleware para os mesmos tipos de conteúdo. Escolha uma única camada.

Para uma minimal API servida diretamente do Kestrel em um contêiner sem proxy sidecar, o middleware é exatamente o certo e a configuração de duas linhas do início deste artigo é tudo de que você precisa. Para qualquer coisa por trás de um proxy ou CDN maduro, meça primeiro: você pode já estar obtendo uma compressão que não configurou.

## Provedores personalizados, em breve

Se você precisa de uma codificação que o framework não inclui, implemente `ICompressionProvider`. A propriedade `EncodingName` é o token que o middleware confronta com `Accept-Encoding`, e `CreateStream` retorna seu invólucro de compressão:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

public sealed class CustomCompressionProvider : ICompressionProvider
{
    public string EncodingName => "mycustomcompression";
    public bool SupportsFlush => true;

    public Stream CreateStream(Stream outputStream)
    {
        // Wrap outputStream in your compression stream here.
        return outputStream;
    }
}
```

Registre-o como qualquer outro provedor com `options.Providers.Add<CustomCompressionProvider>()`. Na prática, com o Zstandard agora integrado, a necessidade de provedores personalizados praticamente evaporou. Entre Zstandard, Brotli e Gzip, o .NET 11 cobre todas as codificações que um cliente HTTP real vai pedir, que é justamente o objetivo da mudança do .NET 11: a opção rápida e moderna agora está ativada por padrão e você não precisa mais sair do framework para obtê-la.

## Relacionados

- [Como transmitir um arquivo de um endpoint do ASP.NET Core sem bufferizar](/pt-br/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) explica por que o middleware de compressão e o streaming podem entrar em conflito.
- [Como adicionar cache de saída a uma minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) combina bem com a compressão para endpoints com muitas leituras.
- [Como organizar os endpoints de minimal API com MapGroup no ASP.NET Core 11](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) ajuda quando você quer compressão em alguns grupos de rotas mas não em outros.
- [Como retornar uma união Results tipada de um endpoint de minimal API no ASP.NET Core 11](/pt-br/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) cobre os tipos de resposta que passam por este middleware.
- [Como usar Native AOT com minimal APIs do ASP.NET Core](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) vale a leitura se você se importa com o custo de CPU da compressão nas inicializações a frio.

## Fontes

- [Response compression in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionOptions.EnableForHttps (API reference)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.responsecompression.responsecompressionoptions.enableforhttps)
- [CompressionLevel enum (API reference)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.compressionlevel)
- [RFC 8878: Zstandard Compression](https://datatracker.ietf.org/doc/html/rfc8878)
- [CRIME attack (Wikipedia)](https://en.wikipedia.org/wiki/CRIME) e [BREACH attack (Wikipedia)](https://en.wikipedia.org/wiki/BREACH)
