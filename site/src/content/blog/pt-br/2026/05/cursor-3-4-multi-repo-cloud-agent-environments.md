---
title: "Cursor 3.4 adiciona ambientes multi-repositório e builds de Dockerfile mais rápidos para agentes na nuvem"
description: "Cursor 3.4 (13 de maio de 2026) permite que um ambiente de agente na nuvem inclua múltiplos repositórios, adiciona segredos de build para Dockerfile, rebuilds com cache de camadas 70% mais rápidos e uma etapa de configuração conduzida pelo agente que valida credenciais antes da primeira execução."
pubDate: 2026-05-21
tags:
  - "cursor"
  - "ai-agents"
  - "cloud-agents"
  - "docker"
lang: "pt-br"
translationOf: "2026/05/cursor-3-4-multi-repo-cloud-agent-environments"
translatedBy: "claude"
translationDate: 2026-05-21
---

Em 13 de maio de 2026, o Cursor lançou a [versão 3.4](https://cursor.com/changelog), e o release trata principalmente do encanamento que frotas de agentes na nuvem precisam para de fato trabalhar. A manchete são os ambientes multi-repositório, mas as mudanças de segredos de build e cache de camadas por baixo é que tornam rodar muitos agentes em paralelo barato o suficiente para ser prático. É uma continuação direta do trabalho de paralelismo do [Cursor 3.3](/pt-br/2026/05/cursor-3-3-build-in-parallel-split-prs/), voltada para times que já dividem tarefas entre subagentes e estavam batendo no muro de "um repo por ambiente".

## Um ambiente, muitos repositórios

Até a 3.4, um ambiente de agente na nuvem ficava limitado a um único repositório. Isso quebrava no momento em que uma tarefa cruzava fronteiras: uma API de backend mais seu pacote de tipos compartilhados, um app Flutter mais um servidor em Dart, ou uma solução `.NET` mais um repositório de infraestrutura irmão. Ou você clonava os repos extras manualmente no script de configuração (lento, frágil) ou dividia a tarefa e perdia o contexto entre repos.

O Cursor 3.4 reaproveita a engenharia dos workspaces multi-root e permite listar cada repositório que o agente precisa como parte da definição do ambiente. Uma configuração típica fica assim:

```json
{
  "name": "api-and-shared-types",
  "repositories": [
    { "url": "github.com/acme/api", "branch": "main" },
    { "url": "github.com/acme/shared-types", "branch": "main" }
  ],
  "dockerfile": "./infra/agent.Dockerfile"
}
```

Ambos os repos são clonados no mesmo ambiente, e o agente os enxerga como um único workspace. As sessões reutilizam o ambiente, então subir um novo agente contra o mesmo par é um cache hit em vez de um clone do zero.

## Segredos de build e cache hits 70% mais rápidos

O caminho do Dockerfile também ganhou duas correções práticas. A primeira é `--mount=type=secret` para segredos de build que ficam fora do contêiner em execução:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/dotnet/sdk:9.0
RUN --mount=type=secret,id=nuget_pat \
    dotnet nuget add source https://nuget.pkg.github.com/acme/index.json \
      --name acme --username ci \
      --password "$(cat /run/secrets/nuget_pat)" --store-password-in-clear-text
COPY . /src
WORKDIR /src
RUN dotnet restore
```

O PAT fica restrito à etapa de build, então o processo do agente que roda depois não consegue lê-lo. Isso fecha a brecha em que feeds privados de pacotes antes significavam embutir credenciais na imagem ou no script do ambiente.

A segunda correção é o cache de camadas. Builds que batem no cache rodam 70% mais rápido, segundo as notas da versão, porque só as camadas modificadas são recompiladas quando você edita o Dockerfile. Na prática, iterar na linha `RUN apt-get install ...` já não invalida um `dotnet restore` longo embaixo, desde que a camada do restore esteja acima da alteração.

## A configuração conduzida pelo agente detecta credenciais faltantes antes da execução

Quando você cria ou atualiza um ambiente, o Cursor agora executa uma etapa de configuração que faz perguntas de esclarecimento, identifica credenciais faltantes e verifica que o build é bem-sucedido antes de permitir que um agente use o ambiente. Se o build falhar, o ambiente cai para uma imagem base e expõe o aviso, em vez de falhar silenciosamente no momento em que um agente tenta clonar.

Cada ambiente também mantém um histórico de versões com rollback restrito a admins e um log de auditoria de quem mudou o quê. Para times que já rodam agentes paralelizados em escala, essas proteções importam mais do que os ganhos de velocidade.

Veja o [changelog completo do Cursor](https://cursor.com/changelog) para o resto da 3.4.
