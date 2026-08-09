---
title: "Como servir documentação OpenAPI com Scalar em vez do Swagger UI no ASP.NET Core 11"
description: "Substitua UseSwaggerUI por MapScalarApiReference no ASP.NET Core 11: roteamento, múltiplos documentos, autenticação pré-preenchida, controle em produção, recursos sem CDN e as extensões OpenAPI exclusivas do Scalar."
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "pt-br"
translationOf: "2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-09
---

Para trocar o Swagger UI pelo Scalar em uma API ASP.NET Core 11, instale `Scalar.AspNetCore`, apague a chamada `app.UseSwaggerUI(...)` e adicione `app.MapScalarApiReference()` ao lado do seu `app.MapOpenApi()` existente. A interface passa a viver em `/scalar` e lê o documento em `/openapi/v1.json`, que é exatamente o que o `MapOpenApi` já serve. Esse é o caso de noventa por cento. Os outros dez por cento são tudo o que vem abaixo: um documento em uma rota que não é a padrão, mais de um documento, um botão Authorize que realmente anexa um token e manter tudo isso fora do seu hostname de produção.

Tudo aqui tem como alvo o .NET 11 (testado com o Preview 6, SDK `11.0.100-preview.6.26359.118`) com `Microsoft.NET.Sdk.Web` e C# 14, usando `Scalar.AspNetCore` 2.16.18, publicado em 2026-08-07. A superfície de API abaixo é idêntica no .NET 8, 9 e 10, porque o pacote tem como alvo `net8.0` e superiores.

## Os seis passos, do começo ao fim

1. Instale `Scalar.AspNetCore` com `dotnet add package Scalar.AspNetCore` e adicione `using Scalar.AspNetCore;` ao `Program.cs`.
2. Remova a chamada de middleware `app.UseSwaggerUI(...)` e remova a referência ao pacote `Swashbuckle.AspNetCore.SwaggerUI` se mais nada o usar.
3. Chame `app.MapScalarApiReference()` dentro da mesma guarda de ambiente que já envolve o `app.MapOpenApi()`.
4. Aponte o Scalar para o documento certo com `WithOpenApiRoutePattern` ou `AddDocument` se o seu JSON de OpenAPI não estiver em `/openapi/{documentName}.json`.
5. Pré-preencha credenciais com `AddPreferredSecuritySchemes` e `AddHttpAuthentication` para que o botão Authorize envie um token real em desenvolvimento.
6. Decida a estratégia de produção: ou deixe o endpoint totalmente fora de produção, ou mapeie-o e encadeie `RequireAuthorization()` no construtor de endpoints retornado.

## O que realmente muda quando o Swagger UI sai de cena

A diferença mais importante não é visual. `UseSwaggerUI` registra middleware. `MapScalarApiReference` registra um endpoint. Essa única mudança tira a interface do pipeline e a coloca na tabela de roteamento, e todo o resto decorre disso.

Middleware roda na ordem de registro e encerra a requisição antes que o roteamento de endpoints tenha voz, e é por isso que o Swagger UI historicamente ignorava suas políticas de autorização a menos que você construísse um middleware personalizado em volta dele. Um endpoint participa do roteamento como qualquer outro, então carrega metadados, aparece no `EndpointDataSource` e as convenções que você já conhece se aplicam a ele diretamente.

```csharp
// Program.cs -- .NET 11, C# 14
// Before: Swashbuckle's UI middleware over the built-in OpenAPI document
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options => options.SwaggerEndpoint("/openapi/v1.json", "v1"));
}
```

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
// After: an endpoint, not middleware
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Repare no que falta no segundo bloco: não há equivalente do `SwaggerEndpoint`. O Scalar usa como rota padrão do documento `/openapi/{documentName}.json`, que é justamente a rota que o `MapOpenApi` registra, então as duas se alinham sem configuração. Se você já trocou o gerador do Swashbuckle pelo embutido, este é o último pacote do Swashbuckle que ainda restava. O lado do gerador dessa troca está coberto em [expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

Há um detalhe de comportamento que vale conhecer antes de abrir um bug. Acessar `/scalar` emite um redirecionamento para `/scalar/` para que os caminhos dos recursos do lado do cliente resolvam corretamente. Se você tem uma política de redirecionamento rígida, um proxy que reescreve barras finais ou um teste de integração afirmando um 200 em `/scalar`, esse 301 é o que você está vendo.

## Apontar o Scalar para um documento que não está na rota padrão

`MapOpenApi` aceita um padrão de rota, e muitos códigos o mudaram anos atrás para agradar geradores de cliente antigos. Se o seu documento está em `/swagger/v1/swagger.json`, ou se o .NET 10 adicionou uma variante YAML que você prefere servir, diga ao Scalar onde procurar:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapOpenApi("/swagger/{documentName}/swagger.json");

app.MapScalarApiReference(options =>
{
    options
        .WithTitle("Orders API")
        .WithOpenApiRoutePattern("/swagger/{documentName}/swagger.json");
});
```

`WithOpenApiRoutePattern` também aceita uma URL absoluta, que é como você aponta um host de documentação para uma especificação gerada por outro serviço. A rota pode igualmente ser o caminho de um arquivo produzido em tempo de build pelo `Microsoft.Extensions.ApiDescription.Server` e servido como arquivo estático, se você preferir não rodar o gerador em runtime.

A rota da própria interface é o primeiro argumento de `MapScalarApiReference`. Há seis sobrecargas: com ou sem prefixo de rota, com ou sem delegate de opções, e com ou sem um `HttpContext` nesse delegate.

```csharp
// Program.cs -- .NET 11, C# 14
// Mount the reference at /api-docs and vary options per request
app.MapScalarApiReference("/api-docs", (options, httpContext) =>
{
    options.WithTitle($"Orders API ({httpContext.Request.Host})");
});
```

A sobrecarga com `HttpContext` importa mais do que parece. É a forma suportada de calcular opções a partir da requisição recebida: escolher um tema a partir de um cookie, selecionar uma lista de servidores com base no cabeçalho host, ou esconder documentos que o chamador não tem direito de ver.

Se você vem de um código com Scalar 1.x, note que `ScalarOptions.EndpointPathPrefix` está obsoleto. O prefixo de rota migrou para aquele primeiro parâmetro, e o padrão mudou de `/scalar/{documentName}` para simplesmente `/scalar`. As velhas gambiarras de sub-caminho, em que você reescrevia manualmente o `OpenApiRoutePattern` para aplicações hospedadas sob um path base, não são mais necessárias e devem ser apagadas, porque a resolução relativa agora é tratada para você.

## Múltiplos documentos e versões de API em uma única barra lateral

O Swagger UI expressava isso com chamadas repetidas a `SwaggerEndpoint` e um menu suspenso. O Scalar expressa isso como documentos registrados:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi("v1");
builder.Services.AddOpenApi("v2");

// ...

app.MapOpenApi();
app.MapScalarApiReference(options =>
{
    options
        .AddDocument("v1", "Orders API v1")
        .AddDocument("v2", "Orders API v2 (beta)", isDefault: true);
});
```

Cada sobrecarga de `AddDocument` aceita um nome, um título de exibição opcional e um padrão de rota opcional, então documentos que vivem em caminhos diferentes coexistem em uma única referência. `AddDocuments(["v1", "v2", "v3"])` é a forma curta quando os nomes bastam. Se você gera um documento por versão de API com `Asp.Versioning`, é aqui que esses nomes aterrissam; o encanamento específico do versionamento está em [versionamento de API com OpenAPI no .NET](/pt-br/2026/04/api-versioning-openapi-dotnet-10/).

Nomes de documento são repassados ao gerador exatamente como você os escreve, incluindo maiúsculas e minúsculas. Um documento registrado como `V1` e requisitado como `v1` produz uma referência vazia em vez de um erro, porque a busca pelo documento simplesmente retorna 404 e a interface não tem nada para renderizar. Mantenha todo nome de documento em minúsculas e isso nunca aparece.

## Fazer o botão Authorize enviar um token de verdade

Esta é a parte que mais gera confusão, e a regra é simples: o Scalar pré-preenche apenas os esquemas de segurança que o seu documento OpenAPI já declara. Ele não lê o seu middleware de autenticação e não pode inventar um esquema que o documento não descreve. Se o documento não tem uma entrada `securitySchemes`, nenhuma configuração de cliente vai anexar um cabeçalho `Authorization`. Escrevi sobre exatamente essa falha em detalhe em [por que o seu token Bearer é ignorado no Scalar](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/), e o diagnóstico não mudou.

Supondo que o documento declare um esquema HTTP bearer chamado `BearerAuth`, isto o pré-seleciona e pré-preenche um token de desenvolvimento:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("BearerAuth")
        .AddHttpAuthentication("BearerAuth", auth =>
        {
            auth.Token = builder.Configuration["Scalar:DevToken"]!;
        });
});
```

Os fluxos OAuth2 ganham helpers de primeira classe em vez da configuração plana chave-valor que o Swagger UI usava. `AddAuthorizationCodeFlow`, `AddClientCredentialsFlow`, `AddPasswordFlow` e `AddImplicitFlow` recebem cada um um delegate de configuração, e o PKCE é uma propriedade e não uma caixa de seleção que você torce para a interface respeitar:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("OAuth2")
        .AddAuthorizationCodeFlow("OAuth2", flow =>
        {
            flow.ClientId = builder.Configuration["Scalar:ClientId"]!;
            flow.Pkce = Pkce.Sha256;
            flow.SelectedScopes = ["orders.read", "orders.write"];
        });
});
```

Duas coisas para guardar. Primeiro, qualquer valor que você passe aqui é serializado dentro da página que o navegador baixa, então um client secret configurado assim é público. A própria documentação do Scalar diz que dados de autenticação pré-preenchidos nunca devem ser usados em produção, e isso não é cautela de praxe: trate esses valores como se você os tivesse colado em um arquivo HTML público, porque foi o que você fez. Segundo, `EnablePersistentAuthentication()` guarda o que o usuário digita no armazenamento do navegador entre recarregamentos, o que é genuinamente conveniente em um notebook e genuinamente errado em uma máquina compartilhada.

Se você está montando o lado do servidor disso ao mesmo tempo, [autenticação JWT bearer em uma minimal API](/pt-br/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) cobre a metade da validação do token, e a declaração do esquema em si é um transformador de documento, descrito em [personalizar o OpenAPI com transformadores de operação e de schema](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Manter a referência fora de produção sem perdê-la

A orientação da Microsoft é explícita: interfaces de usuário de OpenAPI, Scalar incluído, pertencem apenas a ambientes de desenvolvimento. A guarda padrão do template cuida disso:

```csharp
// Program.cs -- .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Times que querem a referência em um host interno de staging têm uma opção melhor que uma checagem de ambiente, e ela existe justamente porque o Scalar é um endpoint. `MapScalarApiReference` retorna um `IEndpointConventionBuilder`, então todas as convenções de roteamento se aplicam:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference()
   .RequireAuthorization("InternalOnly")
   .ExcludeFromDescription();

app.MapOpenApi()
   .RequireAuthorization("InternalOnly");
```

Proteja os dois. Proteger a interface e deixar `/openapi/v1.json` anônimo não protege nada: o documento é a divulgação de informação, e a interface é apenas um renderizador dele. `ExcludeFromDescription()` evita que o endpoint de documentação apareça dentro da documentação, o que é caprichado mais do que importante.

## Recursos, hospedagem offline e as fontes que ligam para casa

O Scalar empacota seu JavaScript e CSS dentro do pacote NuGet e os serve a partir da sua própria origem, então um ambiente isolado ou offline funciona sem configuração alguma. Isso não era verdade nas primeiras versões 1.x, de onde vem a crença persistente de que o Scalar exige uma CDN.

A única requisição externa restante é a fonte web padrão. Elimine-a com uma chamada:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options.DisableDefaultFonts();
});
```

`WithBundleUrl("https://cdn.jsdelivr.net/npm/@scalar/api-reference")` vai na direção oposta, puxando o bundle de uma CDN se você preferir acompanhar a interface mais nova sem atualizar o pacote. Se você aplica uma Content Security Policy rígida, `DisableDefaultFonts` mais os recursos empacotados significam que a referência não precisa de nada além de `'self'` e do script de configuração inline.

As opções também podem ser vinculadas a partir da configuração em vez do código, que é a forma mais limpa de manter ajustes específicos de ambiente fora do `Program.cs`:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOptions<ScalarOptions>().BindConfiguration("Scalar");
```

Qualquer coisa definida no delegate de `MapScalarApiReference` sobrescreve os valores vinculados.

## Metadados exclusivos do Scalar: estabilidade, endpoints ocultos e exemplos de código

Os recursos sem equivalente no Swagger UI vivem em um pacote complementar, `Scalar.AspNetCore.Microsoft` (2.16.18, com alvo `net9.0` e `net10.0`, dependendo de `Microsoft.AspNetCore.OpenApi` e de `Microsoft.OpenApi` 2.7.5 ou superior). Ele registra transformadores de documento que escrevem as extensões de fornecedor do Scalar dentro do documento gerado. Se você ainda usa o gerador do Swashbuckle, `Scalar.AspNetCore.Swashbuckle` faz o mesmo trabalho por meio de filtros.

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore.Microsoft 2.16.18
builder.Services.AddOpenApi(options => options.AddScalarTransformers());

// ...

app.MapGet("/orders", GetOrders).Stable();
app.MapGet("/orders/forecast", GetForecast).Experimental();
app.MapGet("/internal/metrics", GetMetrics).ExcludeFromApiReference();
```

`ExcludeFromApiReference()` merece destaque. Ele esconde a operação na referência renderizada mas a mantém no documento OpenAPI e totalmente roteável, o que é diferente de `ExcludeFromDescription()`, que a remove do documento por completo. Escolha com base em se os seus geradores de cliente ainda precisam enxergar o endpoint. `CodeSample()` anexa um trecho escrito à mão para um dado `ScalarTarget`, e `WithBadge()` coloca um rótulo colorido ao lado de uma operação; ambos existem como atributos em actions de controller se você não usa minimal APIs.

## Armadilhas que custam uma tarde

**O pacote não tem um target framework `net11.0`.** A partir da 2.16.18 a lista de TFM para em `net10.0`, e um projeto `net11.0` consome os recursos de `net10.0` pelas regras normais de compatibilidade. Isso é normal e esperado durante a janela de preview, mas se o seu build falha por uma política interna que exige correspondência exata de TFM, é essa a razão.

**Uma referência em branco quase sempre significa documento ausente, não interface quebrada.** Abra `/openapi/v1.json` diretamente. Se retornar 404, o `MapOpenApi` não está mapeado, está atrás de uma guarda de ambiente diferente da interface, ou está em uma rota que você nunca informou ao Scalar. A referência renderiza uma casca vazia em vez de um erro em todos esses casos.

**A geração de documento em tempo de build não alimenta a interface.** Definir `OpenApiGenerateDocuments` no seu `.csproj` escreve um arquivo JSON durante o build; não serve um em runtime. Se você remover o `MapOpenApi` porque agora gera em tempo de build, sirva o arquivo gerado como arquivo estático e aponte o `WithOpenApiRoutePattern` para ele.

**`launchUrl` ainda diz `swagger`.** Depois de apagar o middleware do Swagger UI, o `Properties/launchSettings.json` vai continuar abrindo um 404 a cada `dotnet run` até você trocar `"launchUrl": "swagger"` por `"launchUrl": "scalar"`.

**Native AOT não muda nada aqui.** O gerador embutido é compatível com AOT e o Scalar serve recursos estáticos, então a dupla sobrevive intacta ao `PublishAot`. O que costuma quebrar sob AOT é algum transformador baseado em reflexão que você escreveu, não a interface de referência.

O Swagger UI não está obsoleto e `Swashbuckle.AspNetCore.SwaggerUI` continua funcionando perfeitamente sobre um documento produzido pelo `Microsoft.AspNetCore.OpenApi`. A razão para migrar é que o Scalar é um endpoint em vez de middleware, entrega seus recursos dentro do pacote e pré-preenche a autenticação por meio de uma API tipada em vez de um saco de strings. Se nada disso importa para você, ficar onde está é uma resposta defensável.

## Relacionados

- [Como expor OpenAPI sem Swashbuckle no ASP.NET Core 11](/pt-br/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Scalar no ASP.NET Core: por que o seu token Bearer é ignorado](/pt-br/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Migrar do Swashbuckle para o gerador de OpenAPI embutido no .NET 11](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Como personalizar o documento OpenAPI com transformadores de operação e de schema](/pt-br/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Como adicionar fluxos de autenticação OpenAPI ao Swagger UI no .NET 11](/pt-br/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)

## Fontes

- [Usar os documentos OpenAPI gerados](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0) no Microsoft Learn
- [Documentação da integração do Scalar com ASP.NET Core](https://scalar.com/products/api-references/integrations/aspnetcore/integration)
- [Extensões OpenAPI do Scalar para .NET](https://scalar.com/products/api-references/integrations/aspnetcore/openapi-extensions)
- [Guia de migração para o Scalar.AspNetCore 2.0.0](https://github.com/scalar/scalar/issues/4362)
- [Scalar.AspNetCore no NuGet](https://www.nuget.org/packages/Scalar.AspNetCore)
