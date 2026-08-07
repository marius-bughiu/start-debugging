---
title: "WebApplicationFactory vs Testcontainers para testes de integração no ASP.NET Core"
description: "Não são alternativas. WebApplicationFactory sobe a sua aplicação, o Testcontainers sobe as dependências dela. Medido no .NET SDK 10.0.201: um fixture com contêiner custa 1,7 s por classe contra 10 ms com SQLite, e uma violação de HasMaxLength(16) que o Postgres rejeita com 22001 o SQLite aceita silenciosamente."
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
lang: "pt-br"
translationOf: "2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests"
translatedBy: "claude"
translationDate: 2026-08-07
---

Use os dois. O `WebApplicationFactory<T>` sobe a sua aplicação; o Testcontainers sobe aquilo com que a sua aplicação conversa. A única decisão que você realmente precisa tomar é o que fica por trás da sua camada de dados, e a resposta é: se o teste verifica qualquer coisa que o banco de dados impõe, você precisa de um banco de dados real em um contêiner. Se ele verifica roteamento, model binding, autorização ou o formato do JSON, pule o Docker e pague 10 ms em vez de 1,7 segundo.

Tudo abaixo foi medido no .NET SDK 10.0.201 com `Microsoft.AspNetCore.Mvc.Testing` 10.0.1, `Testcontainers.PostgreSql` 4.13.0, EF Core 10.0.1 e `postgres:17.6-alpine`, rodando no Docker Desktop 29.5.3 (backend WSL2, 20 CPUs alocadas) em um Intel Core Ultra 7 265KF com 32 GB de RAM, Windows 11 26200. As APIs não mudam no .NET 11 preview.

## As três configurações que as pessoas realmente querem dizer

"WebApplicationFactory vs Testcontainers" é uma pergunta mal formulada, porque os dois vivem em camadas diferentes. O que as pessoas estão escolhendo é uma destas três configurações:

| | A. WAF + fake em processo | B. WAF + Testcontainers | C. Testcontainers de ponta a ponta |
| --- | --- | --- | --- |
| Onde a app roda | No seu processo de teste | No seu processo de teste | Em um contêiner que você compilou |
| Transporte | `TestServer`, sem socket | `TestServer`, sem socket | Socket real, Kestrel real |
| Banco de dados | SQLite / em memória / mock | Motor real em um contêiner | Motor real em um contêiner |
| Exige Docker | Não | Sim | Sim |
| Custo do fixture (medido) | ~10 ms | ~1,7 s | ~1,7 s mais compilar a imagem |
| Permite ponto de interrupção no código da app | Sim | Sim | Não |
| Permite trocar um serviço por um fake | Sim | Sim | Não |
| Testa seu Dockerfile / entrypoint | Não | Não | Sim |
| Testa HTTPS, HTTP/2, limites do Kestrel | Não | Não | Sim |
| Detecta violações de restrição no banco | Não (veja abaixo) | Sim | Sim |

A e B são o mesmo código com uma string de conexão diferente. C é algo genuinamente distinto e é a única linha em que o "vs" é uma escolha real de fato, porque em C você perde o `ConfigureTestServices` por completo: a aplicação é um artefato lacrado e você só consegue falar com ela por HTTP.

A maioria dos times quer B, recorre a A porque o Docker pareceu lento, e nunca avalia C a sério. Os números abaixo dizem que A é mais barato do que você imagina ser caro, que B é mais barato do que você imagina, e que o motivo para escolher B não tem nada a ver com desempenho.

## A medição

O sistema sob teste é uma minimal API com um `POST /orders` que grava via EF Core e um `GET /orders` que lê de volta. `Order.Sku` está configurado com `HasMaxLength(16)` e um índice único. O harness sobe um factory novo três vezes por configuração, no mesmo processo, de modo que a rodada 1 inclui o JIT e a construção do modelo do EF, e as rodadas 2 e 3 mostram o estado estacionário.

```csharp
// .NET 10.0.201, C# 14, Mvc.Testing 10.0.1, Testcontainers.PostgreSql 4.13.0
var sw = Stopwatch.StartNew();
var pg = new PostgreSqlBuilder("postgres:17.6-alpine").Build();
await pg.StartAsync();
var containerStart = sw.ElapsedMilliseconds;

sw.Restart();
await using var factory = new PostgresFactory(pg.GetConnectionString());
var client = factory.CreateClient();
var boot = sw.ElapsedMilliseconds;
```

Configuração A, `WebApplicationFactory<T>` sobre uma conexão SQLite em memória, sem Docker:

| Rodada | Subida do factory | Criação do esquema | Primeira requisição | 100 escritas | 100 leituras |
| --- | --- | --- | --- | --- | --- |
| 1 | 129 ms | 309 ms | 64 ms | 205 ms | 193 ms |
| 2 | 11 ms | 2 ms | 4 ms | 49 ms | 70 ms |
| 3 | 4 ms | 7 ms | 3 ms | 49 ms | 67 ms |

Configuração B, o mesmo factory apontando para uma instância PostgreSQL do Testcontainers, com a imagem já baixada:

| Rodada | Subida do contêiner | Subida do factory | Criação do esquema | Primeira requisição | 100 escritas | 100 leituras | Encerramento |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2933 ms | 5 ms | 198 ms | 4 ms | 210 ms | 191 ms | 321 ms |
| 2 | 1403 ms | 5 ms | 42 ms | 6 ms | 131 ms | 197 ms | 300 ms |
| 3 | 1424 ms | 4 ms | 32 ms | 5 ms | 81 ms | 81 ms | 306 ms |

Duas coisas saem daí que contrariam o senso comum.

**O factory em si é de graça nos dois casos.** Subir o `WebApplicationFactory<T>` custa de 4 a 5 ms depois que o processo esquenta, qualquer que seja o banco de dados por trás. Quando alguém diz que "testes de integração são lentos", quase nunca está falando do `TestServer`.

**O custo por requisição é praticamente o mesmo.** 100 idas e voltas por todo o pipeline de middleware, model binding, EF Core e de volta custam 49 ms contra o SQLite e 81 ms contra um Postgres em contêiner no estado estacionário. Isso dá 0,3 ms de diferença por requisição, sobre um socket de loopback para dentro do WSL2. O banco de dados ser real não é o que deixa sua suíte lenta.

O que é caro é o fixture: cerca de 1,7 segundo entre subir e derrubar o contêiner, por fixture, contra uns 10 ms da opção em processo. Multiplique pelo número de classes de teste que possuem cada uma o seu próprio contêiner e você tem a sua resposta. Uma suíte com 40 fixtures com contêiner próprio gasta 68 segundos sem fazer nada além de subir e derrubar o Postgres.

Vale registrar o custo a frio separadamente, porque é o que a sua primeira execução de CI paga: baixar `postgres:17.6-alpine` do zero levou 11,3 segundos para uma imagem de 106 MB. Esse é o extremo barato. Uma imagem de desenvolvimento do SQL Server é mais de uma ordem de grandeza maior, e é por isso que o [guia do Testcontainers com SQL Server](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) dedica uma seção a cachear essa camada no CI.

## O resultado que decide a questão

Desempenho não é o eixo. Este é:

```csharp
// .NET 10.0.201, EF Core 10.0.1
// Order.Sku is configured HasMaxLength(16)
db.Orders.Add(new Order { Sku = "TOOLONGSKU-0123456789", Total = 1m });
await db.SaveChangesAsync();
```

Contra o contêiner:

```
postgres: 22001: value too long for type character varying(16)
```

Contra o SQLite em memória:

```
sqlite:   ACCEPTED, stored 21 chars
```

O SQLite não impõe limite de comprimento em `varchar`. O EF Core emite fielmente `TEXT` para uma string com `HasMaxLength(16)`, o SQLite guarda os 21 caracteres sem reclamar, e o teste que deveria provar que a sua validação funciona passa. Em produção a mesma escrita lança exceção. Essa divergência sozinha é o argumento inteiro, e ela se generaliza: o SQLite difere do Postgres e do SQL Server na precisão de decimais, na sensibilidade a maiúsculas dos identificadores, na precisão de `DateTime`, no comportamento de escritas concorrentes e em quase toda consulta `FromSql` que você vier a escrever. O provedor em memória do EF Core é ainda pior, já que não impõe nenhuma semântica relacional.

Então a regra não é "sempre use Testcontainers" nem é "Testcontainers é lento demais". É: **no momento em que o que um teste verifica depende de algo que o motor do banco de dados impõe, um banco de dados falso transforma esse teste em uma mentira.** Violações de restrição, exclusões em cascata, tokens de concorrência `rowversion` (veja [concorrência otimista com um token rowversion](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)), SQL cru, migrações e tudo que toca o tradutor de consultas pertencem à configuração B.

## Quando escolher cada uma

**Escolha A (WAF, sem Docker) quando** o teste for sobre a superfície HTTP. `/orders/{id:int}` rejeita `abc` com um 400? O atributo `[Authorize(Policy = "Admin")]` devolve 403 para quem não é administrador? A resposta serializa `total` como número e não como string? O manipulador de exceções produz um corpo `ProblemDetails`? Nada disso se importa se o banco de dados é real, e muitos desses testes nem precisam de banco: registre um repositório falso via `ConfigureTestServices` e pule a persistência inteira. Esses são os testes que você quer rodar a cada tecla digitada, e com 10 ms de preparação eles conseguem.

**Escolha B (WAF + Testcontainers) quando** a verificação chegar ao motor de armazenamento. Esse é o padrão para testes de repositório, testes de consulta do EF Core, verificação de migrações e qualquer endpoint cujo comportamento interessante seja um caminho de erro do banco. É também a única forma honesta de testar que suas migrações realmente se aplicam a um banco vazio, que é uma classe de falha que nenhum fake pega e que derruba a produção.

**Escolha C (tudo em contêineres) quando** o artefato for o que está sob teste. Você está verificando que o Dockerfile gera uma imagem executável, que o entrypoint lê as variáveis de ambiente que o seu chart do Helm define, que o TLS termina corretamente ou que a negociação de HTTP/2 funciona. O `TestServer` não consegue lhe dizer nada disso porque nunca abre um socket. C é um punhado de testes de fumaça no fim do pipeline, não uma estratégia de testes.

## Deixando B barato: reutilização

Os 1,7 segundo por fixture não são um custo fixo. O Testcontainers oferece reutilização de contêineres há um bom tempo, e isso transforma o custo do fixture em um detalhe irrelevante durante o desenvolvimento local:

```csharp
// Testcontainers 4.13.0
var pg = new PostgreSqlBuilder("postgres:17.6-alpine")
    .WithReuse(true)
    .Build();
await pg.StartAsync();
// deliberately not disposed: reuse keeps the container alive between runs
```

Medido em três subidas consecutivas no mesmo processo:

| Subida | Duração | ID do contêiner |
| --- | --- | --- |
| 1 | 1812 ms | `81ae62b0f2b4` |
| 2 | 103 ms | `81ae62b0f2b4` |
| 3 | 81 ms | `81ae62b0f2b4` |

O mesmo contêiner, 81 ms em vez de 1812. A reutilização casa por um hash da configuração do contêiner, então mudar a tag da imagem, o ambiente ou o mapeamento de portas produz corretamente um contêiner novo.

O ponto de atenção é a limpeza. A documentação do Testcontainers é explícita ao dizer que habilitar a reutilização desabilita o resource reaper, então o Ryuk não vai remover o contêiner por você, e chamar `DisposeAsync()` em um contêiner reutilizável o para em vez de apagá-lo. Um contêiner velho carregando o esquema da semana passada vai continuar atendendo seus testes tranquilamente até você removê-lo na mão. Essa propriedade de guardar estado entre execuções é o que faz da reutilização uma otimização de desenvolvimento local e não de CI: coloque-a atrás de uma checagem de variável de ambiente para que seu pipeline sempre receba um motor limpo.

Repare que, diferentemente da implementação em Java, o Testcontainers para .NET não exige nenhuma habilitação em `~/.testcontainers.properties`. `WithReuse(true)` basta sozinho, o que é conveniente e também o motivo de o controle ficar por sua conta.

A outra alavanca, que pesa mais no CI, é compartilhar um contêiner entre muitas classes de teste em vez de um por classe. No xUnit isso é um collection fixture ou um assembly fixture em vez de `IClassFixture<T>`; as diferenças entre frameworks estão cobertas na [comparação entre xUnit v3, NUnit e MSTest](/pt-br/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/). Compartilhe o contêiner, isole os dados: dê a cada classe de teste o seu próprio esquema ou o seu próprio banco no servidor compartilhado, ou limpe com um truncate entre testes.

## Três erros que você vai encontrar montando isso

Os três saíram de construir o harness deste artigo, nas versões atuais dos pacotes.

**`Solution root could not be located using application root`.** O `WebApplicationFactory<T>` localiza o content root da aplicação subindo a árvore de diretórios a partir do assembly de testes em busca de um arquivo `.sln` ou `.slnx`, a menos que o target do MSBuild do `Microsoft.AspNetCore.Mvc.Testing` tenha carimbado um `WebApplicationFactoryContentRootAttribute` no seu assembly de testes. Um projeto de testes que não faz parte de um arquivo de solução, algo cada vez mais comum com os layouts da era `dotnet run app.cs`, quebra no primeiro `CreateClient()`. Ou você adiciona os projetos a uma solução, ou sobrescreve `CreateHost` e define o content root explicitamente.

**`Services for database providers 'Npgsql.EntityFrameworkCore.PostgreSQL', 'Microsoft.EntityFrameworkCore.Sqlite' have been registered in the service provider. Only a single database provider can be registered in a service provider.`** Essa é a clássica falha ao trocar o `DbContext`, e o conselho que você vai achar no Stack Overflow está desatualizado. Remover `DbContextOptions<TContext>` não basta mais, porque o `AddDbContext` no EF Core 9 e posteriores também registra um `IDbContextOptionsConfiguration<TContext>` que ainda carrega o provedor de produção. Remova os três:

```csharp
// .NET 10.0.201, EF Core 10.0.1
protected override void ConfigureWebHost(IWebHostBuilder builder)
{
    builder.ConfigureTestServices(services =>
    {
        services.RemoveAll(typeof(IDbContextOptionsConfiguration<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions));
        services.AddDbContext<OrdersDbContext>(o => o.UseNpgsql(_connectionString));
    });
}
```

A alternativa mais limpa, se o `Program.cs` for seu, é não registrar um provedor que você pretende substituir: leia a string de conexão da configuração e deixe o factory de testes fornecê-la via `ConfigureAppConfiguration`. Aí não há nada para remover.

**`'PostgreSqlBuilder.PostgreSqlBuilder()' is obsolete`.** A partir do Testcontainers 4.13.0 os construtores sem parâmetros dos módulos estão obsoletos e a imagem precisa ser passada ao construtor: `new PostgreSqlBuilder("postgres:17.6-alpine")`. É o desfecho da mudança da 4.10 que parou de fazer os módulos usarem por padrão uma tag escolhida pelos mantenedores. Hoje é um aviso e mais adiante será um erro, e é a decisão certa: uma tag de imagem flutuante significa que um pipeline de CI que passou ontem pode falhar hoje por motivos que não têm nada a ver com o seu commit.

## O que eu faria

Por padrão, configuração B para qualquer coisa com um repositório na pilha de chamadas, e configuração A para todo o resto. Concretamente: um contêiner compartilhado por assembly, `WithReuse(true)` localmente, um reset com truncate entre testes em vez de um contêiner por classe, e um projeto de teste rápido à parte, sem dependência de Docker, para os testes de superfície HTTP, para que `dotnet test` nesse projeto continue abaixo de um segundo.

Não use SQLite nem o provedor em memória como substituto do seu motor de produção. Use-os quando o banco de dados for genuinamente incidental ao que você está verificando, e seja honesto: a essa altura você está escrevendo um teste HTTP que por acaso precisa que exista uma camada de persistência. Os 30 ms por cada cem requisições que você economiza não valem um teste verde que estaria vermelho em produção. Se você quiser um fake mesmo assim, [mockar o `DbContext` sem quebrar o change tracking](/pt-br/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) é um fake mais honesto que um dialeto de SQL diferente.

E recorra à configuração C com parcimônia. É uma capacidade real, não uma versão melhor de B: ela testa o artefato em vez do código, então o lugar dela é ao lado dos seus testes de fumaça de implantação, e não na suíte que o time roda antes do push.

## Relacionados

- A mecânica completa do factory, incluindo `ConfigureTestServices` versus `ConfigureWebHost` e como falsear autenticação: [testes de integração com `WebApplicationFactory<T>` no ASP.NET Core 11](/pt-br/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).
- O lado dos contêineres em profundidade, com `IAsyncLifetime`, migrações e Ryuk: [testes de integração contra um SQL Server real com Testcontainers](/pt-br/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Compartilhamento de fixtures, padrões de paralelismo e ciclo de vida variam por framework: [xUnit v3 vs NUnit vs MSTest em 2026](/pt-br/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- A outra fonte comum de testes pouco confiáveis: [testar código dependente de tempo com `TimeProvider` e `FakeTimeProvider`](/pt-br/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).
- Um comportamento de concorrência que nenhum banco falso reproduz: [concorrência otimista com um token `rowversion` no EF Core 11](/pt-br/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

## Fontes

- [Testes de integração no ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests) sobre `WebApplicationFactory<TEntryPoint>` e o atributo de content root
- [Escolhendo uma estratégia de testes](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) na documentação do EF Core, sobre por que o provedor em memória não é um banco de dados
- Documentação do [Testcontainers for .NET](https://dotnet.testcontainers.org/) e as [versões 4.10.0 a 4.13.0](https://github.com/testcontainers/testcontainers-dotnet/releases), que introduziram a fixação obrigatória da imagem e as APIs do hash de reutilização
- [Discussão sobre reutilização de contêineres no Testcontainers](https://github.com/testcontainers/testcontainers-dotnet/discussions/1470) cobrindo os construtores sem parâmetros obsoletos
- Versões dos pacotes no NuGet: [Microsoft.AspNetCore.Mvc.Testing 10.0.1](https://www.nuget.org/packages/Microsoft.AspNetCore.Mvc.Testing), [Testcontainers.PostgreSql 4.13.0](https://www.nuget.org/packages/Testcontainers.PostgreSql)
