---
title: "Coluna json nativa vs nvarchar(max) para armazenar JSON no SQL Server com EF Core 11"
description: "Use o tipo json nativo no SQL Server 2025 e no Azure SQL: com ele o EF Core 11 ganha JSON_CONTAINS, JSON_VALUE tipado, modify() in-place e índices JSON. Fique no nvarchar(max) para SQL Server 2019/2022, ferramentas legadas ou um schema que você precisa conseguir reverter."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "json"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

Resposta curta: se o seu banco de dados é SQL Server 2025 ou Azure SQL, armazene JSON no tipo nativo `json`. Com ele, o EF Core 11 emite `JSON_VALUE(... RETURNING int)` tipado, traduz `Contains` em uma coleção primitiva para `JSON_CONTAINS`, executa `ExecuteUpdate` pelo método in-place `.modify()` e consegue criar um `CREATE JSON INDEX`. Nada disso funciona com `nvarchar(max)`. Fique no `nvarchar(max)` se você roda SQL Server 2019 ou 2022, tem ferramentas que leem a coluna em formato bruto (formato nativo do bcp, clientes ODBC antigos) ou precisa de uma mudança de schema que possa ser revertida: o SQL Server se recusa a fazer `ALTER` de uma coluna `json` de volta para um tipo string.

Tudo o que está abaixo foi verificado com `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 no SDK do .NET 11 RC 1 (11.0.100-rc.1.26425.128), com C# 14. O comportamento do lado do servidor vem da documentação do SQL Server 2025 (17.x).

## A comparação em resumo

| | `json` (nativo) | `nvarchar(max)` |
| --- | --- | --- |
| Disponível em | SQL Server 2025, Azure SQL Database, Azure SQL MI, SQL database no Fabric | Todas as versões do SQL Server |
| Padrão do EF Core 11 quando | `UseAzureSql`, ou `UseCompatibilityLevel(170)` | `UseSqlServer` (nível padrão 160) |
| Armazenamento | Binário já parseado, UTF-8 (`Latin1_General_100_BIN2_UTF8`), até 2 GB | Texto UTF-16 |
| Validação na escrita | Sempre; o nível superior deve ser um objeto ou array | Nenhuma, a menos que você adicione `CHECK (ISJSON(...) = 1)` |
| SQL de filtro escalar | `JSON_VALUE(col, '$.x' RETURNING int)` | `CAST(JSON_VALUE(col, '$.x') AS int)` |
| `tags.Contains("x")` | `JSON_CONTAINS(col, N'x') = 1` | `N'x' IN (SELECT ... FROM OPENJSON(col) ...)` |
| `ExecuteUpdate` em uma propriedade | `SET [col].modify('$.x', ...)` | `SET col = JSON_MODIFY(col, '$.x', ...)` |
| `CREATE JSON INDEX` | Sim (SQL Server 2025, preview) | Não |
| Tipo de parâmetro que o EF envia | `SqlDbType.Json` | `SqlDbType.NVarChar` |
| Converter de volta com `ALTER COLUMN` | Não permitido | N/A |
| O que clientes mais antigos veem | `varchar(max)` ou `nvarchar(max)` | `nvarchar(max)` |

## O que muda quando o EF Core 11 escolhe o tipo json

O EF não decide com base no banco de dados ao qual se conecta. Ele decide com base no nível de compatibilidade que você configura, e faz isso no momento da construção do modelo. Montei uma pequena sonda que configura o mesmo modelo de quatro formas e imprime o DDL e o SQL, com um interceptor que suprime a conexão para que nenhum banco de dados seja necessário:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string[] Tags { get; set; } = [];          // primitive collection, always JSON
    public required Shipping Shipping { get; set; }   // complex type mapped with ToJson()
}

public class Shipping
{
    public string City { get; set; } = "";
    public int Priority { get; set; }
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<Order>().ComplexProperty(o => o.Shipping, s => s.ToJson());
```

Com um `UseSqlServer(connectionString)` simples, o EF Core 11 roda no nível de compatibilidade 160. Esse padrão mudou no EF Core 11: o EF Core 10 usava 150. As duas colunas JSON saem como `nvarchar(max)`:

```sql
-- UseSqlServer, default level 160
CREATE TABLE [Orders] (
    [Id] int NOT NULL,
    [Customer] nvarchar(max) NOT NULL,
    [Tags] nvarchar(max) NOT NULL,
    [Shipping] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Troque para `UseSqlServer(cs, o => o.UseCompatibilityLevel(170))`, ou para `UseAzureSql(cs)` (cujo padrão é 170), e o mesmo modelo produz `[Tags] json NOT NULL` e `[Shipping] json NOT NULL`. Nada mais no seu código muda. Essa é a primeira coisa a internalizar: **passar de `UseSqlServer` para `UseAzureSql` é uma mudança de tipo de coluna**, quer você tenha essa intenção ou não.

As consultas também mudam. Aqui estão as três formas de LINQ que mais importam, como são geradas em cada nível:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
ctx.Orders.Where(o => o.Shipping.Priority > 2);
ctx.Orders.Where(o => o.Tags.Contains("gift"));
await ctx.Orders.Where(o => o.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Shipping.Priority, o => o.Shipping.Priority + 1));
```

No nível 160 (`nvarchar(max)`):

```sql
WHERE CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) > 2

WHERE N'gift' IN (
    SELECT [t].[value]
    FROM OPENJSON([o].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)

UPDATE [o]
SET [o].[Shipping] = JSON_MODIFY([o].[Shipping], '$.Priority', CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

No nível 170 (`json`):

```sql
WHERE JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) > 2

WHERE JSON_CONTAINS([o].[Tags], N'gift') = 1

UPDATE [o]
SET [Shipping].modify('$.Priority', JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

No caminho de escrita, o `SaveChanges` continua enviando o documento inteiro para uma alteração em uma única propriedade (`UPDATE [Orders] SET [Shipping] = @p0`), nos dois níveis. A diferença está no parâmetro: no nível 170, o `Microsoft.Data.SqlClient` 7.0.2 que o EF Core 11 RC 1 traz como dependência o envia como `SqlDbType.Json` em vez de `SqlDbType.NVarChar`. Só o `ExecuteUpdate` recebe a atualização parcial e in-place. Se você quiser capturar esse SQL na sua própria aplicação, [registrar em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) cobre as opções.

## Quando escolher o tipo json nativo

- **Você está no Azure SQL Database ou no Managed Instance.** O tipo está em disponibilidade geral lá com a política de atualização SQL Server 2025 ou Always-up-to-date, e o `UseAzureSql` já o seleciona. Abrir mão dele custa o `JSON_CONTAINS` e a cláusula tipada `RETURNING`, e não traz nenhum ganho.
- **Você está no SQL Server 2025 e filtra dentro dos documentos.** `JSON_VALUE`, `JSON_PATH_EXISTS` e `JSON_CONTAINS` podem usar um índice JSON, e o EF Core 11 agora consegue criar um a partir do modelo (próxima seção). Com `nvarchar(max)`, sua única opção de índice é uma coluna computada por caminho.
- **Você atualiza em massa campos dentro dos documentos.** O `ExecuteUpdate` vira `.modify()`, que a Microsoft documenta como uma atualização in-place quando o novo valor cabe: uma string não maior que a antiga, ou um número do mesmo tipo ou faixa. O `JSON_MODIFY` sobre texto reescreve o valor.
- **Você quer que o banco de dados rejeite lixo.** Uma coluna `json` recusa qualquer coisa que não seja um objeto ou array bem formado. Com `nvarchar(max)`, essa verificação só existe se você mesmo a adicionar.

## Quando ficar no nvarchar(max)

- **Seu servidor de produção é SQL Server 2019 ou 2022.** O tipo não existe lá, e o EF só o usa se você aumentar o nível de compatibilidade, então mantenha o nível padrão 160 ou defina 150 explicitamente.
- **Algo fora do EF lê a coluna.** A documentação de `json` do SQL Server observa que `sp_describe_first_result_set` não reporta o tipo `json`. Clientes em TDS 7.4 ou posterior veem `varchar(max)` com uma collation UTF-8, e os mais antigos veem `nvarchar(max)`. O formato nativo do bcp grava o documento como texto, então você precisa de um arquivo de formato para carregá-lo de volta. Pacotes de ETL com metadados de coluna fixos no código costumam ser as vítimas.
- **Você precisa de uma migração reversível.** Você pode fazer `ALTER` de `nvarchar(max)` para `json`, mas o SQL Server não permite que um `ALTER TABLE` transforme uma coluna `json` de volta em um tipo string ou binário. O método `Down()` que o EF gera para a conversão é um simples `ALTER COLUMN ... nvarchar(max)`, então reverter significa adicionar uma nova coluna, copiar os dados e trocar tudo à mão.
- **Suas consultas usam formas que o tipo ainda não suporta.** A nota de breaking change do EF Core 10 destaca uma: `DISTINCT` sobre arrays JSON não é suportado em `json`, e essas consultas falham.

## Evidências: o que eu medi e o que não medi

Não rodei um benchmark de armazenamento nem de latência. Não há uma instância do SQL Server 2025 no meu ambiente de testes, e não vou colocar um número de ganho de velocidade ao lado de um tipo que não cronometrei. O que a sonda acima de fato mostra, para o EF Core 11 RC 1:

1. O tipo de coluna é decidido apenas por `UseAzureSql` ou por um nível de compatibilidade 170 ou superior. O `UseSqlServer` usa 160 como padrão (confirmado em `SqlServerOptionsExtension`, onde `SqlServerDefaultCompatibilityLevel = 160` e `AzureSqlDefaultCompatibilityLevel = 170`).
2. Cada diferença de tradução na tabela acima é o SQL gerado exato, não uma paráfrase das notas de versão.
3. A migração que o EF gera para ir de 160 para 170 é um `ALTER COLUMN` por coluna JSON (o tratamento de default constraints foi omitido):

```sql
-- EF Core 11.0.0-rc.1, model diff from level 160 to level 170
ALTER TABLE [Orders] ALTER COLUMN [Tags] json NOT NULL;
ALTER TABLE [Orders] ALTER COLUMN [Shipping] json NOT NULL;
```

As afirmações sobre armazenamento e leitura são da Microsoft. A [referência do tipo de dados json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type) diz que as leituras são mais eficientes porque o documento já está parseado, que as escritas podem atualizar valores individuais e que o formato binário é "otimizado para compressão". Meça com os seus próprios documentos antes de prometer um número a alguém. Documentos pequenos e planos ganham muito menos do que documentos grandes e aninhados sobre os quais você filtra.

## A pegadinha que escolhe por você: índices JSON

O EF Core 11 adiciona `HasIndex` sobre caminhos dentro de tipos complexos JSON, o que vira o `CREATE JSON INDEX` do SQL Server 2025. Esse é o motivo mais forte para migrar para `json`, e ele tem uma armadilha. Veja o que a sonda imprimiu quando adicionei um índice ao modelo acima:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
mb.Entity<Order>().HasIndex("Shipping.City");
```

No nível 170 você obtém o que quer:

```sql
CREATE JSON INDEX [IX_Orders_Shipping_City] ON [Orders]([Shipping]) FOR (N'$.City');
```

No nível 160, o EF emite **exatamente a mesma instrução**, mesmo que a coluna que ele acabou de criar seja `nvarchar(max)`. O gerador de SQL de migrações não verifica o tipo de armazenamento antes de escrever `CREATE JSON INDEX`. A [referência de CREATE JSON INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) exige uma coluna `json`, então essa migração vai falhar ao ser aplicada. É também por isso que o próprio exemplo da Microsoft fixa o tipo explicitamente:

```csharp
// .NET 11, EF Core 11 - make the column type independent of the compatibility level
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Contact, b => b.ToJson().HasColumnType("json"));

modelBuilder.Entity<Customer>()
    .HasIndex("Contact.Address.City");
```

Mais três restrições vêm do lado do SQL. Os índices JSON estão em preview e documentados apenas para o SQL Server 2025, não para o Azure SQL. A tabela precisa de uma chave primária clusterizada. E um índice só pode ser criado offline, mantendo um lock de modificação de schema durante toda a sua duração. Planeje a janela de migração de acordo; o [fluxo de migrations bundle para produção](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) é a forma segura de executá-la.

Uma observação relacionada para o Azure SQL: a documentação do tipo `json` ainda lista `.modify()` como um recurso em preview disponível apenas no SQL Server 2025, mas o EF o emite para toda coluna `json`, inclusive com `UseAzureSql`. Não consegui testar essa combinação. Antes de depender de `ExecuteUpdate` em propriedades JSON no Azure SQL, execute-o uma vez contra um banco de dados real. Esse descompasso já afetou o EF antes: [o erro `AS JSON` no Azure SQL](/pt-br/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/) veio do EF emitindo `json` em uma cláusula `OPENJSON` que só o SQL Server 2025 aceita. Isso foi corrigido no EF Core 10.0.11.

## Como abrir mão, por coluna ou globalmente

Se você está no Azure SQL mas ainda não está pronto para converter, tem duas chaves. A global reduz o nível de compatibilidade que o EF assume:

```csharp
// .NET 11, EF Core 11 - keep every JSON column on nvarchar(max) on Azure SQL
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

Isso também desliga todas as outras traduções do nível 170, incluindo `JSON_CONTAINS`. A pontual fixa colunas individuais e mantém o resto do modelo no 170:

```csharp
// .NET 11, EF Core 11 - pin specific columns to text, verified to emit nvarchar(max) at level 170
modelBuilder.Entity<Order>()
    .ComplexProperty(o => o.Shipping, s => s.ToJson().HasColumnType("nvarchar(max)"));
modelBuilder.Entity<Order>()
    .PrimitiveCollection(o => o.Tags).HasColumnType("nvarchar(max)");
```

Para ir no sentido contrário em um banco de dados existente, aumente o nível, execute `dotnet ef migrations add ConvertJsonColumns` e leia a migração gerada antes de aplicá-la. Ela altera todas as colunas JSON do modelo de uma vez, coleções primitivas incluídas, o que é fácil de esquecer quando você mapeou apenas um tipo complexo com `ToJson()`. Para o lado de modelagem dessa decisão, [tipos complexos vs entidades owned no EF Core 11](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) explica por que `ComplexProperty(...).ToJson()` é o mapeamento em que você deve estar antes de converter. O `ExecuteUpdate` em JSON só funciona com tipos complexos.

## A recomendação, reafirmada

Escolha `json` no SQL Server 2025 e no Azure SQL. É para lá que o EF Core 11 está indo: `JSON_CONTAINS`, `JSON_VALUE` tipado, `.modify()` e índices JSON dependem dele, e o `UseAzureSql` já o assume. Defina `HasColumnType("json")` explicitamente em qualquer coluna JSON que você indexar, para que uma mudança de nível de compatibilidade nunca produza uma migração que falha. Fique no `nvarchar(max)` quando o servidor for anterior ao 2025, quando ferramentas fora do EF leem a coluna bruta ou quando você ainda não pode aceitar uma mudança de schema sem volta. Nesse último caso, fixe o tipo por coluna em vez de reduzir o nível de compatibilidade do contexto inteiro. Para o lado das consultas depois da conversão, o passo a passo sobre [mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) continua de onde este post para.

## Fontes

- [Tipo de dados json (SQL Server 2025, Azure SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type): formato de armazenamento, `modify`, regras de conversão, limitações
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [Novidades do EF Core 11: índices JSON, JSON_CONTAINS, nível de compatibilidade 160 como padrão](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Novidades do EF Core 10: suporte ao tipo JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Breaking change do EF Core 10: tipo de dados json usado por padrão no Azure SQL e no nível de compatibilidade 170](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [Suporte ao tipo de dados JSON no SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/json-data-sql-server)
- [dotnet/efcore#29623: SQL Server, support JSON indexes](https://github.com/dotnet/efcore/issues/29623)
