---
title: "Exporte conversas do Claude Code para PDF com jsonl-to-pdf"
description: "Um guia prático para transformar os arquivos JSONL que o Claude Code escreve em ~/.claude/projects/ em PDFs compartilháveis usando jsonl-to-pdf, com aninhamento de subagentes, redação de segredos, temas compacto e escuro, e receitas amigáveis a CI."
pubDate: 2026-04-29
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
  - "pdf"
lang: "pt-br"
translationOf: "2026/04/export-claude-code-conversations-to-pdf-with-jsonl-to-pdf"
translatedBy: "claude"
translationDate: 2026-04-29
---

Cada conversa que você tem com o Claude Code vive como um arquivo `.jsonl` no fundo de `~/.claude/projects/`, uma linha por turno, fidelidade total, sem renderização. `jsonl-to-pdf` é uma pequena CLI que transforma esses arquivos em PDFs que você pode ler em um leitor, anexar a um pull request, soltar em um tópico do Slack ou imprimir em papel de verdade. A forma mais rápida de testá-la com sua sessão mais recente é `npx jsonl-to-pdf`, que abre um seletor interativo, pergunta se deseja incluir as conversas dos subagentes e escreve um PDF com título no diretório atual.

Este post percorre de onde vêm os arquivos JSONL, o que o PDF realmente contém (subagentes aninhados em linha, blocos de pensamento, chamadas de ferramentas e resultados, anexos de imagens), as flags que valem a pena conhecer para compartilhar externamente (`--compact`, `--redact`, `--no-thinking`, `--subagents-mode appendix`, `--dark`), e algumas receitas para CI e automação. A versão coberta é `jsonl-to-pdf` 0.1.0 contra Claude Code 2.1.x. O repositório está no [GitHub](https://github.com/marius-bughiu/jsonl-to-pdf), e o pacote está no [npm](https://www.npmjs.com/package/jsonl-to-pdf).

## Onde o Claude Code guarda suas conversas

O Claude Code escreve um arquivo JSONL por sessão em `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. O segmento `<encoded-cwd>` é o diretório de trabalho em que a sessão rodou, com os separadores de caminho achatados para `-`. Assim, `C:\S\my-app` no Windows vira `C--S-my-app`, e `/Users/marius/work` no macOS ou Linux vira `-Users-marius-work`. Cada linha é um objeto JSON: um turno do usuário, um turno do assistente, uma chamada de ferramenta, um resultado de ferramenta, um bloco de pensamento, ou metadados de sessão como `cwd`, `gitBranch`, `aiTitle` e `permissionMode`.

As conversas de subagentes (sessões geradas pelo agente principal por meio da ferramenta `Task`/`Agent`) vivem em um diretório irmão: `<session-id>/subagents/<sub-session-id>.jsonl`. São sessões completas por direito próprio, com seus próprios fluxos JSONL, vinculadas a uma chamada de ferramenta no arquivo principal por ID. Esse aninhamento é recursivo na prática: um subagente que gera o próprio subagente deixa um terceiro arquivo ao lado do segundo.

Esse layout importa porque nada na interface do Claude Code expõe isso diretamente. Se você precisa fazer algo com uma sessão depois que a conversa fecha (arquivar, compartilhar, auditar), você primeiro encontra ela no disco. A CLI faz a busca para você com `jsonl-to-pdf list`, mas vale conhecer a codificação de caminhos caso você faça grep por uma sessão específica na mão. A recente [mudança de PR-from-URL no Claude Code 2.1.119](/pt-br/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) continua adicionando mais metadados de sessão a esses arquivos, então o JSONL é cada vez mais o registro canônico do que uma execução do agente realmente fez.

## Início rápido: npx jsonl-to-pdf

O caminho sem instalação roda `jsonl-to-pdf` direto do npm sem mexer no seu `package.json`:

```bash
# Node
npx jsonl-to-pdf

# Bun
bunx jsonl-to-pdf

# pnpm
pnpm dlx jsonl-to-pdf
```

Isso te leva a um seletor interativo que percorre o diretório local de projetos do Claude Code, lista cada sessão começando pela mais recente com título, idade e tamanho, e pergunta se inclui as conversas dos subagentes. Escolha uma sessão, responda à pergunta, e a CLI escreve um PDF com o nome do título da sessão no seu diretório de trabalho atual:

```
$ jsonl-to-pdf
◆ Project   C:\S\my-app
◆ Session   Refactor the billing module to use Stripe webhooks  · 2h ago · 412KB
◆ Include sub-agent conversations? › Yes

✓ Wrote refactor-the-billing-module-to-use-stripe-webhooks.pdf
```

Se você já conhece o caminho do arquivo, `convert` o aceita como argumento posicional e pula o seletor:

```bash
jsonl-to-pdf convert ~/.claude/projects/C--S-my-app/abc-123.jsonl
```

Ambas as formas aceitam as mesmas flags. O seletor interativo é o ponto de entrada certo quando você está convertendo uma sessão pontual; a forma `convert` é o ponto de entrada certo quando você está fazendo scripting contra um arquivo conhecido (upload de artefato de CI, hook de automação, varredura de arquivamento).

Para instalar globalmente, `npm i -g jsonl-to-pdf` ou `bun i -g jsonl-to-pdf` colocam tanto `jsonl-to-pdf` quanto o alias mais curto `j2pdf` no seu `PATH`. Node 18 ou superior é necessário.

## O que vai parar no PDF

Por padrão, o PDF preserva a **fidelidade total** da sessão, não só o chat visível:

- Cada solicitação do usuário e resposta do assistente, em ordem.
- Blocos de *pensamento* (o raciocínio interno do modelo quando o pensamento estendido está ativado). Útil ao revisar como o agente decidiu o que fazer.
- Cada chamada de ferramenta, com sua entrada completa. Uma chamada `Bash` mostra seu comando, uma chamada `Edit` mostra o diff, uma chamada MCP mostra seus argumentos.
- Cada resultado de ferramenta, incluindo stdout/stderr completo do bash. Saídas longas quebram em linhas, não são cortadas.
- Anexos de imagens, embutidos em linha no ponto da conversa em que foram anexados.
- **Subagentes** renderizados aninhados no lugar certo. Quando o agente principal gerou um `Task` ou `Agent`, toda essa subconversa aparece recuada na chamada de ferramenta que a iniciou. Subagentes que geram subagentes são renderizados da mesma forma, recursivamente.

Os blocos de código são renderizados com fonte monoespaçada, quebra de linha consciente da sintaxe e lógica de quebra de página que não rasga no meio de um token. As seções incluem um mínimo de elementos de navegação (números de página, o título da sessão no cabeçalho) sem cair em design pelo design. O tema padrão é claro; `--dark` muda para um tema escuro que fica melhor na tela e pior no papel.

Essa fidelidade é o ponto. PDFs de sessões de agente são mais úteis quando o leitor pode ver exatamente o que o modelo viu, exatamente o que rodou, e exatamente o que voltou. Uma exportação resumida se lê como um postmortem; uma exportação completa se lê como uma transcrição.

## Subagentes em linha ou como apêndice

A renderização padrão é **em linha**: cada conversa de subagente aparece na posição da chamada de ferramenta que a gerou, recuada e agrupada visualmente para que o fluxo pai seja fácil de seguir. Esse é o padrão certo para depuração, em que você quer ver o desvio em contexto.

`--subagents-mode appendix` muda para um layout diferente: a conversa principal lê de cima a baixo sem interrupções, e as conversas dos subagentes vão para o final do documento com âncoras de volta para a chamada de ferramenta que gerou cada uma. Esse é o modo certo para leitura no estilo revisão de código, em que a conversa pai é a história e as threads dos subagentes são a evidência de apoio:

```bash
# inline (default)
jsonl-to-pdf convert session.jsonl

# appendix
jsonl-to-pdf convert session.jsonl --subagents-mode appendix

# omit sub-agents entirely
jsonl-to-pdf convert session.jsonl --no-subagents
```

A terceira opção, `--no-subagents`, é para casos em que as conversas dos subagentes são ruído (frequentemente: buscas longas estilo Explore que não afetam a mudança final). O PDF contém então apenas o fluxo do agente principal.

## Compact e redact: tornar uma sessão segura para compartilhar

Duas flags lidam com o caso de "quero compartilhar isso externamente".

`--compact` reduz a sessão ao essencial. Os blocos de pensamento são ocultados, e qualquer E/S de ferramenta com mais de cerca de 30 linhas é cortada com um marcador claro `[N lines omitted]`. O resultado se lê como o chat se leria, sem o trace profundo. Útil para entregar a conversa para um colega que só se importa com o resultado.

`--no-thinking` é um corte mais fino: oculta apenas os blocos de pensamento do assistente, deixa as chamadas de ferramentas e os resultados intactos. Útil quando o trace importa mas o raciocínio interno é verboso demais para imprimir.

`--redact` roda cada string do documento por um conjunto de expressões regulares que casam com os formatos comuns de segredos: chaves de acesso e secretas da AWS, tokens de acesso pessoal do GitHub (clássicos e granulares), chaves de API da Anthropic e da OpenAI, cabeçalhos `Bearer`, tokens do Slack, e chaves privadas codificadas em PEM. Cada match é substituído por `[redacted:<kind>]` para que o leitor possa saber que tipo de segredo havia sem ver o valor. A lista completa de padrões está em [src/utils/redact.ts](https://github.com/marius-bughiu/jsonl-to-pdf/blob/main/src/utils/redact.ts) no GitHub do projeto.

```bash
# safe to email
jsonl-to-pdf convert session.jsonl --compact --redact

# safe to share, full fidelity
jsonl-to-pdf convert session.jsonl --redact
```

Use `--redact` sempre que o destino estiver fora do seu limite de confiança. Mesmo quando você tiver certeza de que a sessão nunca tocou em uma chave, o custo da flag é praticamente nulo e o custo de errar é uma credencial de produção rotacionada.

## Receitas

Alguns padrões que aparecem com frequência.

**Converta em lote a sua última semana.** Cada sessão mais nova que uma data, um PDF cada, escrito ao lado de onde você rodou o comando:

```bash
jsonl-to-pdf list --json |
  jq -r '.[] | select(.modifiedAt > "2026-04-22") | .filePath' |
  while read f; do jsonl-to-pdf convert "$f"; done
```

`jsonl-to-pdf list --json` imprime um registro por sessão com `sessionId`, `projectPath`, `filePath`, `sizeBytes` e `modifiedAt`, então qualquer filtro que você consiga expressar em `jq` funciona.

**Anexe a sessão ativa como artefato de CI.** Útil em qualquer pipeline em que uma execução do Claude Code produziu a mudança e você quer a conversa arquivada junto com a saída do build:

```yaml
- run: npx -y jsonl-to-pdf convert "$CLAUDE_SESSION_FILE" -o session.pdf --redact
- uses: actions/upload-artifact@v4
  with:
    name: claude-session
    path: session.pdf
```

**Envie para uma impressora ou leitor de PDF.** A forma `-o -` escreve o PDF para stdout, o que é útil para canalizar para `lp`, `lpr`, ou qualquer binário de impressão da sua plataforma, ou para um leitor de PDF de uso único sem deixar arquivo no disco:

```bash
jsonl-to-pdf convert session.jsonl -o - | lp
```

**Liste cada sessão que a CLI consegue ver.** Sem PDF, só o índice:

```bash
jsonl-to-pdf list
```

A saída é legível por humanos por padrão e `--json` para legível por máquina. O ponto ideal de scripting para ferramentas de agente; o [post sobre triagem recorrente do Claude Code](/pt-br/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) tem um exemplo mais longo do mesmo padrão (um job agendado consumindo `list --json`).

## Binários standalone quando você não quer um toolchain Node

A página de Releases do GitHub envia binários de arquivo único construídos com `bun build --compile`, um por SO e arquitetura, sem runtime do Node necessário. Útil em agentes de build que não têm permissão para instalar um toolchain Node, ou em estações de trabalho de desenvolvedor travadas em que instalações globais do npm estão bloqueadas:

```bash
# macOS / Linux
curl -fsSL https://github.com/marius-bughiu/jsonl-to-pdf/releases/latest/download/install.sh | sh
```

No Windows, baixe `jsonl-to-pdf-win-x64.exe` da última release e coloque no seu `PATH`. O binário aceita as mesmas flags que a instalação via npm: `convert`, `list`, `--compact`, `--redact`, `--dark`, tudo.

## Por que um PDF especificamente, e não "abrir no navegador"

Algumas razões pelas quais o formato PDF se justifica em vez de uma visão HTML que existe no roadmap.

- **Arquivar.** Arquivos de sessão locais do Claude Code são rotacionados, coletados como lixo, ou simplesmente esquecidos. Um PDF é um snapshot congelado e auto-contido que você pode colocar em uma pasta de projeto, em uma issue ou em um backup.
- **Compartilhar.** A maioria das ferramentas de revisão de código e chat aceita um anexo PDF de forma limpa. Colar um JSONL de 400KB em um tópico do Slack é uma experiência pior do que soltar um PDF.
- **Revisar.** Ler o trabalho do agente como você lê uma revisão de código (em uma escrivaninha, em um voo, no papel) é um modo de atenção diferente de rolar um chat. PDFs sobrevivem a essa mudança.
- **Auditar.** Uma exportação assinada e determinística é um registro do que realmente foi dito e rodado. Equipes internas de compliance podem marcar um PDF; não podem marcar um JSONL.
- **Onboarding.** Uma sessão real é material de estudo muito melhor para alguém júnior do que um tutorial genérico. Um PDF transforma esse repasse em um problema de um único anexo.

## Roadmap, em resumo

A versão 0.1.0 cobre apenas Claude Code. O roadmap no GitHub do projeto compromete adaptadores para Aider, OpenAI Codex CLI, Cursor Compose e Gemini CLI, todos os quais escrevem alguma variação de transcrição JSONL ou JSON-Lines. Além da cobertura de formatos:

- Saída HTML para compartilhamento web inline, e um pequeno visualizador estático.
- Realce de sintaxe para blocos de código via tokens do Shiki.
- Um sumário com números de página (builds atuais usam outlines/marcadores de PDF).
- Flags de filtragem: `--turns 5..15`, `--only assistant`, `--exclude-tool Bash`, para os casos em que a transcrição completa é demais.

Se você escreve um CLAUDE.md e um hook para manter suas sessões nos trilhos (o [guia de CLAUDE.md](/pt-br/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) cobre isso), `jsonl-to-pdf` é o artefato que combina: uma forma de sair de uma sessão com algo durável para apontar. O repositório está em [github.com/marius-bughiu/jsonl-to-pdf](https://github.com/marius-bughiu/jsonl-to-pdf).
