---
title: "Complex types vs entidades owned no EF Core 11: qual você deve escolher?"
description: "No EF Core 11, prefira complex types para objetos de valor e recorra a entidades owned apenas quando precisar de uma tabela separada ou de uma coleção mapeada para suas próprias linhas."
pubDate: 2026-07-22
tags:
  - "comparison"
  - "complex-types"
  - "owned-entities"
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/07/complex-types-vs-owned-entities-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

No EF Core 11 (com .NET 11 e C# 14), mapeie um objeto de valor como `Address`, `Money` ou `DateRange` como um **complex type**, e recorra a uma **entidade owned** apenas quando o formato de armazenamento forçar você a isso: o valor precisa da sua própria tabela, ou você precisa de uma coleção armazenada como linhas separadas. Esse único eixo decide quase todos os casos. Complex types têm semântica de valor e nenhuma identidade, que é exatamente o que um objeto de valor é; entidades owned são tipos de entidade completos vestindo uma fantasia de objeto de valor, e a fantasia escorrega o tempo todo. O EF Core 11 é a versão em que as últimas razões para preferir entidades owned praticamente desapareceram, porque complex types agora funcionam em herança TPT/TPC, suportam `ExecuteUpdate`, permitem coleções quando mapeados para JSON e podem carregar chaves e índices.

Este post trata da decisão, não da mecânica. Se você quer a configuração passo a passo, leia [how to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/). Aqui comparamos os dois mapeamentos frente a frente, mostramos onde cada um vence e nomeamos as pegadinhas que decidem por você.

## A matriz de recursos em uma tela

A razão pela qual ambos os mapeamentos existem é que eles respondem a perguntas diferentes. Uma entidade owned é a forma do EF Core dizer "esta é uma entidade dependente que eu armazeno dentro do seu proprietário." Um complex type é a forma do EF Core dizer "este é um valor, sem identidade própria." Tudo abaixo decorre disso.

| Dimensão                                   | Complex type                         | Entidade owned                        |
| ------------------------------------------ | ------------------------------------ | ------------------------------------- |
| Tipo de modelo subjacente                  | valor, sem chave                     | entidade, chave primária sombra       |
| Semântica de identidade                    | por valor (conteúdo)                 | por referência (identidade)           |
| `a == b` no LINQ compara                   | conteúdo                             | identidade                            |
| Atribuição copia campos (`x.A = x.B`)      | sim, copia                           | lança exceção (referência compartilhada) |
| Mesma tabela do proprietário (table splitting) | sim (padrão)                     | sim (padrão)                          |
| Tabela separada (`ToTable`)                | não                                  | sim                                   |
| Coluna JSON única (`ToJson`)               | sim                                  | sim                                   |
| Coleção como linhas filhas separadas       | não                                  | sim (`OwnsMany`)                      |
| Coleção dentro de um documento JSON        | sim (`ComplexCollection` + `ToJson`) | sim (`OwnsMany` + `ToJson`)           |
| `ExecuteUpdate` em um membro aninhado      | sim (EF Core 11)                     | não                                   |
| Tipo CLR pode ser `struct` ou `record`     | sim                                  | apenas tipo de referência             |
| Chaves / índices sobre escalar aninhado    | sim (EF Core 11)                     | sim                                   |
| Herança TPT / TPC no proprietário          | sim (EF Core 11)                     | sim                                   |
| Pegada no change tracker                   | nível de coluna, sem nó separado     | nó rastreado separado + chave sombra  |

Leia essa tabela de cima a baixo e o padrão é óbvio: complex types vencem em toda linha que é sobre semântica, e entidades owned vencem nas duas linhas que são sobre formato de armazenamento (tabela separada, linhas filhas separadas). Essa é toda a comparação em miniatura. Versões importam aqui porque três dessas células "sim" para complex types só se tornaram verdadeiras no EF Core 11; no EF Core 9 o cálculo era diferente.

## Quando escolher um complex type

Recorra a `ComplexProperty` (ou ao atributo `[ComplexType]`) nestes casos, que cobrem a grande maioria dos objetos de valor em uma base de código real:

- **O tipo é definido inteiramente pelos seus dados.** `Address`, `Money`, `GeoPoint`, `DateRange`, `PersonName`. Se duas instâncias com campos idênticos são intercambiáveis, é um valor, e um valor quer semântica de valor. No EF Core 11 você escreve `b.ComplexProperty(c => c.ShippingAddress)` e os campos caem inline na tabela do proprietário.
- **Você quer atribuir ou comparar o valor naturalmente.** `customer.BillingAddress = customer.ShippingAddress` copia os campos e salva sem problemas, e `Where(c => c.BillingAddress == c.ShippingAddress)` filtra por conteúdo. Ambos ficam quebrados com entidades owned, como abordado abaixo.
- **Você quer que escritas em massa alcancem o interior do valor.** O EF Core 11 suporta `ExecuteUpdate` em membros de complex type: `ExecuteUpdateAsync(s => s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"))`. Entidades owned nunca permitiram isso. Se você se importa com o caminho de escrita rápido, isso sozinho é decisivo; os tradeoffs são os mesmos de [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).
- **O valor é um `struct` ou `record`.** Entidades owned precisam ser tipos de referência que o EF Core possa chavear e rastrear. Um complex type pode ser um `readonly struct Money` ou um `record`, o que se alinha com a ideia de "sem identidade." A interação com records vale a leitura completa em [how to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

A orientação da Microsoft não é sutil sobre esse padrão. As notas de lançamento do EF Core 11 afirmam que o trabalho de estabilização dos complex types foi feito especificamente "to unblock using complex types as an alternative to the owned entity mapping approach," e as notas do EF Core 10 disseram aos usuários existentes de entidades owned para migrarem. Trate complex types como o padrão e entidades owned como a exceção.

## Quando escolher uma entidade owned

Existem exatamente duas razões estruturais e uma razão de modelagem para permanecer em `OwnsOne` / `OwnsMany`:

- **O valor precisa viver na sua própria tabela.** Complex types são sempre inline: ou colunas table-split no proprietário, ou uma coluna JSON no proprietário. Não existe `ComplexProperty(...).ToTable("Addresses")`. Se o seu esquema requer os dados em uma tabela separada com uma chave estrangeira de volta ao proprietário (uma view de relatório se apoia nela, outra tabela a referencia, um DBA a exige), isso é uma entidade owned mapeada com `OwnsOne(...).ToTable(...)`.
- **Você precisa de uma coleção como linhas separadas.** Um um-para-muitos de objetos de valor que precisa que cada um seja sua própria linha em uma tabela filha é `OwnsMany`. Um complex type table-split precisa ser um valor único, e embora o EF Core 11 tenha adicionado `ComplexCollection` para coleções, essas são armazenadas **dentro de um documento JSON**, não como linhas filhas. Se você quer indexar, juntar ou consultar os elementos como linhas de primeira classe, `OwnsMany` ainda é a ferramenta.
- **Não é de fato um objeto de valor.** Se duas instâncias com o mesmo conteúdo precisam permanecer distinguíveis, ou a coisa tem um ciclo de vida que sobrevive aos seus dados atuais, ela tem identidade. Isso é uma entidade relacionada de verdade, não um tipo owned e não um complex type. Modele-a com um um-para-muitos normal e uma chave que você controla.

Note que nenhuma dessas razões é sobre semântica ou conveniência. Elas são sobre o esquema físico. Se a sua resposta para "isto precisa de uma tabela separada ou de linhas separadas?" é não, você não tem uma razão para usar uma entidade owned no EF Core 11.

## As três arestas das entidades owned que afastam as pessoas delas

A comparação fica concreta quando você atinge as arestas afiadas. Todas as três vêm da mesma causa raiz: uma entidade owned é uma entidade, então o EF Core lhe dá uma chave sombra e raciocina sobre ela por identidade de referência.

Primeiro, você não pode compartilhar uma instância. Isto parece que deveria funcionar e não funciona:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws: the same owned instance is referenced twice
```

Como ambas as propriedades são o mesmo tipo de entidade, o EF Core vê uma entidade referenciada de dois lugares e a recusa. Com um complex type, a atribuição copia os campos e salva sem problemas.

Segundo, a igualdade no LINQ compara identidade, não conteúdo:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var same = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress) // not what you meant
    .ToListAsync();
```

Com uma entidade owned isso não traduz para uma comparação campo a campo. Com um complex type, o EF Core 11 compara o conteúdo (incluindo complex types aninhados, após uma correção específica de bug do EF Core 11), então a consulta significa "os dois endereços são genuinamente iguais."

Terceiro, `ExecuteUpdate` não suporta propriedades de entidade owned de forma alguma, enquanto a versão com complex type funciona:

```csharp
// .NET 11, EF Core 11 - complex type mapping
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

Se o seu código atinge qualquer uma dessas três, o mapeamento de entidade owned está lutando contra você, e a correção é trocar o mapeamento, não contornar o sintoma.

## Desempenho: é sobre nós de rastreamento e joins, não um número de destaque

Não há uma diferença dramática de throughput para colocar em um gráfico aqui, e você deveria desconfiar de qualquer um que lhe mostre uma. A diferença real e estrutural de desempenho está em dois lugares.

O primeiro é o change tracking. Uma entidade owned é rastreada como seu próprio nó no change tracker, com uma chave sombra que o EF Core gerencia. Um complex type não é um nó separado: suas colunas são rastreadas como parte do proprietário, no nível de diff de coluna. Em um grafo de objetos com muitos objetos de valor por agregado, isso significa menos entradas para tirar snapshot, corrigir e diferenciar no `SaveChanges`. A diferença geralmente é pequena por entidade, mas escala com quantos objetos de valor você carrega, e é estritamente a favor do complex type porque simplesmente há menos escrituração.

O segundo é o join, e ele só se aplica ao caso de entidade owned que você de fato escolheria por razões de armazenamento. Um mapeamento `OwnsOne(...).ToTable("Addresses")` vive em uma tabela separada, então ler o proprietário com o seu objeto de valor é um join. Um complex type table-split não tem tabela separada e, portanto, nenhum join. Se você moveu um objeto de valor para uma entidade owned puramente por hábito e ele acabou na tabela do proprietário mesmo assim (o padrão), os dois são equivalentes em armazenamento e a diferença de rastreamento é a única que resta. No momento em que você de fato usa o recurso de destaque da entidade owned (uma tabela separada), você assume o custo do join que os complex types evitam por construção. Para o quadro mais amplo de custo de rastreamento, as mesmas forças aparecem em [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/).

Então a declaração honesta de desempenho é: complex types nunca são mais lentos do que uma entidade owned equivalente na mesma tabela e são estruturalmente mais enxutos para rastrear; entidades owned assumem um join precisamente quando você as usa para a única coisa que complex types não podem fazer.

## A pegadinha que decide por você: a versão do EF Core e a regra de anulabilidade

Duas coisas podem tomar a decisão por você independentemente da preferência.

A primeira é a sua versão do EF Core. Tudo acima assume EF Core 11. No EF Core 9 e anteriores, complex types não podiam ser usados em entidades com herança TPT/TPC, `ExecuteUpdate` em membros aninhados tinha bugs, a comparação de complex types aninhados estava errada e não havia `ComplexCollection`. Se você está preso ao EF Core 9, entidades owned ainda podem ser a escolha pragmática para um objeto de valor herdado ou uma coleção, e você deveria planejar a troca como parte da sua atualização. O [EF Core 6 to EF Core 11 migration guide](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cobre as mudanças que quebram compatibilidade que tendem a surgir junto com esta, e note que o `UseSqlServer` do EF Core 11 agora usa por padrão o nível de compatibilidade 160 (SQL Server 2022), o que afeta algumas traduções de JSON.

A segunda é a regra de valor opcional. Um complex type opcional (anulável) precisa ter **pelo menos uma propriedade obrigatória, não anulável**, porque o EF Core usa essa coluna para distinguir "o valor inteiro é nulo" de "o valor está presente mas seus campos opcionais são nulos." Se você tem um objeto de valor em que genuinamente todo campo é anulável, um complex type opcional não vai compilar, e você ou adiciona um discriminador, reconsidera a anulabilidade, ou recorre a uma entidade owned. Na prática, um `Address` ou `Money` real sempre tem um campo obrigatório, então isso raramente incomoda, mas é a única restrição de modelagem que pode forçar a sua mão em direção às entidades owned.

Filtros de consulta se comportam da mesma forma para ambos: um filtro global ou nomeado é definido na entidade proprietária, não no objeto de valor, então soft delete e multi-tenancy funcionam de forma idêntica qualquer que seja o mapeamento que você escolha. Se essa é a sua preocupação, veja [named query filters vs a single global query filter in EF Core 11](/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/); não é um diferencial entre complex types e entidades owned.

## A recomendação, dita de forma clara

No EF Core 11, prefira complex types para objetos de valor. Mapeie `Address`, `Money`, `GeoPoint`, `DateRange` e seus semelhantes com `ComplexProperty`, obtenha semântica de valor de graça e aproveite `ExecuteUpdate`, suporte a struct/record e igualdade limpa. Recorra a uma entidade owned apenas quando o esquema físico exigir: o valor precisa ficar na sua própria tabela, ou uma coleção de valores precisa ser armazenada como linhas filhas separadas. E se a coisa tem identidade genuína que sobrevive aos seus dados, ela nunca foi um objeto de valor, então modele-a como uma entidade relacionada de verdade com uma chave que você possui.

A regra prática é a mesma que separa um `record` de uma `class`: se a coisa é definida pelos seus dados, é um valor, e um valor é um complex type. Se ela tem uma identidade que você precisa rastrear, é uma entidade. O EF Core 11 finalmente permite que esse modelo mental mapeie um-para-um sobre o framework, com entidades owned reservadas para os casos estreitos de armazenamento em que sempre foram melhores.

## Leitura relacionada

- [How to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) é o passo a passo completo, incluindo a migração de `OwnsOne` para `ComplexProperty`.
- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) aprofunda em records como complex types versus entidades.
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cobre a opção de armazenamento JSON que ambos os mapeamentos compartilham.
- [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) enquadra o caminho de atualização em massa que complex types destravam para objetos de valor.
- [How to configure table-per-hierarchy (TPH) inheritance mapping in EF Core 11](/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) é o complemento quando o seu proprietário fica em uma hierarquia de herança.

## Fontes

- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)
