---
title: "Como usar Native AOT com APIs mínimas do ASP.NET Core"
description: "Configure Minimal APIs para Native AOT com metadados JSON gerados. Entenda builders, ferramentas de publicação, avisos e limitações de recursos."
pubDate: 2026-04-27
updatedDate: 2026-11-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
lang: "pt-br"
translationOf: "2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis"
translatedBy: "claude"
translationDate: 2026-04-29
---

Native AOT compila a aplicação em código nativo na publicação. Pode alterar inicialização, tamanho e uso de memória, mas isso depende da aplicação e do destino. Não torna todo recurso ou dependência do ASP.NET Core compatível.

**Correção — 2 de novembro de 2026:** a versão anterior exigia `CreateSlimBuilder`, excluía todos os servidores SignalR, vinculava geração a `Program.cs` e exagerava restrições de JSON e globalização. O exemplo substituto usa .NET 10; não afirma execução no .NET 11.

## Aplicação com metadados JSON explícitos

Crie o projeto `MyApi` com este arquivo:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Use este `Program.cs`:

```csharp
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default));

var app = builder.Build();
app.MapGet("/todos", () => TypedResults.Ok(new[] { new Todo(1, "Write docs", false) }));
app.MapPost("/todos", (Todo todo) => TypedResults.Ok(todo));
app.Run();

public record Todo(int Id, string Title, bool IsComplete);

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

`PublishAot` ativa análise AOT e geração de delegates de requisição neste projeto Web SDK. O contexto JSON fornece metadados dos tipos raiz utilizados. Registre outras raízes e tipos polimórficos conforme os contratos; registrar `object` não cobre qualquer tipo possível em execução.

O gerador processa os arquivos do projeto. Mover uma extensão de rotas para fora de `Program.cs` não causa incompatibilidade por si só. Uma biblioteca separada precisa das referências ASP.NET Core e do suporte ao gerador adequados; uma propriedade isolada não torna qualquer código compatível.

## Publicar para uma plataforma concreta

```sh
# Use the RID and native toolchain for your deployment target.
# This command is for an Apple Silicon Mac:
dotnet publish -c Release -r osx-arm64 -o ./publish
./publish/MyApi --urls http://127.0.0.1:5080
# Replace MyApi with your project's executable name.
```

Instale as ferramentas nativas exigidas. Publicação Native AOT entre sistemas operacionais distintos não é suportada de modo geral; use host ou container apropriado. Autossuficiente significa não precisar instalar o runtime gerenciado separadamente, não um executável totalmente estático ou independente de bibliotecas do sistema.

Execute o binário publicado e teste endpoints, serialização, autenticação e erros. `dotnet run` normalmente usa JIT e não substitui esse teste. Revise todos os avisos de trimming e AOT; eles não interrompem a publicação automaticamente sem configuração como erros. `IL2026` trata de requisitos de trimming; `IL3050`, de código dinâmico. Atributos como `RequiresDynamicCode` propagam requisitos, mas não corrigem incompatibilidades.

## Builder, JSON e globalização

`CreateSlimBuilder` inicia menos recursos e é uma boa base, não uma API obrigatória. `CreateBuilder` pode ser usado com recursos e dependências compatíveis. O builder reduzido omite HTTPS e HTTP/3 por padrão: adicione o suporte Kestrel necessário ou encerre TLS em um proxy confiável. Configurar endpoints não adiciona sozinho protocolos ausentes.

Adicionar um resolver gerado não desativa reflexão em todos os modos. Native AOT exige metadados adequados; tipos JSON desconhecidos podem falhar em execução. `Results.Json(value)` e `ReadFromJsonAsync<T>()` podem usar opções configuradas e metadados gerados; não são proibidos por definição. Sobrecargas com `JsonTypeInfo<T>` deixam o contrato explícito.

`InvariantGlobalization` altera comportamento, não é um controle de avisos AOT. Se precisar de culturas, mantenha o suporte e forneça as dependências do destino. Não ative o modo invariável apenas para silenciar avisos nem espere preservar toda a semântica cultural.

## Conferir recursos por versão

Controllers MVC e Razor Pages não são opções gerais de Native AOT na matriz documentada. SignalR é diferente: .NET 9 introduziu suporte para cliente e servidor, com restrições e requisitos de geração JSON documentados. Não aplique uma exclusão antiga a versões novas.

Acesso a dados também exige revisão por provedor. EF Core AOT depende de versão e consultas; Dapper comum não é automaticamente seguro só por ser menor. Publique e exercite as dependências concretas.

Para organizar handlers compatíveis, veja [módulos com MapGroup](/pt-br/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Fontes

- [ASP.NET Core Native AOT support](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [.NET Native AOT deployment and prerequisites](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [System.Text.Json source generation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [.NET 9 SignalR Native AOT support and limitations](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-9.0?view=aspnetcore-9.0#signalr-supports-trimming-and-native-aot)
