---
title: "Como popular dados com UseSeeding e UseAsyncSeeding no EF Core 11"
description: "Popule dados de referência do jeito certo no EF Core 11 com UseSeeding e UseAsyncSeeding: onde configurar, quando eles rodam, a verificação de idempotência que você não pode pular e por que precisa implementar ambos."
pubDate: 2026-06-21
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "pt-br"
translationOf: "2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Para popular dados no EF Core 11, configure `UseSeeding` e `UseAsyncSeeding` no `DbContextOptionsBuilder`, escreva uma verificação de existência no topo de cada callback para que a inserção só rode quando a linha estiver faltando, e dispare-os chamando `EnsureCreated`/`EnsureCreatedAsync`, `Migrate`/`MigrateAsync` ou `dotnet ef database update`. Os callbacks são executados em cada uma dessas operações, mesmo quando nenhuma migração foi aplicada, então a verificação de existência é o que impede você de inserir duplicatas. Implemente tanto a sobrecarga síncrona quanto a assíncrona com a mesma lógica, porque as ferramentas do EF Core só chamam a síncrona. Este artigo usa .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) e C# 14.

`UseSeeding` e `UseAsyncSeeding` chegaram no EF Core 9 e são o mecanismo de população de propósito geral recomendado no EF Core 11. Eles substituem o velho hábito de enfiar tudo no `HasData`, que a equipe do EF desde então renomeou para "model managed data" justamente porque ele nunca foi pensado para os dados dinâmicos e dependentes do banco de dados que a maioria dos aplicativos realmente quer popular.

## Por que o UseSeeding existe

Por anos a resposta para "como coloco dados iniciais no meu banco de dados" era `HasData`. Ele funciona, mas tem arestas afiadas que cortam no momento em que seus dados são qualquer coisa diferente de uma tabela de consulta fixa. `HasData` é embutido no modelo: o EF calcula inserções, atualizações e exclusões comparando os dados no snapshot da sua migração, então ele precisa de cada chave primária escrita à mão, não pode usar chaves geradas pelo banco de dados, e qualquer valor que não seja determinístico (um `DateTime.UtcNow`, um `Guid.NewGuid()`, uma senha com hash) faz o modelo parecer "modificado" a cada build. Esse último caso é uma fonte comum do `PendingModelChangesWarning` que surpreende as pessoas durante uma [migração do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

`UseSeeding` é código de aplicativo comum que roda contra um `DbContext` ativo. Você consulta, você ramifica, você chama APIs externas se precisar, você executa `SaveChanges`. Não há snapshot do modelo, nem comparação de chaves, nem exigência de determinismo. É a ferramenta certa sempre que seus dados de população forem um destes casos: fixtures de teste, dados que dependem do que já está no banco de dados, blobs grandes que você não quer capturar nos snapshots de migração, linhas cujas chaves são geradas pelo banco de dados, ou qualquer coisa que exija uma transformação como o hash de senhas. A orientação oficial diz com clareza: `UseSeeding` e `UseAsyncSeeding` são a forma recomendada de popular no EF Core, e `HasData` fica agora reservado para dados de referência genuinamente estáticos, como códigos de país ou CEPs.

## Onde configurar os callbacks

Os métodos ficam pendurados no `DbContextOptionsBuilder`, então eles vão onde quer que você construa suas opções. Os dois lugares comuns são `OnConfiguring` no próprio contexto e o registro do `AddDbContext` no `Program.cs`.

Aqui está a forma com `OnConfiguring` direto de uma classe de contexto:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseSeeding((context, _) =>
        {
            var admin = context.Set<Role>().FirstOrDefault(r => r.Name == "Admin");
            if (admin is null)
            {
                context.Set<Role>().Add(new Role { Name = "Admin" });
                context.SaveChanges();
            }
        })
        .UseAsyncSeeding(async (context, _, cancellationToken) =>
        {
            var admin = await context.Set<Role>()
                .FirstOrDefaultAsync(r => r.Name == "Admin", cancellationToken);
            if (admin is null)
            {
                context.Set<Role>().Add(new Role { Name = "Admin" });
                await context.SaveChangesAsync(cancellationToken);
            }
        });
```

O `context` entregue ao callback é um `DbContext` totalmente funcional, então `context.Set<T>()` dá a você a mesma superfície de consulta e rastreamento que você usa em todo lugar. O parâmetro descartado `_` é um `bool` que informa se o EF criou o banco de dados durante esta operação; a maioria dos populadores o ignora.

Em um aplicativo ASP.NET Core típico, você configura a mesma coisa durante o registro de injeção de dependência. Note que as assinaturas são idênticas; só o hospedeiro muda:

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedRoles(context))
        .UseAsyncSeeding(async (context, _, ct) => await SeedRolesAsync(context, ct)));
```

Mover o corpo para métodos nomeados (`SeedRoles`, `SeedRolesAsync`) mantém o registro legível e dá a você um lugar óbvio onde toda a lógica de população vive, o que era grande parte do objetivo do recurso.

## Quando os callbacks realmente rodam

Este é o detalhe que confunde as pessoas, então vale a pena enunciá-lo com precisão. Os callbacks de população são invocados como parte de:

- `context.Database.EnsureCreated()` chama `UseSeeding`.
- `context.Database.EnsureCreatedAsync()` chama `UseAsyncSeeding`.
- `context.Database.Migrate()` e `MigrateAsync()` os chamam.
- `dotnet ef database update` os chama.

O crucial é que eles rodam em **cada** invocação dessas operações, mesmo quando não houve mudanças no modelo e nenhuma migração foi aplicada. Chamar `Migrate()` em um banco de dados já atualizado ainda dispara o callback de população. Isso é proposital, e é a coisa mais importante para internalizar: o framework não lembra que populou da última vez para pular você. Seu callback é responsável por decidir se há algo a fazer.

É por isso que cada exemplo acima começa com uma consulta. O formato é sempre o mesmo: procure a linha, insira só se ela estiver ausente. Pule a verificação e você inserirá "Admin" em cada inicialização que chamar `Migrate`, e em uma semana você terá uma tabela cheia de papéis de administrador duplicados.

## A verificação de idempotência não é opcional

Como o callback roda de novo, sua lógica de população precisa ser idempotente: rodá-la uma vez e rodá-la dez vezes precisa deixar o banco de dados no mesmo estado. A guarda `FirstOrDefault`/`if (x is null)` dos exemplos é a forma mínima. Para um lote de linhas, consulte o conjunto que você já tem e insira só a diferença:

```csharp
// .NET 11, EF Core 11, C# 14 -- idempotent batch seed
static void SeedRoles(DbContext context)
{
    string[] required = ["Admin", "Editor", "Viewer"];

    var existing = context.Set<Role>()
        .Where(r => required.Contains(r.Name))
        .Select(r => r.Name)
        .ToHashSet();

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new Role { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<Role>().AddRange(missing);
        context.SaveChanges();
    }
}
```

Uma ida e volta para ler o que existe, uma para escrever só o que é novo, e nada acontece quando a tabela está completamente populada. Essa última propriedade importa: um populador que dispara um `SaveChanges` a cada inicialização, mesmo que sem efeito, é desperdício e enche seus logs de ruído. Calcule a diferença primeiro, escreva só quando `missing.Count > 0`.

Não se apoie em um índice único mais uma exceção engolida como sua "idempotência". Isso transforma cada reinicialização depois da primeira em uma `DbUpdateException` capturada, que é lenta, polui os logs e esconde falhas reais. Consulte primeiro.

## Por que você precisa implementar ambas as sobrecargas

A nota na documentação é fácil de passar batido e cara de ignorar: as ferramentas do EF Core atualmente dependem do método **síncrono** `UseSeeding`, e não vão popular corretamente se você implementar só o `UseAsyncSeeding`. Então, quando você roda `dotnet ef database update`, é o callback síncrono que dispara, não importa o quão assíncrono seja o código do seu aplicativo.

O contrário também vale. Se seu aplicativo inicia com `await context.Database.MigrateAsync()` (a inicialização assíncrona idiomática), esse caminho chama `UseAsyncSeeding`, não `UseSeeding`. Implemente só o síncrono e a população da própria inicialização do seu aplicativo não faz nada em silêncio enquanto sua população pela CLI funciona, ou vice-versa.

A regra segura: implemente ambos, com lógica idêntica. Fatore o corpo em um método compartilhado para que os dois callbacks não possam divergir:

```csharp
// .NET 11, EF Core 11, C# 14
options
    .UseSeeding((context, _) => SeedRoles(context))
    .UseAsyncSeeding((context, _, ct) => SeedRolesAsync(context, ct));

// sync and async bodies kept in lockstep
static void SeedRoles(DbContext context) { /* query, branch, SaveChanges */ }

static async Task SeedRolesAsync(DbContext context, CancellationToken ct)
{
    // same query, same branch, SaveChangesAsync(ct)
}
```

Resista à tentação de implementar um bloqueando sobre o outro (`SeedRolesAsync(context, ct).GetAwaiter().GetResult()` dentro do callback síncrono, ou `Task.Run` em volta do corpo síncrono no assíncrono). O sync-over-async convida a deadlocks sob alguns contextos de sincronização, e o async-over-sync só mente sobre ser assíncrono. Escreva os dois corpos por extenso; eles são curtos.

## A concorrência está resolvida, mas só para o corpo da população

Uma propriedade genuinamente agradável: o código dentro de `UseSeeding` e `UseAsyncSeeding` é protegido pelo mecanismo de bloqueio de migrações do EF Core. Quando duas instâncias do seu aplicativo iniciam no mesmo momento e ambas chamam `Migrate`, o bloqueio as serializa, de modo que elas não ultrapassam ambas a verificação de existência nem fazem uma inserção dupla. Essa é uma vantagem real sobre a população de inicialização feita à mão, onde você teria que construir essa coordenação por conta própria.

A proteção cobre o callback de população especificamente. Ela não transforma todo o seu aplicativo em um sistema de escritor único, nem protege dados que você escreve fora do caminho de população. Trate-a exatamente pelo que ela é: uma guarda que torna a etapa de população segura para rodar a partir de muitas instâncias de forma concorrente.

## Quando UseSeeding é a escolha errada

`UseSeeding` não é um martelo para todo prego. Dois casos empurram você para outro lugar.

Primeiro, dados de referência genuinamente estáticos que nunca mudam fora de uma migração de esquema -- sendo o exemplo canônico uma tabela de CEPs ou códigos de país ISO -- ainda são mais bem atendidos pelo `HasData`. Eles viajam com a migração, ficam versionados junto ao esquema e não exigem uma consulta em tempo de execução a cada inicialização. Recorra ao `HasData` quando os dados forem fixos, determinísticos, pequenos e você estiver de acordo em que sejam propriedade das migrações.

Segundo, a população que precisa de duas instâncias distintas de `DbContext` dentro de uma transação não pode ser expressa de forma limpa em um único callback de `UseSeeding`, que recebe um contexto só. Para isso, a documentação remete você de volta à lógica de inicialização personalizada comum: abra os contextos você mesmo, rode o trabalho e, acima de tudo, mantenha-o fora do caminho normal das requisições para não esbarrar em problemas de concorrência nem exigir que o aplicativo em execução tenha permissão para modificar o esquema.

```csharp
// .NET 11, EF Core 11 -- custom initialization, run once at deploy time
await using var context = new AppDbContext();
await context.Database.MigrateAsync();

if (!await context.Roles.AnyAsync())
{
    context.Roles.AddRange(new Role { Name = "Admin" }, new Role { Name = "Viewer" });
    await context.SaveChangesAsync();
}
```

Vale repetir o aviso da documentação: a população em geral não deveria ser parte da execução normal do aplicativo. Rodá-la na inicialização de cada instância significa que cada instância precisa de permissão de escrita e que você está confiando no bloqueio para a correção. Em produção, uma etapa de inicialização dedicada de uma única vez no momento da implantação é mais limpa. `UseSeeding` brilha para o desenvolvimento local, os testes e o tipo de dados de referência pequenos e idempotentes onde a consulta por inicialização é barata.

## Juntando tudo

O modelo mental é curto. `UseSeeding` e `UseAsyncSeeding` são código de aplicativo que o EF Core chama em `EnsureCreated`, `Migrate` e `dotnet ef database update`. Eles rodam toda vez, então sua primeira linha é sempre uma verificação de existência e sua escrita só acontece para as linhas que faltam. Você implementa ambas as sobrecargas porque as ferramentas e seu caminho de inicialização assíncrono chamam as diferentes. O corpo da população é protegido por bloqueio para que inicializações concorrentes não colidam. E `HasData` continua ali para o caso estreito de dados de referência estáticos, determinísticos e propriedade das migrações.

Se você está apertando o resto da sua camada de dados do EF Core 11, o mesmo cuidado sobre o que roda e quando aparece em outros lugares: veja como os [interceptores do EF Core 11 lidam com auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) no ponto de estrangulamento do `SaveChanges`, quando preferir [ExecuteUpdate em vez de carregar entidades e chamar SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) para escritas em massa, e por que [AsNoTracking versus AsNoTrackingWithIdentityResolution](/pt-br/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) importa em consultas com muitas leituras. Se sua inserção de população algum dia tropeçar em [o tipo de entidade exige que uma chave primária seja definida](/pt-br/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/), esse é um problema de modelagem para corrigir antes que o populador rode.

Fontes: a [documentação de população de dados](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) do EF Core no Microsoft Learn cobre a API de `UseSeeding`/`UseAsyncSeeding`, o momento de execução, a exigência de ambas as sobrecargas e a garantia do bloqueio de migração; a referência da API de [DbContextOptionsBuilder.UseSeeding](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding) documenta as assinaturas exatas.
