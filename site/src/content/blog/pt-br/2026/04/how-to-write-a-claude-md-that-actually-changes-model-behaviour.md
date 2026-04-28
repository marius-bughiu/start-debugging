---
title: "Como escrever um CLAUDE.md que realmente muda o comportamento do modelo"
description: "Um manual de 2026 para arquivos CLAUDE.md que o Claude Code realmente segue: a meta de 200 linhas, quando usar regras com escopo de caminho em .claude/rules/, hierarquia de @import e o limite de 5 saltos, a diferença entre mensagem de usuário e prompt de sistema, a linha entre CLAUDE.md e memória automática, e quando desistir e escrever um hook. Ancorado no Claude Code 2.1.x e verificado contra a documentação oficial de memória."
pubDate: 2026-04-28
tags:
  - "claude-code"
  - "ai-agents"
  - "agent-skills"
  - "developer-workflow"
lang: "pt-br"
translationOf: "2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour"
translatedBy: "claude"
translationDate: 2026-04-29
---

Um CLAUDE.md que "não funciona" quase sempre significa uma de três coisas: ele é longo demais e regras importantes acabam sendo afogadas, é vago demais para ser verificado, ou a instrução precisa ser um hook porque o CLAUDE.md é consultivo por design. A partir do **Claude Code 2.1.x**, o arquivo é carregado no contexto como mensagem de usuário depois do prompt de sistema, não dentro do prompt de sistema em si, o que é um detalhe não óbvio que explica boa parte da frustração do tipo "Claude está ignorando minhas regras" no `r/ClaudeAI` e no `r/cursor` neste mês. O comportamento do modelo realmente muda em resposta a um bom CLAUDE.md, mas só se você o tratar do jeito que a própria [documentação de memória](https://code.claude.com/docs/en/memory) da Anthropic descreve: como contexto, não como configuração.

A versão curta: mire em menos de 200 linhas, escreva instruções específicas e verificáveis, jogue regras por tópico em `.claude/rules/` com frontmatter `paths:`, jogue fluxos reutilizáveis em skills, e use hooks para qualquer coisa que precise rodar absolutamente. Use `@imports` para organizar, mas entenda que eles não economizam tokens. E se você corrigir o mesmo erro duas vezes, não enterre mais fundo no CLAUDE.md, ele já está perdendo a luta contra suas outras regras.

Este post assume Claude Code 2.1.59+ (a versão que traz a memória automática) e `claude-sonnet-4-6` ou `claude-opus-4-7` como modelo por baixo. Os padrões funcionam igual nos dois, mas o Sonnet é mais sensível a CLAUDE.md inflado porque a aderência cai mais rápido conforme o contexto enche.

## Por que "eu mandei ele fazer" não basta

A frase mais útil da [documentação oficial de memória](https://code.claude.com/docs/en/memory#claude-isn-t-following-my-claude-md) é esta: "O conteúdo do CLAUDE.md é entregue como mensagem de usuário depois do prompt de sistema, não como parte do prompt de sistema em si. O Claude lê e tenta seguir, mas não há garantia de cumprimento estrito." Isso explica todo thread "literalmente escrevi `NEVER use console.log` e ele fez mesmo assim". O modelo enxerga seu CLAUDE.md igual enxerga o resto do seu prompt: como instruções para pesar, não como uma diretiva inegociável.

Daí saem três consequências concretas:

1. **Mais texto reduz a aderência.** Quanto mais longo o arquivo, mais diluída fica qualquer regra individual. A documentação oficial recomenda "mirar em menos de 200 linhas por arquivo CLAUDE.md. Arquivos mais longos consomem mais contexto e reduzem a aderência."
2. **Regras vagas são arredondadas.** "Formate o código corretamente" é interpretado pelo modelo do mesmo jeito que você interpretaria: faça algo razoável. "Use indentação de 2 espaços, sem ponto e vírgula no final exceto após imports" é uma instrução verificável que o modelo realmente consegue seguir.
3. **Regras conflitantes resolvem de forma arbitrária.** Se seu CLAUDE.md raiz diz "sempre escreva testes" e um aninhado em uma subpasta diz "pule testes para protótipos", o modelo escolhe um sem te avisar qual.

Se você realmente precisa de uma diretiva inegociável, tem duas opções. A primeira é `--append-system-prompt`, que coloca texto dentro do próprio prompt de sistema. Pela [referência da CLI](https://code.claude.com/docs/en/cli-reference#system-prompt-flags), tem que ser passada em cada invocação, o que serve para scripts e CI mas é inviável para uso interativo. A segunda, e quase sempre a melhor, é um hook, do qual chegaremos perto.

## O que vai no CLAUDE.md, o que não vai

O próprio [guia de boas práticas](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md) da Anthropic traz uma tabela enxuta de incluir/excluir que copio em todo projeto que toco. Reformulada e condensada:

**Incluir**: comandos bash que o Claude não consegue inferir do seu `package.json` ou `Cargo.toml`, regras de estilo que diferem do padrão do idioma, o test runner que você quer que ele use, convenções de branch e PR, decisões arquiteturais que não são óbvias ao ler o código, e armadilhas como "o container de testes do postgres precisa de `POSTGRES_HOST_AUTH_METHOD=trust` ou as migrações travam."

**Excluir**: qualquer coisa que o Claude consegue ler do `tsconfig.json`, convenções de framework que todo desenvolvedor conhece, descrições arquivo a arquivo do código, histórico de como o código chegou ao estado atual, e práticas auto-evidentes como "escreva código limpo". O documento de boas práticas é direto: "CLAUDE.md inflados fazem o Claude ignorar suas instruções reais." Cada linha que você adiciona reduz a relação sinal-ruído para o resto.

Um CLAUDE.md que sobreviveu a esse filtro para um backend Next.js + Postgres se parece com isto:

```markdown
# Project: invoice-api
# Claude Code 2.1.x, Node 22, Next.js 15

## Build and test
- Use `pnpm`, never `npm` or `yarn`. The lockfile is committed.
- Run `pnpm test --filter @app/api` for backend tests, NOT the full workspace.
- Migrations: `pnpm db:migrate` only inside the `apps/api` workspace.

## Code style
- Use ESM (`import`/`export`). Default export is forbidden except in
  Next.js page/route files where the framework requires it.
- Zod schemas for every external input. No `any`, no `as unknown as T`.

## Architecture
- Database access goes through `apps/api/src/db/repositories/`.
  Do not call `db.query` from route handlers.
- All money is `bigint` cents. Never `number`, never decimals.

## Workflow
- After a code change, run `pnpm typecheck` and `pnpm test --filter @app/api`.
- Commit messages: imperative, no scope prefix, max 72 chars on the title.
```

São 17 linhas e cobrem cada correção recorrente que o time tinha documentado no template de PR. Repare no que não está ali: nada de "sempre escreva código limpo", nada de "tome cuidado com segurança", nada de "use modo strict do TypeScript" (está no `tsconfig.json`, o modelo enxerga). Cada linha responde "remover isso causaria um erro mensurável?" com sim.

## O teto de 200 linhas e `.claude/rules/`

Ao passar de 200 linhas, a documentação oficial de memória recomenda dividir as instruções por tópico em `.claude/rules/` com frontmatter YAML que delimita cada arquivo a um glob:

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/api/**/*.tsx"
---

# API endpoint conventions

- Every route under `src/api/` exports a `POST`, `GET`, `PUT`, or `DELETE`
  function. Never a default export.
- Validate the body with the matching Zod schema in `src/api/schemas/`
  before doing anything else. If no schema exists, write one first.
- Return errors with `Response.json({ error }, { status })`. Do not throw.
```

Uma regra com `paths:` só carrega no contexto quando o Claude lê um arquivo que casa com um dos globs. O custo de ter dez arquivos de regra de 100 linhas cada é muito menor do que um CLAUDE.md de 1000 linhas, porque nove deles não estão no contexto para uma tarefa qualquer. Regras sem `paths:` carregam toda sessão com a mesma prioridade do `.claude/CLAUDE.md`, então não as ponha lá por hábito a menos que realmente se apliquem a todo arquivo.

Aqui também é onde morre o "scope creep para o CLAUDE.md". Se um colega propuser adicionar doze linhas sobre uma ferramenta de migração obscura, a resposta é "isso vai em `.claude/rules/migrations.md` com `paths: ['db/migrations/**/*.sql']`", não "a gente apara depois". Nunca aparamos depois.

## Imports, hierarquia e o limite de 5 saltos

A sintaxe de import `@path/to/file` é para organização, não para economia de tokens. Da [documentação](https://code.claude.com/docs/en/memory#import-additional-files): "Arquivos importados são expandidos e carregados no contexto na inicialização junto com o CLAUDE.md que os referencia." Se você dividir um CLAUDE.md de 600 linhas em uma raiz de 50 linhas e um `@docs/conventions.md` de 550, o modelo continua vendo 600 linhas.

Imports são úteis para três coisas específicas:

1. **Reaproveitar as mesmas instruções entre dois repos** sem copiar e colar. Use symlink ou importe um arquivo compartilhado em `~/shared/team-conventions.md`.
2. **Sobrescritas por desenvolvedor** que não devem ir para o repo. `@~/.claude/my-project-instructions.md` permite manter preferências pessoais no seu home enquanto todo mundo recebe o CLAUDE.md do time pelo git.
3. **Ponte para `AGENTS.md`** se seu repo já tem um para outros agentes de codificação. A documentação recomenda explicitamente `@AGENTS.md` seguido das sobrescritas específicas do Claude:

```markdown
@AGENTS.md

## Claude Code

Use plan mode for changes under `src/billing/`.
```

Imports resolvem recursivamente até **cinco saltos de profundidade**. Além disso, o import é descartado em silêncio. Se você tem um CLAUDE.md que importa um arquivo que importa um arquivo que importa um arquivo quatro vezes, você construiu algo frágil: achate.

A hierarquia em si é aditiva, não sobrepõe. CLAUDE.md do projeto, CLAUDE.md do usuário (`~/.claude/CLAUDE.md`) e qualquer CLAUDE.md subindo a árvore de diretórios a partir do diretório de trabalho são todos concatenados. `CLAUDE.local.md` (ignorado pelo git) carrega depois do `CLAUDE.md` no mesmo nível, então suas notas pessoais ganham em conflito. Em um monorepo onde você não quer arquivos CLAUDE.md de times irmãos no seu contexto, a [opção `claudeMdExcludes`](https://code.claude.com/docs/en/memory#exclude-specific-claude-md-files) recebe uma lista de padrões glob:

```json
{
  "claudeMdExcludes": [
    "**/monorepo/CLAUDE.md",
    "/home/marius/monorepo/other-team/.claude/rules/**"
  ]
}
```

Coloque isso em `.claude/settings.local.json` para que a exclusão seja sua e não do time.

## CLAUDE.md são "seus requisitos", memória automática é "o que o Claude notou"

O Claude Code 2.1.59 adicionou memória automática: notas que o Claude escreve sobre si mesmo a partir das suas correções. Ela vive em `~/.claude/projects/<project>/memory/MEMORY.md` e é carregada da mesma forma que o CLAUDE.md, exceto que apenas as primeiras 200 linhas ou 25KB do `MEMORY.md` são puxadas no início da sessão. O resto do diretório é lido sob demanda.

A forma mais limpa de pensar a divisão:

- **CLAUDE.md** guarda regras que você quer aplicadas desde o dia um. "Rode `pnpm test --filter @app/api`, não a suíte inteira." Você escreveu, você commitou, seu time vê.
- **Memória automática** guarda padrões que o Claude notou. "Usuário prefere `vitest` em vez de `jest` e me corrigiu quando gerei um `jest.config.js`." O Claude escreveu, é por máquina, não está no git.

Saem daí duas regras práticas. Primeira, não duplique entradas da memória automática no CLAUDE.md "para garantir". A memória automática também carrega toda sessão. Segunda, quando a memória automática acumula um padrão que o time inteiro deveria conhecer, promova: abra o `MEMORY.md`, copie a entrada para o CLAUDE.md, e o `/memory` deixa você apagar o original. A promoção é o momento em que "Claude observou isso sobre mim" vira "nós como time decidimos isto".

Para mais sobre a divisão, o post sobre [agendar rotinas do Claude Code](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) cobre o que sobrevive a uma execução autônoma sem humano no loop, o que é um bom teste de pressão para verificar se seu CLAUDE.md realmente é autocontido.

## Ajustando para aderência

Uma vez que o arquivo está curto e específico, dá para tirar mais cumprimento dele com três técnicas em que documentação e relatos de campo convergem:

1. **Use ênfase com parcimônia.** A orientação oficial é "ajustar instruções adicionando ênfase (por exemplo, `IMPORTANT` ou `YOU MUST`) para melhorar a aderência." Parcimônia é a palavra operativa. Se tudo é `IMPORTANT`, nada é. Reserve a ênfase para a regra que, se violada, realmente quebra um build ou queima alguém de oncall.
2. **Comece pelo verbo, depois pela restrição.** "Rode `pnpm typecheck` após cada mudança de código em `src/`" é seguido com mais confiabilidade do que "A verificação de tipos deve ser realizada regularmente." A primeira é uma ação; a segunda é uma vibe.
3. **Co-localize a regra com o modo de falha.** "Não chame `db.query` dos route handlers; o pool de conexões é por requisição e os route handlers vazam. Use `repositories/` em vez disso." O modo de falha é o que faz a regra grudar entre sessões.

Se você corrigir o mesmo erro duas vezes e a regra já estiver no CLAUDE.md, o movimento certo não é adicionar outra regra. É perguntar por que a regra existente não está vencendo. Geralmente é uma destas: o arquivo está longo demais, duas regras se contradizem, ou a instrução é do tipo que precisa de hook.

## Quando desistir do CLAUDE.md e escrever um hook

CLAUDE.md é consultivo. Hooks são determinísticos. Do [guia de hooks](https://code.claude.com/docs/en/hooks-guide), eles são "scripts que rodam automaticamente em pontos específicos do fluxo do Claude" e "garantem que a ação aconteça". Se sua regra está na categoria "tem que rodar com zero exceções", ela não pertence ao CLAUDE.md.

Um hook `PostToolUse` que roda Prettier após cada edição de arquivo é mais confiável que uma linha de CLAUDE.md dizendo "sempre rode Prettier após edições". O mesmo para "bloqueie escritas em `migrations/`", que vira um hook `PreToolUse` com um padrão de bloqueio. O mesmo padrão é o que faz a história mais ampla das [skills de agente do Visual Studio 2026](/pt-br/2026/04/visual-studio-2026-copilot-agent-skills/) funcionar na prática: a skill é a instrução flexível, o hook é o trilho rígido.

Esse também é o momento certo de pensar na linha entre CLAUDE.md e skills. Uma instrução do CLAUDE.md carrega a cada sessão e se aplica de modo amplo. Uma skill em `.claude/skills/SKILL.md` carrega sob demanda quando o modelo decide que a tarefa é relevante, então conhecimento profundo de fluxo com efeitos colaterais (como um fluxo "fix-issue" que abre um PR) pertence ali. A mesma lógica vale para instruções que são enormes mas só importam para uma parte do código: essas querem uma regra com escopo de caminho, não o CLAUDE.md.

## Diagnosticar o que de fato foi carregado

Quando o modelo está fazendo a coisa errada, o primeiro passo é confirmar o que ele realmente vê. Rode `/memory` dentro de uma sessão do Claude Code. Ele lista cada CLAUDE.md, CLAUDE.local.md e arquivo de regra carregado no momento, com caminhos. Se o arquivo que você esperava não está na lista, o resto da conversa é irrelevante: o Claude não consegue vê-lo.

Para regras com escopo de caminho e arquivos CLAUDE.md de subdiretórios carregados sob demanda, o [hook `InstructionsLoaded`](https://code.claude.com/docs/en/hooks#instructionsloaded) dispara toda vez que o Claude puxa instruções. Conecte-o a um logger para confirmar que um glob `paths:` realmente casou, ou para depurar por que um CLAUDE.md aninhado nunca recarrega após `/compact`. O caso da compactação é uma quina conhecida: o CLAUDE.md da raiz do projeto é reinjetado após `/compact`, mas os aninhados só recarregam na próxima leitura de arquivo naquele subdiretório. Se você depende de um CLAUDE.md aninhado e as instruções parecem perdidas no meio da sessão, é por isso.

O outro diagnóstico que vale conhecer: comentários de bloco HTML (`<!-- like this -->`) são removidos do CLAUDE.md antes da injeção. Use-os para notas humanas (uma linha `<!-- last reviewed 2026-04 -->`) sem pagar custo de token.

## Relacionado

- [Como agendar uma tarefa recorrente do Claude Code que classifica issues do GitHub](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) cobre o que um CLAUDE.md precisa para execuções autônomas.
- [Claude Code 2.1.119: lançar a partir de um PR no GitLab e Bitbucket](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) para a pergunta relacionada de "onde minhas instruções vivem em uma sessão na nuvem".
- [Skills de agente Copilot no Visual Studio 2026](/pt-br/2026/04/visual-studio-2026-copilot-agent-skills/) é o análogo mais próximo do lado da Microsoft: arquivos de skill versus contexto persistente.
- [Construindo um servidor MCP em TypeScript](/pt-br/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) para o caso onde a melhor resposta a "mais regras no CLAUDE.md" é "expor a ferramenta para o agente".

## Fontes

- Oficial: [Como o Claude lembra do seu projeto](https://code.claude.com/docs/en/memory) (documentação de memória do Claude Code e CLAUDE.md).
- Oficial: [Boas práticas para o Claude Code](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md).
- Oficial: [Referência de hooks](https://code.claude.com/docs/en/hooks-guide) e [hook `InstructionsLoaded`](https://code.claude.com/docs/en/hooks#instructionsloaded).
- Notas de campo: [Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md) (HumanLayer).
