---
title: "HasData vs UseSeeding para popular dados no EF Core 11: qual voce deve usar?"
description: "Use HasData apenas para dados de referencia fixos e proprios do modelo. Use UseSeeding e UseAsyncSeeding para todo o resto no EF Core 11. Uma comparacao lado a lado com as regras que forcam a decisao."
pubDate: 2026-06-30
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-30
---

Para popular dados no EF Core 11, use `HasData` apenas para tabelas de referencia pequenas, fixas e deterministicas que voce queira versionar dentro das suas migracoes (codigos de pais, moedas, linhas de consulta tipo enum). Use `UseSeeding` e `UseAsyncSeeding` para todo o resto: qualquer coisa com chaves geradas pelo banco de dados, valores calculados ou nao deterministicos, logica condicional, propriedades de navegacao, ou linhas que dependem do que ja esta no banco de dados. O time do EF renomeou `HasData` para "model-managed data" justamente para desencorajar seu uso como ferramenta de seeding geral. Este artigo usa .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) e C# 14.

Se voce so lembrar de uma linha: `HasData` participa do modelo e do diff da migracao, `UseSeeding` roda como codigo comum contra um `DbContext` vivo. Quase todos os bugs dolorosos de seeding vem de escolher o primeiro quando voce precisava do segundo.

## A matriz de recursos

Esta e a tabela que voce veio buscar. Cada linha e uma restricao real, nao uma impressao.

| Recurso                          | `HasData` (model-managed data) | `UseSeeding` / `UseAsyncSeeding` |
| -------------------------------- | ------------------------------ | -------------------------------- |
| Configurado em                   | `OnModelCreating` (o modelo)   | `DbContextOptionsBuilder`        |
| Quando roda                      | Dentro do SQL de migracao (`InsertData`) | Em `Migrate`/`EnsureCreated` e `dotnet ef database update` |
| Chaves primarias                 | Devem ser especificadas a mao  | Chaves geradas pelo banco funcionam bem |
| Valores nao deterministicos      | Proibidos (re-diff a cada build) | Permitidos (`Guid.NewGuid()`, `DateTime.UtcNow`) |
| Propriedades de navegacao        | Nao, apenas chaves estrangeiras | Sim, insercao de grafos completos |
| Logica condicional               | Nao                            | Sim, voce escreve o `if`         |
| Chamadas externas / transformacoes | Nao                          | Sim (hashing, HTTP, leitura de arquivos) |
| Idempotencia                     | Automatica (EF faz o diff)     | Voce escreve a verificacao de existencia |
| Capturado no controle de versao  | Sim, no snapshot da migracao   | Nao, e codigo de inicializacao   |
| Atualiza linhas existentes       | Sim, via diff da migracao      | So se voce escrever a atualizacao |
| Disponivel desde                 | EF Core 1.0 (era `HasData`)    | EF Core 9, atual no EF Core 11   |

A linha mais importante de todas e "valores nao deterministicos". `HasData` e comparado contra o snapshot do modelo a cada build, entao um `DateTime.UtcNow` ou um `Guid.NewGuid()` no seu seed faz o modelo parecer alterado toda vez, e o EF lanca `PendingModelChangesWarning` ou gera um gotejar infindavel de migracoes inuteis. Esse e o muro contra o qual a maioria esbarra, geralmente durante uma [migracao do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Quando escolher HasData

`HasData` e a ferramenta certa quando os dados sao genuinamente parte do significado do seu schema. O teste mental: voce ficaria confortavel codificando essas linhas em uma constante, e elas quase nunca vao mudar?

- **Tabelas de consulta fixas.** Codigos de pais ISO, codigos de moeda, estados dos EUA, um enum de status de pedido apoiado por uma tabela. As chaves sao estaveis, voce mesmo as atribui, e voce quer que os valores sejam entregues e versionados com o schema. No EF Core 11 voce configura em `OnModelCreating`:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}
```

- **Dados que voce quer que sejam diffados e migrados automaticamente.** Mude `"Shipped"` para `"Dispatched"` e o proximo `dotnet ef migrations add` emite uma chamada `UpdateData`. Voce ganha mudancas versionadas, revisaveis e auditaveis ao seed no mesmo lugar que o schema. Essa e uma vantagem real que o `UseSeeding` nao da de graca.

- **Dados sem os quais o schema nao faz sentido.** Se uma chave estrangeira em outra tabela aponta para `OrderStatus.Id = 2` e a linha esta faltando, sua aplicacao esta quebrada. Embutir na migracao garante que ela aterrisse em sincronia com o schema, dentro da mesma transacao.

As chaves devem ser definidas explicitamente e os valores devem ser deterministicos. Nada de `Guid.NewGuid()`, nada de `DateTime.Now`, nenhuma propriedade de navegacao (defina a coluna de chave estrangeira diretamente). Quebre qualquer uma dessas e o `HasData` vai brigar com voce a cada build.

## Quando escolher UseSeeding e UseAsyncSeeding

`UseSeeding` e o mecanismo de proposito geral recomendado no EF Core 11. E codigo de aplicacao comum com um `DbContext` vivo, entao os limites do `HasData` simplesmente nao existem. Recorra a ele sempre que qualquer uma destas for verdadeira:

- **O banco de dados gera a chave.** Colunas identity, sequencias, `newsequentialid()`: com `HasData` voce teria que inventar chaves a mao e rezar para que nunca colidam com insercoes reais. `UseSeeding` deixa o banco atribui-las.

- **O valor e calculado ou nao deterministico.** Aplicar hash em uma senha de admin padrao, carimbar `CreatedAt = DateTime.UtcNow`, gerar um token `Guid`. Nada disso sobrevive ao diff do modelo, entao tem que rodar em tempo de execucao:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<User>().AnyAsync(u => u.Email == "admin@example.com", ct))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"), // runtime transform
                    CreatedAt = DateTime.UtcNow                        // non-deterministic
                });
                await context.SaveChangesAsync(ct);
            }
        })
        .UseSeeding((context, _) =>
        {
            if (!context.Set<User>().Any(u => u.Email == "admin@example.com"))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"),
                    CreatedAt = DateTime.UtcNow
                });
                context.SaveChanges();
            }
        }));
```

- **Voce precisa de logica condicional ou dependente dos dados.** "Popular um tenant de demonstracao apenas em `Development`", ou "inserir estas linhas apenas se a tabela estiver vazia". Isso e um `if` comum, que o `HasData` nao consegue expressar de jeito nenhum.

- **Voce esta inserindo um grafo de objetos atraves de propriedades de navegacao.** Um blog com tres posts, um pedido com itens, ou [uma relacao muitos-para-muitos](/pt-br/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/). Com `UseSeeding` voce constroi o grafo em C# e deixa o `SaveChanges` descobrir as chaves estrangeiras. Com `HasData` voce teria que conectar a mao cada linha de juncao.

A pegadinha e a que a maioria nao percebe: voce tem que implementar **os dois** overloads, e a verificacao de existencia fica por sua conta. As ferramentas do EF Core (`dotnet ef database update`) so chamam o `UseSeeding` sincrono; seu caminho de tempo de execucao chama o `UseAsyncSeeding`. Implemente um e nao o outro e o seeding silenciosamente nao faz nada a partir do caminho que voce esqueceu. Para os mecanismos completos, veja [como popular dados com UseSeeding e UseAsyncSeeding](/pt-br/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).

## O que de fato acontece em disco

A forma mais clara de ver a diferenca e olhar o que cada um produz.

`HasData` se materializa na sua migracao. Apos `dotnet ef migrations add SeedStatuses`, o metodo `Up` gerado contem chamadas com forma de SQL literal:

```csharp
// .NET 11, EF Core 11 generated migration
migrationBuilder.InsertData(
    table: "OrderStatuses",
    columns: new[] { "Id", "Name" },
    values: new object[,]
    {
        { 1, "Pending" },
        { 2, "Shipped" },
        { 3, "Delivered" }
    });
```

Os dados agora sao um artefato versionado. Roda uma vez, dentro da transacao da migracao, e o EF o rastreia no snapshot do modelo, entao uma edicao posterior produz um `UpdateData`. E exatamente por isso que um valor nao deterministico e veneno aqui: o snapshot nunca casaria, entao o EF acreditaria que o modelo mudou a cada build.

`UseSeeding` nao produz nada em disco. E um callback que dispara depois que o schema esta atualizado, em cada `Migrate`, `EnsureCreated` ou `dotnet ef database update`, incluindo execucoes em que nenhuma migracao foi aplicada. Como roda incondicionalmente, a verificacao de existencia nao e tarefa opcional de manutencao, e a unica coisa entre voce e as linhas duplicadas. O EF Core 11 protege o callback com o mesmo mecanismo de bloqueio de migracao que usa para migracoes, entao duas instancias da aplicacao iniciando ao mesmo tempo nao vao rodar ambas o seed concorrentemente, mas o bloqueio nao torna idempotente um `if` que falta.

## A pegadinha que decide por voce

Algumas restricoes anulam a preferencia por completo. Se alguma destas se aplica, a decisao ja esta tomada por voce:

- **Chaves geradas pelo banco forcam `UseSeeding`.** Se voce nao pode ou nao quer codificar chaves primarias a mao, `HasData` esta fora de cogitacao. Ele nao tem como popular uma linha cuja chave o banco atribui.

- **Valores nao deterministicos ou calculados forcam `UseSeeding`.** Uma senha com hash, um timestamp, um token aleatorio: no momento em que um aparece, `HasData` transforma cada build em uma migracao fantasma. Essa e a razao mais comum pela qual times arrancam o `HasData`.

- **Uma tabela-enum fixa para a qual outras linhas apontam favorece `HasData`.** Quando a integridade referencial depende de o seed existir antes de qualquer dado real, voce o quer dentro da transacao de migracao, nao em um callback de inicializacao que poderia falhar e deixar o schema populado pela metade.

- **Uma chave obrigatoria e gerada pelo banco com uma linha `HasData` dispara um erro.** Se voce tentar popular uma entidade atraves de `HasData` sem fornecer sua chave, o EF lanca `The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'`. Esse erro e o EF dizendo que voce escolheu o mecanismo errado: veja [a solucao para essa mensagem exata](/pt-br/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/).

Voce pode perfeitamente usar os dois em uma so aplicacao. Uma divisao comum e saudavel: `HasData` para as tres tabelas de consulta sem as quais seu schema nao funciona, e `UseSeeding` para os dados de demonstracao, o admin padrao e qualquer coisa especifica de tenant. Eles nao entram em conflito, porque rodam em estagios diferentes.

## A recomendacao, repetida

Por padrao use `UseSeeding` e `UseAsyncSeeding` no EF Core 11. Sao o mecanismo recomendado, lidam com os dados dinamicos, com chave gerada e condicionais que as aplicacoes reais de fato populam, e falham ruidosamente em vez de corromper silenciosamente seu historico de migracoes. Reserve `HasData` para o caso estreito que ele foi renomeado para servir: dados de referencia pequenos, fixos e deterministicos com chaves atribuidas a mao que voce genuinamente queira versionar e diffar junto ao seu schema.

A armadilha a evitar e o padrao historico. Por anos `HasData` foi a unica opcao embutida, entao as bases de codigo recorriam a ele por reflexo e depois se afogavam em migracoes fantasma e `PendingModelChangesWarning`. Se voce esta comecando do zero no EF Core 11, inverta esse instinto: `UseSeeding` primeiro, `HasData` apenas quando voce conseguir nomear por que os dados pertencem ao modelo. Se voce mantem entidades baseadas em `records`, a mesma divisao se aplica de forma limpa, ja que [records funcionam bem com EF Core 11](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/) sob os dois mecanismos.

## Relacionado

- [Como popular dados com UseSeeding e UseAsyncSeeding no EF Core 11](/pt-br/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [Como popular uma relacao muitos-para-muitos no EF Core 11](/pt-br/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [Solucao: the seed entity cannot be added because a non-zero value is required for property Id](/pt-br/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/)
- [Migrar EF Core 6 para EF Core 11: as breaking changes que de fato mordem](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## Fontes

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)
