---
title: "Agent Skills chegam ao Visual Studio 2026 18.5: Copilot descobre SKILL.md automaticamente do seu repo"
description: "Visual Studio 2026 18.5.0 deixa o GitHub Copilot carregar Agent Skills de .github/skills, .claude/skills e ~/.copilot/skills. Packs reutilizáveis de instruções SKILL.md viajam com seu repo."
pubDate: 2026-04-20
tags:
  - "visual-studio"
  - "github-copilot"
  - "agent-skills"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/04/visual-studio-2026-copilot-agent-skills"
translatedBy: "claude"
translationDate: 2026-04-24
---

O release de 14 de abril de 2026 do Visual Studio 2026 (versão 18.5.0) adicionou silenciosamente um dos recursos mais úteis do Copilot do ano: [Agent Skills](https://learn.microsoft.com/en-us/visualstudio/releases/2026/release-notes). Se você passou os últimos seis meses copiando e colando o mesmo parágrafo "é assim que revisamos pull requests neste repo" no Copilot Chat, pode parar. Agent Skills são packs reutilizáveis de instruções que vivem junto do seu código, e o Copilot no Visual Studio agora os descobre automaticamente.

## Onde o Visual Studio procura por skills

Um skill é só uma pasta com um arquivo `SKILL.md` dentro. Visual Studio 2026 18.5 escaneia seis localizações bem conhecidas, três ligadas ao workspace e três ligadas ao seu perfil de usuário:

- Workspace: `.github/skills/`, `.claude/skills/`, `.agents/skills/`
- Pessoal: `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`

A duplicação é intencional. A [especificação agentskills.io](https://agentskills.io/specification) é um formato aberto e as mesmas pastas são lidas pelo GitHub Copilot CLI, pelo agente cloud do Copilot e pelo VS Code. Coloque um skill em `.github/skills/` e toda superfície Copilot que seu time usa o vê, não só a IDE da sua máquina.

## Como um SKILL.md de fato se parece

O arquivo é Markdown com um cabeçalho YAML de frontmatter. O frontmatter tem dois campos obrigatórios, `name` e `description`, mais alguns opcionais para como o skill é invocado:

```markdown
---
name: efcore-migration-review
description: Reviews EF Core migration files in this repo. Use whenever the user asks Copilot to add, squash, or review a migration under src/Infrastructure/Migrations.
argument-hint: [migration file path]
user-invocable: true
disable-model-invocation: false
---

# EF Core migration review

When reviewing a migration under `src/Infrastructure/Migrations`:

1. Reject any migration that drops a column without a corresponding data backfill step.
2. Flag `AlterColumn` calls that change nullability on tables with more than 10M rows. Point at `docs/ops/large-table-playbook.md`.
3. Require a matching `Down()` that is a true inverse, not an empty stub.

Reference implementation: see `examples/add-index-migration.md` in this skill folder.
```

O campo `name` precisa ser em minúsculas, separado por hífens, no máximo 64 caracteres, e precisa bater com o nome da pasta. O campo `description` é o que o Copilot usa para decidir se carrega o skill, então vale escrever como uma query de retrieval, não como um slogan. O comprimento máximo é 1024 caracteres e você deve usá-los.

## Por que isso muda o padrão

Até agora o padrão usual era um `.github/copilot-instructions.md` espalhado ou um agente custom definido em `.agent.md`. Agent Skills são mais estreitos por design: cada skill é uma única preocupação, carregada sob demanda, e só o corpo entra na janela de contexto quando a descrição bate. Para um monorepo .NET com migrations de EF Core, código de plataforma MAUI e controllers ASP.NET Core, você pode entregar três skills separados em vez de um arquivo gigante de instruções e parar de queimar tokens em orientações irrelevantes para a tarefa atual.

Skills também compõem com Custom Agents. Um arquivo `.agent.md` pode escopar quais skills ele puxa, que é como times acabam com um agente "backend-reviewer" que só vê skills de EF Core e ASP.NET Core enquanto um agente "mobile-reviewer" vê os de MAUI e Flutter.

A Microsoft nota que a UI de navegação e criação ainda está vindo em uma atualização 18.x posterior, então por enquanto são arquivos de texto em pastas. Tudo bem. Arquivos de texto em pastas são exatamente para o que serve o controle de versão.
