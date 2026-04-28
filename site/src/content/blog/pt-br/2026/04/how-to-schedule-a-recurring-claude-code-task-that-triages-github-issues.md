---
title: "Como agendar uma tarefa recorrente do Claude Code que classifica issues do GitHub"
description: "Três formas de colocar o Claude Code em um agendamento que classifica issues do GitHub sem supervisão em 2026: Routines na nuvem (a nova /schedule), claude-code-action v1 com cron + issues.opened, e o /loop com escopo de sessão. Inclui um prompt executável de Routine, um YAML completo do GitHub Actions, armadilhas de jitter e identidade, e quando escolher cada um."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "pt-br"
translationOf: "2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues"
translatedBy: "claude"
translationDate: 2026-04-29
---

Uma passada de triagem agendada sobre um backlog do GitHub é uma das coisas mais úteis que você pode pedir a um agente de codificação fazer, e é também a mais fácil de errar. Em abril de 2026 existem três primitivas diferentes de "agendar uma tarefa do Claude Code", elas vivem em runtimes diferentes e têm modos de falha bem diferentes. Este post percorre as três para o mesmo trabalho, "todo dia útil às 8h da manhã, etiquete e roteie cada novo issue do meu repo", usando **Claude Code v2.1.x**, a GitHub Action **`anthropics/claude-code-action@v1`** e o **research preview de routines** que a Anthropic enviou em [14 de abril de 2026](https://claude.com/blog/introducing-routines-in-claude-code). O modelo é `claude-sonnet-4-6` para o prompt de triagem e `claude-opus-4-7` para a passada de deduplicação.

A resposta curta: use uma **Routine na nuvem** com tanto um trigger de agendamento quanto um trigger `issues.opened` do GitHub se sua conta tem Claude Code on the web habilitado. Caia para um workflow **schedule + workflow_dispatch + issues.opened** do GitHub Actions se precisar disso no Bedrock, Vertex ou nos seus próprios runners. Use **`/loop`** apenas para polling ad-hoc enquanto uma sessão está aberta, nunca para triagem não supervisionada.

## Por que as três opções existem, e qual escolher

A Anthropic envia deliberadamente três schedulers diferentes porque os tradeoffs são reais. A [documentação oficial de scheduling](https://code.claude.com/docs/en/scheduled-tasks) coloca todos em uma página:

| Capacidade                  | Routines (nuvem)         | GitHub Actions          | `/loop` (sessão)          |
| :-------------------------- | :----------------------- | :---------------------- | :------------------------ |
| Onde roda                   | Infraestrutura Anthropic | Runner hospedado no GitHub | Seu terminal           |
| Sobrevive a um notebook fechado | Sim                  | Sim                     | Não                       |
| Disparado por `issue.opened` | Sim (nativo)            | Sim (evento de workflow) | Não                      |
| Acesso a arquivos locais    | Não (clone fresco)       | Sim (checkout)          | Sim (cwd atual)          |
| Intervalo mínimo            | 1 hora                   | 5 minutos (peculiaridade do cron) | 1 minuto       |
| Auto-expira                 | Não                      | Não                     | 7 dias                    |
| Prompts de permissão        | Nenhum (autônomo)        | Nenhum (`claude_args`)  | Herdados da sessão        |
| Requisito de plano          | Pro / Max / Team / Ent.  | Qualquer plano com API key | CLI local              |

Para "classificar cada novo issue e rodar uma varredura diária", a routine na nuvem é a primitiva certa. Ela tem um trigger nativo do GitHub, então você não precisa cabear `actions/checkout`, o prompt é editável pela UI web sem um PR, e as execuções não consomem nenhum dos seus minutos de GitHub Actions. A única razão para pular é se sua org roda Claude por AWS Bedrock ou Google Vertex AI, caso em que as routines na nuvem ainda não estão disponíveis e você cai para a action.

## A routine de triagem, ponta a ponta

Uma routine é "uma configuração salva do Claude Code: um prompt, um ou mais repositórios, e um conjunto de connectors, empacotados uma vez e executados automaticamente". Toda execução é uma sessão autônoma do Claude Code na nuvem, sem prompts de permissão, que clona seu repo a partir da branch padrão e escreve quaisquer mudanças de código numa branch prefixada com `claude/` por padrão.

Crie uma de dentro de qualquer sessão do Claude Code:

```text
# Claude Code 2.1.x
/schedule weekdays at 8am triage new GitHub issues in marius-bughiu/start-debugging
```

`/schedule` te conduz pelo mesmo formulário que a [UI web em claude.ai/code/routines](https://claude.ai/code/routines) mostra: nome, prompt, repositórios, ambiente, connectors e triggers. Tudo o que você define na CLI é editável na web, e a mesma routine aparece em Desktop, web e CLI imediatamente. Uma restrição importante: `/schedule` só anexa triggers de **agendamento**. Para adicionar o trigger `issues.opened` do GitHub que torna a triagem quase instantânea, edite a routine na web depois da criação.

### O prompt

Uma routine roda sem humano no loop, então o prompt precisa ser autocontido. A frase de exemplo da própria equipe Anthropic na [documentação de routines](https://code.claude.com/docs/en/web-scheduled-tasks) é "aplica labels, atribui owners com base na área de código referenciada, e posta um resumo no Slack para que o time comece o dia com a fila arrumada". Concretamente:

```markdown
# Routine prompt: daily-issue-triage
# Model: claude-sonnet-4-6
# Repos: marius-bughiu/start-debugging

You are the issue triage bot for this repository. Every run, do the following.

1. List every issue opened or updated since the last successful run of this
   routine, using `gh issue list --search "updated:>=YYYY-MM-DD"` with the
   timestamp of the previous run from the routine's session history. If you
   cannot find a previous run, scope to the last 24 hours.

2. For each issue, classify it as exactly one of: bug, feature, docs,
   question, support, spam. Apply that label with `gh issue edit`.

3. Assess priority as one of: p0, p1, p2, p3. Apply that label too.
   p0 only when the issue describes a production-affecting regression
   with a reproducer.

4. Look up the touched code area. Use `gh search code --repo` and `rg`
   against the cloned working copy to find the most likely owner via
   the `CODEOWNERS` file. Assign that user. If there is no CODEOWNERS
   match, leave it unassigned and apply the `needs-triage` label.

5. Run a duplicate check. Use `gh issue list --search "<title keywords>
   in:title is:open"` to find similar open issues. If you find one with
   high confidence, post a comment on the new issue: "This looks like
   a duplicate of #N. Closing in favor of that thread; please reopen
   if I got it wrong." and then `gh issue close`.

6. Post a single Slack message to #engineering-triage via the connector
   summarizing what you did: counts per label, p0 issues by number, and
   any issue that you could not classify with confidence above 0.7.

Do not push any commits. Do not modify code. The only writes this routine
performs are GitHub label/assign/comment/close calls and one Slack message.
```

Dois detalhes não óbvios que vale fixar:

- **O truque do "timestamp da execução anterior".** Routines não têm estado entre execuções. Cada sessão é um clone fresco. Para evitar etiquetar o mesmo issue duas vezes, o prompt precisa derivar o corte de algo durável. Ou (a) use a identidade GitHub da routine para aplicar uma label `triaged-YYYY-MM-DD` e pular qualquer coisa com essa label, ou (b) leia o timestamp do post de resumo do Slack anterior via o connector. Ambas são confiáveis. Pedir ao modelo "lembre quando você rodou da última vez" não é.
- **As regras do modo autônomo.** Routines rodam sem prompts de permissão. A sessão pode rodar comandos de shell, usar qualquer ferramenta de qualquer connector incluído e chamar `gh`. Trate o prompt como você trataria a política de uma conta de serviço: detalhe exatamente quais escritas são permitidas.

### Os triggers

No formulário de edição da routine, anexe dois triggers:

1. **Agendamento, dias úteis às 08:00.** Os horários são na sua zona local e convertidos para UTC do lado servidor, então um agendamento US-Pacific e um agendamento CET disparam na mesma hora de relógio onde quer que a sessão na nuvem aterrisse. Routines adicionam um stagger determinístico de até alguns minutos por conta, então não defina o agendamento como `0 8` se o timing exato importar; defina como `:03` ou `:07`.
2. **Evento do GitHub, `issues.opened`.** Isso faz a routine disparar em segundos depois de cada novo issue, além da varredura das 8h. Os dois não são redundantes: o trigger de agendamento captura tudo que cai enquanto o GitHub App está pausado ou atrás do cap horário por conta, e o trigger de evento mantém issues frescos de não ficarem frios por um dia útil.

Para anexar o trigger `issues.opened`, o [Claude GitHub App](https://github.com/apps/claude) precisa estar instalado no repositório. `/web-setup` da CLI concede acesso de clone apenas e não habilita entrega de webhook, então instalar o app pela UI web é obrigatório.

### A expressão cron customizada

Os presets de agendamento são horário, diário, dias úteis e semanal. Para qualquer outra coisa, escolha o preset mais próximo no formulário, depois caia para a CLI:

```text
/schedule update
```

Ande pelos prompts até a seção de agendamento e forneça uma expressão cron customizada de 5 campos. A única regra rígida é que o **intervalo mínimo é uma hora**; uma expressão como `*/15 * * * *` é rejeitada na hora de salvar. Se você genuinamente precisa de uma cadência mais apertada, isso é sinal de que você quer o caminho do GitHub Actions ou o trigger de evento, não o trigger de agendamento.

## O fallback do GitHub Actions

Se seu time está no Bedrock ou Vertex, ou você simplesmente prefere a trilha de auditoria de um log de run do Actions, o mesmo job roda como um workflow com `claude-code-action@v1`. A action saiu para GA em 26 de agosto de 2025 e a superfície v1 está unificada em torno de duas entradas: um `prompt` e uma string `claude_args` que passa qualquer flag direto para a CLI do Claude Code. A tabela completa de upgrade da superfície beta vive na [documentação do GitHub Actions](https://code.claude.com/docs/en/github-actions#breaking-changes-reference).

```yaml
# .github/workflows/issue-triage.yml
# claude-code-action v1, claude-sonnet-4-6, schedule + issues.opened + manual
name: Issue triage

on:
  schedule:
    - cron: "3 8 * * 1-5"  # weekdays 08:03 UTC, off the :00 boundary
  issues:
    types: [opened]
  workflow_dispatch:        # manual run from the Actions tab

permissions:
  contents: read
  issues: write
  pull-requests: read
  id-token: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            EVENT: ${{ github.event_name }}
            ISSUE: ${{ github.event.issue.number }}

            On a schedule run, list open issues updated in the last 24 hours
            and triage each one. On an `issues.opened` event, triage only
            the single issue ${{ github.event.issue.number }}.

            For each issue:
            1. Classify as bug / feature / docs / question / support / spam.
            2. Assess priority p0 / p1 / p2 / p3.
            3. Apply both labels with `gh issue edit`.
            4. Resolve the touched area via CODEOWNERS and assign the owner,
               or apply `needs-triage` if no match.
            5. Search for duplicates by title keywords. Comment and close
               only if confidence is high.

            Do not edit code. Do not push. Only GitHub label / assign /
            comment / close calls are allowed.
          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 12
            --allowedTools "Bash(gh:*),Read,Grep"
```

Três coisas que esse workflow acerta e que um cron feito à mão não. **`workflow_dispatch`** ao lado de `schedule` põe um botão "Run workflow" na aba Actions para você testar sem esperar até as 8h. **`--allowedTools "Bash(gh:*),Read,Grep"`** usa o mesmo gating da CLI local; sem isso, a action teria também acesso a `Edit` e `Write`. **O minuto `:03`** evita o atraso amplo e não determinístico que o GitHub Actions adiciona a triggers de cron de free-tier durante horários de pico. Essencialmente, é o [exemplo de issue triage](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md) do guia de soluções da action, com um trigger de agendamento e uma allowlist de ferramentas mais apertada.

## Quando `/loop` é a primitiva certa

`/loop` é a terceira opção e é à qual recorrer **menos** para trabalho de triagem. A [documentação de scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) detalha as restrições:

- Tarefas só disparam enquanto o Claude Code está rodando e ocioso. Fechar o terminal as para.
- Tarefas recorrentes expiram 7 dias depois da criação.
- Uma sessão pode ter até 50 tarefas agendadas ao mesmo tempo.
- Cron é honrado com granularidade de um minuto, com até 10% de jitter limitado a 15 minutos.

O uso certo do `/loop` é babá de uma routine de triagem que você ainda está afinando, não rodar a triagem em si. Dentro de uma sessão aberta apontando para o repo:

```text
/loop 30m check the last 5 runs of the daily-issue-triage routine on
claude.ai/code/routines and tell me which ones produced label edits
that look wrong. Skip silently if nothing has changed.
```

O Claude converte `30m` em uma expressão cron, agenda o prompt sob um ID gerado de 8 caracteres e o re-dispara entre seus turnos até você apertar `Esc` ou se passarem sete dias. Isso é genuinamente útil para um loop de feedback de "a routine está derivando?" enquanto um humano fica no teclado. É a forma errada para "rodar para sempre, sem supervisão".

## Armadilhas que vale conhecer antes da primeira execução

Algumas coisas vão te morder na primeira execução agendada se você não planejar.

**Identidade.** Routines pertencem à sua conta individual no claude.ai, e qualquer coisa que a routine faz pela sua identidade GitHub conectada aparece como você. Para um repo open-source, instale a routine sob uma conta bot dedicada, ou use o caminho do GitHub Actions com uma instalação separada de bot do [Claude GitHub App](https://github.com/anthropics/claude-code-action).

**Cap diário de execuções.** Routines têm um cap diário por plano (Pro 5, Max 15, Team e Enterprise 25). Cada evento `issues.opened` é uma execução, então um repo que recebe 30 issues por dia estoura antes do almoço a menos que você habilite uso extra no billing. A routine apenas com agendamento e o caminho do GitHub Actions ambos contornam isso; o último é cobrado contra tokens de API.

**Segurança de push de branch.** Uma routine só pode dar push para branches prefixadas com `claude/` por padrão. O prompt de triagem acima não dá push em nada, mas estendê-lo para abrir um PR de fix significa ou aceitar o prefixo ou habilitar **Allow unrestricted branch pushes** por repo. Não vire essa chave sem pensar.

**O header beta `experimental-cc-routine-2026-04-01`.** O endpoint `/fire` que sustenta o trigger de API hoje é entregue sob esse header. A Anthropic mantém as duas versões datadas mais recentes funcionando quando elas quebram, então construa o header em uma constante e gire em flips de versão, não em cada webhook.

**Stagger e sem catch-up.** Os dois runtimes adicionam um offset determinístico (até 10% do período para routines, muito mais amplo para Actions free-tier durante horários de pico), e nenhum repete disparos perdidos. A combinação `schedule + issues.opened` lida com o gap de catch-up melhor que apenas schedule porque o trigger de evento cobre a zona morta.

## Leitura relacionada

- O release completo do Claude Code que abriu `--from-pr` para GitLab e Bitbucket combina bem com routines na nuvem: veja [Claude Code 2.1.119: PRs do GitLab, Bitbucket e GHE](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/).
- Se você quer que a routine leia de um sistema de negócio `.NET` enquanto faz triagem, exponha-o por MCP primeiro. O passo a passo está em [Como construir um servidor MCP customizado em C# no .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/).
- Para o equivalente no formato GitHub Copilot, a versão de agent skills está em [Skills de agente Copilot no Visual Studio 2026](/pt-br/2026/04/visual-studio-2026-copilot-agent-skills/).
- Para devs C# construindo agent runners do lado da Microsoft em vez do lado da Anthropic, [Microsoft Agent Framework 1.0](/pt-br/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) é a entrada pronta para produção.
- E sobre a economia de bring-your-own-key se você prefere pagar por tokens contra um modelo diferente, veja [GitHub Copilot no VS Code com BYOK Anthropic, Ollama e Foundry Local](/pt-br/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

Routines ainda estão em research preview, então a UI exata e o header beta `/fire` vão se mexer. O modelo para o qual qualquer disso aponta, no entanto, é estável: um prompt autocontido, acesso a ferramentas com escopo, triggers determinísticos e uma trilha de auditoria por execução. Essa é a parte que se desenha com cuidado. O runtime é a parte que você troca.
