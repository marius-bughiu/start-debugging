---
title: "Correção: failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet"
description: "O BuildKit não consegue ler o manifesto da sua imagem base. Verifique se a tag existe, conserte o credential helper do Docker, libere os dois endpoints do MCR e faça pull antecipado para builds offline."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "docker"
  - "containers"
  - "buildkit"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/08/fix-failed-to-resolve-source-metadata-for-mcr-microsoft-com-dotnet-aspnet"
translatedBy: "claude"
translationDate: 2026-08-29
---

Isto é o BuildKit falhando ao ler o manifesto da imagem da sua linha `FROM`, e acontece antes de uma única instrução do seu Dockerfile rodar. Quatro causas cobrem quase todas as ocorrências, nesta ordem: a tag não existe (`11.0` não é uma tag real enquanto o .NET 11 ainda está em preview), um credential helper quebrado em `~/.docker/config.json`, um proxy ou firewall bloqueando `mcr.microsoft.com` ou `*.data.mcr.microsoft.com`, ou um build offline com um builder que não enxerga as imagens que você baixou localmente. Rode primeiro `docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:10.0`. Se isso também falhar, o problema não é o seu Dockerfile.

```text
 => ERROR [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0
------
 > [internal] load metadata for mcr.microsoft.com/dotnet/aspnet:11.0:
------
failed to solve: failed to resolve source metadata for
mcr.microsoft.com/dotnet/aspnet:11.0: mcr.microsoft.com/dotnet/aspnet:11.0: not found
```

Tudo abaixo foi verificado contra o Docker Engine 29 (BuildKit v0.32.x, Buildx v0.32), o .NET 10 (`10.0`, lançado em 2025-11-11) e os previews do .NET 11, que em agosto de 2026 estão no Preview 7, com GA previsto para novembro de 2026. O mesmo mecanismo se aplica sem mudanças ao Engine 27 e 28 e ao frontend compatível com BuildKit do Podman. Só a redação exata da cláusula final muda entre versões.

## O que o BuildKit está fazendo quando diz "resolve source metadata"

O BuildKit não executa seu Dockerfile de cima para baixo como o builder clássico fazia. Ele primeiro monta um grafo de dependências e, para isso, precisa saber o que cada referência `FROM` realmente é. Isso significa uma requisição `HEAD https://mcr.microsoft.com/v2/dotnet/aspnet/manifests/<tag>` por imagem base, por build, para fixar a referência em um digest de conteúdo antes de planejar qualquer coisa. Essa requisição é o passo "load metadata" que você vê na saída do build, e a mensagem que você recebeu é esse passo falhando.

Três consequências saem disso, e elas explicam a maior parte da confusão em torno do erro:

- **Ele dispara mesmo quando todas as camadas já estão em cache.** Camadas em cache não respondem à pergunta "esta tag ainda aponta para o mesmo digest", então o BuildKit pergunta assim mesmo. É por isso que um build offline falha em uma máquina que compilou exatamente a mesma imagem uma hora antes.
- **Ele dispara antes de `RUN`, `COPY` e `WORKDIR`.** Nenhum build argument que afete o ambiente de build ajuda, porque nada do ambiente de build começou ainda. Em particular, `--build-arg HTTP_PROXY=...` não faz nada aqui. Esse build argument é injetado nos passos `RUN`; ele não configura o cliente de registry do próprio daemon do BuildKit.
- **A cláusula final depois dos últimos dois-pontos é o erro real.** `not found` significa que a tag não existe. `dial tcp ...: i/o timeout` significa rede. `error getting credentials` significa a sua configuração do Docker. Leia essa cláusula primeiro e pule direto para a seção correspondente abaixo.

Todo o resto da mensagem é embrulho do BuildKit. O verbo que falha é sempre o mesmo.

## O repro mínimo

Dois estágios, uma imagem de build e uma de runtime, que é o formato que os templates de contêiner do .NET geram:

```dockerfile
# Docker Engine 29, BuildKit v0.32. Fails at "load metadata".
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyApi.dll"]
```

`docker build .` falha imediatamente com o erro acima e nunca chega ao `dotnet publish`. Repare que não há nenhum código de aplicação envolvido. Um diretório vazio só com este Dockerfile reproduz o problema, e essa é a forma mais rápida de provar que a causa não é o seu projeto.

## Correção 1: confira se a tag realmente existe

Esta é a causa mais comum hoje, e o motivo é o .NET 11. A Microsoft não publica uma tag flutuante de versão maior enquanto a release não chega ao GA. Durante a janela de preview, as tags são `11.0-preview` e a fixada `11.0.0-preview.7`, além de variantes qualificadas por sistema operacional como `11.0-preview-resolute` e `11.0-preview-alpine`. Não existe `11.0`. Essa tag aparece em novembro de 2026 e não antes, então um Dockerfile copiado de um projeto .NET 10 e atualizado na mão falha em um nome que nunca existiu.

Pergunte direto ao registry em vez de adivinhar:

```bash
# Works against any registry, prints the manifest list and its platforms.
docker buildx imagetools inspect mcr.microsoft.com/dotnet/aspnet:11.0-preview
```

O MCR também serve a listagem anônima de tags do OCI, útil quando você quer ver o que está de fato publicado:

```bash
curl -s https://mcr.microsoft.com/v2/dotnet/aspnet/tags/list | jq '.tags[] | select(startswith("11.0"))'
```

Outros dois erros de tag produzem exatamente a mesma mensagem. O primeiro é a renomeação do repositório: .NET Core 3.1 e anteriores ficavam em `mcr.microsoft.com/dotnet/core/aspnet`, e tudo do .NET 5 em diante fica em `mcr.microsoft.com/dotnet/aspnet`. Um Dockerfile antigo herdado mantém o segmento `core/` e recebe `not found` para qualquer versão moderna. O segundo é escolher uma variante de sistema operacional aposentada, como uma tag `bullseye-slim` em uma versão do .NET cuja base Debian já avançou. A [documentação de tags das imagens de contêiner do .NET](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md) é a autoridade sobre quais variantes estão vivas, e vale ler sempre que você trocar de imagem base em vez de confiar em um post antigo. Se você está escolhendo entre variantes de sistema operacional, os trade-offs descritos em [as tags de contêiner resolute do .NET 10](/pt-br/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/) também valem para os previews do .NET 11.

## Correção 2: conserte o credential helper do Docker

Se a cláusula final for assim, o registry está bem e o que está quebrado é a sua configuração local do Docker:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0:
error getting credentials - err: exit status 1, out: ``
```

A CLI do Docker lê `~/.docker/config.json`, vê uma entrada `credsStore` ou `credHelpers` e chama um binário `docker-credential-<nome>` para buscar as credenciais do registry. Quando esse binário não está no `PATH` ou não consegue alcançar um keychain, a CLI aborta antes mesmo de contatar o MCR. O gatilho clássico é `"credsStore": "desktop"` em um arquivo de configuração compartilhado com uma distro WSL2, um contêiner de CI ou uma sessão SSH remota onde `docker-credential-desktop` não existe.

O MCR serve suas imagens públicas anonimamente, então você não precisa de credenciais para ele. Apague a entrada:

```json
{
  "auths": {},
  "credsStore": ""
}
```

Ou remova a chave `credsStore` por completo. No macOS o valor que funciona é `osxkeychain`, no Linux `pass` ou `secretservice`, e se um helper estiver realmente instalado, confirme que ele responde:

```bash
echo '{"ServerURL":"https://index.docker.io/v1/"}' | docker-credential-desktop get
```

Uma variante próxima aparece como `401 Unauthorized` em uma requisição HEAD ao MCR. Isso significa que credenciais obsoletas estão sendo enviadas para um registry anônimo. Limpe com `docker logout mcr.microsoft.com` e compile de novo.

## Correção 3: libere os dois endpoints do MCR e configure o proxy do builder

O Microsoft Artifact Registry divide o trabalho entre dois hostnames, e regras de firewall escritas só contra o primeiro falham de um jeito que parece aleatório. `mcr.microsoft.com` cuida da descoberta de conteúdo, ou seja, das requisições de manifesto e de tags. `*.data.mcr.microsoft.com` é a CDN do Azure Front Door que entrega os bytes das camadas. As [regras de firewall para clientes](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md) da Microsoft exigem os dois sobre HTTPS na porta 443 e alertam explicitamente contra regras específicas por região, porque as regiões do endpoint de dados mudam por questões de desempenho. Se você liberar só o endpoint de registry, a resolução de metadados funciona e o pull morre depois. Se não liberar nenhum, você recebe o erro deste post.

A configuração de proxy é onde se perde mais tempo, porque depende do driver de builder que você usa e os dois se comportam de forma diferente:

- **O driver `docker` padrão** roda o BuildKit dentro do daemon do Docker, então ele herda as configurações de proxy do daemon. No Docker Desktop isso fica em Settings, Resources, Proxies. No Linux é um drop-in do systemd em `/etc/systemd/system/docker.service.d/http-proxy.conf`, seguido de `systemctl daemon-reload && systemctl restart docker`.
- **O driver `docker-container`** criado por `docker buildx create` roda o BuildKit no próprio contêiner, que não herda nada. Você precisa passar o ambiente explicitamente:

```bash
# Buildx v0.32. env.<key> sets variables inside the BuildKit container.
docker buildx create --name proxied \
  --driver docker-container \
  --driver-opt env.HTTP_PROXY=http://proxy.corp:8080 \
  --driver-opt env.HTTPS_PROXY=http://proxy.corp:8080 \
  --driver-opt env.NO_PROXY=localhost,127.0.0.1 \
  --use
```

Se o seu proxy termina TLS com uma autoridade certificadora corporativa, a cláusula final é `tls: failed to verify certificate: x509: certificate signed by unknown authority`. A correção do lado do daemon é instalar a CA no repositório de confiança do host e reiniciar o Docker. Para um builder `docker-container` você precisa colocar a CA dentro daquele contêiner, seja montando-a através de um `buildkitd.toml` customizado, seja compilando no driver padrão.

Falhas puras de DNS aparecem como `dial tcp: lookup mcr.microsoft.com: no such host`, comuns no WSL2 depois de uma troca de VPN. Definir resolvedores explícitos em `/etc/docker/daemon.json` com `"dns": ["1.1.1.1", "8.8.8.8"]` e reiniciar o daemon geralmente resolve.

## Correção 4: faça pull antecipado para builds offline e observe o driver do builder

Como a resolução de metadados sempre quer um registry vivo, um build isolado da rede ou com conectividade instável falha mesmo com as camadas em disco. A correção é fazer a imagem estar presente no image store local, não apenas em cache:

```bash
# Run these while you still have connectivity.
docker pull mcr.microsoft.com/dotnet/sdk:10.0
docker pull mcr.microsoft.com/dotnet/aspnet:10.0
```

Com o driver `docker` padrão, o BuildKit consegue então resolver a referência a partir do image store do daemon e o build offline funciona. Adicionar `--pull=false` deixa a intenção explícita e impede que o BuildKit prefira uma consulta remota.

O detalhe é que isso só funciona no driver padrão. Um builder `docker-container` tem o próprio content store e não enxerga as imagens do daemon do Docker, [um comportamento antigo e redescoberto com frequência](https://github.com/moby/moby/issues/49542). Se você criou um builder customizado para saída multiplataforma e depois ficou offline, o pull antecipado não ajuda em nada. Volte com `docker buildx use default` para trabalho offline, ou suba um mirror de registry que o builder consiga alcançar.

A mesma distinção morde no CI. Runners do GitHub Actions usando `docker/setup-buildx-action` recebem um builder `docker-container` por padrão, então um workflow que funciona localmente depois de um passo de `docker pull` ainda vai bater no registry no runner.

## Correção 5: acerte a plataforma

Se a tag existe mas não tem imagem para a sua plataforma alvo, a falha chega no mesmo passo com uma cauda diferente:

```text
failed to resolve source metadata for mcr.microsoft.com/dotnet/aspnet:10.0-nanoserver-ltsc2022:
no match for platform in manifest: not found
```

Dois formatos comuns. O primeiro é uma tag só de Windows como `nanoserver` ou `windowsservercore` solicitada de um daemon rodando contêineres Linux. Mude o Docker Desktop para contêineres Windows, ou use uma tag Linux. O segundo é um `--platform linux/arm64` explícito contra uma tag que publica só amd64, o que acontece com imagens sidecar de terceiros com mais frequência do que com as da Microsoft, já que as imagens de runtime do .NET publicam amd64, arm64 e arm32v7. `docker buildx imagetools inspect` lista todas as plataformas da manifest list, então confira ali antes de assumir que a imagem está quebrada.

## Variantes que parecem iguais mas não são

`failed to solve: process "/bin/sh -c dotnet restore" did not complete successfully` é uma falha totalmente diferente. A resolução de metadados funcionou e o seu build já está rodando, então o problema é o NuGet, não o registry. Do mesmo jeito, `NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json` dentro de um estágio de build significa que o contêiner alcança o MCR mas não o NuGet, o que costuma ser a mesma história de proxy uma camada abaixo.

Se a imagem baixa e inicia mas o contêiner sai imediatamente, você já passou deste erro e está em território de runtime. O crash de globalização coberto pela [correção do pacote ICU ausente](/pt-br/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) é o mais comum em imagens base enxutas.

Por fim, se você está brigando com as linhas `FROM`, considere se precisa mesmo de um Dockerfile. O SDK consegue produzir uma imagem OCI diretamente, e [publicar um app .NET 11 com `/t:PublishContainer`](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/) resolve imagens base com uma lógica no estilo NuGet, que falha com mensagens bem mais específicas do que as do BuildKit.

## Relacionados

- [Como publicar um app .NET 11 como imagem de contêiner com dotnet publish /t:PublishContainer](/pt-br/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [.NET 10 no Ubuntu 26.04: tags de contêiner resolute e Native AOT no arquivo](/pt-br/2026/04/dotnet-10-ubuntu-2604-resolute-container-tags/)
- [Correção: Couldn't find a valid ICU package installed on the system em um contêiner .NET](/pt-br/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/)
- [SBOM para .NET no Docker: pare de forçar uma única ferramenta a enxergar tudo](/pt-br/2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything/)
- [Aspire vs Docker Compose para desenvolvimento local multiserviço](/pt-br/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/)

## Fontes

- [Regras de firewall para clientes do Microsoft Artifact Registry](https://github.com/microsoft/containerregistry/blob/main/docs/client-firewall-rules.md)
- [Guia de endpoints do Microsoft Artifact Registry](https://github.com/microsoft/containerregistry/blob/main/docs/mcr-endpoints-guidance.md)
- [dotnet/dotnet-docker: tags suportadas do runtime do ASP.NET Core](https://github.com/dotnet/dotnet-docker/blob/main/README.aspnet.md)
- [Documentação do Docker: opções do driver de build docker-container](https://docs.docker.com/build/builders/drivers/docker-container/)
- [Documentação do Docker: variáveis de build e argumentos de proxy](https://docs.docker.com/build/building/variables/)
- [moby/moby#49542: BuildKit com o driver docker-container se recusa a usar imagens locais](https://github.com/moby/moby/issues/49542)
- [dotnet/core#8268: docker-compose build falha ao baixar imagens de mcr.microsoft.com](https://github.com/dotnet/core/issues/8268)
