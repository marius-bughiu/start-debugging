---
title: "Como executar Claude Code em uma GitHub Action para revisão autônoma de PR"
description: "Configure anthropics/claude-code-action@v1 para que cada pull request receba uma revisão autônoma do Claude Code sem disparador @claude. Inclui o YAML da v1, claude_args para claude-sonnet-4-6 vs claude-opus-4-7, ferramentas para comentários inline, filtros de path, REVIEW.md e a escolha entre a action auto-hospedada e a versão preliminar de pesquisa de Code Review gerenciada."
pubDate: 2026-05-01
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "pt-br"
translationOf: "2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review"
translatedBy: "claude"
translationDate: 2026-05-01
---

Um pull request é aberto, o GitHub Actions acorda, o Claude Code lê o diff no contexto do resto do repositório, posta comentários inline nas linhas que ele não gosta e escreve um resumo. Nenhum humano digitou `@claude`. Esse é o fluxo que este post configura de ponta a ponta com `anthropics/claude-code-action@v1` (a versão GA lançada em 26 de agosto de 2025), `claude-sonnet-4-6` para a passagem de revisão e um upgrade opcional para `claude-opus-4-7` em paths sensíveis à segurança. Em maio de 2026 há duas formas de fazer isso e elas não são intercambiáveis, então o post começa com a escolha e depois percorre o caminho da Action auto-hospedada, que funciona em qualquer plano.

A resposta curta: use `anthropics/claude-code-action@v1` disparada em `pull_request: [opened, synchronize]` com um prompt e `--allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"`. Pule o filtro por menção `@claude`. Se sua organização tem plano Team ou Enterprise e não usa Zero Data Retention, a [versão preliminar de pesquisa de Code Review gerenciada](https://code.claude.com/docs/en/code-review) é a alternativa de menor atrito para o mesmo trabalho.

## Duas primitivas, dois modelos de custo, uma decisão

A Anthropic oferece dois produtos separados de "Claude revisa seu PR" em 2026. Eles parecem similares de fora e se comportam de forma muito diferente:

| Capacidade                       | claude-code-action@v1                   | Code Review gerenciado (preview)              |
| :------------------------------- | :-------------------------------------- | :----------------------------------------- |
| Onde executa                     | Seus runners do GitHub Actions          | Infraestrutura da Anthropic                |
| O que você configura             | Um workflow YAML em `.github/workflows/` | Toggle em `claude.ai/admin-settings`       |
| Superfície de disparo            | Qualquer evento do GitHub que você possa escrever | Dropdown por repo: opened, cada push, manual |
| Modelo                           | `--model claude-sonnet-4-6` ou qualquer ID | Frota multiagente, modelo não selecionável |
| Comentários inline em linhas do diff | Via servidor MCP `mcp__github_inline_comment` | Nativos, com marcadores de severidade       |
| Custo                            | Tokens de API mais seus minutos de Actions | $15-25 por revisão, cobrados como uso extra |
| Requisito de plano               | Qualquer plano com uma API key          | Team ou Enterprise, apenas não-ZDR          |
| Disponível em Bedrock / Vertex   | Sim (`use_bedrock: true`, `use_vertex: true`) | Não                                       |
| Prompt personalizado             | Texto livre na entrada `prompt`         | `CLAUDE.md` mais `REVIEW.md`               |

O produto gerenciado é a resposta certa quando está disponível para você. Ele executa uma frota de agentes especializados em paralelo e roda uma etapa de verificação antes de postar uma descoberta, o que mantém os falsos positivos baixos. A contrapartida é que você não pode fixar um modelo, e o preço escala com o tamanho do PR de uma forma que uma única revisão de $25 em uma refatoração de 2000 linhas pode chocar um gerente que esperava cobrança por taxa de tokens.

A Action é a resposta certa quando você quer controle total do prompt, quer usar Bedrock ou Vertex por residência de dados, quer filtrar por paths ou nomes de branch, ou não está em um plano Team ou Enterprise. Tudo a seguir é o caminho da Action.

## O workflow mínimo viável de revisão autônoma

Comece em qualquer repo onde você é admin. De um terminal com [Claude Code 2.x](https://code.claude.com/docs/en/setup) instalado:

```text
# Claude Code 2.x
claude
/install-github-app
```

O comando slash guia você pela instalação do [Claude GitHub App](https://github.com/apps/claude) no repo e pelo armazenamento de `ANTHROPIC_API_KEY` como secret do repo. Ele só funciona para usuários diretos da API da Anthropic. Para Bedrock ou Vertex você configura OIDC manualmente, o que a [documentação de GitHub Actions](https://code.claude.com/docs/en/github-actions) cobre em "Using with AWS Bedrock & Google Vertex AI."

Coloque isso em `.github/workflows/claude-review.yml`:

```yaml
# claude-code-action v1 (GA Aug 26, 2025), Claude Code 2.x
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            Review the diff for correctness, security, and obvious bugs.
            Focus on logic errors, unhandled error paths, missing input
            validation, and tests that do not actually exercise the new
            behavior. Skip style nits. Post inline comments on the lines
            you have something concrete to say about, then a one-paragraph
            summary as a top-level PR comment.

          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 8
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

É isso. Sem filtro por disparador `@claude`, sem condicional `if:` no corpo do comentário, sem `mode: agent`. A [versão v1](https://code.claude.com/docs/en/github-actions) da Action detecta automaticamente o modo de automação sempre que você fornece uma entrada `prompt` em um evento que não é de comentário, então você não escreve mais o condicional. O bloco `permissions` concede exatamente o que o prompt precisa: ler o repo, escrever comentários de PR e (para OIDC contra provedores cloud) emitir um token de identidade.

Algumas coisas neste YAML importam e são fáceis de errar.

`actions/checkout@v6` com `fetch-depth: 1`. A Action lê o diff do PR via `gh`, mas o prompt também permite que ele abra arquivos no diretório de trabalho para verificar uma descoberta antes de postar. Sem checkout, cada turno de "olhe o código ao redor" falha e o Claude ou adivinha ou estoura o tempo.

`--allowedTools "mcp__github_inline_comment__create_inline_comment,..."`. A Action embarca um servidor MCP que envolve a API de revisão do GitHub. Sem esse allowlist, o Claude não tem como anexar um comentário a uma linha específica. Ele recorrerá a um único comentário grande de PR de nível superior, o que é metade do valor. As entradas `Bash(gh pr ...)` estão escopadas para ler o diff e postar o comentário de resumo.

`--max-turns 8`. Orçamento de conversa. Oito é suficiente para o modelo ler o diff, abrir três ou quatro arquivos para contexto e postar comentários. Aumentar mais raramente é a vitória que parece; se as revisões estão estourando o tempo, restrinja o filtro de paths ou troque o modelo, não gaste mais turnos.

## A v1 quebrou muitos workflows beta

Se você vem de `claude-code-action@beta`, seu YAML antigo não roda. A [tabela de breaking changes](https://code.claude.com/docs/en/github-actions#breaking-changes-reference) da v1 é a cola de migração:

| Entrada beta          | Equivalente em v1                      |
| :-------------------- | :------------------------------------- |
| `mode: tag` / `agent` | Removido, autodetectado a partir do evento |
| `direct_prompt`       | `prompt`                               |
| `override_prompt`     | `prompt` com variáveis do GitHub       |
| `custom_instructions` | `claude_args: --append-system-prompt`  |
| `max_turns: "10"`     | `claude_args: --max-turns 10`          |
| `model: ...`          | `claude_args: --model ...`             |
| `allowed_tools: ...`  | `claude_args: --allowedTools ...`      |
| `claude_env: ...`     | Formato JSON `settings`                |

O padrão é claro: cada configuração no formato CLI colapsou em `claude_args`, e tudo que servia para desambiguar "este é o fluxo de disparador por comentário ou o fluxo de automação" foi removido porque a v1 deduz isso a partir do evento. A migração é mecânica, mas a ordem importa. Se você deixar `mode: tag` no lugar, a v1 falha de forma fechada com um erro de configuração em vez de rodar silenciosamente o caminho errado.

## Escolhendo o modelo: Sonnet 4.6 é o padrão por um motivo

A Action usa `claude-sonnet-4-6` como padrão quando `--model` não está definido, e esse é o padrão certo para revisão de PR. Sonnet 4.6 é mais rápido, mais barato por token e bem calibrado para o loop de "escaneie um diff, encontre os bugs óbvios" que a revisão de PR realmente é. Opus 4.7 é o upgrade ao qual você recorre quando o diff toca autenticação, criptografia, fluxos de pagamento ou qualquer coisa em que um bug perdido custa mais do que uma revisão de $5.

O padrão mais limpo são dois workflows. Sonnet 4.6 em cada PR, Opus 4.7 só quando o filtro de paths diz que vale o gasto:

```yaml
# Opus 4.7 review for security-critical paths only
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "src/auth/**"
      - "src/billing/**"
      - "src/api/middleware/**"

jobs:
  review-opus:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Treat this diff as security-sensitive. Flag any changes to
            authentication, session handling, secret storage, or trust
            boundaries. Cite a file:line for every claim about behavior,
            do not infer from naming.
          claude_args: |
            --model claude-opus-4-7
            --max-turns 12
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr comment:*)"
```

O mesmo truque funciona ao contrário: filtre o workflow do Sonnet em `paths-ignore: ["docs/**", "*.md", "src/gen/**"]` para que PRs só de docs não consumam tokens.

## Adicionando comentários inline e rastreamento de progresso

O servidor MCP `mcp__github_inline_comment__create_inline_comment` é a peça que leva o Claude de "escreve um comentário longo de PR" para "deixa sugestões em linhas específicas do diff". Ele é permitido via `--allowedTools` e essa é toda a fiação necessária. O modelo decide quando chamá-lo.

Para revisões maiores em que você quer um sinal visível de que a execução está viva, a Action embarca uma entrada `track_progress`. Defina `track_progress: true` e a Action posta um comentário de rastreamento com checkboxes, marca-os à medida que o Claude completa cada parte da revisão e marca como pronto no fim. O padrão completo do [exemplo oficial `pr-review-comprehensive.yml`](https://github.com/anthropics/claude-code-action/tree/main/examples) é:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    track_progress: true
    prompt: |
      REPO: ${{ github.repository }}
      PR NUMBER: ${{ github.event.pull_request.number }}

      Comprehensive review covering: code quality, security, performance,
      test coverage, documentation. Inline comments for specific issues,
      one top-level summary at the end.
    claude_args: |
      --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

`track_progress` é o mais perto que a v1 chega da antiga experiência `mode: agent` da beta, e é a escolha certa quando as revisões rotineiramente levam mais de um ou dois minutos e o autor do PR quer saber que está rodando.

## Calibrando o que o revisor sinaliza

Um workflow que comenta cada nome de variável e cada vírgula faltante será silenciado em uma semana. Dois arquivos na raiz do repo governam o que o modelo leva a sério: `CLAUDE.md` para comportamento geral e (apenas para a versão preliminar gerenciada de Code Review) `REVIEW.md` para regras específicas de revisão. A Action não carrega `REVIEW.md` automaticamente, mas lê `CLAUDE.md` da mesma forma que uma sessão local do Claude Code, e um `CLAUDE.md` enxuto mais um `prompt` enxuto cobrem o mesmo terreno.

As regras que realmente movem a qualidade da revisão são concretas, específicas do repo e curtas:

```markdown
# CLAUDE.md (excerpt)

## What "important" means here
Reserve "important" for findings that would break behavior in
production, leak data, or block a rollback: incorrect logic,
unscoped database queries, PII in logs, migrations that are not
backward compatible. Style and naming are nits at most.

## Cap the nits
Report at most five nits per review. If you found more, say
"plus N similar items" in the summary.

## Do not report
- Anything CI already enforces (lint, format, type errors)
- Generated files under `src/gen/` and any `*.lock`
- Test-only code that intentionally violates production rules

## Always check
- New API routes have an integration test
- Log lines do not include user IDs or request bodies
- Database queries are scoped to the caller's tenant
```

Colar mais ou menos esse conteúdo na entrada `prompt` também funciona e tem a vantagem de que as regras versionam junto com o arquivo do workflow. De qualquer forma, a alavanca que importa é "dizer não ao volume de nitpicks em voz alta", porque a voz padrão de revisão do Sonnet é mais minuciosa do que a maioria dos times quer.

## Forks, secrets e a armadilha do `pull_request_target`

O evento padrão `on: pull_request` roda no contexto da branch head do PR. Para PRs de forks, isso significa que o workflow roda sem acesso aos secrets do repo, incluindo `ANTHROPIC_API_KEY`. A correção que parece óbvia é trocar para `pull_request_target`, que roda no contexto da branch base e tem acesso aos secrets. Não faça isso para revisão autônoma do Claude, porque `pull_request_target` faz checkout do código da branch base por padrão e isso significa que você está revisando a árvore errada, e se você mudar o checkout para buscar a ref head, está rodando ferramentas guiadas por modelo contra código controlado por atacante com secrets no escopo.

Os padrões sustentáveis são: deixar `on: pull_request` e aceitar que PRs de fork não recebem revisão (use a versão preliminar gerenciada de Code Review se precisar cobri-los), ou rodar um workflow manual que mantenedores disparam em um PR de fork depois de terem dado uma olhada no diff. O [guia de segurança](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md) completo vale a pena ser lido uma vez antes de você implantar isso em qualquer lugar fora de um repo privado.

## Quando recorrer a Bedrock ou Vertex

Se sua organização passa por AWS Bedrock ou Google Vertex AI, a Action suporta ambos com `use_bedrock: true` ou `use_vertex: true` mais uma etapa autenticada por OIDC antes de a Action rodar. O formato do ID do modelo muda (Bedrock usa a forma com prefixo regional, por exemplo `us.anthropic.claude-sonnet-4-6`) e a documentação de provedores cloud descreve a configuração de IAM e Workload Identity Federation. Os padrões de disparador e prompt acima não mudam. A mesma abordagem está documentada para Microsoft Foundry. O único produto gerenciado pela Anthropic que não suporta esses caminhos é a versão preliminar de pesquisa de Code Review, o que é uma das razões pelas quais a Action auto-hospedada continua útil mesmo depois da versão preliminar gerenciada chegar a GA.

## Relacionados

- [Como agendar uma tarefa recorrente do Claude Code que faz triagem de issues do GitHub](/pt-br/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [Como construir um servidor MCP customizado em TypeScript que envolve uma CLI](/pt-br/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)
- [Como adicionar prompt caching a um app do SDK da Anthropic e medir a taxa de acerto](/pt-br/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [Claude Code 2.1.119: revise pull requests do GitLab e Bitbucket](/pt-br/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/)
- [O agente de codificação do GitHub Copilot no dotnet/runtime: dez meses de dados](/pt-br/2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data/)

## Fontes

- [Documentação do Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions)
- [Documentação do Claude Code Code Review (versão preliminar de pesquisa)](https://code.claude.com/docs/en/code-review)
- [`anthropics/claude-code-action` no GitHub](https://github.com/anthropics/claude-code-action)
- [Exemplo `pr-review-comprehensive.yml`](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-comprehensive.yml)
- [Exemplo `pr-review-filtered-paths.yml`](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-filtered-paths.yml)
