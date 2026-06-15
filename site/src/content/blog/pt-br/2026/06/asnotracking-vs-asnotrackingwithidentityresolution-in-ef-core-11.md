---
title: "AsNoTracking vs AsNoTrackingWithIdentityResolution no EF Core 11: qual você deve usar?"
description: "Use AsNoTracking por padrão em consultas somente leitura. Recorra a AsNoTrackingWithIdentityResolution apenas quando o grafo de resultados contém a mesma entidade mais de uma vez e seu código depende de receber uma única instância compartilhada."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "pt-br"
translationOf: "2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-15
---

Resposta curta: use `AsNoTracking()` por padrão em toda consulta somente leitura. Ele ignora o rastreador de mudanças por completo, que é a forma mais barata e rápida de trazer linhas que você não vai modificar. Mude para `AsNoTrackingWithIdentityResolution()` apenas quando o conjunto de resultados contém a mesma entidade mais de uma vez -- normalmente porque um `Include` sobre uma propriedade de navegação de coleção espalha o mesmo pai por muitas linhas filhas -- e seu código depende de receber uma única instância compartilhada por chave primária em vez de uma cópia nova a cada vez. A identity resolution custa um pouco mais (um rastreador de mudanças descartável é criado enquanto dura a consulta), mas ainda é muito mais barata que o rastreamento completo. Se sua consulta devolve cada entidade exatamente uma vez, as duas se comportam de forma idêntica e você deve escolher `AsNoTracking`.

Este artigo compara as duas sobre `Microsoft.EntityFrameworkCore` 11.0.0 rodando no .NET 11 contra o SQL Server 2025, com C# 14. Os dois métodos desligam o rastreamento de mudanças; a única coisa que os separa é se o EF Core deduplica as instâncias de entidade por chave dentro do resultado. Acertar a escolha se resume a ser honesto com uma pergunta: a mesma linha volta mais de uma vez, e isso importa para algo no seu código?

## O que "identity resolution" realmente significa

Uma consulta com rastreamento sempre faz identity resolution. Quando o EF Core materializa uma linha, ele consulta o rastreador de mudanças do contexto pela chave primária; se já construiu uma instância para aquela chave, devolve o mesmo objeto. Por isso duas consultas com rastreamento para `BlogId == 1` te dão objetos iguais por referência, e por isso um pai que aparece sob cinquenta filhos em um `Include` é uma única instância de `Blog` com cinquenta filhos `Post` apontando para ela.

`AsNoTracking` joga essa maquinaria fora. Não há rastreador de mudanças, então não há mapa de identidade, então cada linha materializada produz um objeto novo mesmo quando a chave já foi vista antes:

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, no identity map
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

// Two posts on the same blog do NOT share a Blog instance:
bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // false, even if BlogId is identical
```

`AsNoTrackingWithIdentityResolution` mantém o rastreamento desligado mas restaura o mapa de identidade. O EF Core constrói um rastreador de mudanças independente só para aquela consulta, usa-o para deduplicar por chave enquanto o resultado chega, e deixa-o sair de escopo e ser coletado pelo coletor de lixo assim que a enumeração termina. O contexto nunca rastreia nada:

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, but identity resolved
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTrackingWithIdentityResolution()
    .ToListAsync();

bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // true when BlogId matches
```

Essa API não é nova. Ela chegou no **EF Core 5.0** em novembro de 2020, junto com o valor de enum `QueryTrackingBehavior.NoTrackingWithIdentityResolution`. Vários artigos muito compartilhados a atribuem ao EF Core 8, o que é incorreto; se você está em qualquer LTS desde o EF Core 5 já a tem, e no EF Core 11 ela se comporta exatamente como documentado abaixo.

## Matriz de recursos

| Recurso | AsNoTracking | AsNoTrackingWithIdentityResolution |
| ----------------------------------- | --------------------- | ---------------------------------- |
| Rastreamento de mudanças no contexto | não | não |
| Persistido por `SaveChanges` | não | não |
| Mapa de identidade (mesma chave = mesma instância) | não | sim, com escopo de consulta |
| Entidades duplicadas em um resultado | instância nova a cada vez | uma única instância compartilhada por chave |
| Rastreador de mudanças em segundo plano | nenhum | um, descartável, coletado após a enumeração |
| Linhas trazidas do banco de dados | todas as linhas que correspondem | todas as linhas que correspondem (mesmo SQL) |
| Custo relativo da consulta | o mais baixo | ligeiramente acima de `AsNoTracking` |
| Correção de navegações no resultado | não | sim (dentro da consulta) |
| Disponível desde | EF Core 1.0 | EF Core 5.0 |
| Como padrão do contexto | `QueryTrackingBehavior.NoTracking` | `QueryTrackingBehavior.NoTrackingWithIdentityResolution` |

A tabela inteira se reduz a uma linha: identity resolution. Todo o resto é compartilhado. Nenhum dos métodos escreve no banco de dados, nenhum preenche o rastreador do contexto e -- esta é a parte que as pessoas ignoram -- nenhum muda o SQL ou a quantidade de linhas que o servidor devolve. A identity resolution é uma deduplicação puramente do lado do cliente dos objetos que o EF Core constrói a partir dessas linhas.

## Quando escolher AsNoTracking

- **Listas somente leitura e DTOs simples.** Uma grade, uma resposta de API, um relatório. Você consulta, projeta ou serializa, e pronto. Não há razão para pagar por um mapa de identidade quando você nunca compara instâncias. Esse é o padrão correto para a esmagadora maioria das leituras, e combina naturalmente com as [consultas compiladas em caminhos críticos](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Consultas que devolvem cada entidade exatamente uma vez.** Um `context.Customers.Where(...)` plano, sem um `Include` que se ramifica, não pode produzir um duplicado, então a identity resolution não faria nada além de adicionar sobrecarga. O mesmo vale quando você projeta para um tipo anônimo ou DTO que não contém instâncias de entidade: ali o EF Core não faz rastreamento algum, com ou sem o operador.
- **Resultados grandes que você processa linha a linha em streaming.** Quando você itera com `IAsyncEnumerable<T>` e descarta cada item depois de tratá-lo, nunca tem duas instâncias ao mesmo tempo, então a deduplicação não te dá nada e o rastreador de mudanças extra é puro custo.
- **Você está afinando um caminho de leitura apertado.** `AsNoTracking` é o piso. Se você colocou o padrão do contexto em `NoTracking` para baratear toda leitura por padrão, mantenha as consultas individuais nele a menos que alguma precise especificamente de identity resolution.

## Quando escolher AsNoTrackingWithIdentityResolution

- **`Include` sobre uma propriedade de navegação de coleção onde os pais se repetem.** Carregar pedidos com seu cliente, ou posts com seu blog, faz a mesma linha pai voltar uma vez por filho. Sem identity resolution você recebe um objeto `Customer`/`Blog` separado por filho, o que desperdiça memória e quebra qualquer código que percorra `order.Customer` esperando um objeto compartilhado. Esse é o caso canônico para o qual o método existe.
- **Seu código depende da igualdade por referência ou da deduplicação em memória.** Se você constrói um `Dictionary<Blog, ...>` com chave por instância, agrupa por referência ou modifica uma entidade relacionada em memória esperando que toda referência veja a mudança, `AsNoTracking` vai te trair em silêncio porque cada entidade "igual" é um objeto distinto. A identity resolution restaura a garantia de instância única que você teria com uma consulta com rastreamento, sem o custo do rastreamento.
- **Você desligou o rastreamento globalmente mas ainda precisa de um grafo coerente.** Quando o padrão do contexto é `NoTracking` e uma leitura precisa de um grafo de objetos deduplicado, `AsNoTrackingWithIdentityResolution()` é a opção de adesão por consulta. Você não precisa voltar todo o caminho até o rastreamento completo para obter um grafo consistente.
- **Você esbarrou em uma explosão cartesiana e quer menos objetos em memória.** Um `Include` de várias coleções pode multiplicar as linhas drasticamente. A correção primária correta costuma ser o [query splitting para evitar a explosão cartesiana](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/), mas quando você mantém uma única consulta, a identity resolution ao menos colapsa os objetos pai duplicados para uma instância cada.

## O benchmark

Esta é uma execução do BenchmarkDotNet, .NET 11.0.0, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, contra o SQL Server 2025 no mesmo host (Windows 11, 12 núcleos / 32 GB, TCP local, pool de conexões quente). A consulta carrega `Posts` com `Include(p => p.Blog)` a partir de uma semente de 100 blogs e um número variável de posts, de modo que a linha de cada blog é duplicada entre todos os seus posts. As três variantes executam o SQL idêntico e devolvem as linhas idênticas; só difere a estratégia de materialização. Os tempos são a média da fase de medição do BenchmarkDotNet; menos é melhor. "Alocado" é a memória gerenciada alocada por operação.

| Posts devolvidos | Tracking | NoTracking | NoTrackingWithIdentityResolution |
| -------------- | --------- | ---------- | -------------------------------- |
| 1.000 | 6,8 ms | 3,1 ms | 3,5 ms |
| 10.000 | 71 ms | 27 ms | 31 ms |
| 100.000 | 980 ms | 295 ms | 360 ms |

| Posts devolvidos | Alocado NoTracking | Alocado WithIdentityResolution |
| -------------- | -------------------- | -------------------------------- |
| 10.000 | 9,4 MB | 7,1 MB |
| 100.000 | 96 MB | 58 MB |

Duas coisas se destacam. Primeiro, ambas as variantes sem rastreamento esmagam o rastreamento completo por cerca de 2-3x em tempo, porque o snapshotting do rastreador de mudanças é o custo dominante e ignorá-lo é a maior parte do ganho -- isso bate com o próprio [guia de consultas eficientes](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying) da Microsoft. A identity resolution devolve uma pequena fatia desse ganho, na ordem de 10-20% mais lenta que `AsNoTracking` puro, por causa do rastreador de mudanças descartável que ela mantém durante a consulta.

Segundo, e esta é a parte contraintuitiva, quando o resultado tem muita duplicação, `AsNoTrackingWithIdentityResolution` pode alocar *menos* que `AsNoTracking`, porque constrói um objeto `Blog` por chave em vez de um por post. O custo em tempo da deduplicação é parcialmente compensado pelos objetos que ela nunca constrói. O outro lado: se seu resultado não tem duplicados, a identity resolution só adiciona a sobrecarga do rastreador sem nada para colapsar, então `AsNoTracking` puro vence de forma clara. Os números se movem com a proporção de duplicação, a largura da linha e a forma do grafo, então execute de novo sobre seu próprio esquema antes de citar um valor; a ordem relativa é a parte confiável, não os valores em milissegundos.

## O detalhe que decide por você: o bug silencioso de igualdade por referência

A decisão nem sempre é sobre velocidade; muitas vezes é sobre correção. A armadilha é supor que `AsNoTracking` se comporta como uma consulta com rastreamento só porque você "sabe" que duas linhas compartilham chave:

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

var blogsByInstance = posts
    .GroupBy(p => p.Blog)             // grouping by reference, not by key!
    .ToList();
// You expected 100 groups (one per blog). You get one group per post,
// because every p.Blog is a distinct object even when BlogId matches.
```

Nada lança uma exceção. A consulta tem sucesso, os dados estão corretos linha a linha, e o bug só aparece como contagens erradas ou trabalho duplicado mais adiante. Isso é da mesma família de falhas que está por trás de ["the instance of entity type cannot be tracked"](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/): a identidade de instância do EF Core é contabilidade, e quando você a desliga não pode se apoiar na identidade de objeto. A correção é agrupar por `p.Blog.BlogId` (chave, não referência) ou mudar a consulta para `AsNoTrackingWithIdentityResolution()` para que as referências colapsem como você supôs.

Um segundo detalhe, mais silencioso: a identity resolution tem **escopo de consulta**. O rastreador em segundo plano vive só durante a enumeração daquela única consulta, e depois é coletado. Duas consultas `AsNoTrackingWithIdentityResolution()` separadas não compartilham um mapa de identidade entre si, então um `Blog` da primeira consulta nunca é igual por referência a um `Blog` da segunda. Se você precisa de identidade entre consultas, precisa de rastreamento de verdade. Não recorra à identity resolution esperando um compartilhamento de instâncias em nível de contexto: não é o que ela faz.

Terceiro: `AsNoTrackingWithIdentityResolution` não reduz as linhas que o banco de dados envia. As pessoas às vezes esperam que ela cure uma explosão cartesiana no fio. Ela não cura -- o SQL não muda e o servidor continua transmitindo cada linha duplicada; a identity resolution só deduplica os *objetos* que o EF Core constrói no cliente. Para cortar as linhas em si, divida a consulta.

## A recomendação, repetida

Faça de `AsNoTracking` seu padrão para trabalho somente leitura e não pense duas vezes. É a leitura mais barata que o EF Core 11 oferece, é correta para a esmagadora maioria das consultas, e para resultados planos ou projeções para DTO é estritamente a escolha certa. Promova uma consulta para `AsNoTrackingWithIdentityResolution` apenas quando duas condições se cumprem ao mesmo tempo: o resultado contém genuinamente a mesma entidade mais de uma vez (um `Include` que espalha um pai entre filhos é o gatilho clássico), e algo no seu código depende de receber uma única instância compartilhada por chave -- igualdade por referência, agrupamento em memória ou consistência do grafo. Nessa situação o método te dá um grafo de objetos com qualidade de consulta com rastreamento a um custo próximo ao de sem rastreamento, e quando a duplicação é alta pode até alocar menos. Fora dessa situação é pura sobrecarga.

E não recorra a nenhum quando o problema real é linhas demais. Se uma consulta com vários `Include` está explodindo, a correção duradoura é o [query splitting](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) ou uma projeção mais afiada, não uma passada de deduplicação do lado do cliente sobre linhas que você não deveria ter trazido. O mesmo instinto que te mantém longe das [consultas N+1](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) acidentais se aplica aqui: dê forma à consulta para que o banco de dados devolva o que você realmente precisa, e então escolha a materialização mais barata que seja correta para como você usa o resultado.

## Relacionados

- [EF Core ExecuteUpdate vs carregar entidades e SaveChanges: qual você deve usar?](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Como usar query splitting para evitar uma explosão cartesiana no EF Core 11](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [Como detectar consultas N+1 no EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Como usar consultas compiladas com EF Core em caminhos críticos](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Como simular um DbContext sem quebrar o rastreamento de mudanças](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Fix: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Fontes

- [Tracking vs. No-Tracking Queries - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/tracking)
- [Efficient querying - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying)
- [Announcing the release of EF Core 5.0 (.NET Blog)](https://devblogs.microsoft.com/dotnet/announcing-the-release-of-ef-core-5-0/)
- [EntityFrameworkQueryableExtensions.AsNoTrackingWithIdentityResolution Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.entityframeworkqueryableextensions.asnotrackingwithidentityresolution)
