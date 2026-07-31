---
title: "A revisão de código do Copilot agora lê a sua pasta .github/skills"
description: "As agent skills e os servidores MCP na revisão de código do GitHub Copilot chegaram ao GA em 2026-07-29. Veja onde os arquivos ficam, por que as skills são carregadas da branch head e por que toda chamada de ferramenta MCP em uma revisão é somente leitura."
pubDate: 2026-07-31
tags:
  - "github-copilot"
  - "agent-skills"
  - "mcp"
  - "code-review"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/07/copilot-code-review-agent-skills-and-mcp-ga"
translatedBy: "claude"
translationDate: 2026-07-31
---

Em 2026-07-29 o GitHub tornou [as agent skills e o suporte a MCP na revisão de código do Copilot](https://github.blog/changelog/2026-07-29-copilot-code-review-agent-skills-and-mcp-now-generally-available/) disponíveis de forma geral para Copilot Pro, Pro+, Business e Enterprise. Até agora o revisor lia o seu diff e as suas instruções personalizadas, e essa era toda a janela de contexto. Agora ele consegue puxar as mesmas pastas de skills que o seu agente de código usa, além de contexto somente leitura vindo de servidores MCP.

Isso fecha a lacuna mais irritante da revisão automatizada: o bot conseguia dizer que faltava uma verificação de `null`, mas não fazia ideia de que o seu time exige que toda migração do EF Core entregue um `Down()` não vazio, e não tinha como consultar se a issue que este PR fecha já havia sido revertida na sprint passada.

## Skills são pastas, e o revisor escolhe sozinho

Uma skill é um diretório dentro de `.github/skills` com um `SKILL.md` lá dentro. O Copilot compara a tarefa com a `description` de cada skill e carrega apenas o que parece relevante, então uma skill voltada para revisão precisa de um nome de diretório e de uma descrição que soem como trabalho de revisão.

```md
---
name: ef-core-migration-review
description: Review EF Core migrations for a non-empty Down(), no data loss on column drops, and an explicit index name. Use when the diff touches Migrations/.
---

## What to flag

- A `Down()` method with only `// no-op` or an empty body. Every migration must be reversible.
- `DropColumn` without a preceding data copy. Comment with the backfill snippet from `references/backfill.md`.
- `CreateIndex` without an explicit `name:` argument.
```

O detalhe que vale conhecer: a revisão de código do Copilot lê as instruções e as skills da **branch head**, não da branch base. Edite uma skill e abra um PR, e esse mesmo PR será revisado pela skill editada. Você consegue iterar nas regras de revisão sem precisar fazer merge antes, o oposto de como se comporta a maior parte da configuração de lint baseada em CI.

## MCP vem ligado por padrão, e é somente leitura por design

Os servidores MCP para revisão são configurados nas configurações do repositório, em Copilot > MCP servers, usando o mesmo JSON que o agente na nuvem consome. Os servidores do GitHub e do Playwright já vêm habilitados.

```json
{
  "mcpServers": {
    "issue-tracker": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer $COPILOT_MCP_TRACKER_TOKEN" },
      "tools": ["search_issues", "get_issue"]
    }
  }
}
```

Os tokens ficam nas configurações do repositório, em Secrets and variables > Agents, referenciados como `$COPILOT_MCP_*`. Toda chamada de ferramenta MCP feita durante uma revisão é limitada a somente leitura, e essa é a escolha certa: um revisor que consegue escrever no seu issue tracker é um revisor que pode sofrer prompt injection pelo corpo de um pull request. Repare que `"tools": ["*"]` continua sendo aceito, e a própria orientação do GitHub é colocar na allowlist ferramentas específicas, porque o agente as usa de forma autônoma e sem etapa de aprovação.

Se você preferir manter o MCP restrito apenas ao agente na nuvem, a configuração de repositório "Allow Copilot to use MCP tools when reviewing pull requests" vem ligada por padrão e pode ser desligada. Os comentários de revisão que se apoiaram em uma skill ou em uma ferramenta MCP agora trazem atribuição, então dá para saber qual regra gerou cada apontamento.

Se o seu repositório ainda tem uma pasta `.github/prompts/`, este é o empurrão para terminar de [migrar esses prompt files para agent skills](/2026/07/migrate-copilot-prompt-files-to-agent-skills/): o mesmo `SKILL.md` agora alimenta o IDE, o agente na nuvem e o revisor.
