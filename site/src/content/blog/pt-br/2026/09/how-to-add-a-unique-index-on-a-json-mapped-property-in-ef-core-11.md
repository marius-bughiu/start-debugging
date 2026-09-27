---
title: "Como adicionar um índice exclusivo em uma propriedade mapeada como JSON no EF Core 11 (SQL Server e SQLite)"
description: "HasIndex(...).IsUnique() em um membro ToJson() não garante exclusividade no EF Core 11 RC 1: o SQL Server descarta o IsUnique e o SQLite indexa o documento inteiro. Exponha o valor JSON como uma coluna computada e coloque o índice exclusivo nela."
pubDate: 2026-09-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "sqlite"
  - "json"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/how-to-add-a-unique-index-on-a-json-mapped-property-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-27
---

Resposta curta: no EF Core 11 RC 1, não coloque `IsUnique()` em um índice sobre um membro de uma propriedade complexa `ToJson()`. Isso não faz o que o modelo diz. No SQL Server, o EF emite `CREATE JSON INDEX`, que não tem forma exclusiva, e descarta silenciosamente o `IsUnique()`. No SQLite, o EF emite `CREATE UNIQUE INDEX ... ("Contact")`, então ele indexa o documento JSON inteiro, e duas linhas com o mesmo email são aceitas. A correção que funciona nos dois provedores é expor o valor JSON como uma shadow property mapeada para uma coluna computada (`JSON_VALUE` no SQL Server, `json_extract` no SQLite), colocar `HasIndex(...).IsUnique()` nessa coluna e consultar através de `EF.Property` para que o índice seja realmente usado.

Verifiquei tudo abaixo em relação a `Microsoft.EntityFrameworkCore.SqlServer` e `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 no SDK do .NET 11 RC 1 (11.0.100-rc.1.26425.128), C# 14. Executei os resultados do SQLite em um banco de dados real em memória. Produzi o DDL do SQL Server com `GenerateCreateScript()` e o gerador de SQL de migrações, e não executei isso contra um SQL Server 2025 real. Onde o comportamento do servidor importa, cito a documentação do SQL Server.

## O modelo que parece certo, mas não é

O EF Core 11 adicionou índices sobre propriedades dentro de tipos complexos, incluindo tipos complexos mapeados para uma coluna JSON. A [página de novidades](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) mostra `HasIndex("Contact.Address.City")` produzindo um índice JSON do SQL Server. É natural adicionar `.IsUnique()` a isso e esperar uma restrição:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Contact Contact { get; set; } = new();
}

public class Contact
{
    public string Email { get; set; } = "";
    public Address Address { get; set; } = new();
}

public class Address { public string City { get; set; } = ""; }

protected override void OnModelCreating(ModelBuilder mb)
{
    mb.Entity<Customer>().ComplexProperty(c => c.Contact, b => b.ToJson());
    mb.Entity<Customer>().HasIndex("Contact.Email").IsUnique(); // looks fine, is not
}
```

No SQL Server, no nível de compatibilidade 170, `GenerateCreateScript()` imprime:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE JSON INDEX [IX_Customers_Contact_Email] ON [Customers]([Contact]) FOR (N'$.Email');
```

Não há nenhum `UNIQUE` em lugar nenhum. A [sintaxe do CREATE JSON INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) não tem nenhuma opção exclusiva. Um índice JSON é uma estrutura de busca para predicados `JSON_VALUE`, `JSON_PATH_EXISTS` e `JSON_CONTAINS`, não uma restrição. No nível 160 você obtém o mesmo `CREATE JSON INDEX` sobre uma coluna `nvarchar(max)`, que falhará ao ser aplicado, uma armadilha que cobri em [native json vs nvarchar(max) no EF Core 11](/pt-br/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/). Com o log em `Warning`, o EF não registrou nada sobre o `IsUnique()` descartado.

O SQLite é pior, porque parece que funcionou:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_Contact_Email" ON "Customers" ("Contact");
```

O índice tem o nome baseado em `Contact_Email`, mas a chave é a coluna `"Contact"` inteira. Inseri dois clientes com o mesmo email e cidades diferentes, e as duas chamadas de `SaveChanges` tiveram sucesso. Depois inseri dois clientes cujos documentos `Contact` inteiros eram idênticos, e o segundo falhou com `SQLite Error 19: 'UNIQUE constraint failed: Customers.Contact'`. Então a restrição que você obtém é "dois clientes não podem ter documentos de contato idênticos byte a byte", o que não é uma regra que ninguém quer.

Os dois comportamentos foram relatados no repositório upstream: [dotnet/efcore#39065](https://github.com/dotnet/efcore/issues/39065) para o SQL Server e [dotnet/efcore#39064](https://github.com/dotnet/efcore/issues/39064) para o SQLite. O Npgsql tem o mesmo problema de coluna inteira para `jsonb` em [npgsql/efcore.pg#3918](https://github.com/npgsql/efcore.pg/issues/3918).

## Por que um caminho JSON não pode ser uma chave exclusiva diretamente

Um índice exclusivo precisa de uma chave escalar por linha. Um documento JSON é um único valor em uma única coluna. O banco de dados só enxerga `$.Email` como um escalar se algo o extrair:

- O SQL Server não permite que a chave de um índice seja uma expressão. O padrão documentado em [Index JSON data](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) é uma coluna computada sobre `JSON_VALUE` mais um índice B-tree comum sobre ela. `JSON_VALUE` é determinístico, e o [CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) permite um índice `UNIQUE` em uma coluna computada que seja determinística e precisa.
- O SQLite suporta índices sobre expressões, e também suporta colunas geradas. O EF Core não tem API para um índice de expressão, mas tem `HasComputedColumnSql`, que o SQLite transforma em uma coluna gerada.

Uma coluna computada é o único formato que os dois provedores suportam e que o EF Core consegue modelar, migrar e ler de volta. Essa é a correção.

## A correção: uma coluna computada com um índice exclusivo

1. Adicione uma shadow property para o valor que você quer que seja exclusivo, e mapeie-a para uma coluna computada que a extrai da coluna JSON.
2. Coloque `HasIndex(...).IsUnique()` nessa shadow property, não no caminho JSON.
3. No SQL Server, garanta que o EF não adicione seu filtro padrão `IS NOT NULL` ao índice (detalhes abaixo).
4. Adicione uma migração, verifique se há duplicatas existentes antes de aplicá-la, e consulte através de `EF.Property` para que as buscas usem o índice.

Aqui está a configuração do modelo, escrita uma vez para os dois provedores:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
protected override void OnModelCreating(ModelBuilder mb)
{
    var customer = mb.Entity<Customer>();
    customer.ComplexProperty(c => c.Contact, b => b.ToJson());

    var emailSql = Database.IsSqlServer()
        ? "CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320))"
        : "json_extract(\"Contact\", '$.Email')";

    customer.Property<string>("ContactEmail")
        .HasMaxLength(320)
        .HasComputedColumnSql(emailSql, stored: false)
        .IsRequired();

    customer.HasIndex("ContactEmail").IsUnique();
}
```

SQL Server, nível 170 (o nível 160 é idêntico, exceto que `[Contact]` é `nvarchar(max)`):

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)),
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);
```

SQLite:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "ContactEmail" AS (json_extract("Contact", '$.Email')),
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

Com esse modelo no SQLite, um segundo cliente com `a@x.com` falha em `SaveChanges` com `DbUpdateException` envolvendo `SQLite Error 19: 'UNIQUE constraint failed: Customers.ContactEmail'`. O `ExecuteUpdate` também é coberto: `SetProperty(x => x.Contact.Email, "a@x.com")` em uma linha diferente falhou com o mesmo erro, porque a coluna gerada é recalculada a partir do documento atualizado. Depois do `SaveChanges`, o EF também lê o valor computado de volta para a shadow property (`Entry(e).Property("ContactEmail").CurrentValue` retornou `a@x.com`), já que colunas computadas são `ValueGenerated.OnAddOrUpdate`.

No SQL Server, a duplicata aparece como `SqlException` número 2601 ("Cannot insert duplicate key row"). Capture `DbUpdateException` e inspecione a exceção interna se você quiser transformar isso em um erro de validação.

Algumas escolhas nesse código importam:

- **O `CAST` para `nvarchar(320)`.** `JSON_VALUE` retorna `nvarchar(4000)`, e a [página Index JSON data](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) avisa que chaves de índice acima de 1700 bytes fazem as inserções falharem. 320 caracteres é o máximo prático para um endereço de email e são 640 bytes como `nvarchar`. Converta para o tipo mais estreito que caiba no seu valor. Para números, converta para `int` ou `bigint`.
- **`stored: false`.** Nenhum dos dois provedores precisa que o valor seja persistido para que ele seja indexado. No SQL Server, uma coluna computada não persistida pode ser indexada desde que seja determinística e precisa. No SQLite, uma coluna gerada virtual pode ser indexada, e só as virtuais podem ser adicionadas com `ALTER TABLE` depois.
- **`IsRequired()`.** Isso não é sobre a coluna. Isso impede que o EF adicione um filtro ao índice, que é o assunto da próxima seção.

## A armadilha do filtro no SQL Server

Se você deixar a shadow property opcional, o provedor SQL Server do EF faz o que faz para todo índice exclusivo em uma coluna anulável e adiciona um filtro:

```sql
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]) WHERE [ContactEmail] IS NOT NULL;
```

Essa instrução não vai rodar. A [referência do CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) afirma que o predicado do filtro "can't reference a computed column". O EF gera isso sem reclamar, então você descobre quando `dotnet ef database update` falha.

Duas saídas, ambas verificadas para remover a cláusula `WHERE` do SQL gerado:

```csharp
// .NET 11 RC 1, EF Core 11 - either mark the value required...
customer.Property<string>("ContactEmail").IsRequired();

// ...or keep it optional and remove the filter explicitly
customer.HasIndex("ContactEmail").IsUnique().HasFilter(null);
```

Sem o filtro, o SQL Server trata NULLs como iguais em um índice exclusivo, então apenas uma linha pode não ter um email. Se sua propriedade JSON realmente for opcional, incorpore um valor por linha na expressão para que emails ausentes nunca colidam. Por exemplo: `ISNULL(CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)), N'#' + CAST([Id] AS nvarchar(11)))`. Isso é determinístico e preciso, então continua indexável. Não executei esse contra um servidor real. O SQLite não tem esse problema: NULLs são sempre distintos em um índice exclusivo do SQLite, e o EF não adiciona nenhum filtro lá.

## Consulte através da coluna, ou o índice fica sem uso

O índice exclusivo aplica a regra não importa como você escreva as consultas. Usá-lo para buscas é uma questão separada. Um filtro LINQ simples sobre o caminho JSON não faz referência à sua coluna computada:

```csharp
// .NET 11 RC 1, EF Core 11
db.Customers.Where(c => c.Contact.Email == email);
// SQL Server 170: WHERE JSON_VALUE([c].[Contact], '$.Email' RETURNING nvarchar(max)) = N'a@x.com'
// SQLite:         WHERE "c"."Contact" ->> 'Email' = 'a@x.com'
```

O SQL Server consegue combinar uma expressão de consulta com uma coluna computada equivalente, mas somente quando as expressões são iguais. `JSON_VALUE(... RETURNING nvarchar(max))` não é o mesmo que `CAST(JSON_VALUE(...) AS nvarchar(320))`. O SQLite não combina expressões de coluna gerada de forma alguma. Com a CLI do sqlite3 3.50.6, `EXPLAIN QUERY PLAN` retornou `SCAN c` tanto para `Contact ->> 'Email'` quanto para um `json_extract(Contact, '$.Email')` escrito manualmente, e somente a referência à coluna produziu `SEARCH c USING INDEX IX_Customers_ContactEmail (ContactEmail=?)`.

Então filtre pela shadow property:

```csharp
// .NET 11 RC 1, EF Core 11 - produces WHERE [c].[ContactEmail] = @email on both providers
var existing = await db.Customers
    .Where(c => EF.Property<string>(c, "ContactEmail") == email)
    .FirstOrDefaultAsync();
```

Se as strings do `EF.Property` incomodam você, mapeie uma propriedade somente leitura de verdade (`public string ContactEmail { get; private set; } = "";`) com o mesmo `HasComputedColumnSql`. O EF a preenche depois de cada salvamento, e suas consultas ganham uma lambda normal.

## Adicionando isso a uma tabela que já tem dados

A migração que o EF gera é composta de duas instruções em cada provedor:

```sql
-- SQL Server
ALTER TABLE [Customers] ADD [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320));
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);

-- SQLite
ALTER TABLE "Customers" ADD "ContactEmail" AS (json_extract("Contact", '$.Email'));
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

O `ALTER TABLE` tem sucesso mesmo quando existem duplicatas. O `CREATE UNIQUE INDEX` não. No SQLite, com duas linhas existentes de `a@x.com`, ele falhou com `UNIQUE constraint failed: Customers.ContactEmail (19)`. Encontre os culpados primeiro. O EF traduz o agrupamento sobre o caminho JSON sem a nova coluna:

```csharp
// .NET 11 RC 1, EF Core 11 - run before applying the migration
var duplicates = await db.Customers
    .GroupBy(c => c.Contact.Email)
    .Where(g => g.Count() > 1)
    .Select(g => new { Email = g.Key, Count = g.Count() })
    .ToListAsync();
```

Limpe essas linhas, depois aplique a migração. Para lançamentos em produção, gere o SQL e revise-o em vez de deixar o aplicativo migrar sozinho; o [fluxo de trabalho de migrations bundle](/pt-br/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) cobre isso. Se sua equipe impõe convenções de nomenclatura de índices, a coluna computada recebe um nome como qualquer outra propriedade, então as regras de [convenções de nomenclatura personalizadas para chaves e índices no EF Core 11](/pt-br/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) se aplicam a `IX_Customers_ContactEmail` sem tratamento especial.

## Pegadinhas que vale a pena conhecer antes de lançar

**A sensibilidade a maiúsculas e minúsculas difere entre provedores.** No SQLite, inseri `a@x.com` e `A@X.com` e ambos foram aceitos, porque o SQLite compara com collation `BINARY` por padrão. No SQL Server, a exclusividade segue a collation da coluna de origem, e para a maioria dos bancos de dados isso não diferencia maiúsculas de minúsculas, então o mesmo par colidiria. Se a regra é "uma conta por email", normalize: armazene emails em minúsculas, ou use `lower(json_extract("Contact", '$.Email'))` no SQLite para que os dois provedores concordem. Misturar provedores entre testes e produção é onde isso morde, um dos motivos pelos quais [WebApplicationFactory vs Testcontainers](/pt-br/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) importa para testes de regras de dados.

**O nome da propriedade JSON faz parte do SQL.** `$.Email` precisa corresponder ao que o EF escreve no documento. Se você renomear a propriedade CLR, ou configurar `HasJsonPropertyName("email")`, atualize o SQL da coluna computada na mesma migração. O EF não vai fazer isso por você, porque o caminho é uma string opaca. Uma incompatibilidade não falha: toda linha produz NULL, e sua regra "exclusiva" para de aplicar qualquer coisa.

**Coleções complexas estão fora do escopo.** Um índice exclusivo precisa de um valor por linha. Para "SKU deve ser exclusivo em `Items[]`" você precisa de uma tabela filha, não de uma coluna JSON. O EF Core 11 pode indexar `Items[].Sku` para buscas no SQL Server, mas isso é um índice JSON, não uma restrição.

**Não conte com um futuro `IsUnique()`.** A correção do SQL Server, [dotnet/efcore#39090](https://github.com/dotnet/efcore/pull/39090), foi mesclada em `release/11.0` em 2026-09-26, depois que o RC 1 foi lançado. Ela não torna os índices JSON exclusivos. Ela faz o modelo falhar na validação com `JSON index '{index}' on entity type '{entityType}' was configured with the '{option}' option, which is not supported on JSON indexes.` Isso é uma melhoria, já que o descarte silencioso se torna um erro visível, mas a resposta continua sendo uma coluna computada. O issue do SQLite ainda estava aberto quando escrevi isso.

**A coluna computada precisa das opções `SET` usuais do SQL Server.** Índices em colunas computadas exigem configurações como `QUOTED_IDENTIFIER ON` e `ANSI_NULLS ON` para sessões que modificam a tabela. Os padrões do SqlClient satisfazem isso, mas um script ou ferramenta legada que os desative vai receber erros ao escrever em `Customers`.

Se você ainda não definiu um mapeamento JSON, [como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cobre `ComplexProperty(...).ToJson()` do início ao fim. Tudo aqui assume esse mapeamento.

## Fontes

- [Novidades do EF Core 11: chaves e índices em propriedades de tipos complexos, índices JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [Index JSON data (colunas computadas sobre JSON_VALUE)](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data)
- [CREATE INDEX (Transact-SQL): regras de índice filtrado e coluna computada](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql)
- [Colunas geradas do SQLite](https://www.sqlite.org/gencol.html)
- [dotnet/efcore#39065: IsUnique() em um índice sobre um membro mapeado como JSON é descartado silenciosamente](https://github.com/dotnet/efcore/issues/39065)
- [dotnet/efcore#39064: índice do SQLite em um membro mapeado como JSON indexa a coluna inteira](https://github.com/dotnet/efcore/issues/39064)
- [dotnet/efcore#39090: validar opções de índice JSON do SQL Server não suportadas](https://github.com/dotnet/efcore/pull/39090)
- [npgsql/efcore.pg#3918: índice em um membro mapeado como JSON indexa a coluna jsonb inteira](https://github.com/npgsql/efcore.pg/issues/3918)
