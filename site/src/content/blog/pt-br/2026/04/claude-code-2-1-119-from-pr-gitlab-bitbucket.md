---
title: "Claude Code 2.1.119 puxa PRs de GitLab, Bitbucket e GitHub Enterprise"
description: "Claude Code v2.1.119 expande --from-pr para além do github.com. A CLI agora aceita URLs de merge requests do GitLab, pull requests do Bitbucket e PRs do GitHub Enterprise, e uma nova configuração prUrlTemplate aponta o badge do rodapé para o host de revisão correto."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "gitlab"
  - "bitbucket"
lang: "pt-br"
translationOf: "2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket"
translatedBy: "claude"
translationDate: 2026-04-27
---

A última versão do Claude Code, v2.1.119, traz uma mudança pequena mas atrasada para times fora do GitHub: `--from-pr` agora aceita URLs de merge requests do GitLab, URLs de pull requests do Bitbucket e URLs de PRs do GitHub Enterprise, e uma nova configuração `prUrlTemplate` aponta o badge do rodapé para uma URL de revisão de código personalizada em vez de github.com. Até essa versão, o fluxo de revisão de PR assumia que todo host de revisão de código era github.com, o que tornava o recurso esquisito para qualquer empresa no GitLab ou no Bitbucket Cloud.

## O que --from-pr faz, e por que o host importa

`--from-pr` é a flag para "iniciar uma sessão contra este pull request": você cola a URL do PR, o Claude Code faz checkout do branch head e prepara a sessão com o diff e a thread de revisão. Tem sido a forma mais limpa de iniciar uma sessão de agente direcionada a uma revisão de código específica desde que apareceu, mas o parser de URL estava amarrado em `github.com/owner/repo/pull/<n>`. Qualquer URL fora do GitHub escapava do parser e a sessão perdia o contexto de revisão.

A v2.1.119 generaliza o tratamento de URL. Os formatos que o changelog menciona explicitamente são URLs de merge request do GitLab, URLs de pull request do Bitbucket e URLs de PR do GitHub Enterprise:

```bash
claude --from-pr https://github.com/acme/api/pull/482
claude --from-pr https://gitlab.com/acme/api/-/merge_requests/482
claude --from-pr https://bitbucket.org/acme/api/pull-requests/482
claude --from-pr https://github.acme.internal/acme/api/pull/482
```

Mesma flag, mesmo fluxo, quatro hosts de revisão diferentes.

## prUrlTemplate substitui o link do rodapé para github.com

Mesmo com `--from-pr` funcionando, restava um ponto de atrito: o badge do rodapé que mostra o PR ativo estava fixado em github.com, porque a URL estava codificada a fogo na CLI. A v2.1.119 adiciona uma configuração `prUrlTemplate` que aponta esse badge para uma URL de revisão de código personalizada. A mesma versão também aponta que os links curtos `owner/repo#N` na saída do agente agora usam o host do remote do git em vez de sempre apontar para github.com, então a reescrita é consistente em toda a superfície.

`prUrlTemplate` mora em `~/.claude/settings.json` como o restante da configuração do Claude Code. A nova versão também persiste as configurações de `/config` (tema, modo de editor, verboso e similares) no mesmo arquivo com precedência de override project/local/policy, então uma organização pode entregar `prUrlTemplate` via `~/.claude/settings.policy.json` e evitar que cada desenvolvedor configure manualmente.

## Por que isso importa para empresas .NET no GitLab

A maioria dos times .NET que saíram do Azure DevOps nos últimos anos aterrissou no GitHub ou no GitLab self-hosted, muitas vezes com uma cauda longa de repositórios internos que espelham para uma instância de GitHub Enterprise para interoperar com OSS. Até agora, apontar o Claude Code para um desses repositórios não-GitHub significava:

1. Fazer ida e volta do PR através de um clone temporário de um mirror no github.com, ou
2. Fazer a revisão colando o diff manualmente na conversa.

Com a v2.1.119 mais um `prUrlTemplate` embutido no arquivo de policy da organização, o mesmo fluxo `claude --from-pr <url>` funciona para a mistura toda. A versão anterior v2.1.113 que migrou a [CLI para um binário nativo](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) significa que também não há runtime do Node.js para instalar nos agentes de build que rodam tarefas automatizadas de revisão de PR, o que torna essa implantação mais fácil de vender em frotas de CI estritamente gerenciadas.

Se você entrega um `~/.claude/settings.policy.json` para seu time, esta é a semana de adicionar a linha `prUrlTemplate`. As notas de versão completas da v2.1.119 estão no [changelog do Claude Code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
