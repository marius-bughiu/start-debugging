---
title: "As automações do Copilot agora disparam em comentários de issues e PRs"
description: "O changelog do GitHub de 2026-08-03 adiciona um gatilho por comentário às automações do agente em nuvem do Copilot, substituindo o workflow issue_comment mais o PAT mais o disparo via REST que os times vinham montando na mão desde junho."
pubDate: 2026-08-06
tags:
  - "github-copilot"
  - "ai-agents"
  - "automation"
  - "ci-cd"
lang: "pt-br"
translationOf: "2026/08/copilot-automations-now-trigger-on-issue-and-pr-comments"
translatedBy: "claude"
translationDate: 2026-08-06
---

Em 2026-08-03 o GitHub publicou [Trigger Copilot automations with comments](https://github.blog/changelog/2026-08-03-trigger-copilot-automations-with-comments/). As automações do agente em nuvem do Copilot agora podem disparar quando um comentário de issue ou de pull request é criado, com correspondência ao texto de comentário que você definir. É uma entrada de changelog de uma linha só que elimina uma quantidade surpreendente de YAML.

## O conjunto de gatilhos anterior era orientado a eventos, não a conversas

As automações chegaram em 2026-06-02 com quatro gatilhos: por agendamento (a cada hora, diário ou semanal), quando um issue é criado, quando um pull request é aberto e quando um pull request é sincronizado. Cada um deles dispara no momento em que algo entra em um estado. Nenhum cobre o padrão que os times realmente usam, que é uma pessoa lendo a thread primeiro e depois dizendo "pode ir".

Então você escrevia a cola você mesmo. O formato era sempre o mesmo: um workflow de `issue_comment`, uma guarda de texto, um token e um `POST` para a [API REST de Agent Tasks](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/).

```yaml
name: copilot-on-comment
on:
  issue_comment:
    types: [created]

jobs:
  dispatch:
    if: startsWith(github.event.comment.body, '/copilot fix')
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch an agent task
        env:
          GH_USER_TOKEN: ${{ secrets.COPILOT_USER_TOKEN }}
        run: |
          curl -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2026-03-10" \
            -H "Authorization: Bearer $GH_USER_TOKEN" \
            https://api.github.com/agents/repos/${{ github.repository }}/tasks \
            -d '{
              "prompt": "Investigate the stack trace in issue #${{ github.event.issue.number }} and open a fix PR.",
              "base_ref": "main",
              "create_pull_request": true
            }'
```

Cada linha ali é uma superfície de manutenção. `secrets.COPILOT_USER_TOKEN` precisa ser um token de usuário para servidor porque o `GITHUB_TOKEN` embutido não dispara tarefas do agente, e ele expira no calendário de alguém. A guarda é uma correspondência de prefixo crua, então `/copilot fixup` também dispara. `X-GitHub-Api-Version: 2026-03-10` fixa uma versão prévia pública cujo formato de resposta pode mudar. E como a frase de gatilho vive em um arquivo, mudá-la é um pull request.

## Como fica a configuração no lugar disso

Abra a aba **Agents** no repositório, escolha **Automations** na barra lateral e clique em **Create new**. Uma automação é um nome, um prompt, um ou mais gatilhos, um modelo opcional e um conjunto de ferramentas. Com o novo gatilho você indica qual texto de comentário deve iniciá-la, e essa é toda a integração. Sem token, sem arquivo de workflow, sem cabeçalho de versão de API.

A lista de ferramentas é onde mora o raciocínio de verdade. Ela é o limite de permissão da execução, não um ajuste de conveniência: decide o que o agente pode tocar depois que um comentário o acorda. O botão **Suggest tools** propõe um conjunto a partir do seu prompt, mas trate isso como ponto de partida e corte até o que a tarefa realmente precisa.

## Restrições para checar antes de planejar em cima disso

As automações exigem um repositório **privado ou interno**. Elas não estão disponíveis em repositórios públicos, então um projeto de código aberto não pode usar isso para triar issues de passagem. Você precisa de acesso de escrita para criar uma, o plano tem que ser Copilot Pro, Pro+, Max, Business ou Enterprise, e em Business e Enterprise um administrador precisa habilitar antes a política do agente em nuvem. O **Run now** permite testar uma automação antes que um comentário real a dispare.

Vale parar em uma consequência. Antes disso, disparar um agente exigia um token que um mantenedor provisionava deliberadamente. Agora qualquer pessoa que possa comentar em um issue do repositório pode gastar tempo de agente. A visibilidade privada ou interna limita o raio de impacto, mas mantenha a frase de gatilho específica e a lista de ferramentas enxuta.
