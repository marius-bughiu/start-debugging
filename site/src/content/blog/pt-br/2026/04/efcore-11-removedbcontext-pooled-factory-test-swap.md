---
title: "EF Core 11 Preview 3 adiciona RemoveDbContext para swaps limpos de provider em testes"
description: "EF Core 11 Preview 3 introduz RemoveDbContext, RemoveExtension, e um overload sem parâmetros do AddPooledDbContextFactory, removendo o boilerplate de trocar providers em testes e centralizando a configuração da pooled factory."
pubDate: 2026-04-23
tags:
  - "dotnet-11"
  - "ef-core-11"
  - "testing"
  - "dependency-injection"
lang: "pt-br"
translationOf: "2026/04/efcore-11-removedbcontext-pooled-factory-test-swap"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 Preview 3 conserta discretamente um dos incômodos mais antigos em testes de integração com EF Core: a necessidade de desfazer a chamada `AddDbContext` do projeto pai antes de registrar um provider diferente. A release introduz os helpers `RemoveDbContext<TContext>()` e `RemoveExtension<TExtension>()`, além de um overload sem parâmetros para `AddPooledDbContextFactory<TContext>()` que reutiliza a configuração declarada dentro do próprio context.

## A velha dança do swap em testes

Se seu composition root em `Startup` ou `Program.cs` registra um context de SQL Server, o projeto de testes de integração geralmente precisa sobrescrever isso. Até agora, fazer isso de forma limpa exigia ou reestruturar o registro de produção num método de extensão que recebesse um delegate de configuração, ou percorrer manualmente o `IServiceCollection` e remover cada `ServiceDescriptor` que o EF Core tinha registrado. Essa segunda rota é frágil, porque depende do conjunto exato de serviços internos que o EF Core fia para um provider dado.

```csharp
// EF Core 10 and earlier: manual cleanup before swapping providers
services.RemoveAll<DbContextOptions<AppDbContext>>();
services.RemoveAll(typeof(AppDbContext));
services.RemoveAll(typeof(IDbContextOptionsConfiguration<AppDbContext>));
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

Você tinha que saber quais tipos de descriptor esfregar, e qualquer mudança em como o EF Core conecta seu pipeline de options poderia quebrar o setup de testes silenciosamente.

## O que `RemoveDbContext` realmente faz

No Preview 3 o mesmo swap colapsa em duas linhas:

```csharp
services.RemoveDbContext<AppDbContext>();
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

`RemoveDbContext<TContext>()` tira o registro do context, o `DbContextOptions<TContext>` vinculado, e os callbacks de configuração que o EF Core acumulou para aquele context. Também há um `RemoveExtension<TExtension>()` mais cirúrgico para o caso em que você quer manter a maior parte da configuração intacta mas derrubar uma única options extension, por exemplo removendo a retry strategy do SQL Server sem reconstruir o pipeline inteiro.

## Pooled factories sem duplicar configuração

A segunda mudança mira `AddPooledDbContextFactory<TContext>()`. Antes a chamada exigia um delegate de options, mesmo quando o context já sobrescrevia `OnConfiguring` ou tinha registrado sua configuração via `ConfigureDbContext<TContext>()`. Preview 3 adiciona um overload sem parâmetros, então um context que já sabe como se configurar pode ser exposto como pooled factory em uma linha:

```csharp
services.ConfigureDbContext<AppDbContext>(o =>
    o.UseSqlServer(connectionString));

services.AddPooledDbContextFactory<AppDbContext>();
```

Combinadas, as duas mudanças deixam trivial pegar um registro de produção, tirar o provider, e re-adicionar o mesmo context como pooled factory apontando para um store diferente, que é exatamente o formato que a maioria dos fixtures de testes multi-tenant já queria.

## Onde ler mais

As notas completas vivem nas [release notes do EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md), e o anúncio está no [post do .NET 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/). Se você mantém uma classe base de test fixture que faz a dança manual de `RemoveAll`, esse é o momento de deletar.
