---
title: "Correção: não é possível gerar OpenAPI 3.0 após atualizar o Swashbuckle.AspNetCore para a v9"
description: "Swashbuckle 8 e versões posteriores emitem openapi 3.0.4, não 3.0.1, e não existe um OpenApiSpecVersion para versões de patch. Por que mudou e quatro formas de fixar a string que sua ferramenta espera."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore"
translatedBy: "claude"
translationDate: 2026-08-19
---

Você atualizou o `Swashbuckle.AspNetCore` para 9.x, seu código continua dizendo `OpenApiSpecVersion.OpenApi3_0`, e o documento gerado agora traz `"openapi": "3.0.4"` em vez de `"openapi": "3.0.1"`. As ferramentas que consomem o documento o rejeitam, e não existe um membro `OpenApi3_0_1` no enum para selecionar. A string de versão é um literal fixo dentro do `Microsoft.OpenApi`, não uma configuração do Swashbuckle: 1.6.22 e anteriores escrevem `3.0.1`, 1.6.23 e posteriores escrevem `3.0.4`. O Swashbuckle 8.0.0 foi a versão que assumiu a dependência da 1.6.23, então a mudança atinge qualquer um que cruze a fronteira do 7.x. As correções abaixo são, em ordem: atualizar o consumidor, reescrever a propriedade você mesmo em um middleware, ou fixar todo o stack do Swashbuckle em 7.2.0.

Tudo aqui foi medido no SDK do .NET 10.0.201 sobre `net10.0`, com Swashbuckle.AspNetCore 6.5.0, 7.2.0, 8.1.4, 9.0.6 e 10.2.3.

## Os erros em contexto

Pedindo a versão de patch diretamente à CLI:

```text
System.NotSupportedException: The specified OpenAPI version "3.0.1" is not supported.
   at Swashbuckle.AspNetCore.Cli.Program.<>c.<Main>b__1_5(IDictionary`2 namedArgs)
   at Swashbuckle.AspNetCore.Cli.CommandRunner.Run(IEnumerable`1 args)
   at Swashbuckle.AspNetCore.Cli.Program.Main(String[] args)
```

Tentando segurar o `Microsoft.OpenApi` mantendo o Swashbuckle 9:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.OpenApi from 1.6.25 to 1.6.22.
  Reference the package directly from the project to select a different version.
   MyApi -> Swashbuckle.AspNetCore 9.0.6 -> Swashbuckle.AspNetCore.Swagger 9.0.6 -> Microsoft.OpenApi (>= 1.6.25)
   MyApi -> Microsoft.OpenApi (>= 1.6.22)
```

E, se você silenciar o NU1605 e insistir:

```text
error CS1705: Assembly 'Swashbuckle.AspNetCore.SwaggerGen' with identity
'Swashbuckle.AspNetCore.SwaggerGen, Version=9.0.6.0, ...' uses 'Microsoft.OpenApi, Version=1.6.25.0, ...'
which has a higher version than referenced assembly 'Microsoft.OpenApi' with identity
'Microsoft.OpenApi, Version=1.6.22.0, ...'
```

Versões antigas do Swagger UI renderizam o documento assim:

```text
Unable to render this definition
The provided definition does not specify a valid version field.
Please indicate a valid Swagger or OpenAPI version field. Supported version fields are
swagger: "2.0" and those that match openapi: 3.x.y (for example, openapi: 3.1.0).
```

## Por que a string de versão é 3.0.4 e não algo que eu controle?

`OpenApiSpecVersion` é um enum pequeno, e nenhum de seus membros carrega um número de patch. No `Microsoft.OpenApi` 1.6.25, do qual o Swashbuckle 9.0.6 depende, ele tem exatamente dois membros:

```text
OpenApi2_0
OpenApi3_0
```

No `Microsoft.OpenApi` 2.7.5, do qual o Swashbuckle 10.2.3 depende, ganha mais um:

```text
OpenApi2_0
OpenApi3_0
OpenApi3_1
```

Não existe membro 3.0.1, 3.0.3 ou 3.0.4, porque a versão de patch não é uma opção do serializador. `OpenApiDocument.SerializeAsV3` escreve uma constante de tempo de compilação. Dá para ver a mudança com um dump de strings dos assemblies publicados:

```text
strings -a -e l on lib/netstandard2.0/Microsoft.OpenApi.dll:
  1.2.3   -> 3.0.1
  1.6.22  -> 3.0.1
  1.6.23  -> 3.0.4
  1.6.25  -> 3.0.4
  2.7.5   -> 3.0.4 and 3.1.1
```

A mudança chegou no [PR #2011 do OpenAPI.NET](https://github.com/microsoft/OpenAPI.NET/pull/2011), mesclado em 2024-12-20, que trouxe o comportamento da v2 para a linha v1. Não é um bug: OpenAPI 3.0.4 é um release de patch real da especificação, e emitir o patch mais recente é o padrão correto. O problema é que muitos consumidores validam o campo `openapi` contra uma lista fixa de valores permitidos em vez de um padrão `3.0.x`.

## Qual versão do Swashbuckle emite qual versão de patch?

O campo `openapi` acompanha o assembly do `Microsoft.OpenApi` que de fato é resolvido, não a versão do Swashbuckle que você escreveu no csproj:

| Swashbuckle.AspNetCore | Microsoft.OpenApi (declarado) | campo `openapi` |
| --- | --- | --- |
| 6.5.0 | 1.2.3 | `3.0.1` |
| 7.2.0 | 1.6.22 | `3.0.1` |
| 8.0.0 a 8.1.4 | 1.6.23 | `3.0.4` |
| 9.0.0 a 9.0.6 | 1.6.23 a 1.6.25 | `3.0.4` |
| 10.0.0 a 10.2.3 | 2.3.0 a 2.7.5 | `3.0.4`, ou `3.1.1` com `OpenApi3_1` |

Dois pontos. Primeiro, a fronteira real é a 8.0.0, não a 9.0.0: se você pulou da 7.x direto para a 9.x, cruzou sem perceber. Segundo, a dependência do NuGet é um piso, não uma fixação. Um projeto na 7.2.0 que também referencia algo que puxa o `Microsoft.OpenApi` 1.6.23 ou posterior resolve o assembly mais novo e passa a emitir `3.0.4` sem nenhuma mudança no Swashbuckle. Se seu documento mudou e sua versão do Swashbuckle não, execute isto antes de olhar em qualquer outro lugar:

```bash
dotnet list package --include-transitive
```

## Reprodução mínima em net10.0

```csharp
// .NET SDK 10.0.201, net10.0, Swashbuckle.AspNetCore 9.0.6
using Microsoft.OpenApi;
using Microsoft.OpenApi.Models;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(o =>
    o.SwaggerDoc("v1", new OpenApiInfo { Title = "Demo", Version = "v1" }));

var app = builder.Build();
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.MapGet("/orders/{id}", (int id) => new Order(id, "open", null)).WithName("GetOrder");
app.Run();

record Order(int Id, string Status, string? Note);
```

`GET /swagger/v1/swagger.json` retorna:

```json
{
  "openapi": "3.0.4",
  "info": { "title": "Demo", "version": "v1" },
  "paths": { }
}
```

Definir `OpenApiVersion` explicitamente não muda nada aqui, porque `OpenApi3_0` já é o padrão e o enum não oferece granularidade mais fina.

## Posso passar uma versão de patch para a CLI?

Não. O `dotnet swagger tofile` analisa `--openapiversion` contra um conjunto fechado de três strings. Do código-fonte da v10.2.3:

```csharp
// Swashbuckle.AspNetCore.Cli/Program.cs, v10.2.3
specVersion = versionArg switch
{
    "2.0" => OpenApiSpecVersion.OpenApi2_0,
    "3.0" => OpenApiSpecVersion.OpenApi3_0,
    "3.1" => OpenApiSpecVersion.OpenApi3_1,
    _ => throw new NotSupportedException($"The specified OpenAPI version \"{versionArg}\" is not supported."),
};
```

Na 9.0.6 o braço `"3.1"` também não existe, então `2.0` e `3.0` são suas únicas entradas. Saída medida para cada valor aceito na 10.2.3: `2.0` dá `"swagger": "2.0"`, `3.0` dá `"openapi": "3.0.4"`, `3.1` dá `"openapi": "3.1.1"`. Qualquer outra coisa, incluindo `3.0.1` e `3.1.1`, lança exceção.

Um detalhe sobre a CLI: a ferramenta 9.0.6 traz um apphost `net9.0`, então se recusa a iniciar numa máquina que só tem o runtime do .NET 10. Defina `DOTNET_ROLL_FORWARD=Major` antes de invocá-la, ou instale o runtime correspondente.

## Baixar o Microsoft.OpenApi para 1.6.22 funciona?

Não no Swashbuckle 9 nem no 10, e esse é o conselho que você mais vai encontrar em threads antigas. Adicionar uma referência direta primeiro dispara o NU1605, que o NuGet trata como erro por padrão. Se você suprimir com `<WarningsNotAsErrors>NU1605</WarningsNotAsErrors>`, o restore resolve a 1.6.22 e então a compilação falha com `CS1705`, porque o `Swashbuckle.AspNetCore.Swagger` 9.0.6 foi compilado contra a identidade de assembly 1.6.25. As duas falhas se reproduzem num projeto `net10.0` limpo.

O caminho de fixar versões só funciona se você voltar o stack inteiro:

```xml
<!-- net10.0, verified: emits "openapi": "3.0.1" -->
<ItemGroup>
  <PackageReference Include="Swashbuckle.AspNetCore" Version="7.2.0" />
  <PackageReference Include="Microsoft.OpenApi" Version="1.6.22" />
</ItemGroup>
```

O Swashbuckle 7.2.0 ainda tem como alvo o `netstandard2.0` e roda bem em `net10.0`, e resolve o `Microsoft.OpenApi` 1.6.22. A referência explícita ao `Microsoft.OpenApi` está ali para impedir que um bump transitivo empurre você para frente de novo. Trate isso como uma solução temporária com prazo, não como correção: você está congelando um gerador de OpenAPI duas versões maiores atrás, e a 8.x e a 9.x contêm correções de geração de schema que você vai acabar querendo.

## Como reescrevo a string de versão no Swashbuckle 9 ou 10?

Não há gancho. Os mantenedores do Swashbuckle já disseram isso na [issue #3540](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540): o `SwaggerMiddleware` serializa direto para o stream de resposta, sem nada no meio. A alternativa que eles sugerem, e que de fato se sustenta, é bufferizar a resposta e editar a propriedade. Funciona igual na 9.0.6 e na 10.2.3 porque nunca toca no modelo de objetos:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6 and 10.2.3, both verified
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/swagger")
        && ctx.Request.Path.Value!.EndsWith(".json"),
    branch => branch.Use(async (ctx, next) =>
    {
        var original = ctx.Response.Body;
        using var buffer = new MemoryStream();
        ctx.Response.Body = buffer;

        await next();

        ctx.Response.Body = original;
        if (ctx.Response.StatusCode != StatusCodes.Status200OK)
        {
            buffer.Position = 0;
            await buffer.CopyToAsync(original);
            return;
        }

        var json = Encoding.UTF8.GetString(buffer.ToArray())
            .Replace("\"openapi\": \"3.0.4\"", "\"openapi\": \"3.0.1\"", StringComparison.Ordinal);
        var bytes = Encoding.UTF8.GetBytes(json);
        ctx.Response.ContentLength = bytes.Length;
        await original.WriteAsync(bytes);
    }));

app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.UseSwaggerUI();
```

Registre antes do `UseSwagger`. O Swagger UI continua funcionando, `/swagger/index.html` ainda retorna 200, e o endpoint JSON retorna `3.0.1`. Dois detalhes importam: restaurar `ctx.Response.Body` para o stream original antes de escrever, e definir `ContentLength` depois da reescrita, já que a substituição muda a contagem de bytes. O filtro `.EndsWith(".json")` mantém o buffer longe dos arquivos estáticos da UI. Se você também serve YAML, adicione um ramo para ele, porque lá a propriedade é escrita como `openapi: '3.0.4'` e a substituição de JSON não vai casar.

Se preferir não bufferizar, substitua o endpoint por completo e serialize o documento você mesmo:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6
app.MapGet("/swagger/v1/swagger.json", (ISwaggerProvider provider) =>
{
    var document = provider.GetSwagger("v1");
    var node = JsonNode.Parse(document.SerializeAsJson(OpenApiSpecVersion.OpenApi3_0))!;
    node["openapi"] = "3.0.1";
    return Results.Text(
        node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
        "application/json");
}).ExcludeFromDescription();
```

`ExcludeFromDescription()` não é opcional. Sem ele o endpoint se descobre sozinho, e `/swagger/v1/swagger.json` aparece como um path documentado na própria saída. `SerializeAsJson` vive em `Microsoft.OpenApi.Extensions` na linha 1.6.x; no Swashbuckle 10 com `Microsoft.OpenApi` 2.x essa extensão não existe mais, então prefira o middleware ali.

Para um documento gerado em tempo de build com `dotnet swagger tofile` ou `OpenApiGenerateDocumentsOnBuild`, não faça nada disso em código. Gere com `--openapiversion 3.0` e corrija o arquivo como um passo do build:

```bash
jq '.openapi = "3.0.1"' swagger.json > swagger.tmp && mv swagger.tmp swagger.json
```

## O Swagger UI continua rejeitando a definição, e agora?

Se o navegador mostra "The provided definition does not specify a valid version field", o documento está certo e a UI está desatualizada. O swagger-ui ganhou suporte a 3.0.4 na [v5.19.0](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0), lançada em 2025-02-17, via o [PR #10247](https://github.com/swagger-api/swagger-ui/pull/10247). O Swashbuckle incorporou isso no `Swashbuckle.AspNetCore.SwaggerUI` 7.3.0. Qualquer coisa mais antiga exibe o erro contra um documento 3.0.4 perfeitamente válido.

A armadilha é a defasagem de versões dentro da mesma solução. `Swashbuckle.AspNetCore.SwaggerUI` é um pacote separado, e projetos que referenciam os três subpacotes individualmente costumam subir `Swagger` e `SwaggerGen` deixando o `SwaggerUI` para trás. Confira os três e depois recarregue o navegador forçando a limpeza de cache, porque o `swagger-ui-bundle.js` embutido é cacheado de forma agressiva.

Se o problema é o seu renderizador e não o seu documento, este também é um bom momento para olhar [como servir a documentação com Scalar](/pt-br/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/), que lê 3.0.4 e 3.1 sem reclamar.

## E se eu realmente quiser 3.1?

Aí você precisa do Swashbuckle 10 ou posterior, porque o `Microsoft.OpenApi` 1.6.x não tem nenhum membro `OpenApi3_1`. Na 10.x é opt-in, então o padrão continua sendo 3.0.4 e você pede 3.1 explicitamente:

```csharp
// net10.0, Swashbuckle.AspNetCore 10.2.3, emits "openapi": "3.1.1"
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);
```

Reserve tempo para a atualização. O Swashbuckle 10 migra para o `Microsoft.OpenApi` v2, que achata os namespaces, então a primeira coisa que você encontra é:

```text
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi'
```

Remova `using Microsoft.OpenApi.Models;`, já que os tipos agora vivem diretamente em `Microsoft.OpenApi`. Além disso, tipos concretos do modelo viram interfaces (`OpenApiSchema` vira `IOpenApiSchema`), nomes de tipo em string viram valores do enum `JsonSchemaType`, e `WithOpenApi()` não é mais suportado. O [guia de migração para a v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md) recomenda passar pela 9.0.6 antes, o que é um bom conselho: isola as mudanças de ruptura da 9.x (abandono do `netstandard2.0`, remoção de membros obsoletos, remoção do `--serializeasv2`) das do OpenAPI.NET v2.

## Qual correção devo escolher?

Ordenadas pelo que eu realmente faria:

1. Atualize o consumidor. `3.0.4` é OpenAPI 3.0 válido, e todo validador, gerador e gateway atual aceita. A maioria desses relatos se resume a uma ferramenta três versões atrás.
2. Se o consumidor é um fornecedor que você não consegue mover, adicione a reescrita em middleware. São 20 linhas, é independente de versão e não congela seu grafo de dependências.
3. Corrija o arquivo no CI com `jq` se o documento é gerado em tempo de build em vez de servido em tempo de execução.
4. Fixe o Swashbuckle na 7.2.0 apenas como paliativo, com um ticket para remover.

O que não funciona, apesar do que os resultados de busca vão dizer: baixar o `Microsoft.OpenApi` sob um Swashbuckle atual, ou caçar um membro de `OpenApiSpecVersion` que codifique a versão de patch.

## Relacionado

- [Migrar do Swashbuckle para o gerador de OpenAPI integrado](/pt-br/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) cobre a direção oposta, se você prefere abandonar o Swashbuckle a gerenciar a rotatividade de versões dele.
- [O erro de compilação 'OpenApiReference' could not be found](/pt-br/2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found/) é a falha irmã do mesmo achatamento de namespaces do `Microsoft.OpenApi` v2.
- [Mapear IOperationFilter e ISchemaFilter para transformers](/pt-br/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/) é a parte da migração que leva mais tempo.
- [Scalar e Swagger UI comparados](/pt-br/2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11/) vale a leitura se a rejeição de versão veio do renderizador e não de um serviço consumidor.
- [Gerar clientes fortemente tipados a partir de uma especificação OpenAPI](/pt-br/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) importa se quem rejeita seu documento é um gerador de código.

## Fontes

- [OpenAPI.NET PR #2011: bumps v3 patch version to 3.0.4](https://github.com/microsoft/OpenAPI.NET/pull/2011)
- [Swashbuckle.AspNetCore issue #3540: changing the openapi version in swagger.json](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540)
- [Swashbuckle.AspNetCore issue #3216: 7.2.0 json doc says openapi 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3216)
- [Swashbuckle.AspNetCore issue #3265: add support for OpenAPI 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3265)
- [Notas de lançamento da v9.0.0 do Swashbuckle.AspNetCore](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v9.0.0)
- [Notas de lançamento da v10.0.0 do Swashbuckle.AspNetCore](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.0.0)
- [Guia de migração para a v10 do Swashbuckle.AspNetCore](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Notas de lançamento da v5.19.0 do swagger-ui](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0)
