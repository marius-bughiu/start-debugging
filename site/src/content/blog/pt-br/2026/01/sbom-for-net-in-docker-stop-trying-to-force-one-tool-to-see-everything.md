---
title: "SBOM para .NET no Docker: pare de tentar forçar uma única ferramenta a ver tudo"
description: "Como rastrear dependências NuGet e pacotes do SO do contêiner de uma imagem Docker de .NET usando CycloneDX, Syft e Dependency-Track -- e por que um único SBOM não basta."
pubDate: 2026-01-10
tags:
  - "docker"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything"
translatedBy: "claude"
translationDate: 2026-04-30
---
Uma thread de DevOps fez uma pergunta que continuo vendo: "Como eu rastreio ao mesmo tempo as dependências NuGet e os pacotes do SO do contêiner para uma aplicação .NET entregue como imagem Docker?". O autor já estava perto da abordagem certa: CycloneDX para o grafo do projeto .NET, Syft para a imagem, depois ingestão no Dependency-Track.

Fonte: [Thread no Reddit](https://www.reddit.com/r/devops/comments/1q8erp9/sbom_generation_for_a_net_app_in_a_container/).

## Um SBOM único costuma ser o alvo errado

Uma imagem de contêiner contém pelo menos dois universos de dependências:

-   Dependências da aplicação: pacotes NuGet resolvidos em tempo de compilação (seu mundo de `*.deps.json`).
-   Dependências da imagem: pacotes do SO e camadas da imagem base (seu mundo de `apt`, `apk`, libc, OpenSSL).

No .NET 9 e no .NET 10, qualquer um dos lados pode sumir por acidente:

-   Scanners de imagem podem perder versões de NuGet porque não estão lendo o grafo do projeto.
-   Ferramentas de SBOM em nível de aplicação não verão os pacotes do SO da imagem base porque não estão varrendo camadas.

É por isso que "fazer uma só ferramenta dar conta de tudo" geralmente termina em pontos cegos.

## Gere dois SBOMs e preserve a proveniência

Esta é a pipeline prática:

-   **SBOM A** (em nível de aplicação): gere a partir da solução ou do projeto em tempo de compilação.
    -   Ferramenta: [cyclonedx-dotnet](https://github.com/CycloneDX/cyclonedx-dotnet)
-   **SBOM B** (em nível de imagem): gere a partir da imagem construída.
    -   Ferramenta: [Syft](https://github.com/anchore/syft)
-   **Ingerir e monitorar**: envie ambos para o [Dependency-Track](https://dependencytrack.org/).

A chave é a proveniência. Você quer poder responder: "Esta CVE está na minha imagem base ou no meu grafo de NuGet?" sem chutar.

## Comandos mínimos que você pode colar em um job de CI

```bash
# App SBOM (NuGet focused)
dotnet tool install --global CycloneDX
dotnet CycloneDX .\MyApp.sln -o .\sbom --json

# Image SBOM (OS packages and what the image reveals)
docker build -t myapp:ci .
syft myapp:ci -o cyclonedx-json=.\sbom\container.cdx.json
```

Se você quer que o SBOM da aplicação corresponda ao que de fato é entregue, gere-o a partir do mesmo commit que produziu a imagem do contêiner e armazene os dois artefatos juntos.

## Você deve mesclar os BOMs?

Se sua pergunta principal é "devo mesclar esses BOMs em um só?", minha resposta padrão é: não mescle por padrão.

-   Mantenha-os separados para que os alertas continuem acionáveis.
-   Se você precisa de um relatório único de compliance, mescle na camada de relatório, não achatando a proveniência no próprio SBOM.

No Dependency-Track, isso costuma virar dois projetos: `myapp` e `myapp-image`. Não é complexidade extra. É um modelo mais limpo.

## Por que o Syft "perde o NuGet" e o que fazer

O Syft é forte em imagens e sistemas de arquivos. Ele reporta o que consegue identificar a partir do que consegue enxergar. Se você quer dependências NuGet autoritativas, gere a partir do grafo do projeto com as ferramentas do CycloneDX.

Você pode experimentar varrer a saída publicada (por exemplo `syft dir:publish/`), mas trate isso como suplemento. A pergunta "quais pacotes referenciamos e em quais versões?" pertence ao grafo de build, não a uma varredura de camada.

Se você está construindo serviços .NET 10 em contêineres, dois SBOMs é a resposta honesta. Você ganha mais cobertura, dono mais claro e menos falsos positivos que desperdiçam uma sprint.
