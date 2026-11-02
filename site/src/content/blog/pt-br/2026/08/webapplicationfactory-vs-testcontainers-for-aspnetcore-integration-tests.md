---
title: "WebApplicationFactory vs Testcontainers para testes de integração no ASP.NET Core"
description: "Escolha a configuração de testes de integração ASP.NET Core pelo que precisa comprovar: rotas HTTP, comportamento do banco de produção ou imagem publicada."
pubDate: 2026-08-07
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests"
translatedBy: "claude"
translationDate: 2026-08-07
---

`WebApplicationFactory<TEntryPoint>` inicia a aplicação em teste. Testcontainers inicia dependências como PostgreSQL ou SQL Server. Eles podem ser usados juntos. Escolha a configuração pelo comportamento que a asserção precisa observar.

**Correção, 2 de novembro de 2026.** Uma restrição de rota `:int` sem correspondência normalmente produz 404. A versão anterior indicava 400 e sugeria que somente um app em contêiner poderia usar um socket real. O exemplo HTTP foi verificado com ASP.NET Core 10.0.10 e SDK 10.0.302. Os tempos de fixtures sem benchmark publicado foram removidos.

## Escolher o limite da prova

| O que o teste precisa comprovar | Configuração | O que verificar |
| --- | --- | --- |
| Rotas, autorização e serialização | Factory com `TestServer` padrão e serviços de teste | Status, cabeçalhos e corpo |
| Semântica do banco de produção | Factory com o mesmo mecanismo em Testcontainers | Restrições, migrações, tradução de consultas e concorrência |
| A imagem publicada inicia corretamente | Compilar e executar a imagem com seus serviços | Dockerfile, ponto de entrada, configuração e rede |

A factory usa por padrão um servidor HTTP no processo. Desde .NET 10, `UseKestrel()` permite usar Kestrel e uma porta real. Chame antes de inicializar a factory. TLS e HTTP/2 ainda exigem configuração compatível no servidor e cliente. Teste o contêiner quando a própria imagem for o alvo.

## Uma asserção HTTP sem banco

```csharp
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/orders/{id:int}", (int id) => TypedResults.Ok(id));
app.MapGet("/bound/{id}", (int id) => TypedResults.Ok(id));
app.Run();
```

`GET /orders/7` retorna 200. `GET /orders/abc` não atende à restrição e retorna 404 porque nenhuma rota corresponde. `GET /bound/abc` corresponde à rota, mas a vinculação ao parâmetro inteiro falha com 400. Esses testes rodaram no Kestrel via loopback. Para configurar a factory, substituir um serviço ou testar autenticação, consulte [o guia de WebApplicationFactory](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

## Um teste de banco precisa do provedor relevante

SQLite aplica restrições como unicidade, mas `VARCHAR(16)` sozinho não limita o tamanho a 16 caracteres. PostgreSQL rejeita um valor com caracteres não brancos excedendo `varchar(16)`. Um teste verde no SQLite não comprova essa regra do PostgreSQL. O mesmo vale para SQL específico do provedor, migrações e [concorrência com rowversion](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

Para um endpoint com SQL Server, inicie o contêiner do mecanismo, aplique as migrações, configure a conexão da factory e verifique o resultado. O [guia de Testcontainers para SQL Server](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) mostra a preparação. Testes somente HTTP podem ficar independentes de Docker.

## Manter fixtures repetíveis

Compartilhe um contêiner apenas com isolamento de dados. Use um esquema ou banco por grupo, ou redefina os dados explicitamente entre testes. Meça download da imagem, inicialização, criação do esquema e requisições separadamente. Uma imagem local em cache e um worker de CI novo têm custos diferentes.

## Fontes

- [ASP.NET Core integration tests](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests?view=aspnetcore-10.0)
- [Route constraints](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing?view=aspnetcore-10.0#route-constraints)
- [WebApplicationFactory.UseKestrel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel?view=aspnetcore-10.0)
- [Testcontainers for .NET](https://dotnet.testcontainers.org/)
- [SQLite VARCHAR limits](https://sqlite.org/faq.html#q9) · [PostgreSQL character types](https://www.postgresql.org/docs/17/datatype-character.html)
