---
title: "Scalar vs Swagger UI para documentação OpenAPI no ASP.NET Core 11"
description: "O Scalar entrega 1,02 MiB de JavaScript comprimido com gzip e um construtor de requisições bem melhor. O Swagger UI entrega 514 KiB e renderiza OpenAPI 3.2, que é o que o .NET 11 agora emite por padrão. Payloads medidos, a lacuna do 3.2, roteamento por endpoints dos dois lados e os detalhes de autenticação que decidem."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "pt-br"
translationOf: "2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

Escolha o **Scalar** (`Scalar.AspNetCore` 2.16.20) para uma API nova no .NET 11 se quem lê a sua documentação está fora da empresa, porque o construtor de requisições, os exemplos de código em várias linguagens e a busca são realmente melhores do que qualquer coisa que o Swagger UI faça. Escolha o **Swagger UI** (`Swashbuckle.AspNetCore.SwaggerUI` 10.2.3, que empacota o swagger-ui 5.32.7) se você quer o payload menor, se depende do fluxo de redirecionamento OAuth2 que já configurou, ou se precisa de renderização confiável de OpenAPI 3.2 hoje, porque o .NET 11 emite 3.2 por padrão e o trabalho de 3.2 no Scalar ainda é uma issue aberta. Os dois são licenciados sob MIT, os dois são renderizadores puros sem qualquer influência sobre o seu documento OpenAPI, e a orientação da Microsoft é que nenhum deles deve ficar acessível em produção.

Tudo o que foi medido abaixo rodou no SDK do .NET 10.0.201 com as versões exatas de pacotes citadas, em 2026-08-15. A superfície de API é idêntica do .NET 8 ao .NET 11, porque os dois pacotes publicam assemblies `net8.0`, `net9.0` e `net10.0` e fazem uma referência de framework a `Microsoft.AspNetCore.App` em vez de fixar um runtime.

## A comparação que as pessoas acham que estão fazendo não é a que importa

Desde o .NET 9, o `dotnet new webapi` não inclui o Swashbuckle. O `Microsoft.AspNetCore.OpenApi` gera o documento e é compatível com trimming e Native AOT. Isso significa que a escolha à sua frente não é "Swashbuckle ou Scalar", e sim "qual bundle de JavaScript renderiza o documento que o seu framework já produz". Se você ainda usa o `SwaggerGen` do Swashbuckle para a geração, essa é uma decisão separada, coberta em [como expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

Essa distinção tem uma consequência prática. O metapacote `Swashbuckle.AspNetCore` traz junto `Swashbuckle.AspNetCore.Swagger`, `SwaggerGen` e `Microsoft.Extensions.ApiDescription.Server` ao lado da interface. Se você só quer a interface, referencie `Swashbuckle.AspNetCore.SwaggerUI` diretamente e nada mais vem junto.

```xml
<!-- .NET 11, C# 14: the UI only, no second document generator -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.2.3" />
</ItemGroup>
```

```xml
<!-- .NET 11, C# 14: the Scalar equivalent, one package, zero NuGet dependencies -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Scalar.AspNetCore" Version="2.16.20" />
</ItemGroup>
```

## A matriz

| | Scalar 2.16.20 | Swagger UI 5.32.7 (Swashbuckle 10.2.3) |
| --- | --- | --- |
| Bytes na rede no primeiro carregamento (gzip) | 1.071.277 | 526.322 |
| JavaScript interpretado após descompactar | 3.711 KB | 1.794 KB |
| Registro | `app.MapScalarApiReference()` | `app.UseSwaggerUI(...)` ou `app.MapSwaggerUI(...)` |
| Roteamento por endpoints | Sim, desde a 1.x | Sim, desde a 10.2.0 (maio de 2026) |
| OpenAPI 3.2 | O parser lida com ele, suporte completo em uma issue aberta | Suporte básico desde o swagger-ui 5.32.0 |
| Exemplos de código | Mais de 20 alvos (curl, fetch, axios, Python, Go, Java, PHP, Ruby e outros) | curl para a requisição que você acabou de enviar |
| Cache de assets | `Cache-Control: no-cache` mais ETag, fixo no código | ETag por padrão, `max-age` se você definir `CacheLifetime` |
| Credenciais persistidas | `persistAuth` grava no local storage | `PersistAuthorization` no objeto de configuração |
| Try It entre origens | `proxyUrl` opcional | fetch direto do navegador, CORS é problema seu |
| Temas | 12 temas embutidos, `customCss`, plugins | `InjectStylesheet`, `InjectJavascript`, o sistema de plugins do swagger-ui |
| Licença | MIT | MIT |

## Quanto cada um custa para o navegador, medido

Os dois pacotes embutem seus assets no assembly como streams gzip e entregam esses bytes direto para um cliente que anuncia `Accept-Encoding: gzip`. A integração do Scalar com o ASP.NET Core verifica `IsGzipAccepted()` e define `Content-Encoding` mais `Vary: Accept-Encoding` a partir do asset armazenado. O middleware da interface do Swashbuckle carrega a mesma maquinaria (`IsGZipAccepted`, um `GZipStream` em modo de descompressão para o cliente raro que recusar). Então os tamanhos dos recursos armazenados são os tamanhos de transferência, e você consegue lê-los dos pacotes sem executar nada:

```csharp
// .NET SDK 10.0.201, run as a file-based app: dotnet run res.cs <dll>
using System.Reflection;

var asm = Assembly.LoadFrom(args[0]);
foreach (var name in asm.GetManifestResourceNames())
{
    using var s = asm.GetManifestResourceStream(name);
    Console.WriteLine($"{s?.Length,10}  {name}");
}
```

O Scalar serve três assets, e só dois deles são código:

```text
   1070166  ScalarStaticAssets.scalar.js
      1111  ScalarStaticAssets.scalar.aspnetcore.js
       533  ScalarStaticAssets.favicon.svg
```

O `index.html` do Swashbuckle puxa o bundle, o preset standalone, a folha de estilos e o próprio inicializador:

```text
    421507  swagger-ui-bundle.js
     77731  swagger-ui-standalone-preset.js
     26499  swagger-ui.css
       433  index.js
       152  index.css
       739  index.html
```

São 1.071.277 bytes para o Scalar contra 526.322 bytes para o Swagger UI, uma diferença de 2,0x na rede. Descompactado, o `scalar.js` são 3.708.228 bytes de JavaScript que o navegador precisa interpretar, contra 1.793.552 bytes do bundle mais o preset do Swagger UI. A opção de aparência moderna é a pesada, o oposto do que a maioria dos textos sugere.

Duas ressalvas antes de dar peso demais a isso. Primeiro, é uma ferramenta de desenvolvimento: os bytes chegam à sua máquina, por loopback, uma vez por carregamento frio. Segundo, o `swagger-ui.js` do Swashbuckle (92.466 bytes) fica no pacote sem ser usado pela página padrão, então o número acima é o que realmente carrega, não o que é distribuído. Se você servir qualquer uma das interfaces por uma rede de verdade, a [comparação de compressão de respostas](/pt-br/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) não ajuda aqui: os dois pacotes já comprimiram esses assets por conta própria, e recomprimir uma resposta com `Content-Encoding: gzip` não é algo que o middleware vá fazer.

O cache é a parte que incomoda no dia a dia. O `SwaggerUIOptions.CacheLifetime` documenta seu padrão como "0 days (ETags are used to check if resources have been updated)", então de fábrica as duas interfaces revalidam. A diferença é que o Swashbuckle permite optar por cache de verdade e o Scalar não: o handler de assets estáticos dele fixa `Cache-Control: no-cache` no código e responde a um `If-None-Match` compatível com um 304. Você paga uma ida e volta por asset por carregamento de página, para sempre.

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.CacheLifetime = TimeSpan.FromDays(7); // 304s become cache hits
});
```

## A pegadinha do .NET 11: o seu documento agora é 3.2

Este é o fato que deveria guiar a decisão em agosto de 2026, e quase ninguém escreveu sobre ele. O Microsoft Learn é explícito: "Starting in .NET 11, the default OpenAPI version for generated documents is 3.2. In .NET 10, the default is 3.1." Atualize uma API do .NET 10 para o .NET 11, sem mudar mais nada, e o documento que a sua interface precisa renderizar muda de versão de especificação.

Do lado do Swagger UI, o swagger-ui 5.32.0 (27 de fevereiro de 2026) trouxe "basic OpenAPI 3.2.0 support", e o Swashbuckle 10.2.3 empacota o 5.32.7, então o renderizador pelo menos sabe o que está olhando. Do lado do Scalar, o `@scalar/openapi-parser` entende 3.2, mas a issue de acompanhamento [scalar/scalar#6715](https://github.com/scalar/scalar/issues/6715) continua aberta, com "set OpenAPI 3.2 as the default version" e a renderização de tags profundamente aninhadas na barra lateral listados como trabalho pendente na última atualização, em 30 de junho de 2026.

Na prática um documento gerado a partir de endpoints de minimal API muda muito pouco entre 3.1 e 3.2, então a maioria das aplicações não verá diferença alguma. Se você vir uma barra lateral agrupando errado ou um schema renderizado vazio, fixe a versão em vez de abrir um bug contra a interface:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    // .NET 11 defaults to OpenApi3_2; pin 3.1 while a renderer catches up
    options.OpenApiVersion = Microsoft.OpenApi.OpenApiSpecVersion.OpenApi3_1;
});
```

O mesmo controle existe para a geração em tempo de compilação pela propriedade MSBuild `OpenApiGenerateDocumentsOptions` com `--openapi-version OpenApi3_1`. Fixar não custa nada hoje: nada em um documento gerado pelo ASP.NET Core depende de recursos do 3.2 ainda.

## Middleware ou endpoint, agora dos dois lados

O argumento arquitetural mais forte a favor do Scalar costumava ser que `MapScalarApiReference` registra um endpoint enquanto `UseSwaggerUI` registra middleware, e middleware encerra a requisição antes que o roteamento por endpoints tenha voz. Esse argumento venceu em maio de 2026. O Swashbuckle 10.2.0 adicionou `MapSwaggerUI` e `MapReDoc` "to support endpoint routing". As duas interfaces agora podem carregar metadados de endpoint, aparecer no `EndpointDataSource` e receber convenções de roteamento diretamente:

```csharp
// Program.cs -- .NET 11, C# 14
// Scalar: MapScalarApiReference returns an IEndpointConventionBuilder
app.MapScalarApiReference()
   .RequireAuthorization("ApiDocsPolicy");

// Swashbuckle 10.2.0+: same shape
app.MapSwaggerUI()
   .RequireAuthorization("ApiDocsPolicy");
```

Se você está atrás de um proxy reverso, note que o endpoint HTML do Scalar redireciona uma requisição para `/scalar` até `/scalar/` com um 301 para que os caminhos relativos dos assets resolvam, e o middleware do Swashbuckle faz um 301 de uma requisição ao prefixo de rota puro até o `index.html`. Um teste de integração que espera 200 no caminho puro falha contra qualquer um dos dois.

## Authorize, e o que acontece depois do clique

As duas interfaces leem os esquemas de segurança do documento, e nenhuma delas os inventa. A própria documentação do Scalar é direta: o seu documento OpenAPI já precisa incluir os esquemas para o Scalar trabalhar com eles. Se você não os colocou lá, o [passo a passo dos transformadores de operação e schema](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) é o mecanismo de que você precisa.

O que difere é a ergonomia dali em diante. O Scalar preenche as credenciais a partir da configuração no servidor e consegue mantê-las entre recarregamentos:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.20
app.MapScalarApiReference(options =>
{
    options.AddPreferredSecuritySchemes("Bearer")
           .AddHttpAuthentication("Bearer", auth => auth.WithToken(devToken));
    options.PersistentAuthentication = true;
});
```

O equivalente do Swagger UI vive no objeto de configuração e, para OAuth2, na página `oauth2-redirect.html` que o Swashbuckle embute para você (664 bytes de script de redirecionamento que estão em uso há uma década):

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.OAuthClientId("dev-client");
    options.OAuthUsePkce();
    options.EnablePersistAuthorization();
});
```

A única capacidade que o Scalar tem e o Swagger UI não é o `proxyUrl`. O Try It do Swagger UI dispara um `fetch` a partir da origem da documentação, então uma API em outra origem sem CORS permissivo produz um erro de navegador que parece falha do servidor. O Scalar consegue rotear a requisição por um proxy. Se a sua documentação é hospedada separada da API, essa única opção decide.

## Os exemplos de código são a diferença real de produto

O Swagger UI mostra o comando curl da requisição que você acabou de executar. O Scalar renderiza a requisição em todo cliente que conhece antes de você enviar qualquer coisa: shell (curl, httpie), JavaScript (fetch, axios, jquery), Node, Python, Go, Java, Ruby, PHP e outros, controlados por `hiddenClients` e `defaultHttpClient`. Para uma API interna em que quem lê são as mesmas pessoas que escreveram, isso é decoração. Para uma API pública em que quem lê está decidindo se o seu produto é fácil de integrar, é a página inteira.

O Scalar também dá `searchHotKey` (CMD/CTRL+K por padrão), doze temas embutidos, `customCss` e um hook `/scalar/config.js` para configuração arbitrária do cliente. A personalização do Swagger UI passa por `InjectStylesheet`, `InjectJavascript` e o sistema de plugins do swagger-ui, que é mais poderoso e bem menos agradável, e esse é o resumo honesto da comparação inteira.

## Quando escolher cada um

Escolha o Scalar quando a documentação for uma superfície de produto, quando quem lê estiver fora do seu time, quando você quiser o construtor de requisições e os exemplos de código, ou quando a documentação for hospedada em uma origem diferente da API e você precisar do proxy.

Escolha o Swagger UI quando quiser o menor payload e cache real com `max-age`, quando tiver uma configuração OAuth2 existente que já funciona, quando alguém do time depender de um plugin do swagger-ui, ou quando quiser o renderizador com suporte explícito ao 3.2 enquanto o .NET 11 emite 3.2 por padrão.

Não escolha nenhum, e use o `Swashbuckle.AspNetCore.ReDoc` ou uma extensão do editor, quando o documento for consumido por clientes gerados em vez de pessoas. Não existe regra dizendo que uma API precisa de uma referência renderizada.

Seja qual for a escolha, o Microsoft Learn é claro sobre a postura de segurança: interfaces de usuário de OpenAPI só devem ser habilitadas em ambientes de desenvolvimento. Os dois pacotes transformam isso em uma guarda de ambiente de uma linha, e a versão passo a passo dessa configuração, incluindo o bloqueio em produção e os assets offline, está no [passo a passo do Scalar](/pt-br/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/).

## As pegadinhas que decidem por você

- **O metapacote.** O `Swashbuckle.AspNetCore` 10.2.3 traz `SwaggerGen` e `Microsoft.Extensions.ApiDescription.Server`. Se você migrou para o gerador embutido, agora tem dois geradores e um deles está desatualizado. Referencie `Swashbuckle.AspNetCore.SwaggerUI` sozinho. O caminho completo de remoção está em [migrar do Swashbuckle para o gerador OpenAPI embutido](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/).
- **Nenhum dos pacotes tem alvo `net11.0`.** Os dois publicam assemblies `net8.0`, `net9.0` e `net10.0` com referência de framework. O asset `net10.0` roda no .NET 11 por roll-forward, o que funciona, mas significa que uma correção específica para `net11.0` em qualquer um dos projetos não é algo que você possa esperar.
- **Os assets do Scalar nunca são cacheados.** `Cache-Control: no-cache` não é configurável pelas opções. Em um link lento até um ambiente de desenvolvimento compartilhado, você paga uma revalidação por asset por carregamento.
- **A barra final.** As duas interfaces fazem 301 do caminho puro. Proxies rígidos e testes de integração percebem.
- **O header de versão do Swagger UI.** O Swashbuckle acrescenta `x-swagger-ui-version` às respostas de assets, o que é útil para confirmar o que realmente foi distribuído e o que alguns scanners vão sinalizar como divulgação de informação. Mais um motivo para a guarda de ambiente.

Entre dois renderizadores licenciados sob MIT do mesmo documento, esta é uma decisão reversível: trocar uma linha do `Program.cs` e uma referência de pacote leva você para qualquer direção em uns cinco minutos. Escolha pelo leitor, não pelo framework.

## Relacionado

- [Como servir documentação OpenAPI com Scalar em vez do Swagger UI no ASP.NET Core 11](/pt-br/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) é a configuração completa: roteamento, múltiplos documentos, autenticação e bloqueio em produção.
- [Como expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) cobre a metade geradora dessa divisão.
- [Migrar do Swashbuckle para a geração de documentos OpenAPI embutida no .NET 11](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) é o checklist de remoção.
- [Como personalizar o documento OpenAPI com AddOperationTransformer e AddSchemaTransformer](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) é como os esquemas de segurança chegam ao documento em primeiro lugar.
- [Zstandard vs Brotli vs Gzip na compressão de respostas no .NET 11](/pt-br/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) explica por que assets estáticos pré-comprimidos passam por fora do middleware de compressão.

## Fontes

- [Use the generated OpenAPI documents (Microsoft Learn, ASP.NET Core 11)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-11.0)
- [Generate OpenAPI documents, default version 3.2 in .NET 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-11.0)
- [OpenApiSpecVersion enum, including OpenApi3_2 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.openapi.openapispecversion)
- [Swashbuckle.AspNetCore v10.2.0 release notes, MapSwaggerUI and MapReDoc](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.2.0)
- [Swashbuckle.AspNetCore.SwaggerUI 10.2.3 on NuGet](https://www.nuget.org/packages/Swashbuckle.AspNetCore.SwaggerUI/10.2.3)
- [swagger-ui v5.32.0 release, basic OpenAPI 3.2.0 support](https://github.com/swagger-api/swagger-ui/releases/tag/v5.32.0)
- [Scalar.AspNetCore 2.16.20 on NuGet](https://www.nuget.org/packages/Scalar.AspNetCore/2.16.20)
- [Scalar .NET integration documentation](https://scalar.com/scalar/scalar-api-references/net-integration)
- [Scalar API reference configuration options](https://scalar.com/scalar/scalar-api-references/configuration)
- [OpenAPI 3.2 support tracking issue (scalar/scalar#6715)](https://github.com/scalar/scalar/issues/6715)
