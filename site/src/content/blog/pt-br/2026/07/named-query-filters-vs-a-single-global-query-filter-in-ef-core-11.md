---
title: "Filtros de consulta nomeados vs um único filtro de consulta global no EF Core 11: qual usar?"
description: "Ambos geram o mesmo SQL. Recorra aos filtros nomeados apenas quando precisar desativar um predicado de forma independente; um único filtro combinado é mais simples para uma única preocupação no EF Core 11."
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-07
---

Se você tem uma única preocupação de filtragem em uma entidade, use um único `HasQueryFilter(e => ...)` sem nome. Se você tem duas ou mais preocupações que precisam ser levantadas de forma independente no momento da consulta, por exemplo um filtro de exclusão lógica e um filtro de tenant onde uma tela de administração precisa ver as linhas excluídas mas nunca as linhas de outro tenant, use filtros nomeados. Essa é toda a decisão. O SQL gerado é idêntico nos dois casos; a única coisa que muda é se `IgnoreQueryFilters` consegue desligar metade do seu predicado. Os filtros de consulta nomeados chegaram no EF Core 10 e são o mecanismo padrão para múltiplos filtros no EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14).

Tudo o que segue é sobre esse único eixo: a granularidade da desativação. Como ambas as abordagens se traduzem na mesma cláusula `WHERE`, aqui não há nenhuma história de desempenho nem de ecossistema. A comparação é puramente sobre quanto controle você precisa para desligar filtros.

## As duas formas lado a lado

Um filtro de consulta global é um predicado que o EF Core injeta em cada consulta LINQ de um tipo de entidade. Antes do EF Core 10 você tinha exatamente um por entidade, então uma segunda preocupação significava `&&`:

```csharp
// EF Core 9 style -- one unnamed filter, two concerns welded with &&
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

A sobrecarga nomeada recebe primeiro uma chave do tipo string, e as chamadas repetidas se compõem em vez de se sobrescrever:

```csharp
// EF Core 11 -- two named filters on the same entity
modelBuilder.Entity<Invoice>()
    .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
    .HasQueryFilter("TenantFilter",       i => i.TenantId == _tenantId);
```

Execute uma consulta simples contra qualquer uma das duas configurações e você obtém as mesmas linhas e o mesmo SQL:

```sql
-- Identical for both the && filter and the two named filters
SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
```

Essa é a coisa importante a internalizar antes de escolher: filtros nomeados não são "filtragem mais poderosa". Eles filtram exatamente igual. O que você compra com a cerimônia extra é um handle nomeado que você pode pegar mais tarde.

## Matriz de recursos

| Recurso                                   | Filtro global único                      | Filtros nomeados                               |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Filtros por entidade (EF Core 11)         | um predicado sem nome                    | vários, cada um com um nome                    |
| Combinar múltiplas preocupações           | `&&` em uma expressão                    | uma chamada `HasQueryFilter` por preocupação   |
| SQL gerado                                | `WHERE` unido com `AND`                  | `WHERE` idêntico unido com `AND`               |
| `IgnoreQueryFilters()` (sem argumentos)   | descarta o filtro inteiro                | descarta todos os filtros nomeados             |
| `IgnoreQueryFilters(["Name"])`            | não se aplica                            | descarta apenas aquele predicado               |
| Misturar com e sem nome em uma entidade   | n/a                                      | lança ao construir o modelo; escolha um estilo |
| Disponível desde                          | EF Core 2.0                              | EF Core 10                                      |
| Impacto no cache de planos de consulta    | parametrizado, um plano                  | parametrizado, um plano                        |
| Cerimônia                                 | a menor                                  | constantes de nome de filtro, helpers          |

A única linha que muda um resultado é a linha `IgnoreQueryFilters(["Name"])`. Qualquer outra diferença é cosmética ou uma restrição que você resolve uma vez.

## Quando usar um único filtro global

Recorra ao filtro simples sem nome quando o endereçamento extra não trouxer nada:

- **Uma única preocupação por entidade.** Uma tabela de lookup somente leitura que só precisa de `!IsArchived` não tem nada para desativar de forma seletiva. `HasQueryFilter(x => !x.IsArchived)` é toda a história, e um nome seria peso morto.
- **Você sempre quer tudo ou nada.** Se o único momento em que você contorna o filtro é uma rota de administração ou migração que legitimamente quer ver tudo, `IgnoreQueryFilters()` sem parâmetros é exatamente o certo. Nomear permitiria fazer menos do que você quer, não mais.
- **Múltiplas preocupações que nunca são levantadas separadamente.** Dois predicados combinados com `&&` estão bem quando nenhuma rota de código precisa de um ligado e o outro desligado. Um filtro `!IsDeleted && OrgId == _orgId` em uma ferramenta interna onde você nunca expõe "mostrar excluídos" é mais simples como uma única expressão.
- **Você está no EF Core 9 ou anterior.** A sobrecarga nomeada não existe antes do EF Core 10, então um único filtro `&&` é a única opção embutida. Se você ainda combina preocupações dessa forma, veja [migrar do EF Core 6 para o EF Core 11: mudanças disruptivas que realmente mordem](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) antes de separá-las.

A vantagem do filtro único é que ele não tem strings mágicas. Não há nenhum typo `IgnoreQueryFilters(["SoftDeletonFilter"])` esperando para desativar nada em silêncio, porque não há nenhum nome para digitar errado.

## Quando usar filtros nomeados

Nomeie seus filtros no momento em que duas preocupações precisarem de ciclos de vida diferentes em uma única consulta:

- **Exclusão lógica mais multi-tenancy na mesma tabela.** Este é o caso canônico. Um relatório de administração precisa ver as faturas excluídas, mas deve permanecer restrito ao tenant atual. Com `IgnoreQueryFilters(["SoftDeletionFilter"])` o predicado do tenant sobrevive, então você não consegue transformar uma tela de relatórios em um vazamento de dados entre tenants. Todo o cabeamento está em [como usar filtros de consulta nomeados para exclusão lógica e multi-tenancy no EF Core 11](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).
- **Uma preocupação "comutável" ao lado de uma preocupação "nunca desligada".** Sempre que um predicado é um limite de segurança (tenant, propriedade, autorização em nível de linha) e outro é uma conveniência (exclusão lógica, estado publicado/rascunho), nomear permite expor o interruptor de conveniência sem nunca entregar aos chamadores uma forma de descartar o limite.
- **Você quer uma API que revele a intenção para o bypass.** Com nomes você pode envolver o ignore atrás de um método de extensão para que nenhum chamador digite uma string de filtro:

```csharp
// EF Core 11 -- filter name hidden behind a readable call site
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant     = nameof(Tenant);
}

public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> q)
    => q.IgnoreQueryFilters([InvoiceFilters.SoftDelete]); // tenant filter stays on

// Reads like English, cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

- **Os filtros vivem em classes de configuração separadas.** Se a exclusão lógica vem de uma convenção `IEntityTypeConfiguration<T>` compartilhada e o filtro de tenant é específico da aplicação, duas chamadas nomeadas os mantêm desacoplados em vez de forçar uma classe a ser dona de uma expressão `&&` combinada.

## Por que não há seção de benchmark

Um artigo de comparação normalmente deve números a você. Este não deve, e vale a pena dizer isso com clareza para que você não vá procurar uma diferença que não existe. Ambas as abordagens se reduzem à mesma árvore de predicados, então o EF Core emite a mesma cláusula `WHERE` e o planejador de consultas vê o mesmo SQL. O valor do tenant se torna um parâmetro de consulta nos dois casos, o que significa que nenhuma das abordagens fragmenta o cache de planos como uma constante embutida faria. Não há custo por consulta ao nomear um filtro; o nome existe apenas nos metadados do modelo, não na consulta traduzida. Se você esperava que os filtros nomeados também fossem uma alavanca de desempenho, eles não são. Escolha apenas pelo eixo de granularidade da desativação. Se você está medindo a contagem de consultas enquanto adiciona qualquer filtro, o que realmente mexe o ponteiro são os joins, tratado em [como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).

## Os detalhes que decidem por você

Três restrições podem forçar a decisão independentemente de qual você preferiria por razões de estilo.

**Você não pode misturar filtros com e sem nome em uma entidade.** Assim que qualquer filtro sobre `Invoice` tiver um nome, todos precisam ter. Adicionar um `HasQueryFilter(i => ...)` sem nome a uma entidade que já tem um filtro nomeado lança no momento de construir o modelo. Então a escolha é por entidade, não por filtro: decida o estilo uma vez, e se você algum dia esperar uma segunda preocupação comutada de forma independente, comece nomeado.

**`IgnoreQueryFilters()` sem parâmetros ainda destrói tudo.** Nomear seus filtros não torna a antiga chamada sem parâmetros segura. `context.Invoices.IgnoreQueryFilters().ToListAsync()` descarta também o filtro de tenant. Em qualquer tabela que carregue uma coluna de tenant, trate a sobrecarga sem argumentos como um code smell e sempre passe a lista explícita de nomes que você pretende desativar. Esse único hábito é a diferença entre um interruptor de exclusão lógica e uma leitura acidental entre tenants.

**Nomes de filtro como strings mágicas falham em silêncio.** `IgnoreQueryFilters(["SoftDeletonFilter"])` com um typo não desativa nada e não lança nenhum erro, porque o EF não tem como saber que você quis dizer um filtro real. Se você for de nomes, fixe os nomes em campos `const` (como no trecho acima) para que um typo seja um erro de compilação, não um vazamento em produção. Um único filtro sem nome não tem essa armadilha, o que é um ponto genuíno a seu favor quando você tem apenas uma preocupação.

Um detalhe se aplica igualmente a ambos e não é um critério de desempate: um filtro no lado obrigatório de uma navegação transforma `Include` em um `INNER JOIN`, então um pai filtrado descarta em silêncio seus filhos. Esse comportamento é idêntico quer o predicado seja nomeado ou combinado com `&&`. A correção, um `LEFT JOIN` via uma navegação opcional ou um filtro correspondente em ambas as pontas, é a mesma nos dois mundos e é explicada passo a passo no [guia de filtros de consulta nomeados](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

## Migrando de um filtro combinado para filtros nomeados

Se você já distribui um filtro `!IsDeleted && TenantId == x` e agora precisa expor "mostrar excluídos" sem descartar a restrição por tenant, a migração é mecânica. Divida a única expressão em duas chamadas nomeadas:

```csharp
// Before -- one filter, cannot disable half of it
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);

// After -- two named filters, soft delete now independently ignorable
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant,     i => i.TenantId == _tenantId);
```

Nada do comportamento de consulta padrão muda; as mesmas linhas voltam e o mesmo SQL é gerado. A única capacidade nova é que `IgnoreQueryFilters([InvoiceFilters.SoftDelete])` agora existe como um bypass direcionado. Como você não pode misturar estilos, faça essa divisão para a entidade inteira em uma única edição, e audite cada chamada `IgnoreQueryFilters()` existente sobre essa entidade: qualquer chamada sem parâmetros que costumava significar "visão de administração com excluídos" já estava descartando o filtro de tenant, e dividir o filtro é o momento de tornar essas chamadas explícitas.

## A decisão

Por padrão, um único filtro de consulta global sem nome. É a opção de menor cerimônia, não tem strings mágicas, e para o caso comum de uma única preocupação por entidade é estritamente a escolha certa. Suba para filtros nomeados no instante em que uma segunda preocupação precisar ser comutada de forma independente da primeira, o que na prática quase sempre significa "exclusão lógica ao lado de um limite de tenant ou de propriedade". A regra prática: se você consegue imaginar uma consulta que quer um predicado desligado e o outro ligado, nomeie-os agora; caso contrário combine com `&&` e siga em frente. O SQL não vai notar a diferença, mas o seu eu futuro depurando por que um relatório de administração vazou as faturas de outro tenant com certeza vai.

## Relacionados

- [Como usar filtros de consulta nomeados para exclusão lógica e multi-tenancy no EF Core 11](/pt-br/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution no EF Core 11](/pt-br/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [Como usar interceptores do EF Core 11 para auditoria](/pt-br/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core ExecuteUpdate vs carregar entidades e SaveChanges](/pt-br/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)

## Fontes

- [Global Query Filters, documentação do EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10: multiple query filters per entity, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
- [Named global query filters in Entity Framework Core 10, Tim Deschryver](https://timdeschryver.dev/blog/named-global-query-filters-in-entity-framework-core-10)
- [Add ability to configure multiple query filters on a given DbSet, dotnet/efcore issue #33432](https://github.com/dotnet/efcore/issues/33432)
