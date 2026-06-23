---
title: "Como mapear e consultar colunas JSON no EF Core 11"
description: "Mapeie um tipo aninhado para uma única coluna JSON com ComplexProperty(...).ToJson(), deixe o EF Core 11 armazená-lo no tipo json nativo do SQL Server 2025 e depois consulte-o com LINQ que se traduz em JSON_VALUE, JSON_CONTAINS e JSON_PATH_EXISTS."
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "json"
  - "sql-server"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/06/how-to-map-and-query-json-columns-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-23
---

Resposta curta: modele os dados aninhados como um tipo complexo, chame `ComplexProperty(b => b.Details, d => d.ToJson())` em `OnModelCreating`, e o EF Core 11 mapeia todo o grafo de objetos para uma única coluna. No SQL Server 2025 (nível de compatibilidade 170) essa coluna é o tipo de dados `json` nativo, não `nvarchar(max)`. Então você a consulta com LINQ comum: `Where(b => b.Details.Viewers > 3)` se traduz em `JSON_VALUE(... RETURNING int)`, `b.Tags.Contains("ef-core")` se traduz em `JSON_CONTAINS`, e `EF.Functions.JsonPathExists(...)` verifica um caminho. Atualizações em massa dentro do documento também funcionam, via `ExecuteUpdateAsync` e a função `.modify()` do tipo `json` do SQL Server.

Este artigo usa `Microsoft.EntityFrameworkCore` 11.0.0 no .NET 11 com C# 14, contra o SQL Server 2025. As APIs de mapeamento são independentes do provedor, mas o SQL exato e o tipo `json` nativo são específicos do SQL Server; PostgreSQL e SQLite usam suas próprias funções JSON para o mesmo LINQ.

## Duas formas de mapear uma coluna para JSON, e por que uma agora é preferida

O EF Core já consegue colocar um objeto .NET aninhado em uma única coluna JSON há algum tempo, mas historicamente a única forma era por meio de *tipos de entidade owned*: `OwnsOne(...).ToJson()`. Isso ainda funciona. O problema é que os tipos owned são tipos de entidade por baixo, então carregam identidade e semântica de referência, o que vaza para o seu código de formas surpreendentes.

A partir do EF Core 10 e estabilizado ainda mais no 11, a ferramenta de modelagem recomendada é o *tipo complexo*. Um tipo complexo não tem chave, nem identidade, e tem semântica de valor, que é exatamente o que um documento JSON dentro de uma linha é. Marque o tipo com `[ComplexType]` (ou configure-o de forma fluente) e chame `ToJson()`:

```csharp
// .NET 11, EF Core 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    public string[] Tags { get; set; } = [];     // primitive collection
    public required BlogDetails Details { get; set; }
}

[ComplexType]
public class BlogDetails
{
    public string? Description { get; set; }
    public int Viewers { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .ComplexProperty(b => b.Details, d => d.ToJson());
}
```

Duas coisas caem em JSON aqui. `Details` se torna uma coluna JSON porque você pediu com `ToJson()`. `Tags` se torna uma coluna JSON automaticamente: o EF mapeia coleções de primitivos (`string[]`, `List<int>` e assim por diante) para uma coluna de array JSON sem nenhuma configuração, um comportamento que existe desde o EF Core 8.

## O tipo de dados json nativo, e quando você o obtém

O *tipo* da coluna depende do banco de dados para o qual você aponta o EF. Com o EF Core 10 e 11, se você configurar o provedor com `UseAzureSql`, ou com um nível de compatibilidade do SQL Server de 170 ou superior (que é o que o SQL Server 2025 reporta), o EF define por padrão a coluna como o tipo de dados `json` nativo em vez de `nvarchar(max)`:

```csharp
// .NET 11, EF Core 11.0.0 - opt into the SQL Server 2025 json type
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

O modelo acima então produz esta tabela:

```sql
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Tags] json NOT NULL,
    [Details] json NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
```

O tipo `json` nativo valida seu conteúdo, armazena-o de forma mais compacta que texto e suporta um índice JSON. Vale a pena sinalizar logo de início um detalhe da migração: se o seu aplicativo já armazena JSON em colunas `nvarchar(max)` e você eleva o nível de compatibilidade para 170, a próxima migração que o EF gerar *mudará essas colunas para `json`* automaticamente. Se você não estiver pronto para isso, fixe o tipo da coluna de volta para `nvarchar(max)` explicitamente ou mantenha o nível de compatibilidade abaixo de 170. Abaixo de 170, tudo neste artigo ainda funciona; os dados apenas vivem em uma coluna de texto e o SQL usa as funções JSON antigas baseadas em string.

## Configurando o mapeamento, passo a passo

Aqui está o caminho mínimo e ordenado de uma classe comum até uma coluna JSON consultável.

1. **Modele os dados aninhados como um `[ComplexType]`.** Dê a ele as propriedades que você quer dentro do documento. Coleções são permitidas dentro de um tipo complexo que mapeia para JSON, ao contrário da divisão de tabelas.
2. **Chame `ToJson()` em `OnModelCreating`.** Use `ComplexProperty(b => b.Details, d => d.ToJson())` para um único objeto aninhado. Para uma coleção de objetos aninhados, use `ComplexProperty` com um tipo de coleção, e todo o array mapeia para uma coluna.
3. **Aponte para o SQL Server 2025 para o tipo nativo.** Defina `UseCompatibilityLevel(170)` (ou `UseAzureSql`) para que a coluna seja `json` em vez de `nvarchar(max)`.
4. **Adicione uma migração e aplique-a.** `dotnet ef migrations add AddBlogDetailsJson` e depois `dotnet ef database update`. Inspecione o `CREATE TABLE` gerado para confirmar que o tipo da coluna é o que você espera.
5. **Consulte e atualize com LINQ comum.** Sem SQL bruto, sem serialização manual. As seções abaixo mostram em que cada forma de LINQ se traduz.

## Consultando dentro do documento com LINQ

Esta é a parte que faz valer a pena usar colunas JSON em vez de um blob serializado que você precisa desserializar na memória. Você filtra, projeta e ordena sobre propriedades *dentro* do JSON, e o EF traduz isso para funções JSON do lado do servidor.

Filtrar sobre um escalar aninhado lê através de `JSON_VALUE` com uma cláusula `RETURNING` tipada:

```csharp
// .NET 11, EF Core 11.0.0
var popular = await context.Blogs
    .Where(b => b.Details.Viewers > 3)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) > 3
```

A cláusula `RETURNING int` é o que permite que a comparação aconteça como um inteiro no servidor em vez de uma comparação de strings, o que é correto e amigável a índices.

### Pesquisar uma coleção de primitivos: Contains se torna JSON_CONTAINS

Verificar se um array JSON contém um valor é a consulta JSON mais comum. No SQL Server 2025, o EF Core 11 traduz `Contains` sobre uma coleção de primitivos apoiada por JSON para a nova função `JSON_CONTAINS`:

```csharp
var tagged = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

Isso substitui a tradução antiga e mais lenta baseada em `OPENJSON`, e o `JSON_CONTAINS` pode usar um índice JSON se houver um definido. Cobri essa tradução em detalhe no [artigo sobre EF Core 11 e JSON_CONTAINS](/2026/04/efcore-11-json-contains-sql-server-2025/), incluindo a troca de nível de compatibilidade que a ativa. Um ponto delicado: o `JSON_CONTAINS` não consegue pesquisar por null, então o EF só o emite quando consegue provar que um lado não admite null (uma constante não nula, ou uma coluna ou elemento não anulável). Quando não consegue, recorre à forma `OPENJSON` para que a consulta ainda retorne a resposta correta.

### Pesquisa com caminho e modo específicos: EF.Functions.JsonContains

Quando você precisa pesquisar em um caminho específico dentro do documento, ou especificar um modo de pesquisa, chame `JSON_CONTAINS` diretamente por meio de `EF.Functions.JsonContains()`:

```csharp
var rated = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

Ele aceita o valor JSON, o valor a pesquisar e, opcionalmente, um caminho e um modo de pesquisa. Funciona contra propriedades escalares de string, tipos complexos e tipos de entidade owned mapeados para JSON.

### Esse caminho existe?: EF.Functions.JsonPathExists

Novo no EF Core 11, o `EF.Functions.JsonPathExists()` verifica se um caminho JSON está presente, traduzindo para o `JSON_PATH_EXISTS` do SQL Server (disponível desde o SQL Server 2022). Esta é a ferramenta certa para "linhas onde o documento tem um campo opcional definido":

```csharp
var withOptional = await context.Blogs
    .Where(b => EF.Functions.JsonPathExists(b.JsonData, "$.OptionalInt"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_PATH_EXISTS([b].[JsonData], N'$.OptionalInt') = 1
```

## Atualizando dentro do documento sem carregá-lo

Escrever em uma coluna JSON tem dois modos. O familiar é o rastreamento de mudanças: você carrega a entidade, muta a propriedade aninhada, chama `SaveChanges`. O EF serializa o documento atualizado e escreve a coluna. Isso é bom para uma linha.

O interessante é a atualização em massa diretamente no banco de dados. O EF Core 10 adicionou suporte de `ExecuteUpdateAsync` para JSON, e ele continua no 11. Dado o mapeamento de tipo complexo acima, você pode incrementar um contador dentro do JSON para todo um conjunto de resultados em uma única ida e volta:

```csharp
await context.Blogs.ExecuteUpdateAsync(s =>
    s.SetProperty(b => b.Details.Viewers, b => b.Details.Viewers + 1));
```

No SQL Server 2025 isso usa a função `.modify()` do tipo `json`, então o servidor reescreve apenas aquela propriedade no lugar, em vez de ler e reserializar todo o documento:

```sql
UPDATE [b]
SET [Details].modify('$.Viewers', JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) + 1)
FROM [Blogs] AS [b]
```

Um requisito firme: `ExecuteUpdate` em JSON só funciona quando o tipo é mapeado como um *tipo complexo*. Não funciona para tipos de entidade owned. Esta é a razão mais concreta para preferir tipos complexos em código novo, e o compromisso mais amplo entre [`ExecuteUpdate` e carregar entidades para depois chamar SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) também se aplica aqui.

## As colunas JSON agora funcionam com herança TPT e TPC

Até o EF Core 11, os tipos complexos e as colunas JSON não podiam ser usados em tipos de entidade que usavam herança tabela por tipo (TPT) ou tabela por tipo concreto (TPC). Essa restrição acabou no 11. Você pode mapear uma propriedade JSON em um tipo base e usá-la em toda a hierarquia:

```csharp
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Animal>()
        .UseTptMappingStrategy()
        .ComplexProperty(a => a.Details, b => b.ToJson());
}
```

Se você mantém um modelo de domínio com uma hierarquia de herança real, esta é a mudança que permite manter TPT/TPC e ainda assim modelar como documento as partes compartilhadas e estruturadas de cada entidade.

## Casos limítrofes que mordem

**Semântica de owned versus complexo.** Com tipos de entidade owned, atribuir um documento a outro (`blog.BillingDetails = blog.ShippingDetails`) lança uma exceção, porque a mesma instância de entidade não pode ser rastreada duas vezes. Os tipos complexos são comparados e atribuídos por valor, então a atribuição apenas copia os campos. Se você ainda está com tipos owned para JSON, migrar para tipos complexos elimina toda uma categoria desses bugs; combina bem com a disciplina de [usar records com EF Core 11 corretamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/) para formas de valor imutáveis.

**Tipos complexos struct ainda não podem estar em coleções.** O EF Core 10 adicionou suporte de `struct` e `record struct` para tipos complexos, o que combina bem com sua semântica de valor. Mas uma *coleção* de tipos complexos struct não é suportada atualmente. Use uma classe se o tipo aninhado vive em uma lista.

**Tipos complexos opcionais precisam de uma propriedade obrigatória.** Um tipo complexo opcional (anulável) mapeado para JSON requer ao menos uma propriedade obrigatória definida no tipo, caso contrário o EF não consegue distinguir um documento todo-null de um ausente.

**A migração de nvarchar para json é automática.** Elevar o nível de compatibilidade para 170 reescreve as colunas JSON `nvarchar(max)` existentes para o tipo `json` nativo na próxima migração. Revise essa migração antes de aplicá-la em produção; é uma mudança de esquema em cada coluna JSON de uma vez.

**Indexação.** Um índice JSON é o que faz o `JSON_CONTAINS` e as buscas por caminho serem rápidos em escala. O tipo `json` nativo suporta `CREATE JSON INDEX`; colunas de texto puro não. Se suas consultas JSON são caminhos críticos, o tipo nativo mais um índice é a diferença entre um seek e uma varredura completa, a mesma lição que aparece nas [mudanças disruptivas da migração do EF Core 6 para o 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) em torno dos planos de consulta.

A versão curta: opte por `[ComplexType]` mais `ToJson()`, aponte para o SQL Server 2025 para que a coluna seja `json` de verdade, e depois trate o documento como qualquer outra parte do seu modelo em LINQ. O EF Core 11 traduz a filtragem, o `Contains` do array, as verificações de caminho e até as atualizações em massa para funções JSON do lado do servidor, então o documento nunca precisa fazer uma ida à memória só para ser consultado.

## Fontes

- [What's New in EF Core 11: complex types and JSON with TPT/TPC, JsonPathExists, JSON_CONTAINS](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: native json data type, complex types ToJson, ExecuteUpdate for JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [SQL Server json data type and the modify() method](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type)
- [JSON_CONTAINS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql)
- [JSON_PATH_EXISTS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-path-exists-transact-sql)
</content>
