---
title: "TPH vs TPT vs TPC para mapeamento de herança no EF Core 11: qual você deve escolher?"
description: "No EF Core 11, use TPH por padrao para quase toda hierarquia, recorra ao TPC apenas quando voce consulta quase sempre um unico tipo folha e um benchmark prova que ele vence, e use TPT somente quando uma restricao externa obrigar."
pubDate: 2026-07-22
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/07/tph-vs-tpt-vs-tpc-inheritance-mapping-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

No EF Core 11 (com .NET 11 e C# 14), mapeie uma hierarquia de classes com **table-per-hierarchy (TPH)** a menos que voce tenha um motivo medido para nao fazer isso. O TPH coloca toda a hierarquia em uma unica tabela com uma coluna discriminadora, entao as leituras sao varreduras de tabela unica sem joins. Recorra ao **table-per-concrete-type (TPC)** apenas quando seu codigo consulta de forma esmagadora um unico tipo folha e um benchmark sobre seus dados mostra que ele supera o TPH. Use **table-per-type (TPT)** somente quando uma restricao externa obrigar, porque o proprio benchmark da Microsoft coloca o TPT em cerca de duas vezes o tempo e quase o dobro das alocacoes do TPH em uma consulta do tipo base. A regra em uma linha: TPH por padrao, TPC para cargas de trabalho centradas em tipo folha que medem mais rapido, TPT nunca por escolha.

Este artigo e a decisao, nao o passo a passo completo de configuracao. Se voce quer a API do discriminador, as colunas compartilhadas e a mecanica de colunas anulaveis em profundidade, leia [como configurar o mapeamento de heranca table-per-hierarchy (TPH) no EF Core 11](/pt-br/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/). Aqui colocamos as tres estrategias lado a lado, mostramos o esquema que cada uma gera e nomeamos as restricoes que tomam a decisao por voce.

## A matriz de recursos em uma tela

Pegue uma hierarquia de dois niveis: uma classe base `Blog` e uma derivada `RssBlog` que adiciona um `RssUrl`. As tres estrategias mapeiam isso para tres esquemas completamente diferentes, e cada compromisso abaixo deriva dessa forma.

| Dimensao                               | TPH                          | TPT                                | TPC                                   |
| -------------------------------------- | ---------------------------- | ---------------------------------- | ------------------------------------- |
| Tabelas geradas                        | uma, toda a hierarquia       | uma por tipo (incluindo abstratos) | uma por tipo concreto apenas          |
| Coluna discriminadora                  | sim                          | nao                                | nao                                   |
| Colunas de tipo derivado               | anulaveis, tabela compartilhada| tabela propria, podem ser `NOT NULL`| tabela propria, podem ser `NOT NULL` |
| Consulta do tipo base (`context.Blogs`)| um `SELECT`, sem join       | `LEFT JOIN` entre todas as tabelas | `UNION ALL` entre tabelas concretas   |
| Consulta de um tipo folha (`OfType<RssBlog>`)| predicado discriminador| join tabela base + folha           | uma tabela, sem filtro                |
| Forma de armazenamento                 | larga, esparsa, muitos nulls | normalizada, sem nulls             | desnormalizada, colunas repetidas     |
| Geracao de chaves                      | qualquer (Identity serve)    | qualquer (Identity na base)        | sequencia compartilhada, sem Identity simples |
| Restricao FK para o tipo base          | sim                          | sim                                | nao (a chave vive na tabela folha)    |
| Tipos complexos / colunas JSON         | sim                          | sim (novo no EF Core 11)           | sim (novo no EF Core 11)              |
| Leitura do tipo base: velocidade relativa| mais rapida (referencia)   | ~2x mais lenta                     | ~igual ao TPH                         |
| Postura da Microsoft                   | padrao recomendado           | "apenas se voce estiver obrigado"  | boa para consultas de um tipo folha   |

O padrao nao e sutil. O TPH vence ou empata em quase toda linha que importa, o TPC o iguala exceto quando voce consulta entre tipos, e o TPT troca um esquema de aparencia mais limpa por joins que custam a voce em tempo de consulta. Tres dessas celulas mudaram no EF Core 11: os tipos complexos e as colunas JSON agora funcionam em hierarquias TPT e TPC, o que antes nao era suportado e empurrava as pessoas de volta as entidades proprietarias para qualquer objeto de valor herdado. Isso encerra um dos ultimos motivos nao relacionados a desempenho para evitar TPT e TPC, mas nao muda o veredito de desempenho.

## O que cada estrategia realmente escreve no banco de dados

Os esquemas concretizam os compromissos abstratos. O TPH e uma unica tabela com um discriminador e colunas derivadas anulaveis:

```sql
-- TPH: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [RssUrl] nvarchar(max) NULL,          -- nullable: base Blogs have no RssUrl
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);
```

O TPT divide cada tipo em sua propria tabela, ligadas por uma chave estrangeira sobre a chave primaria compartilhada:

```sql
-- TPT: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL,
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId]),
    CONSTRAINT [FK_RssBlogs_Blogs_BlogId] FOREIGN KEY ([BlogId])
        REFERENCES [Blogs] ([BlogId]) ON DELETE NO ACTION
);
```

O TPC da a cada tipo concreto uma tabela autocontida com cada coluna herdada repetida, com chave baseada em uma sequencia compartilhada:

```sql
-- TPC: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,             -- inherited column, repeated here
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId])
);
```

Configurar cada uma e uma unica linha na entidade raiz. O TPH e o padrao e nao precisa de nada; TPT e TPC sao ativados com uma chamada de estrategia de mapeamento:

```csharp
// EF Core 11: choosing a strategy on the root entity type
modelBuilder.Entity<Blog>().UseTphMappingStrategy(); // default, can be omitted
modelBuilder.Entity<Blog>().UseTptMappingStrategy(); // one table per type
modelBuilder.Entity<Blog>().UseTpcMappingStrategy(); // one table per concrete type
```

## Quando escolher TPH

O TPH e a resposta certa para a grande maioria das hierarquias. Escolha-o quando:

- **Voce consulta atraves da hierarquia.** Qualquer codigo que le o tipo base (uma lista de todas as linhas `Payment`, um painel que mistura `CardPayment` e `BankTransferPayment`) e uma varredura de uma tabela indexada sob o TPH. Nao ha join nem `UNION`. Este e o padrao de acesso mais comum, e e exatamente onde o TPT falha.
- **A hierarquia e rasa ou os tipos derivados adicionam poucas colunas.** Dois ou tres subtipos que adicionam um punhado de propriedades cada um produzem uma tabela apenas levemente esparsa. Os bancos de dados lidam bem com colunas vazias, e no SQL Server voce pode marcar colunas TPH raramente populadas como [colunas esparsas (sparse columns)](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns) para recuperar o espaco.
- **Voce quer as escritas mais simples.** Um insert TPH e uma linha em uma tabela. `ExecuteUpdate` e `ExecuteDelete` contra um tipo derivado aplicam o predicado discriminador por voce e tocam uma unica tabela, que e o caminho limpo de escrita em massa descrito em [como usar ExecuteUpdate e ExecuteDelete para escritas em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/).
- **Voce precisa de uma chave estrangeira para o tipo base.** Como cada linha vive em uma tabela, um relacionamento que aponta para o tipo base ganha uma restricao FK real. O TPC nao consegue impor essa restricao, como coberto abaixo.

O unico custo que voce aceita e que uma propriedade obrigatoria em um tipo derivado ainda mapeia para uma coluna anulavel, porque as linhas irmas a deixam vazia. Se a nao-nulidade imposta pelo banco de dados em propriedades derivadas e um requisito rigido, esse e o motivo classico para deixar o TPH, e ele aponta para o TPT.

## Quando escolher TPC

O TPC e o especialista. Ele iguala o TPH de perto em consultas entre tipos e se adianta em uma forma especifica:

- **Voce quase sempre consulta um unico tipo folha.** Se seu caminho quente e `context.RssBlogs.Where(...)` e raramente `context.Blogs`, o TPC le uma tabela autocontida sem filtro discriminador e sem join. A orientacao da Microsoft e explicita: o TPC se destaca "ao consultar entidades de um unico tipo folha". Meca-o contra o TPH sobre seus dados antes de se comprometer, porque o ganho depende da carga de trabalho.
- **Voce quer colunas derivadas nao nulas sem os joins do TPT.** Cada tabela TPC contem todas as colunas de um tipo concreto inline, entao uma propriedade derivada obrigatoria pode ser `NOT NULL` em sua propria tabela, e ler esse tipo continua sendo de uma unica tabela. Essa e a propriedade que o TPT compra com um join e o TPC compra sem ele.

O preco e um esquema desnormalizado e chaves incomodas. O TPC nao pode usar uma coluna `Identity` simples, porque nao ha uma unica tabela que possua a sequencia; o EF Core 11 usa por padrao uma sequencia de banco de dados compartilhada (`NEXT VALUE FOR [BlogSequence]`) para que as chaves continuem unicas entre tabelas irmas. No SQLite, que nao tem sequencias, a geracao de chaves inteiras nao esta disponivel para o TPC e voce recorre a GUIDs gerados no cliente. E como a chave primaria de um tipo base pode viver em qualquer tabela concreta, uma chave estrangeira que referencia o tipo base nao pode ser imposta por uma restricao de banco de dados de forma alguma. Se todas as suas escritas passam pelo EF Core com navegacoes, isso costuma ser aceitavel, mas e uma perda real de integridade em nivel de banco de dados.

## Quando escolher TPT (e por que a resposta costuma ser "nao escolha")

O TPT produz o esquema que mais se parece com seu diagrama de classes: uma tabela por tipo, unidas pela chave. Essa estetica e a armadilha. Recorra ao TPT apenas quando:

- **Uma restricao externa dita o esquema.** Um DBA obriga uma tabela normalizada por tipo, um esquema legado que voce nao pode mudar ja tem essa aparencia, ou outro sistema le as tabelas por tipo diretamente. Esses sao os casos de "estar obrigado a fazer isso por fatores externos" que a Microsoft nomeia.
- **Voce realmente precisa de tabelas por tipo com restricoes FK e colunas derivadas nao nulas e as consultas entre tipos sao raras.** Esta e uma intersecao estreita, e mesmo entao voce deveria fazer benchmark contra o TPC primeiro.

Nao escolha o TPT porque ele parece mais limpo. Cada consulta do tipo base faz join entre todo o conjunto de tabelas, e joins sao uma das principais fontes de problemas de desempenho relacional. Os numeros confirmam isso, que e a proxima secao.

## O benchmark: o TPT custa cerca de 2x

Isso nao e conversa fiada. O proprio benchmark de heranca da Microsoft monta uma hierarquia de 7 tipos, semeia 5000 linhas por tipo (35000 linhas no total) e carrega cada linha do banco de dados. Os resultados:

| Metodo | Media     | Alocado   |
| ------ | --------- | --------- |
| TPH    | 149.0 ms  | 40 MB     |
| TPT    | 312.9 ms  | 75 MB     |
| TPC    | 158.2 ms  | 46 MB     |

O TPT e cerca de 2.1x mais lento que o TPH e aloca quase o dobro de memoria, porque carregar a hierarquia faz join de sete tabelas. O TPC fica dentro de cerca de 6 por cento do TPH nesta consulta de todos os tipos, e se adiantaria ao TPH em uma consulta de um unico tipo folha onde ele le uma tabela e o TPH ainda varre a tabela compartilhada com um filtro discriminador. A metodologia importa: esta e uma consulta do tipo base que toca cada tabela, que e o pior caso do TPC e do TPT, entao a diferenca que voce ve na sua carga de trabalho depende de com que frequencia voce consulta entre tipos versus um tipo folha. Ainda assim, a conclusao e estavel entre execucoes: o TPT paga um imposto de join que o TPH e o TPC nao pagam, e nenhum argumento de estetica de esquema o recupera.

Execute o benchmark contra seu proprio modelo antes de tomar uma decisao irreversivel. Mudar uma estrategia de heranca depois de ter dados em producao significa uma migracao de esquema que move linhas entre tabelas, entao esta e uma decisao que vale a pena medir uma vez, cedo.

## As armadilhas que decidem por voce

Tres restricoes podem decidir a estrategia independentemente da preferencia.

A primeira e a **nao-nulidade imposta pelo banco de dados em uma propriedade derivada**. O TPH nao consegue fazer isso, porque a coluna compartilhada precisa ser anulavel para as linhas irmas. Se voce precisa que o banco de dados (nao apenas sua aplicacao) garanta que cada `CardPayment` tem um `Last4`, voce precisa dessa coluna em sua propria tabela, o que significa TPT ou TPC.

A segunda e a **geracao de chaves no seu banco de dados**. O TPC precisa de sequencias para chaves inteiras. No SQL Server isso e automatico, mas no SQLite voce nao pode usar chaves de identidade inteiras com o TPC de forma alguma e deve trocar para GUIDs. Se voce esta no SQLite e quer chaves inteiras, o TPC esta descartado.

A terceira e a **integridade de chave estrangeira para o tipo base**. Se outras tabelas referenciam seu tipo base e voce quer que o banco de dados imponha essas referencias, o TPC nao consegue lhe dar a restricao. TPH e TPT conseguem. Isso por si so descarta o TPC para muitos esquemas normalizados.

Uma coisa igual nas tres: voce nao pode mudar o tipo de uma entidade em tempo de execucao. Transformar um `CardPayment` em um `BankTransferPayment` e um delete mais um insert em cada estrategia, porque o discriminador (ou a propria tabela) codifica o tipo. Isso e uma realidade de modelagem, nao um diferenciador.

## A recomendacao, dita claramente

Use TPH por padrao. E a mais rapida para a consulta comum entre tipos, a mais simples para escrever contra ela, a unica estrategia sem friccao de geracao de chaves, e o padrao recomendado pela Microsoft para um amplo leque de cenarios. Recorra ao TPC apenas quando sua carga de trabalho for dominada por consultas de um unico tipo folha e um benchmark sobre seus dados mostrar que ele supera o TPH, e aceite o esquema desnormalizado, as chaves de sequencia compartilhada e a ausencia da restricao FK para o tipo base que o acompanham. Use TPT apenas quando um fator externo nao lhe der escolha, e faca isso sabendo que voce paga um imposto de consulta de cerca de 2x por um esquema que parece mais arrumado.

O modelo mental e o mesmo que os numeros impoem: uma tabela e rapida, muitas tabelas unidas por join sao lentas, e muitas tabelas sem join sao rapidas mas desnormalizadas. Se esta decisao faz parte de uma atualizacao de versao mais ampla, as mudancas de heranca e mapeamento tendem a aparecer junto as do [guia de migracao do EF Core 6 para o EF Core 11](/pt-br/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Leituras relacionadas

- [Como configurar o mapeamento de heranca table-per-hierarchy (TPH) no EF Core 11](/pt-br/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) e o passo a passo completo do TPH: API do discriminador, colunas compartilhadas e a regra de colunas anulaveis.
- [Tipos complexos vs entidades proprietarias no EF Core 11](/pt-br/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) cobre o mapeamento de objetos de valor, que agora funciona dentro de hierarquias TPT e TPC.
- [Como mapear e consultar colunas JSON no EF Core 11](/pt-br/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) explica o armazenamento JSON que as hierarquias de heranca ganharam no EF Core 11.
- [Como usar ExecuteUpdate e ExecuteDelete para escritas em massa no EF Core 11](/pt-br/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) mostra o caminho de escrita em massa de tabela unica que o TPH torna limpo.
- [Como detectar consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11) ajuda a pegar os padroes de consulta com muitos joins que o TPT pode incentivar.

## Fontes

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Modeling for performance: inheritance mapping (with the TPH/TPT/TPC benchmark)](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core inheritance benchmark source](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Benchmarks/Inheritance.cs)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [SQL Server sparse columns](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns)
