---
title: "Nível de compatibilidade 150 vs 160 do SQL Server: o que muda nas consultas do EF Core 11"
description: "O EF Core 11 agora usa por padrão o nível de compatibilidade 160 em UseSqlServer, o que coloca LEAST, GREATEST e LTRIM/RTRIM com dois argumentos no seu SQL, inclusive em todo Take(n).FirstOrDefault(). Mantenha 160 no SQL Server 2022 e posteriores; fixe UseCompatibilityLevel(150) se algum ambiente ainda roda SQL Server 2019."
pubDate: 2026-09-16
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-09-16
---

Resposta curta: se todo banco de dados com que seu app conversa roda SQL Server 2022 ou posterior, mantenha o novo padrão do EF Core 11, o nível de compatibilidade 160. Ele transforma `Math.Min`/`Math.Max`, `EF.Functions.Least`/`Greatest`, `Min`/`Max` sobre arrays inline e chamadas encadeadas de `Take` em `LEAST`/`GREATEST`, e `TrimStart(char)`/`TrimEnd(char)` em `LTRIM`/`RTRIM` com dois argumentos. Se algum ambiente ainda roda SQL Server 2019, chame `UseCompatibilityLevel(150)` antes de atualizar. No nível 160, uma consulta tão comum quanto `.Take(pageSize).FirstOrDefaultAsync()` vira `SELECT TOP(LEAST(@p, 1))`, e o SQL Server 2019 não tem `LEAST`.

Tudo abaixo foi verificado com `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 no SDK do .NET 11 RC 1 (11.0.100-rc.1.26425.128) com C# 14, e com 10.0.12 no SDK 10.0.302 para o cenário anterior. Comparei o SQL que as duas versões geram. Não executei contra um SQL Server real, então o comportamento no servidor vem da documentação do SQL Server, com links abaixo.

## 150 vs 160 em resumo

| Forma do LINQ (EF Core 11) | Nível 150 (padrão do EF Core 10) | Nível 160 (padrão do EF Core 11) |
| --- | --- | --- |
| `Math.Max(a, b)` em `Where` / `OrderBy` | Lança "could not be translated" | `GREATEST([a], [b])` |
| `Math.Min(a, b)` no `Select` final | Avaliado no cliente | `LEAST([a], [b])` no servidor |
| `EF.Functions.Greatest(a, b, c)` em `Where` | Lança "could not be translated" | `GREATEST([a], [b], [c])` |
| `new[] { a, b }.Max()` | `(SELECT MAX(...) FROM (VALUES ...))` | `GREATEST([a], [b])` |
| `Take(n).FirstOrDefault()` | `TOP(1)` aninhado sobre subconsulta `TOP(@p)` | `TOP(LEAST(@p, 1))` |
| `Skip(s).Take(n).First()` | `TOP(1)` sobre uma subconsulta com `OFFSET`/`FETCH` | `FETCH NEXT LEAST(@p1, 1) ROWS ONLY` |
| `TrimStart('0')` em `Where` | Lança "could not be translated" | `LTRIM([col], N'0')` |
| `ExecuteUpdate` atribuindo a uma propriedade JSON uma coluna `DateTime` | Lança exceção | `JSON_MODIFY(..., JSON_VALUE(JSON_OBJECT('v': [col]), '$.v'))` |
| DDL / migrações | Idêntico | Idêntico |
| Colunas JSON | `nvarchar(max)` | `nvarchar(max)` (só o 170 muda para `json`) |
| Servidor mínimo | SQL Server 2019 | SQL Server 2022 (e nível 160 do banco de dados para `LTRIM`/`RTRIM` com caracteres) |

## O nível de compatibilidade do EF não é o nível de compatibilidade do seu banco de dados

Existem duas configurações separadas, e as duas se chamam "nível de compatibilidade".

A **configuração do EF** é o que você passa para `UseCompatibilityLevel`. O EF nunca a lê do servidor. Ela é fixada quando as opções são construídas e só decide quais recursos de SQL o pipeline de consultas pode usar. Em `SqlServerOptionsExtension`, os padrões no EF Core 11 são `SqlServerDefaultCompatibilityLevel = 160` e `AzureSqlDefaultCompatibilityLevel = 170`. No EF Core 10 o primeiro era 150. A mudança é a [dotnet/efcore#38198](https://github.com/dotnet/efcore/issues/38198), entregue no PR #38199, e está listada como breaking change de baixo impacto do EF Core 11.

A **configuração do banco de dados** é `sys.databases.compatibility_level`. Ela controla o comportamento do otimizador de consultas e algumas regras de sintaxe. No nível 160 do banco de dados, o SQL Server 2022 ativa a otimização de planos sensíveis a parâmetros e o feedback de estimativa de cardinalidade. Um banco de dados restaurado ou anexado em um servidor mais novo mantém o nível antigo. Então um banco de dados migrado do SQL Server 2019 para o 2022 pode continuar em 150.

As duas configurações só interagem pelo SQL que o EF envia. A página da Microsoft sobre nível de compatibilidade diz que a nova sintaxe T-SQL "isn't gated by database compatibility level, except when they can break existing applications". `GREATEST` e `LEAST` não estão na lista de exceções, então funcionam no SQL Server 2022 em qualquer nível do banco de dados. O argumento opcional *characters* de `LTRIM` e `RTRIM` é uma exceção: a documentação dele exige nível de compatibilidade 160 no banco de dados.

Note também que `UseAzureSql` e `UseSqlServer` são caminhos separados. `UseAzureSql` já usava 170 por padrão no EF Core 10, então nada neste post muda para quem usa Azure SQL. Se você aponta `UseSqlServer` para o Azure SQL, acabou de passar de 150 para 160 como todo mundo.

## Como medi a diferença

O teste constrói o mesmo modelo três vezes (padrão, `UseCompatibilityLevel(150)`, `UseCompatibilityLevel(160)`). Ele imprime `ToQueryString()` para as consultas. Para `FirstOrDefaultAsync` e `ExecuteUpdateAsync`, um interceptor suprime a conexão e captura o texto do comando, então nenhum banco de dados é envolvido:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
var configs = new (string Name, Action<DbContextOptionsBuilder> Configure)[]
{
    ("UseSqlServer (default)", o => o.UseSqlServer(Cs)),
    ("UseSqlServer + 150", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(150))),
    ("UseSqlServer + 160", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(160))),
};

foreach (var (name, configure) in configs)
{
    using var db = Shop.Create(configure); // adds the interceptor, EnableServiceProviderCaching(false)
    Q("Math.Max in Where", () => db.Products
        .Where(p => Math.Max(p.Stock, p.ReorderLevel) > 10).ToQueryString());
    Q("TrimStart('0') in Where", () => db.Products
        .Where(p => p.Sku.TrimStart('0') == "42").ToQueryString());
    // ...one line per shape in the table above
}

class NoDb : DbCommandInterceptor, IDbConnectionInterceptor
{
    public ValueTask<InterceptionResult> ConnectionOpeningAsync(DbConnection c, ConnectionEventData d,
        InterceptionResult r, CancellationToken t = default) => ValueTask.FromResult(InterceptionResult.Suppress());

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand cmd,
        CommandEventData d, InterceptionResult<DbDataReader> r, CancellationToken t = default)
    {
        Capture.Last = cmd.CommandText;
        throw new CapturedException(); // stop before anything needs a real reader
    }
    // ConnectionOpening (sync) and NonQueryExecutingAsync follow the same pattern
}
```

Rodar o mesmo arquivo com o EF Core 10.0.12 serviu como um controle útil. O EF Core 10 com `UseCompatibilityLevel(160)` produziu SQL idêntico ao padrão do EF Core 11. Nenhuma dessas traduções é nova no EF Core 11. `Math.Min`/`Math.Max` via `LEAST`/`GREATEST` e as sobrecargas com `char` de `TrimStart`/`TrimEnd` chegaram no EF Core 9, condicionadas ao nível 160. O EF Core 11 só mudou o padrão, para que elas sejam ativadas sem você pedir.

## A mudança que machuca: Take seguido de First ou Single

Esta é a que eu não esperava, e ela atinge código que não tem nada a ver com `Math`. Quando uma consulta já tem um limite de linhas e você adiciona outro, o EF junta os dois. Se ambos os limites forem constantes, ele mantém o menor. Caso contrário, chama `GenerateLeast`, que só retorna uma expressão `LEAST` no nível 160 ou superior. Abaixo de 160 retorna null, e o EF recorre a uma consulta aninhada.

`FirstOrDefaultAsync` adiciona um limite de 1, e `SingleOrDefaultAsync` um limite de 2. O EF parametriza o valor que você passa para `Take`, mesmo um literal como `Take(20)`. Então um repositório que retorna um `IQueryable` paginado, seguido de um chamador que pede a primeira linha, fica assim:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var first = await db.Products
    .OrderBy(p => p.Id)
    .Take(pageSize)
    .FirstOrDefaultAsync();
```

No nível 160 (o padrão do EF Core 11):

```sql
SELECT TOP(LEAST(@p, 1)) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
FROM [Products] AS [p]
ORDER BY [p].[Id]
```

No nível 150 (o padrão do EF Core 10):

```sql
SELECT TOP(1) [p0].[Id], [p0].[CreatedAt], [p0].[ListPrice], [p0].[Name], ...
FROM (
    SELECT TOP(@p) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
    FROM [Products] AS [p]
    ORDER BY [p].[Id]
) AS [p0]
ORDER BY [p0].[Id]
```

Com `Skip`, o limite vai para `OFFSET @p ROWS FETCH NEXT LEAST(@p1, 1) ROWS ONLY`. `Take(n).Take(m)` com dois parâmetros produz `TOP(LEAST(@p, @p1))`. `Take(n).AnyAsync()` e `Take(n).CountAsync()` não são afetados, porque envolvem a consulta limitada em vez de empilhar um segundo limite. `Take(n).Take(n)` com o mesmo parâmetro também não é afetado, porque o EF vê dois limites iguais e mantém um.

No SQL Server 2022 a forma do 160 é simplesmente um SQL mais curto. No SQL Server 2019 o servidor rejeita `LEAST` como função interna desconhecida. Esse código compilou, passou nos testes contra um servidor mais novo e funcionava no EF Core 10. É por isso que uma suíte de testes que roda contra um contêiner do SQL Server 2022 não vai avisar você.

## Math.Min, Math.Max e arrays inline

No 150, `Math.Max` e `EF.Functions.Greatest` simplesmente não podem ser traduzidos. Em um `Where` ou `OrderBy` você recebe a conhecida `InvalidOperationException` pedindo para reescrever a consulta ou mudar para avaliação no cliente. Na projeção final, o EF seleciona discretamente as duas colunas e executa `Math.Min` no cliente:

```sql
-- level 150: Select(p => new { p.Id, Effective = Math.Min(p.Price, p.ListPrice) })
SELECT [p].[Id], [p].[Price], [p].[ListPrice]
FROM [Products] AS [p]

-- level 160
SELECT [p].[Id], LEAST([p].[Price], [p].[ListPrice]) AS [Effective]
FROM [Products] AS [p]
```

Essa projeção é a segunda mudança silenciosa após a atualização: o mesmo LINQ agora depende de o servidor ter `LEAST`.

Arrays inline tinham um fallback funcional no 150, uma subconsulta `VALUES` correlacionada:

```sql
-- level 150: Where(p => new[] { p.Stock, p.ReorderLevel }.Max() > 10)
WHERE (
    SELECT MAX([v].[Value])
    FROM (VALUES ([p].[Stock]), ([p].[ReorderLevel])) AS [v]([Value])) > 10

-- level 160
WHERE GREATEST([p].[Stock], [p].[ReorderLevel]) > 10
```

A semântica de nulos é a mesma. `GREATEST` e `LEAST` ignoram argumentos `NULL`, a menos que todos sejam `NULL`, exatamente como `MAX` sobre as linhas de `VALUES` e como `Enumerable.Min` sobre um `decimal?[]`. O EF também verifica isso: para um tipo de resultado anulável, ele só escolhe `LEAST`/`GREATEST` quando a função não propaga nulos. Então `new decimal?[] { p.SalePrice, p.Price }.Min()` vira `LEAST([p].[SalePrice], [p].[Price])` sem alterar resultados.

## TrimStart e TrimEnd com caracteres

Remover espaços sem argumentos é `LTRIM(col)` em qualquer nível. Remover caracteres específicos exige a forma com dois argumentos do SQL Server 2022, e o EF só a usa no 160:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var bySku = db.Products.Where(p => p.Sku.TrimStart('0') == "42");
var byName = db.Products.Where(p => p.Name.TrimEnd(' ', '.') == "Widget");
```

```sql
-- level 160
WHERE LTRIM([p].[Sku], N'0') = N'42'
WHERE RTRIM([p].[Name], N' .') = N'Widget'
```

No 150 ambos lançam "could not be translated". Em um `Select` final eles rodam no cliente, e no 160 passam para o servidor. Este é o caso que também depende do nível do próprio banco de dados. No SQL Server 2022, a documentação de `LTRIM` exige nível de compatibilidade 160 no banco de dados para o argumento de caracteres. Um banco de dados restaurado do 2019 e nunca elevado vai rejeitá-lo, mesmo que `GREATEST` funcione normalmente no mesmo servidor.

## ExecuteUpdate em colunas JSON

Para tipos complexos mapeados como JSON, atribuir a uma propriedade uma coluna `int` ou `string` funciona nos dois níveis. Atribuir uma coluna de outro tipo, como `DateTime`, exige `JSON_OBJECT`, que também é do SQL Server 2022:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
await db.Products.ExecuteUpdateAsync(s =>
    s.SetProperty(p => p.Details.LastPriceChange, p => p.CreatedAt));
```

No 160 isso vira `JSON_MODIFY([p].[Details], '$.LastPriceChange', JSON_VALUE(JSON_OBJECT('v': [p].[CreatedAt]), '$.v'))`. No 150 o EF lança exceção. O EF Core 10.0.12 lança uma mensagem que diz o que fazer: "'ExecuteUpdate' cannot set a property in a JSON column to an expression containing a column on SQL Server versions before 2022". O EF Core 11 RC 1 a envolve na mensagem genérica "could not be translated, see inner exception".

## O que não muda entre 150 e 160

O schema. `GenerateCreateScript()` retornou DDL idêntico no 150 e no 160 para um modelo com um tipo complexo JSON. `SupportsJsonType` só muda no 170, então as colunas JSON continuam `nvarchar(max)` e trocar entre 150 e 160 não gera migração. As consultas JSON baseadas em `OPENJSON`, que precisam do nível 130, não são afetadas. Tudo o que precisa do 170 (o tipo nativo `json`, `JSON_CONTAINS`, `.modify()`) continua desativado nos dois níveis.

## Quando manter 160

- **Todo ambiente é SQL Server 2022 ou 2025, ou Azure SQL / Managed Instance.** Você ganha SQL mais curto em consultas paginadas, `Math.Min`/`Math.Max` no servidor e remoção de caracteres que é traduzida em vez de lançar exceção.
- **Você já tinha definido `UseCompatibilityLevel(160)` manualmente.** Pode apagar a chamada. O resultado é o mesmo, como mostrou a execução de controle com o EF Core 10.
- **Você dependia da avaliação no cliente de `Math.Min` ou `TrimStart('0')` em projeções.** Levar esse trabalho para o servidor normalmente é o que você queria de qualquer forma.

## Quando fixar 150

- **Algum ambiente roda SQL Server 2019.** Isso inclui staging, a instalação on-premises de um cliente ou uma réplica de recuperação de desastres. A documentação do provider do EF Core 11 ainda lista o SQL Server 2019 como suportado, mas só no nível 150.
- **Seus bancos de dados rodam no SQL Server 2022 com nível 150, e você não controla isso.** Por exemplo, um fornecedor é dono do banco de dados e não vai elevar o nível porque o 160 altera planos de consulta. `GREATEST`/`LEAST` ainda funcionariam ali, mas `LTRIM`/`RTRIM` com caracteres não. Fixar 150 é a única configuração do lado do EF que cobre os dois casos.
- **Você entrega um único binário para muitos tenants com versões desconhecidas do SQL Server.** Escolha o nível que o servidor mais antigo que você suporta consegue executar.

## Deixe o nível explícito e verifique-o na inicialização

A própria documentação do provider da Microsoft recomenda configurar o nível explicitamente, e esta mudança de padrão é um bom motivo para seguir esse conselho. Leia-o da configuração para que cada ambiente declare o que roda:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
var level = builder.Configuration.GetValue("Database:CompatibilityLevel", 150);

builder.Services.AddDbContext<Shop>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Shop"),
        sql => sql.UseCompatibilityLevel(level)));
```

Depois falhe rápido se o nível configurado pedir mais do que o servidor pode oferecer:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<Shop>();

    // EngineEdition 5 = Azure SQL Database, 8 = Azure SQL Managed Instance
    var engineEdition = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS [Value]")
        .SingleAsync();
    var serverMajor = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS [Value]")
        .SingleAsync();
    var databaseLevel = await db.Database
        .SqlQuery<int>($"SELECT CAST(compatibility_level AS int) AS [Value] FROM sys.databases WHERE name = DB_NAME()")
        .SingleAsync();

    // SQL Server 2019 = 15, 2022 = 16, 2025 = 17; the matching levels are 150, 160, 170
    var isAzure = engineEdition is 5 or 8;
    if ((!isAzure && level > serverMajor * 10) || level > databaseLevel)
        throw new InvalidOperationException(
            $"EF is configured for compatibility level {level}, but the server is version {serverMajor} " +
            $"and the database is at level {databaseLevel}.");
}
```

O Azure SQL não informa uma versão de SQL Server tradicional que dê para comparar dessa forma, então ali a verificação depende só do nível do banco de dados. A comparação com o nível do banco de dados é mais rígida do que o necessário para `LEAST`/`GREATEST`. Prefiro assim, porque `LTRIM` com caracteres depende sim do nível do banco de dados, e uma verificação que cobre só metade dos casos é pior do que nenhuma. Rode a mesma verificação nos seus testes de integração contra um contêiner da versão de servidor *mais antiga* que você suporta, não da mais nova.

## A recomendação, reformulada

O nível 160 é o padrão certo em 2026. O SQL Server 2022 já está disponível há quase quatro anos, e o SQL é melhor. Mas o padrão é um palpite sobre o seu servidor, e para quem usa SQL Server 2019 ele está errado de um jeito que nenhum compilador, analisador ou migração vai apontar. O primeiro sinal é um erro de SQL em runtime em consultas que funcionavam no EF Core 10. Então defina `UseCompatibilityLevel` explicitamente em todo app que você migrar para o EF Core 11: 160 ou superior se todo servidor for 2022+, 150 se pelo menos um não for.

## Relacionados

- O passo para o 170 é bem maior, porque muda tipos de coluna: [coluna json nativa vs nvarchar(max) no EF Core 11](/pt-br/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/).
- Se você está vindo de uma versão mais antiga, [as breaking changes do EF Core 6 ao 11 que realmente machucam](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cobre as outras traduções que dependem de versão.
- As falhas do nível 150 neste post são o clássico [erro de expressão LINQ que não pôde ser traduzida](/pt-br/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), e as reescritas de lá se aplicam.
- Para ver qual SQL seu app realmente envia após a atualização, [registre em log o SQL que o EF Core 11 gera](/pt-br/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- Para pegar a divergência de versão do servidor no CI, [rode testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), fixado na sua versão de produção mais antiga.

## Fontes

- [Breaking changes do EF Core 11: o nível de compatibilidade do SQL Server agora tem padrão 160](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes#sqlserver-compatibility-level-160)
- [dotnet/efcore#38198: Bump default SQL Server compatibility level from 150 to 160](https://github.com/dotnet/efcore/issues/38198)
- [dotnet/efcore#38196: Math.Min/Max not translating on the old default level](https://github.com/dotnet/efcore/issues/38196)
- [Provider SQL Server do EF Core: nível de compatibilidade](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/#compatibility-level)
- [Nível de compatibilidade do ALTER DATABASE: níveis suportados e diferenças entre 150 e 160](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-compatibility-level)
- [GREATEST (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/logical-functions-greatest-transact-sql)
- [LTRIM (Transact-SQL): o argumento de caracteres exige nível de compatibilidade 160](https://learn.microsoft.com/en-us/sql/t-sql/functions/ltrim-transact-sql)
- Código-fonte do EF Core na tag `v11.0.0-rc.1.26425.128`: `SqlServerSqlTranslatingExpressionVisitor.GenerateGreatest`/`GenerateLeast`, `RelationalQueryableMethodTranslatingExpressionVisitor.ApplyLimit`, `SqlServerStringMethodTranslator.TranslateTrimStartEnd`, `SqlServerSingletonOptions`
