---
title: "Correção: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause"
description: "O EF Core emite [col] json '$.path' AS JSON dentro de OPENJSON WITH, e o Azure SQL rejeita com a Msg 13618. Atualize para o EF Core 10.0.11+ ou baixe o nível de compatibilidade do provedor para 160."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "azure"
  - "json"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql"
translatedBy: "claude"
translationDate: 2026-09-09
---

Atualize o `Microsoft.EntityFrameworkCore.SqlServer` para 10.0.11 ou posterior. Antes dessa versão, o EF Core gerava `[col] json '$.path' AS JSON` dentro de uma cláusula `OPENJSON ... WITH` sempre que um tipo complexo mapeado para JSON continha uma coleção aninhada e o provedor rodava no nível de compatibilidade 170. O SQL Server 2025 aceita o tipo nativo `json` nessa posição; o Azure SQL não, e rejeita com a Msg 13618. Se você não puder atualizar, passe `o => o.UseCompatibilityLevel(160)`. Um detalhe: a correção só entra em ação quando o EF sabe que está falando com o Azure SQL, ou seja, quando você chama `UseAzureSql` e não `UseSqlServer` com uma string de conexão do Azure.

## O erro em contexto

A exceção aparece como uma `SqlException` comum na primeira consulta que entra em uma coleção JSON aninhada:

```
Microsoft.Data.SqlClient.SqlException (0x80131904): AS JSON option can be specified only for column of nvarchar(max) type in WITH clause.
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReaderAsync(RelationalCommandParameterObject parameterObject, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.AsyncEnumerator.InitializeReaderAsync(AsyncEnumerator enumerator, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, ...)
   at Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync[TSource](IQueryable`1 source, CancellationToken cancellationToken)
```

O número do erro no servidor é 13618. O SQL que o produziu se parece com isto:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

A linha problemática é `[partNumbers] json '$.partNumbers' AS JSON`. Todo o resto da instrução está correto.

O sinal de que você está na página certa e não em uma parecida: a falha depende do ambiente. O mesmo binário, o mesmo modelo e a mesma consulta funcionam contra uma instância local do SQL Server 2025 e falham contra o Azure SQL, mesmo quando os dois bancos de dados reportam nível de compatibilidade 170.

## Por que isso acontece

Três fatos independentes colidem.

**`AS JSON` sempre exigiu `nvarchar(max)`.** A [referência do OPENJSON](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql) é explícita: "If you specify the `AS JSON` option, the type of the column must be **nvarchar(MAX)**." Essa regra é nove anos mais antiga que o tipo nativo `json`.

**O SQL Server 2025 flexibilizou a regra, o Azure SQL não.** O tipo de dados nativo `json` está disponível de forma geral no Azure SQL Database e no Azure SQL Managed Instance, e em versão prévia no SQL Server 2025. Mas as [limitações do tipo de dados json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations) abrem uma exceção específica para o `OPENJSON`: "Currently, the `OPENJSON()` function doesn't accept the **json** data type in some platforms. Currently, it's an implicit conversion. Explicitly convert to **nvarchar(max)** first. In SQL Server 2025 (17.x), the `OPENJSON()` function does support **json**." Portanto, o tipo `json` em uma cláusula `WITH` é um recurso do SQL Server 2025 local, não do Azure SQL.

**`UseAzureSql` liga o nível de compatibilidade 170 por padrão, e 170 é o que faz o EF escolher o tipo `json`.** Em `SqlServerOptionsExtension`, `SqlServerDefaultCompatibilityLevel` é 160 enquanto `AzureSqlDefaultCompatibilityLevel` é 170. `SqlServerSingletonOptions.SupportsJsonType` retorna true a partir de 170. A consequência prática é que você não precisa optar por nada: trocar `UseSqlServer` por `UseAzureSql` já basta para mover suas colunas JSON para o tipo nativo `json` e começar a emitir `json ... AS JSON` nas consultas geradas.

Antes do EF Core 10.0.11, `SqlServerQuerySqlGenerator.GenerateColumnInfo` escrevia `columnInfo.TypeMapping.StoreType` literalmente para cada coluna da cláusula `WITH`. Quando o tipo de armazenamento era `json` e a coluna carregava `AS JSON`, isso produzia SQL que só o SQL Server 2025 conseguia analisar.

Repare que o formato da consulta importa. Uma coluna JSON que você só lê inteira nunca cai nisso, e um `Where` sobre um escalar dentro do documento também não. `AS JSON` aparece quando a consulta entra em uma coleção aninhada dentro do documento JSON, porque o EF precisa entregar esse array aninhado a uma segunda chamada de `OPENJSON`. Se é a primeira vez que você vê como o EF transforma documentos aninhados em árvores de `OPENJSON`, a mecânica está coberta em [mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/).

## Reprodução mínima

O modelo precisa de um tipo complexo mapeado para JSON, contendo uma coleção de tipos complexos, contendo uma coleção de primitivos. Esse é o formato relatado em [dotnet/efcore#38615](https://github.com/dotnet/efcore/issues/38615):

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
public class Car
{
    public int CarId { get; set; }
    public string Vin { get; set; } = null!;
    public string DealerId { get; set; } = null!;
    public CarConfiguration CarConfiguration { get; set; } = null!;
}

public class CarConfiguration
{
    public string? CurrentTrim { get; set; }
    public List<OptionPackage>? OptionPackages { get; set; }
}

public class OptionPackage
{
    public required string PackageId { get; set; }
    public required ICollection<string> PartNumbers { get; set; }
}
```

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Car>(builder =>
    {
        builder.ToTable("Cars");
        builder.HasKey(e => e.CarId);
        builder.Property(e => e.Vin).IsUnicode(false).HasMaxLength(32);
        builder.Property(e => e.DealerId).IsUnicode(false).HasMaxLength(32);

        builder.ComplexProperty(e => e.CarConfiguration, pp =>
        {
            pp.ToJson("CarConfiguration");
            pp.IsRequired();
            pp.Property(p => p.CurrentTrim).HasJsonPropertyName("currentTrim");

            pp.ComplexCollection(p => p.OptionPackages, op =>
            {
                op.HasJsonPropertyName("optionPackages");
                op.Property(o => o.PackageId).HasJsonPropertyName("packageId");
                op.PrimitiveCollection(o => o.PartNumbers)
                    .ElementType(e => e.IsUnicode(false).HasMaxLength(32))
                    .HasJsonPropertyName("partNumbers");
            });
        });
    });
}
```

Não existe `HasColumnType("json")` nessa configuração de propósito. Você não precisa dele: no nível de compatibilidade 170 o provedor escolhe o tipo nativo sozinho.

A consulta que falha é qualquer projeção que desce dois níveis:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
var options = new DbContextOptionsBuilder<CarContext>()
    .UseAzureSql(connectionString)   // defaults to compatibility level 170
    .Options;

await using var ctx = new CarContext(options);

var partNumbers = await ctx.Cars
    .Where(c => c.Vin == "1FA6P8TH8J5123456" && c.DealerId == "DEALER-001")
    .SelectMany(c => c.CarConfiguration.OptionPackages!)
    .Where(op => op.PackageId == "PKG-SPORT")
    .SelectMany(op => op.PartNumbers)
    .ToListAsync();                  // Msg 13618 on Azure SQL
```

Você não precisa de uma assinatura do Azure para ver o SQL defeituoso. `ToQueryString()` gera sem abrir conexão, então um aplicativo de console descartável com uma string de conexão falsa já basta para confirmar qual formato sua build produz. Rodar esse aparato contra a 10.0.10 imprime a linha `[partNumbers] json '$.partNumbers' AS JSON` mostrada antes.

## A correção, em detalhe

### 1. Atualize para o EF Core 10.0.11 ou posterior

Esta é a correção de verdade e não exige mudanças de modelo nem de consulta. O [dotnet/efcore#38665](https://github.com/dotnet/efcore/pull/38665) entrou no branch `release/10.0` em 2026-07-20 e saiu na 10.0.11 (2026-08-11). O patch atual, 10.0.12, também tem.

```xml
<!-- .NET 10 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="10.0.12" />
```

Mesma reprodução, mesma consulta, `Microsoft.EntityFrameworkCore.SqlServer` 10.0.12 e `UseAzureSql`:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] nvarchar(max) '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

O gerador agora substitui o tipo apenas naquela posição:

```csharp
// dotnet/efcore, SqlServerQuerySqlGenerator.GenerateColumnInfo, release/10.0
if (columnInfo.AsJson
    && columnInfo.TypeMapping.StoreType == "json"
    && (_sqlServerSingletonOptions.EngineType != SqlServerEngineType.SqlServer
        || _sqlServerSingletonOptions.SqlServerCompatibilityLevel < 170))
{
    Sql.Append("nvarchar(max)");
}
else
{
    Sql.Append(columnInfo.TypeMapping.StoreType);
}
```

Nada muda na sua tabela. A coluna continua `json` em disco; só a declaração da cláusula `WITH` é reescrita, e o `OPENJSON` continua aceitando a coluna `json` como primeiro argumento por conversão implícita.

### 2. Se você não puder atualizar, baixe o nível de compatibilidade para 160

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.SqlServer 10.0.9 or 10.0.10
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

Em 160, `SupportsJsonType` é false, a coluna JSON mapeia para `nvarchar(max)`, e a cláusula `WITH` volta a ser `[partNumbers] nvarchar(max) '$.partNumbers' AS JSON`. Confirmado contra a 10.0.10.

O custo não se limita a essa cláusula. O nível de compatibilidade 160 também desliga a tradução de `JSON_CONTAINS`, o suporte a `.modify()` do tipo `json` para `ExecuteUpdate`, e as demais traduções exclusivas do 170 descritas em [a tradução de JSON_CONTAINS no EF Core 11](/pt-br/2026/04/efcore-11-json-contains-sql-server-2025/). Mais importante, isso muda o tipo de coluna modelado, e o pipeline de migrações vai perceber. Ler o tipo de armazenamento direto do modelo relacional na 10.0.12 deixa isso concreto:

```
UseAzureSql (default compat 170)            Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(170)   Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(160)   Cars.CarConfiguration -> nvarchar(max)
```

Se sua tabela já é `json` e você baixa o nível de compatibilidade, o próximo `dotnet ef migrations add` vai gerar um `ALTER COLUMN` de volta para `nvarchar(max)`. De todo jeito o SQL Server não deixa converter uma coluna `json` para um tipo de string com `ALTER TABLE`, então essa migração falha na implantação em vez de reescrever seus dados em silêncio. Trate o 160 como paliativo em tempo de execução e mantenha-o fora do modelo a partir do qual você gera migrações, ou aceite que ficará com armazenamento `nvarchar(max)` de vez.

### 3. Confira se você está realmente chamando `UseAzureSql`

Esta é a parte que pega quem atualiza e continua vendo o erro. Olhe de novo a condição do gerador: ele substitui por `nvarchar(max)` quando o tipo de motor não é `SqlServer`, ou quando é `SqlServer` com nível de compatibilidade abaixo de 170. Aponte `UseSqlServer` para uma string de conexão do Azure SQL, peça o nível 170, e o EF conclui que está falando com um SQL Server 2025 local que suporta `json` no `OPENJSON`. Na 10.0.12 essa combinação ainda emite a linha que falha:

```sql
-- UseSqlServer + UseCompatibilityLevel(170), EF Core 10.0.12
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
```

Esse comportamento é correto, não um segundo bug: o EF não tem como saber para onde uma string de conexão aponta sem perguntar ao servidor. A correção é declarar o motor em que você está. O `UseAzureSql` existe desde o EF Core 9.0 e ainda configura resiliência de conexão apropriada para o Azure de graça.

```csharp
// .NET 10, EF Core 9.0 and later
builder.Services.AddDbContext<CarContext>(options =>
    options.UseAzureSql(builder.Configuration.GetConnectionString("CarContext")));
```

O Azure SQL Managed Instance usa a mesma chamada. O Azure Synapse tem `UseAzureSynapse`, que reporta `SupportsJsonType` como false incondicionalmente, então nunca chega a esse caminho de código.

### 4. O que não funciona: sobrescrever o tipo da coluna contêiner

A solução que parece óbvia é forçar a coluna JSON de volta para um tipo de string:

```csharp
// Does NOT fix the WITH clause
pp.ToJson("CarConfiguration");
pp.HasColumnType("nvarchar(max)");
```

Na 10.0.10 com `UseSqlServer` no nível 170, isso ainda emite `[partNumbers] json '$.partNumbers' AS JSON`. O motivo é que `HasColumnType` define o tipo de armazenamento da coluna contêiner, enquanto a entrada da cláusula `WITH` para uma coleção aninhada pega seu tipo do mapeamento de tipos JSON do provedor, que é escolhido a partir do nível de compatibilidade. Mudar a coluna externa não alcança a declaração interna. Recorra ao salto de versão ou ao nível de compatibilidade.

## Pegadinhas e erros parecidos

**"The store type 'nvarchar(2000)' specified for JSON column ... is not supported by the current provider."** Erro diferente, causa diferente. Este é uma `InvalidOperationException` lançada pela validação do modelo antes de qualquer SQL ser gerado, e dispara em toda configuração, com Azure ou sem:

```
InvalidOperationException: The store type 'nvarchar(2000)' specified for JSON column 'CarConfiguration' in table 'Cars' is not supported by the current provider. JSON columns require a provider-specific JSON store type.
```

Significa que você fixou uma coluna JSON em um `nvarchar(x)` que não é MAX, algo que funcionava no EF Core 9 e virou erro de validação no EF Core 10 ([dotnet/efcore#37424](https://github.com/dotnet/efcore/issues/37424)). Use `nvarchar(max)` ou `json`, ou remova a chamada a `HasColumnType` e deixe o provedor escolher.

**SQL escrito à mão e `FromSql`.** A Msg 13618 é uma regra de T-SQL, não do EF. Se a instrução que falha é o seu próprio `OPENJSON ... WITH (Payload nvarchar(100) '$.payload' AS JSON)`, nenhuma versão do EF resolve: aumente a declaração da coluna para `nvarchar(max)`. A página de [problemas comuns com JSON](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server) na documentação do SQL cobre a mesma regra pelo lado do T-SQL. Como SQL cru pula o pipeline de consultas, `ToQueryString()` não vai ajudar aqui; o SQL que você escreveu é o SQL que roda.

**SQL Server 2025 local não é afetado.** Se seu banco de dados é o SQL Server 2025 (17.x) e o EF está configurado com `UseSqlServer` mais nível 170, `json ... AS JSON` é válido e o SQL anterior à 10.0.11 roda bem. Essa assimetria é exatamente o motivo de esse bug ter sobrevivido até um cliente rodar a mesma build contra o Azure.

**O nível de compatibilidade do EF não é o do banco de dados.** `UseCompatibilityLevel(170)` só diz ao EF qual SQL ele pode gerar. Ele não executa `ALTER DATABASE ... SET COMPATIBILITY_LEVEL`. Configurar o EF em 170 contra um banco ainda em 150 produz uma família de erros de sintaxe completamente diferente.

**Um `SELECT` que só lê o documento inteiro é seguro.** Se o erro apareceu depois de uma refatoração aparentemente sem relação, procure um novo `SelectMany`, `Any` ou `Contains` sobre uma coleção aninhada. É isso que puxa o segundo `OPENJSON` e a coluna `AS JSON`. Ligar o log de SQL como descrito em [como registrar o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) mostra em uma única requisição qual consulta mudou de formato.

## O EF Core 11 já tem a correção

O mesmo código do gerador está presente no branch `release/11.0`, então o `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128, publicado em 2026-09-08, traz a correção. Esse pacote tem como alvo somente `net11.0`, então verificá-lo exige um SDK do .NET 11; todos os exemplos de SQL acima foram produzidos no SDK do .NET 10.0.302 contra o EF Core 10.0.10, 10.0.11 e 10.0.12 usando `ToQueryString()`.

Se você já está levando um modelo cheio de JSON para o EF Core 11, vale juntar isso à mesma passada das decisões de mapeamento em [tipos complexos versus entidades próprias](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) e das mudanças de provedor em [migrar do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/). A lição de fundo vai além deste erro: "Azure SQL" e "SQL Server 2025" não são o mesmo alvo, divergem em JSON especialmente, e o EF só sabe em qual você está porque você contou.

## Relacionados

- [Como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [O EF Core 11 traduz Contains para JSON_CONTAINS no SQL Server 2025](/pt-br/2026/04/efcore-11-json-contains-sql-server-2025/)
- [Tipos complexos versus entidades próprias no EF Core 11](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [Como registrar o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Migrar do EF Core 6 para o EF Core 11: as mudanças incompatíveis que realmente doem](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Fontes

- [dotnet/efcore#38615, exceção ao consultar json que acontece somente no Azure SQL com nível de compatibilidade 170](https://github.com/dotnet/efcore/issues/38615)
- [dotnet/efcore#38665, correção da falha de OPENJSON AS JSON no Azure SQL quando o tipo da coluna é json no nível de compatibilidade 170](https://github.com/dotnet/efcore/pull/38665)
- [dotnet/efcore#37424, EF10 SQL Server: tipos JSON mapeados para nvarchar(x) não funcionam mais](https://github.com/dotnet/efcore/issues/37424)
- [OPENJSON (Transact-SQL), incluindo a regra de tipo de coluna para AS JSON](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql)
- [Limitações do tipo de dados json, sobre OPENJSON e o tipo json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations)
- [Provedor de banco de dados Microsoft SQL Server para EF Core, sobre UseAzureSql e níveis de compatibilidade](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/)
- [Resolver problemas comuns com JSON no SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server)
