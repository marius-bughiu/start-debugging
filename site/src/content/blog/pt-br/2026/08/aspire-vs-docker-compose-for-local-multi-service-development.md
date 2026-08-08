---
title: "Aspire vs Docker Compose para desenvolvimento local com vários serviços"
description: "O Aspire 13.4.6 vence o ciclo interno do .NET porque executa seus projetos como processos do host que você pode depurar, enquanto o Docker Compose vence quando o arquivo compose também é o seu contrato de CI e implantação. Medições de inicialização e de edição até a execução nos dois, a configuração que cada um injeta para você e os seis detalhes que decidem."
pubDate: 2026-08-08
template: vs
tags:
  - "comparison"
  - "aspire"
  - "docker"
  - "dotnet"
  - "devops"
lang: "pt-br"
translationOf: "2026/08/aspire-vs-docker-compose-for-local-multi-service-development"
translatedBy: "claude"
translationDate: 2026-08-08
---

Escolha o Aspire se os serviços que você executa localmente são projetos .NET que você compila a partir do código-fonte: ele os executa como processos comuns do host, então um depurador se conecta a todos de uma vez, e ele injeta strings de conexão e configuração de OpenTelemetry que você escreveria à mão de outro modo. Escolha o Docker Compose se o seu `docker-compose.yaml` também é o seu contrato de CI, staging ou produção, ou se a maior parte da sua stack são imagens prontas que você não escreve. Você não é obrigado a escolher: `aspire publish` gera um arquivo Compose a partir do mesmo modelo. Todos os números e APIs abaixo vêm do Aspire 13.4.6 (a versão estável atual, publicada em 2026-06-20) e do Docker Compose v5.1.4 sobre .NET 10.

Uma nota sobre o nome: o produto largou o prefixo ".NET" com o Aspire 13 em novembro de 2025, então ".NET Aspire" e "Aspire" são a mesma coisa, e o passo `dotnet workload install aspire` sumiu desde o Aspire 9.0.

## A matriz

| | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| Formato de configuração | C# ou TypeScript | YAML |
| Como o seu próprio serviço .NET executa | processo do host, iniciado pelo DCP | contêiner compilado a partir de um Dockerfile |
| Conexão do depurador | F5 em todos os projetos de uma vez | depurador remoto, configurado por serviço |
| Strings de conexão | injetadas como `ConnectionStrings__<name>` | você escreve |
| URLs entre serviços | injetadas como `services__<name>__<scheme>__0` | DNS do contêiner pelo nome do serviço |
| Telemetria | endpoint OTLP mais dashboard, sem configuração | nenhuma |
| Ordem de inicialização | `WaitFor()` mais health checks | `depends_on` com `condition: service_healthy` |
| Redes personalizadas | sem equivalente | `networks:` |
| Limites de CPU e memória | não modelados | `deploy.resources` |
| Nomes de contêiner | sufixo aleatório (`cache-mmsmckhq`) | determinísticos (`<project>-cache-1`) |
| É o seu artefato de implantação? | não, o AppHost é apenas de tempo de desenvolvimento | com frequência sim |
| Serviços que não são .NET | Node, Bun, Python, Go ou qualquer contêiner | qualquer contêiner |

## O que cada um realmente inicia

Esta é a diferença da qual todo o resto decorre. O Compose inicia contêineres, ponto final. Cada serviço do arquivo, inclusive aquele que você está editando, é uma imagem que precisa ser compilada antes de poder rodar.

O AppHost do Aspire inicia uma mistura. Tudo o que você declarou com `AddProject<T>` roda como um processo comum na sua máquina sob o Developer Control Plane; só as coisas que você não escreveu, declaradas com `AddContainer`, `AddRedis`, `AddPostgres` e companhia, viram contêineres. Dá para ver isso no `docker ps` enquanto a aplicação roda:

```
NAMES              IMAGE
cache-mmsmckhq     redis:8.6
```

Essa é a lista completa de contêineres para uma aplicação de dois serviços. A API é um processo `dotnet`, e é por isso que o Visual Studio e o Rider conseguem colocar um ponto de interrupção nela sem nenhuma configuração de depuração remota, e por isso uma recompilação não envolve o Docker em nada.

## A mesma stack, escrita duas vezes

Uma minimal API mais Redis. Primeiro a versão do Compose:

```yaml
# docker-compose.yaml -- Docker Compose v5.1.4
services:
  cache:
    image: redis:8.2
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 15

  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - ConnectionStrings__cache=cache:6379
    ports:
      - "8080:8080"
    depends_on:
      cache:
        condition: service_healthy
```

Mais um Dockerfile, que não é opcional e não está mostrado aqui. Agora a versão do Aspire, o arquivo inteiro:

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6, .NET 10
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithHttpEndpoint(port: 8080, name: "public")
       .WithReference(cache)
       .WaitFor(cache);

builder.Build().Run();
```

O arquivo de projeto tem três linhas de conteúdo interessante, e note que o template do 13.4.6 agora coloca o SDK no atributo `Sdk` em vez de um elemento `<Sdk>` aninhado:

```xml
<!-- AppHost/AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Aspire.AppHost.Sdk/13.4.6">
  <ItemGroup>
    <ProjectReference Include="..\Api\Api.csproj" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.Redis" Version="13.4.6" />
  </ItemGroup>
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

As duas stacks executam o mesmo `Program.cs`, que lê `ConnectionStrings:cache` da configuração. Com o Compose você forneceu esse valor. Com o Aspire, não.

## O que o Aspire escreve dentro do seu processo

Adicionei um endpoint de depuração que despeja as variáveis de ambiente interessantes e então executei o AppHost. Foi isto que o processo da API recebeu sem uma linha de configuração da minha parte:

```
ASPNETCORE_URLS=https://localhost:61681;http://localhost:61682;http://localhost:61683
ConnectionStrings__cache=localhost:58390,password=T9bjFegjra6EBk5HG3M9uq
OTEL_EXPORTER_OTLP_ENDPOINT=https://localhost:21089
OTEL_EXPORTER_OTLP_HEADERS=x-otlp-api-key=566b726e1f4c36c1b4e0474e80db9cd5
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_METRIC_EXPORT_INTERVAL=1000
OTEL_SERVICE_NAME=api
OTEL_TRACES_SAMPLER=always_on
```

Duas coisas merecem atenção. O Aspire gerou uma senha para o Redis e a colocou na string de conexão, então o cache local não fica aberto em uma porta conhecida e sem autenticação, como acontece com `redis:8.2` em um arquivo Compose. E o bloco OTLP é o que faz traces e métricas aparecerem de graça no dashboard; se você quer o mesmo com o Compose, vai subir um coletor e ligar exportadores por conta própria, o que rende um artigo inteiro sobre [como usar OpenTelemetry com .NET 11 e um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/).

Para referências entre projetos, a variável injetada é `services__<name>__<scheme>__0`, por exemplo `services__basket__https__0`, e a descoberta de serviços do .NET resolve `https://basket` a partir dela.

## As medições

Mesma máquina, mesma aplicação, mesmo Redis: um Intel Core Ultra 7 265KF (20 núcleos), 32 GB de RAM, Windows 11 Pro 26200, Docker 29.5.3 com Compose v5.1.4, .NET SDK 10.0.201, Aspire CLI 13.4.6. As imagens base foram baixadas antes da medição, então nenhuma medição inclui download do registro. O tempo é de relógio, do início do comando até um GET HTTP na aplicação devolver o código recém-compilado, com sondagem a cada 250 ms. A edição é uma mudança de uma linha em um literal de string no `Program.cs`, e cada rodada usa um valor novo para que nada possa ser servido de um cache.

| Cenário | Aspire 13.4.6 | Docker Compose v5.1.4 |
| --- | --- | --- |
| Início a frio: nada compilado, stack no ar e respondendo | 15,5 s (`dotnet clean`, depois `aspire run`) | 10,8 s (7,0 s de `build --no-cache` mais 3,8 s de `up`) |
| Mudança de uma linha em C# até servir o código novo | 14,6 / 13,9 / 11,0 s, mediana 13,9 s | 5,4 / 5,6 / 5,3 s, mediana 5,4 s |

O Docker Compose venceu em todas as linhas, e eu não vou maquiar isso. Vale entender por quê antes de tirar uma conclusão daí.

O ciclo do Compose aqui é um `docker build` incremental de três segundos (a camada de restore está em cache, só `COPY` e `dotnet publish` rodam de novo) mais a recriação do contêiner, em uma aplicação cuja saída publicada são uns dez kilobytes de código meu. O ciclo do Aspire é `aspire resource api stop`, uma invocação completa do MSBuild e `aspire resource api start`, e o próprio custo de inicialização do MSBuild domina em um projeto tão pequeno. O número do Compose cresce com o tamanho da camada de imagem que você recompila; o do Aspire cresce com o grafo do MSBuild. Eu não medi onde essas curvas se cruzam, então não vou afirmar um ponto de cruzamento.

A ressalva mais importante é que a linha do Aspire é medida com a CLI, e a CLI não é como a maioria usa o Aspire. No Visual Studio ou no Rider o ciclo é F5 mais Hot Reload, que aplica o patch no processo em execução e nunca recompila. Não existe equivalente para um serviço em contêiner: `docker compose watch` sincroniza arquivos ou recompila a imagem, não aplica patch em um processo em execução. Então leia a tabela como um limite superior do ciclo interno do Aspire e uma medida justa do ciclo do Compose.

## Quando o Docker Compose é a resposta certa

- **O arquivo compose é uma entrega.** Se o CI sobe o mesmo YAML, se uma máquina de QA o executa, se o seu runbook de plantão diz `docker compose up`, então o Compose não é só uma ferramenta de desenvolvimento e substituí-lo por um AppHost significa manter duas descrições do mesmo sistema.
- **Em geral você não compila os serviços.** Uma stack de Kafka, MinIO, Keycloak e um Postgres com três scripts de inicialização é uma stack de imagens. O Aspire também modela isso como contêineres, mas você está pagando por uma abstração em C# sobre coisas que já estavam bem como YAML.
- **Você precisa de redes ou limites de recursos.** O Aspire não tem equivalente para isolamento de rede personalizado; todo recurso é alcançável pelo nome. Se você está testando o que acontece quando o serviço A realmente não consegue alcançar o serviço B, ou precisa de `deploy.resources` para limitar um contêiner a uma CPU, o Compose faz isso e o Aspire não.
- **Seu time não é .NET em primeiro lugar.** O Aspire 13.4 tornou os AppHosts em TypeScript geralmente disponíveis e adicionou `AddGoApp` e `AddBunApp`, então isso é menos verdadeiro do que há um ano, mas a documentação, os exemplos e o catálogo de integrações continuam centrados em .NET.

## Quando o Aspire é a resposta certa

- **Você depura mais de um serviço ao mesmo tempo.** Esta é a maior razão isolada. Pontos de interrupção na API e no worker com um único F5, sem `docker-compose.debug.yml`, sem `vsdbg` na imagem, sem malabarismo de portas.
- **Sua stack de desenvolvimento tem serviços de apoio com configuração chata.** `AddPostgres("db").AddDatabase("orders")` te dá um contêiner, uma senha gerada, uma string de conexão no formato .NET correto e uma inicialização condicionada por health checks. O equivalente no Compose são quinze linhas e um arquivo `.env`.
- **Você quer telemetria no ciclo interno.** O dashboard mostra traces entre serviços, logs estruturados e métricas desde o momento em que você aperta executar. Encontrar um N+1 ou uma tempestade de retentativas na sua própria máquina, em vez de no staging, muda como você escreve o código. Se você vem [detectando consultas N+1 no EF Core 11](/pt-br/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) por arquivos de log, isso é uma melhoria real.
- **Você já está adicionando ele de forma incremental.** O Aspire entra em uma solução legada como dois projetos novos, que é o tema de [como adicionar o Aspire a uma solução ASP.NET Core existente](/pt-br/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/).

## Os detalhes que decidem por você

**A sintaxe de portas do Compose não traduz literalmente.** `ports: ["8080:8080"]` parece `WithHttpEndpoint(port: 8080, targetPort: 8080)`, e essa combinação lança uma exceção na inicialização:

```
System.InvalidOperationException: The endpoint 'public' for resource 'api'
requested a proxy (IsProxied is true). Non-container resources cannot be
proxied when both TargetPort and Port are specified with the same value.
```

O Aspire faz proxy dos endpoints de projeto, então a porta do host e a porta de destino não podem ter o mesmo valor. Especifique só `port:` e deixe ele escolher o destino.

**`WithReference` não é `depends_on`.** O guia de migração é explícito: `WithReference()` só configura descoberta de serviços e strings de conexão, e não controla a ordem de inicialização. Se você quer o comportamento de `condition: service_healthy` do Compose, o que você quer é `WaitFor()`, e você quer isso além de `WithReference()`, não no lugar dele.

**Nomes de contêiner não são estáveis.** O Compose te dá `bench-cache-1`, derivado do nome do projeto e do serviço. O Aspire me deu `cache-vvkhtnuf`, depois `cache-zwjpvzxh`, depois `cache-mmsmckhq` em três execuções. Qualquer script ou hábito de um colega construído sobre `docker exec -it myapp-cache-1 redis-cli` quebra.

**As versões de imagem padrão se movem com a versão do Aspire.** `AddRedis` no 13.4.6 baixou `redis:8.6`, não o `redis:8.2` que meu arquivo Compose fixava. O Aspire 13.4 também moveu o padrão do Postgres de 17.6 para 18.3, que não é compatível com um volume de dados existente. Fixe com `WithImageTag` se isso importa para você.

**Um contexto de build do Compose precisa de um `.dockerignore`.** Sem ele, `COPY Api/ Api/` manda os seus `bin/` e `obj/` do host para o contexto de build, o que incha cada build e invalida camadas em mudanças que nem tocaram o código-fonte. Duas linhas resolvem, e a diferença aparece no log de build, onde a transferência de contexto para este projeto cai para 1,18 kB:

```
# .dockerignore
**/bin
**/obj
```

O Aspire não tem problema equivalente porque nunca compila uma imagem para o seu projeto. Ele tem o problema espelhado: o MSBuild não consegue sobrescrever `Api.dll` enquanto o recurso está rodando, então uma recompilação pela linha de comando precisa de `aspire resource api stop` antes do `dotnet build`. A IDE cuida disso para você; um script de shell não.

**O proxy do Aspire pode sobreviver ao `aspire stop`, e vai encobrir seus contêineres.** Este me custou uma hora enquanto eu coletava os números acima. Depois de `aspire stop --force`, um processo `dcp` continuava vinculado à porta fixa do host:

```
PID=70448 Name=dcp Addr=127.0.0.1
PID=70448 Name=dcp Addr=::1
```

O Docker então vinculou a mesma porta em `::`, os dois comandos reportaram sucesso, e cada requisição para `localhost:8080` era respondida pelo proxy abandonado do Aspire em vez do contêiner. Nada dá erro. O `docker compose ps` mostra o contêiner saudável e mapeado, a imagem realmente contém o seu código novo, e a aplicação continua devolvendo as respostas do build anterior, porque você não está falando com o contêiner de jeito nenhum. Passei um tempo culpando o cache de camadas do Docker antes de checar quem realmente era dono da porta:

```bash
Get-NetTCPConnection -LocalPort 8080 -State Listen
```

Isso só morde quando você fixa uma porta do host com `WithHttpEndpoint(port: ...)`, que é exatamente o que você faz ao traduzir um arquivo Compose. As portas dinâmicas padrão do Aspire não colidem.

## Usando os dois

A escolha não é permanente, porque o modelo do AppHost pode gerar o arquivo Compose:

```csharp
// AppHost/AppHost.cs -- Aspire 13.4.6
builder.AddDockerComposeEnvironment("compose")
       .WithDashboard(d => d.WithHostPort(8080));
```

```bash
aspire publish
```

Isso emite um `docker-compose.yaml` mais um `.env` com os parâmetros em branco, e cada recurso do modelo vira um serviço do Compose sem opt-in adicional. `PublishAsDockerComposeService` personaliza um serviço individual (nome do contêiner, labels, política de restart) e `ConfigureComposeFile` edita o documento inteiro antes de ele ser escrito. Então um estado final razoável é: Aspire para o ciclo interno, Compose gerado para os ambientes que precisam de um arquivo YAML, uma única fonte da verdade. Note que o AppHost em si nunca é enviado, do mesmo jeito que [publicar uma imagem de contêiner com `dotnet publish /t:PublishContainer`](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) é uma preocupação separada de como você rodou a coisa localmente.

## A decisão

Para uma solução .NET onde você compila os serviços, o Aspire é o melhor ambiente de desenvolvimento local, e o motivo enfaticamente não é velocidade: o Compose ganhou em todas as medições que eu fiz. É que o seu código roda como um processo que você pode depurar, e que o AppHost escreve as strings de conexão, as portas e a configuração de OpenTelemetry que você manteria à mão em YAML e que sairiam de sincronia. Segundos de inicialização são baratos perto de uma tarde descobrindo por que o contêiner tem um build velho ou por que o depurador não conecta.

Fique no Docker Compose quando o arquivo tem um segundo emprego. Se CI, staging ou um runbook dependem daquele YAML, a comparação honesta não é "Aspire vs Compose" e sim "Aspire mais Compose gerado vs Compose sozinho", e se o seu time é pequeno e a stack são cinco imagens que você não escreveu, a segunda opção continua sendo uma resposta perfeitamente boa em 2026.

## Relacionado

- [Como adicionar o Aspire a uma solução ASP.NET Core existente sem reestruturá-la](/pt-br/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/)
- [O que é .NET Aspire?](/pt-br/2023/11/what-is-net-aspire/)
- [Como usar OpenTelemetry com .NET 11 e um backend gratuito](/pt-br/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [WebApplicationFactory vs Testcontainers para testes de integração em ASP.NET Core](/pt-br/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/)
- [Como publicar uma aplicação .NET 11 como imagem de contêiner com dotnet publish /t:PublishContainer](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## Fontes

- [Migrate from Docker Compose to Aspire](https://aspire.dev/app-host/migrate-from-docker-compose/), o mapeamento oficial conceito a conceito
- [Deploy Aspire apps with Docker Compose to any host](https://aspire.dev/deployment/docker-compose/)
- [Aspire Docker integration for containerized resources](https://aspire.dev/integrations/compute/docker/)
- [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/), incluindo as mudanças de imagem padrão do Postgres e do RabbitMQ
- [Aspire service discovery fundamentals](https://aspire.dev/fundamentals/service-discovery/)
- [Compose Develop Specification](https://docs.docker.com/reference/compose-file/develop/) para `watch`
- [microsoft/aspire releases](https://github.com/microsoft/aspire/releases)
