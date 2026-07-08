---
title: "Migrar do seeding com HasData para UseAsyncSeeding no EF Core 11"
description: "Um guia passo a passo para mover os dados de seed do HasData para UseSeeding e UseAsyncSeeding no EF Core 11, incluindo a armadilha da migracao DeleteData que apaga suas linhas existentes se voce pular esse cuidado."
pubDate: 2026-07-08
updatedDate: 2026-07-08
template: migration
tags:
  - "migration"
  - "efcore"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-08
---

Mover os dados de seed de `HasData` para `UseSeeding`/`UseAsyncSeeding` no EF Core 11 e um trabalho de meio dia para uma aplicacao tipica, e a unica coisa que vai te morder nao e a API nova: e que apagar uma chamada `HasData` faz o proximo `dotnet ef migrations add` emitir uma instrucao `DeleteData` que remove exatamente essas linhas de todo banco de dados contra o qual a migracao roda. Se voce apagar o `HasData` e adicionar o `UseSeeding` na mesma implantacao sem pensar na ordem, pode apagar dados de referencia em producao. Este guia percorre a migracao na ordem que evita isso, usando .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) e C# 14. Reserve uma tarde para uma aplicacao media, a maior parte gasta auditando quais seeds ja deveriam ter sido movidos ha anos.

Vale a pena? Para qualquer coisa dinamica, com chave gerada, calculada ou condicional: sim, e ja estava atrasado. Para uma tabela de referencia genuinamente estatica de tres linhas, deixe no `HasData`. O objetivo aqui nao e "apagar todo `HasData`", e "mover os seeds que nunca pertenceram ao modelo".

## Por que sair do HasData

`HasData` embute seus dados de seed no snapshot do modelo. Esse unico fato de design e a raiz de cada motivo para sair:

- **Valores nao deterministicos geram migracoes fantasma.** Um `DateTime.UtcNow`, um `Guid.NewGuid()` ou uma senha com hash dentro de uma linha `HasData` faz o diff do modelo nunca bater, entao o EF acredita que o modelo mudou a cada build e ou avisa com `PendingModelChangesWarning` ou despeja um gotejar interminavel de migracoes sem efeito. Esse e o muro que a maioria das equipes bate, muitas vezes no meio de uma [migracao do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).
- **Chaves geradas pelo banco de dados sao impossiveis.** `HasData` exige cada chave primaria escrita a mao. Colunas identity e sequencias ficam de fora, entao voce acaba inventando chaves e rezando para que nunca colidam com insercoes reais.
- **Sem logica condicional, sem grafos de navegacao, sem transformacoes.** "Semear um tenant de demo apenas em Development" ou "inserir este grafo de objetos atraves de suas propriedades de navegacao" nao pode ser expresso em `HasData` de forma alguma.
- **O seed e parte do diff do seu schema, quer voce queira ou nao.** Cada edicao de valor vira um `UpdateData` em uma migracao, o que e um recurso para codigos de pais e um incomodo para qualquer coisa que voce preferiria gerenciar como codigo.

A equipe do EF renomeou `HasData` para "model-managed data" justamente para desencorajar seu uso como ferramenta geral de seeding. `UseSeeding` e `UseAsyncSeeding`, introduzidos no EF Core 9 e vigentes no EF Core 11, sao codigo de aplicacao comum que roda contra um `DbContext` vivo, sem nenhum desses limites. Se voce ainda esta decidindo quais seeds mover, a [matriz de decisao HasData vs UseSeeding](/pt-br/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) traca a linha linha por linha.

## O que quebra

| Area | Mudanca | Severidade |
| ---- | ------- | ---------- |
| Bancos de dados existentes | Remover uma chamada `HasData` gera `DeleteData`, que apaga as linhas do seed na migracao | alta |
| Idempotencia | `HasData` era diferenciado automaticamente; `UseSeeding` roda toda vez e precisa de uma verificacao de existencia escrita a mao | alta |
| Dois caminhos de codigo | O tooling chama o `UseSeeding` sincrono, a inicializacao async chama `UseAsyncSeeding`; implemente apenas um e o outro nao faz nada em silencio | alta |
| Controle de versao | Os valores do seed saem do snapshot da migracao e vivem no codigo de inicializacao; eles nao ficam mais capturados no historico de migracoes | media |
| Integridade referencial | Dados dos quais chaves estrangeiras de outras tabelas dependem agora aterrissam em um callback de inicializacao, nao dentro da transacao da migracao | media |
| Configuracao de testes | Testes que dependiam do `HasData` rodar via `EnsureCreated` ainda funcionam, mas apenas se ambos os overloads forem implementados | baixa |

A linha do topo e a que acaba em um relatorio de incidente. Todo o resto e mecanico.

## Checklist pre-voo

Antes de tocar em uma linha de codigo de seeding:

- **Confirme que sua versao do EF Core e 9.0 ou posterior.** `UseSeeding`/`UseAsyncSeeding` nao existem antes do EF Core 9. Rode `dotnet list package | findstr EntityFrameworkCore` e confirme 11.0 (ou no minimo 9.0).
- **Inventarie cada chamada `HasData`.** Faca grep no codigo: `grep -rn "HasData" .` (ou `findstr /s HasData *.cs` no Windows). Para cada uma, decida manter ou mover usando a regra abaixo.
- **Classifique cada seed.** Mantenha no `HasData` se o dado for pequeno, fixo, deterministico, com chave escrita a mao e algo sem o qual o schema nao faz sentido (enums de status de pedido, codigos de pais ISO). Mova para `UseSeeding` se tiver chaves geradas pelo banco de dados, valores calculados ou nao deterministicos, logica condicional, propriedades de navegacao ou transformacoes externas.
- **Faca backup da producao, ou ensaie sobre uma copia restaurada.** Voce esta prestes a gerar uma migracao que emite instrucoes `DELETE`. Nao descubra o comportamento dela em producao.
- **Tenha um banco de dados de staging que ja tenha as linhas `HasData` aplicadas.** Voce precisa ver o que a migracao de remocao faz sobre um banco de dados que foi semeado do jeito antigo, nao apenas sobre um vazio.

## Passos da migracao

A ordem importa. Fazer isso na sequencia errada e exatamente como voce apaga dados de referencia de producao.

### 1. Escreva primeiro os callbacks UseSeeding e UseAsyncSeeding

Adicione o novo caminho de seeding antes de apagar qualquer coisa. Ambos os overloads, logica identica, verificacao de existencia no topo de cada um. Fatore o corpo em metodos compartilhados para que as versoes sincrona e async nao divirjam:

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedStatuses(context))
        .UseAsyncSeeding((context, _, ct) => SeedStatusesAsync(context, ct)));

static void SeedStatuses(DbContext context)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToHashSet();

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        context.SaveChanges();
    }
}

static async Task SeedStatusesAsync(DbContext context, CancellationToken ct)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = await context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToListAsync(ct);

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        await context.SaveChangesAsync(ct);
    }
}
```

Note que esta versao nao fixa mais `Id` a mao. O banco de dados atribui. E esse o ponto todo: se voce antes atribuia chaves a mao no `HasData`, referencias de chave estrangeira existentes podem apontar para esses valores especificos, o que e o que torna o passo 2 delicado.

**Verifique:** rode a aplicacao contra um banco de dados local vazio com as chamadas `HasData` ainda presentes. Ela deve iniciar de forma limpa sem linhas duplicadas. A verificacao de existencia deve fazer um segundo inicio nao fazer nada (uma consulta de leitura, zero escritas).

### 2. Decida como preservar as linhas existentes antes de remover o HasData

Este e o passo que todos pulam e depois lamentam. Quando voce apaga uma chamada `HasData` e roda `dotnet ef migrations add`, o EF gera um `DeleteData` no metodo `Up` para cada linha previamente semeada:

```csharp
// .NET 11, EF Core 11 -- what removing HasData generates
migrationBuilder.DeleteData(
    table: "OrderStatuses",
    keyColumn: "Id",
    keyValues: new object[] { 1, 2, 3 });
```

Em um banco de dados existente, esse `DELETE` roda. Se outras tabelas tiverem chaves estrangeiras apontando para essas linhas, o delete ou falha com um erro `FOREIGN KEY constraint failed` ou, pior, cascateia. Voce tem tres opcoes seguras:

- **A. Mantenha as chaves estaveis e deixe o seed reinserir.** Se as linhas forem dados de referencia puros sem chaves estrangeiras de entrada, deixar a migracao apaga-las e o `UseSeeding` reinseri-las no proximo inicio esta tudo bem, mas as novas chaves vao diferir (geradas pelo banco de dados), entao isso so e seguro quando nada referencia as chaves antigas.
- **B. Edite a mao a migracao gerada para remover o `DeleteData`.** Depois de `dotnet ef migrations add RemoveStatusSeed`, abra o arquivo gerado e apague a chamada `DeleteData` (e o `InsertData` correspondente em `Down`). As linhas ficam; apenas o snapshot do modelo para de rastrea-las. Esta e a opcao mais segura quando chaves estrangeiras referenciam as linhas semeadas e voce quer deixa-las intactas.
- **C. Preserve as chaves no novo seeder.** Se voce precisa manter os valores exatos de chave (porque chaves estrangeiras dependem deles), continue atribuindo-os explicitamente no `UseSeeding` e ainda assim edite a mao removendo o `DeleteData`. Voce perde o beneficio da chave gerada pelo banco de dados para esta tabela, mas mantem a integridade referencial.

Para qualquer coisa com chaves estrangeiras de entrada, a opcao B e quase sempre o que voce quer. As linhas nao precisam se mover; apenas a propriedade delas.

**Verifique:** depois de gerar a migracao de remocao, leia o arquivo gerado antes de aplica-lo. Confirme que as chamadas `DeleteData` visam exatamente as linhas que voce espera, e que voce escolheu e aplicou A, B ou C para cada tabela.

### 3. Remova as chamadas HasData de OnModelCreating

Agora apague o bloco `HasData` dos seeds que voce esta movendo:

```csharp
// Before -- .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}

// After -- the HasData block is gone; seeding lives in UseSeeding now
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    // OrderStatus seeding moved to UseSeeding in Program.cs
}
```

**Verifique:** o projeto ainda compila, e `dotnet ef migrations has-pending-model-changes` reporta uma mudanca pendente (o seed removido) que voce esta prestes a capturar.

### 4. Gere e revise a migracao de remocao

```bash
# .NET 11, EF Core 11
dotnet ef migrations add RemoveOrderStatusSeed
```

Abra a migracao gerada e aplique sua decisao do passo 2. Se voce escolheu a opcao B, apague o `DeleteData` de `Up` e o `InsertData` correspondente de `Down`. Deixe intactas as mudancas do snapshot do modelo; essas estao corretas e necessarias.

**Verifique:** rode `dotnet ef migrations script` contra seu banco de dados de staging e leia o SQL. Confirme que nenhum `DELETE FROM OrderStatuses` inesperado sobrevive se sua intencao era preservar as linhas.

### 5. Aplique contra staging e confirme que os dados sobrevivem

```bash
# .NET 11, EF Core 11
dotnet ef database update
```

Depois inicie a aplicacao para que `UseAsyncSeeding` rode.

**Verifique:** consulte a tabela. As linhas de referencia estao presentes exatamente uma vez. Inicie a aplicacao uma segunda vez e confirme que nenhum duplicado apareceu, o que prova que a verificacao de existencia funciona. Se chaves estrangeiras referenciam as linhas, confirme que essas relacoes estao intactas.

## Teste de fumaca pos-migracao

Rode esta checklist contra staging antes de enviar:

- `dotnet build` tem sucesso sem `PendingModelChangesWarning`.
- `dotnet ef migrations has-pending-model-changes` nao reporta nada pendente.
- A aplicacao inicia via seu caminho async (`await context.Database.MigrateAsync()`) e as linhas semeadas existem uma vez.
- `dotnet ef database update` sobre um banco de dados novo tambem semeia corretamente (isso exercita o `UseSeeding` sincrono, que o tooling chama).
- Reiniciar a aplicacao nao insere nada novo (a idempotencia se mantem).
- As relacoes de chave estrangeira que apontavam para as chaves antigas do seed ainda resolvem.
- Nenhuma tabela mostra o sintoma de migracao fantasma: adicionar uma migracao nova nao produz nenhum `InsertData`/`DeleteData` relacionado ao seed.

## Plano de rollback

Esta migracao e reversivel, mas leia as letras miudas. Se voce escolheu a opcao B (editou a mao removendo o `DeleteData`), o `Down` a nivel de schema nao faz nada para os dados, entao reverter a migracao deixa as linhas no lugar e simplesmente restaura o snapshot do modelo. Readicionar o bloco `HasData` e gerar uma migracao nova te devolve ao mundo antigo, embora o EF va querer fazer `InsertData` de qualquer linha que estiver faltando.

Se voce escolheu a opcao A (deixou o apagar-e-ressemear acontecer), o rollback e mais arriscado: as linhas agora tem chaves geradas pelo banco de dados, entao reverter para um modelo `HasData` que espera chaves fixas nao vai bater. Nesse caso, nao tente um rollback in-place de dados ao vivo. Restaure do backup que voce fez no passo pre-voo. E por isso que o backup pre-voo nao e opcional.

## Armadilhas que enfrentamos

- **O delete cascateou atraves de uma chave estrangeira.** Uma tabela `Order` referenciava `OrderStatus.Id`. O `DeleteData` da migracao de remocao disparou um `FOREIGN KEY constraint failed`, o que ao menos falha ruidosamente. Se a relacao tivesse sido configurada com delete em cascata, ela teria levado os pedidos junto silenciosamente. A opcao B (editar removendo o `DeleteData`) e a correcao. Veja a [correcao de FOREIGN KEY constraint failed](/pt-br/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) para a mecanica de por que o delete se propaga.
- **Apenas o overload async foi implementado, entao `dotnet ef database update` nao semeou nada.** O tooling chama o `UseSeeding` sincrono. A aplicacao funcionava em producao (caminho de inicializacao async) mas o `database update` da CI produziu uma tabela de lookup vazia e os testes de integracao falharam. Implemente ambos, sempre.
- **A verificacao de existencia consultava um `DateTime`, nao uma chave.** Alguem escreveu a guarda como `if (!context.Set<User>().Any(u => u.CreatedAt == seedTime))`. Como `CreatedAt` era `DateTime.UtcNow`, a verificacao nunca batia e o seeder inseria um novo admin a cada inicio. Faca a guarda sobre uma chave natural estavel (o email, o nome do status), nunca sobre uma coluna nao deterministica. O padrao completo esta em [como semear dados com UseSeeding e UseAsyncSeeding](/pt-br/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).
- **Semear na inicializacao de cada instancia exigia permissao de escrita em todo lugar.** `UseSeeding` roda em `Migrate` em cada replica. Se seus pods de aplicacao de producao rodam com permissoes de banco de dados majoritariamente de leitura, o callback do seed lanca. Para producao, prefira um passo de inicializacao unica em tempo de implantacao em vez de semear a cada inicio; `UseSeeding` brilha para dev local e testes.
- **Um movimento parcial deixou uma linha `HasData` da qual outros seeds dependiam.** Migrar metade dos seeds significou que uma insercao de callback de inicializacao referenciava uma linha de lookup que a migracao de remocao acabara de apagar. Mova juntos os seeds dependentes, ou mantenha o lookup no `HasData` e mova apenas os dados dependentes.

Se suas entidades sao records, nada disso muda: [records funcionam corretamente com EF Core 11](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/) sob tanto `HasData` quanto `UseSeeding`. E se voce esta ajustando a camada de dados enquanto esta aqui, a mesma disciplina de "o que roda e quando" aparece em [os interceptores do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).

## Relacionados

- [HasData vs UseSeeding para semear dados no EF Core 11](/pt-br/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/)
- [Como semear dados com UseSeeding e UseAsyncSeeding no EF Core 11](/pt-br/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [Migrar do EF Core 6 para o EF Core 11: breaking changes que realmente mordem](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix: FOREIGN KEY constraint failed ao deletar uma entidade no EF Core 11](/pt-br/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [Como usar records com EF Core 11 corretamente](/pt-br/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## Fontes

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)
