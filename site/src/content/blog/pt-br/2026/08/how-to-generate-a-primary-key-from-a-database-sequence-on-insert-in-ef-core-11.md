---
title: "Como gerar uma chave primária a partir de uma sequência do banco de dados no insert no EF Core 11"
description: "Tire uma chave do IDENTITY e coloque em uma sequência do SQL Server no EF Core 11 com UseSequence: o SQL exato que o EF emite, por que valores de chave explícitos de repente funcionam sem IDENTITY_INSERT, a sequência bigint alimentando uma coluna int e as lacunas que você precisa considerar no design."
pubDate: 2026-08-17
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "primary-keys"
  - "migrations"
  - "dotnet-11"
  - "how-to"
lang: "pt-br"
translationOf: "2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-17
---

Resposta curta: chame `UseSequence` na propriedade da chave. O EF Core coloca a propriedade em `ValueGenerated.OnAdd`, dá à coluna uma restrição `DEFAULT (NEXT VALUE FOR [schema].[SequenceName])` na migração e lê o valor gerado de volta com uma cláusula `OUTPUT` no insert. Custa exatamente o mesmo número de idas e voltas que o `IDENTITY`, agrupa em lotes do mesmo jeito, e permite inserir valores de chave explícitos sem `SET IDENTITY_INSERT`. As duas coisas que mordem são o tipo da sequência (o EF cria uma sequência `bigint` a menos que você a declare) e as lacunas, que o SQL Server documenta como inevitáveis.

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Order>()
    .Property(o => o.Id)
    .UseSequence("OrderNumbers", "shared");
```

O SQL deste artigo foi capturado do próprio `ICommandBatchPreparer` do EF Core e de `GenerateCreateScript()` usando **EF Core 10.0.11 sobre o SDK do .NET 10.0.201**, já que o EF Core 11 exige o runtime do .NET 11 e esta máquina não o tem. Isso importa menos do que o normal: as [notas de versão do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) não contêm nenhuma entrada sobre sequências ou geração de valores de chave, e `SqlServerPropertyBuilderExtensions.UseSequence` está inalterado na `main`. Cada instrução abaixo é a saída real do EF, não algo que eu redigitei. O comportamento que exige um servidor em execução para ser observado (lacunas por rollback, perda de cache) é citado da documentação do SQL Server e marcado como tal.

## Por que você tiraria uma chave do IDENTITY

`IDENTITY` é o padrão do SQL Server e serve bem para a maioria das tabelas. Três situações empurram as pessoas para fora dele:

- **Duas tabelas precisam consumir do mesmo espaço de numeração.** Pedidos e faturas que nunca podem compartilhar um número de documento não podem ter cada um o seu próprio `IDENTITY`. Uma sequência não está associada a uma tabela, então as duas podem puxar dela.
- **Você precisa do valor antes do insert.** `NEXT VALUE FOR` pode ser chamado sozinho, então você consegue reservar uma chave, montar um documento em volta dela e inserir depois. `IDENTITY` só produz um valor como efeito colateral de um insert.
- **Você importa linhas com chaves já atribuídas.** Com `IDENTITY`, cada insert desse tipo precisa de `SET IDENTITY_INSERT dbo.Orders ON` em volta, um interruptor com escopo de conexão e de uma tabela por vez que o EF não gerencia para você. Com uma sequência a coluna é uma coluna comum com um valor padrão, então um valor explícito simplesmente entra.

## A versão de duas linhas

Declare a sequência e depois aponte a chave para ela:

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.HasSequence<int>("DocumentNumbers", schema: "shared")
        .StartsAt(1000)
        .IncrementsBy(1);

    modelBuilder.Entity<Order>()
        .Property(o => o.Id)
        .UseSequence("DocumentNumbers", "shared");

    modelBuilder.Entity<Invoice>()
        .Property(i => i.Id)
        .UseSequence("DocumentNumbers", "shared");
}
```

`UseSequence` define três coisas na propriedade: a estratégia de geração de valores como `SqlServerValueGenerationStrategy.Sequence`, o nome e o esquema da sequência, e `ValueGenerated.OnAdd`. Ele também limpa qualquer configuração anterior de hi-lo ou de semente de identity. Despejar o modelo confirma:

```text
Order.Id:   ValueGenerated=OnAdd, Strategy=Sequence, DefaultValueSql=NEXT VALUE FOR [shared].[DocumentNumbers]
Invoice.Id: ValueGenerated=OnAdd, Strategy=Sequence, DefaultValueSql=NEXT VALUE FOR [shared].[DocumentNumbers]
```

Repare que o EF preencheu `DefaultValueSql` para você. Você não escreveu essa string, e não deve escrevê-la quando usa `UseSequence`.

## O que a migração produz

`dotnet ef migrations add Initial` te dá uma chamada a `CreateSequence` mais um `defaultValueSql` na coluna:

```csharp
// .NET 11, EF Core 11 migration output
migrationBuilder.EnsureSchema(name: "shared");

migrationBuilder.CreateSequence<int>(
    name: "DocumentNumbers",
    schema: "shared",
    startValue: 1000L);

migrationBuilder.CreateTable(
    name: "Orders",
    columns: table => new
    {
        Id = table.Column<int>(type: "int", nullable: false,
            defaultValueSql: "NEXT VALUE FOR [shared].[DocumentNumbers]"),
        Name = table.Column<string>(type: "nvarchar(max)", nullable: false)
    },
    constraints: table =>
    {
        table.PrimaryKey("PK_Orders", x => x.Id);
    });
```

O que chega no banco de dados como:

```sql
-- SQL Server, generated by EF Core
CREATE SEQUENCE [shared].[DocumentNumbers] AS int START WITH 1000 INCREMENT BY 1 NO CYCLE;

CREATE TABLE [Orders] (
    [Id] int NOT NULL DEFAULT (NEXT VALUE FOR [shared].[DocumentNumbers]),
    [Name] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Não há `IDENTITY` na coluna. É um `int` comum com uma restrição de valor padrão.

## O INSERT que o EF realmente envia

Esta é a parte que as pessoas erram quando raciocinam a partir de primeiros princípios. Uma chave por sequência **não** custa uma ida e volta extra. O EF omite a coluna do insert, deixa o valor padrão disparar e lê o valor de volta na mesma instrução:

```sql
-- one Order, EF Core 11
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
```

Adicione três pedidos em um único `SaveChangesAsync` e o EF usa a mesma forma `MERGE ... OUTPUT` que usa para `IDENTITY`, de modo que as chaves retornadas podem ser correlacionadas às entidades rastreadas por posição:

```sql
-- three Orders in one batch, EF Core 11
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
MERGE [Orders] USING (
VALUES (@p0, 0),
(@p1, 1),
(@p2, 2)) AS i ([Name], _Position) ON 1=0
WHEN NOT MATCHED THEN
INSERT ([Name])
VALUES (i.[Name])
OUTPUT INSERTED.[Id], i._Position;
```

Byte a byte, é isso que uma chave `IDENTITY` também produz. Mudar para uma sequência não muda nada na estratégia de lotes do EF, então se você estava preocupado com um `SELECT NEXT VALUE FOR` por linha, pode parar. Isso só acontece com `UseHiLo`, que é uma estratégia diferente (mais sobre isso abaixo). Se quiser ver isso no seu próprio modelo, [registrar o SQL que o EF Core gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) leva umas quatro linhas de configuração.

## Valores de chave explícitos, o motivo pelo qual a maioria dos times muda

Defina a chave você mesmo e o EF percebe que a propriedade não está mais no valor padrão do CLR, inclui a coluna no insert e remove a cláusula `OUTPUT`:

```csharp
// .NET 11, C# 14, EF Core 11
db.Orders.Add(new Order { Id = 5000, Name = "imported" });
await db.SaveChangesAsync();
```

```sql
INSERT INTO [Orders] ([Id], [Name])
VALUES (@p0, @p1);
```

Uma chave `IDENTITY` gera a instrução *idêntica*, e o SQL Server a rejeita com `Cannot insert explicit value for identity column in table 'Orders' when IDENTITY_INSERT is set to OFF` a menos que você mesmo alterne `IDENTITY_INSERT` em volta da chamada. Contra uma coluna apoiada por sequência não há nada para alternar: a coluna tem um valor padrão, e fornecer um valor simplesmente o sobrescreve. Essa é a diferença prática, e é por isso que o código de importação e de migração de dados fica bem mais curto depois da mudança.

Duas ressalvas sobre isso:

**Zero não é um valor explícito.** O EF decide "o usuário definiu a chave" comparando com o valor padrão do CLR. `new Order { Id = 0 }` é indistinguível de `new Order { }`, então a sequência dispara:

```sql
-- Order { Id = 0, Name = "zero" }
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
```

Se zero é uma chave legítima nos seus dados, torne a propriedade anulável no modelo ou use um valor que não seja o padrão do CLR.

**Misturar os dois quebra o lote.** Adicione uma entidade com chave explícita e outra sem, e o EF emite duas instruções separadas em vez de um `MERGE`, com a linha gerada primeiro:

```sql
SET NOCOUNT ON;
INSERT INTO [Orders] ([Name])
OUTPUT INSERTED.[Id]
VALUES (@p0);
INSERT INTO [Orders] ([Id], [Name])
VALUES (@p1, @p2);
```

Ainda é uma ida e volta, mas o ganho do lote se foi. Para uma importação em massa, mantenha os inserts com chave explícita na própria chamada de `SaveChanges`. Se a vazão é o ponto principal, vale olhar os números de [EF Core 11 vs Dapper para inserções em massa](/pt-br/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/) antes de ajustar mais isso.

## A sequência bigint alimentando uma coluna int

Este é o fio da navalha. `UseSequence` vai tranquilamente nomear uma sequência que você nunca declarou, e o EF a cria para você com o tipo padrão do SQL Server, que é `bigint`:

```csharp
// no HasSequence call anywhere in the model
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence("OrderNumbers");
```

```sql
CREATE SEQUENCE [OrderNumbers] START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE [Docs] (
    [Id] int NOT NULL DEFAULT (NEXT VALUE FOR [OrderNumbers]),
    ...
);
```

Sem `AS int`. A [documentação de CREATE SEQUENCE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql) é explícita: "If no data type is provided, the bigint data type is used as the default." Uma sequência `bigint` alimentando uma coluna `int` funciona bem nos primeiros 2.147.483.647 valores e depois começa a entregar à coluna números que ela não consegue armazenar. Para a maioria das tabelas isso está muito longe, mas até lá é uma configuração incorreta silenciosa, e não vai aparecer em nenhum teste.

Declare a sequência com o tipo que você quer e a divergência desaparece:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.HasSequence<int>("OrderNumbers").StartsAt(1000);
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence("OrderNumbers");
```

```sql
CREATE SEQUENCE [OrderNumbers] AS int START WITH 1000 INCREMENT BY 1 NO CYCLE;
```

Regra prática: nunca deixe o `UseSequence` criar a sequência implicitamente. Sempre pareie com um `HasSequence<T>` que nomeie a mesma sequência.

## Nomes, e uma linha errada na documentação

Chame `UseSequence()` sem argumentos e o EF nomeia a sequência para você:

```csharp
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence();
// -> CREATE SEQUENCE [DocSequence] ...
```

A documentação XML do parâmetro `nameSuffix` diz que ele é "the name that will suffix the table name". Não é. Renomeie a tabela e o nome da sequência não se move:

```csharp
modelBuilder.Entity<Doc>().ToTable("ArchivedDocuments");
modelBuilder.Entity<Doc>().Property(d => d.Id).UseSequence();
// -> CREATE SEQUENCE [DocSequence]
// -> CREATE TABLE [ArchivedDocuments] ([Id] int NOT NULL DEFAULT (NEXT VALUE FOR [DocSequence]), ...)
```

O nome vem do nome curto do tipo de entidade CLR mais o sufixo, que por padrão é `"Sequence"`. Renomeie a classe e o nome da sua sequência muda por baixo dos panos, que é exatamente o tipo de coisa que produz um par surpresa de `DropSequence` mais `CreateSequence` em uma migração. Nomeie suas sequências explicitamente.

Também existe um interruptor no nível do modelo, que dá a cada chave a sua própria sequência:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.UseKeySequences();
// -> CREATE SEQUENCE [DocSequence] ...
// -> CREATE SEQUENCE [NoteSequence] ...
// -> [Docs].[Id]  int    DEFAULT (NEXT VALUE FOR [DocSequence])
// -> [Notes].[Id] bigint DEFAULT (NEXT VALUE FOR [NoteSequence])
```

A mesma ressalva sobre `bigint` vale para cada sequência que ele cria.

## UseSequence vs HasDefaultValueSql

A [documentação de sequências do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/sequences) mostra a abordagem mais antiga, escrevendo a expressão padrão à mão:

```csharp
modelBuilder.HasSequence<int>("OrderNumbers").StartsAt(1000);
modelBuilder.Entity<Doc>()
    .Property(d => d.Id)
    .HasDefaultValueSql("NEXT VALUE FOR OrderNumbers");
```

O SQL de inserção é idêntico byte a byte ao de `UseSequence`. As diferenças estão no modelo:

| | `UseSequence` | `HasDefaultValueSql` |
| --- | --- | --- |
| `ValueGenerated` | `OnAdd` | `OnAdd` |
| Estratégia | `Sequence` | `None` |
| SQL padrão | o EF gera, delimitado | o seu, emitido literalmente |
| Renomear a sequência | atualize uma chamada a `HasSequence` | atualize a string também, em todos os lugares |

Aquela linha de "emitido literalmente" importa. Sua string chega no DDL exatamente como foi digitada, sem delimitadores:

```sql
[Id] int NOT NULL DEFAULT (NEXT VALUE FOR OrderNumbers)
```

O que quebra no momento em que a sequência vive em um esquema com um nome que precisa ser delimitado, ou alguém coloca um espaço. `UseSequence` produz `NEXT VALUE FOR [shared].[DocumentNumbers]` com os colchetes já no lugar. Prefira `UseSequence` para chaves. Guarde `HasDefaultValueSql` para colunas que não são chave, que `UseSequence` não suporta.

## Colunas que não são chave: números de pedido e de fatura

Uma variante comum é uma chave substituta `IDENTITY` mais um número visível para humanos vindo de uma sequência. `HasDefaultValueSql` é a ferramenta certa aqui:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.HasSequence<int>("TicketNumbers").StartsAt(500).IncrementsBy(10);

modelBuilder.Entity<Ticket>()
    .Property(t => t.TicketNumber)
    .HasDefaultValueSql("NEXT VALUE FOR TicketNumbers");
```

O EF adiciona a coluna à lista de `OUTPUT` quando você a deixa sem definir, e a move para a lista de colunas quando você a define:

```sql
-- new Ticket { Name = "t1" }
INSERT INTO [Tickets] ([Name])
OUTPUT INSERTED.[Id], INSERTED.[TicketNumber]
VALUES (@p0);

-- new Ticket { Name = "t2", TicketNumber = 42 }
INSERT INTO [Tickets] ([Name], [TicketNumber])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1);
```

Mesma regra do padrão do CLR: `TicketNumber = 0` é lido como não definido.

## Lacunas são garantidas, então projete pensando nelas

Se alguma parte do seu sistema trata a chave como um contador sem lacunas, uma sequência vai quebrar isso, e o `IDENTITY` também quebraria. A [documentação de CREATE SEQUENCE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql) diz sem rodeios: "Sequence numbers are generated outside the scope of the current transaction. They're consumed whether the transaction using the sequence number is committed or rolled back."

Existe uma segunda fonte de lacunas. Sequências vêm com `CACHE` por padrão, e o SQL Server prealoca um bloco de valores em memória, persistindo apenas o limite do bloco. Segundo a mesma documentação, "an unexpected shutdown (such as a power failure) might result in the loss of sequence numbers remaining in the cache." Uma queda pode, portanto, queimar um bloco de cache inteiro.

`NO CACHE` estreita a janela ao custo de uma escrita em tabela de sistema por valor, e mesmo assim a documentação observa que "gaps can still occur if numbers are requested using the NEXT VALUE FOR or sp_sequence_get_range functions, but then the numbers are either not used or are used in uncommitted transactions."

A API fluente do EF não consegue expressar isso. `SequenceBuilder` expõe `StartsAt`, `IncrementsBy`, `HasMin`, `HasMax` e `IsCyclic`, e nada mais. Recorra a SQL bruto na migração:

```csharp
// .NET 11, EF Core 11
migrationBuilder.Sql("ALTER SEQUENCE [shared].[DocumentNumbers] NO CACHE;");
```

Faça isso apenas onde um regulador estiver pedindo, não por padrão. Se você precisa de um número de documento legal genuinamente sem lacunas, gere-o em uma tabela transacional separada, não a partir de uma sequência.

## UseSequence vs UseHiLo

`UseHiLo` é a outra estratégia apoiada em sequências e se comporta de forma completamente diferente:

```csharp
modelBuilder.Entity<HiLoOrder>().Property(h => h.Id).UseHiLo("HiLoOrderSequence");
// -> CREATE SEQUENCE [HiLoOrderSequence] START WITH 1 INCREMENT BY 10 NO CYCLE;
// -> [HiLoOrders].[Id] int NOT NULL   (no default constraint)
```

A coluna não recebe valor padrão. O EF chama a sequência uma vez para reservar um bloco de dez e depois distribui chaves desse bloco no cliente. Isso significa que as chaves são conhecidas antes do insert (útil quando você está construindo um grafo de objetos em memória), ao custo de uma ida e volta separada sempre que um bloco se esgota, e de lacunas bem maiores sempre que um `DbContext` é descartado no meio de um bloco. `UseSequence` mantém a geração no servidor; `UseHiLo` a move para o cliente. Escolha `UseSequence` a menos que você precise especificamente ter a chave em mãos antes de `SaveChanges`.

## Convertendo uma tabela IDENTITY existente

`ALTER TABLE ... ALTER COLUMN` não consegue adicionar nem remover a propriedade `IDENTITY`. A [restrição documentada](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) só permite mudar o tipo de uma coluna identity existente, para outro tipo que suporte a propriedade identity. Então não existe migração no lugar; a coluna precisa ser substituída. Passos:

1. Leia a marca d'água atual com `SELECT ISNULL(MAX(Id), 0) FROM dbo.Orders`, e some uma margem de segurança para as linhas inseridas entre a leitura e a virada.
2. Adicione `modelBuilder.HasSequence<int>("DocumentNumbers", "shared").StartsAt(<high-water mark + margin>)` e `UseSequence("DocumentNumbers", "shared")` na chave, e então gere uma migração.
3. Substitua o corpo gerado por SQL que cria a sequência, monta uma tabela nova cujo `Id` tem o valor padrão da sequência, copia as linhas com `INSERT INTO ... SELECT`, remove a tabela antiga e renomeia a nova. As chaves estrangeiras que apontam para a tabela precisam ser removidas e recriadas em volta da troca.
4. Rode a migração dentro de uma transação e verifique depois que `SELECT current_value FROM sys.sequences WHERE name = 'DocumentNumbers'` fica acima da maior chave existente.

Dois detalhes que vale conhecer. A semeadura com `HasData` não encaixa neste modelo, porque o EF exige valores de chave literais nos dados de seed e não deixa semear implicitamente uma chave gerada pelo armazenamento, que é a origem de [a entidade de seed não pode ser adicionada porque é exigido um valor diferente de zero](/pt-br/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/); com uma sequência você pode simplesmente fornecer as chaves, já que valores explícitos são legais. E se você já vai escrever SQL de migração editado à mão para a troca de tabelas, vale o mesmo cuidado de quando se está [renomeando uma tabela em uma migração do EF Core 11 sem perder dados](/pt-br/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/): a saída gerada para mudanças estruturais é um ponto de partida, não a resposta.

Uma última coisa para conferir depois de tudo isso: rode `dotnet ef migrations add` de novo e confirme que ele produz uma migração vazia. Uma sequência cujo tipo no modelo não bate com o tipo no banco de dados, ou uma sequência de nome implícito que se moveu quando uma classe foi renomeada, aparece como um `DropSequence` mais `CreateSequence` fantasma em toda geração. Colunas `rowversion` produzem a mesma classe de diferença fantasma pelo mesmo motivo, e o passo a passo em [concorrência otimista com um token rowversion no EF Core 11](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) cobre como ler as anotações em vez do DDL quando você está rastreando uma.

## Fontes

- [Sequências, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/modeling/sequences)
- [Geração de valores no SQL Server, documentação do EF Core](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/value-generation)
- [CREATE SEQUENCE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-sequence-transact-sql)
- [ALTER TABLE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql)
- [Novidades do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Código-fonte de `SqlServerPropertyBuilderExtensions.UseSequence`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Extensions/SqlServerPropertyBuilderExtensions.cs)
- [Código-fonte de `SqlServerModelBuilderExtensions.UseKeySequences`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Extensions/SqlServerModelBuilderExtensions.cs)
