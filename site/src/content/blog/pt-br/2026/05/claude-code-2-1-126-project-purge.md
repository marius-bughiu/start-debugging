---
title: "Claude Code 2.1.126 adiciona `claude project purge` para apagar todo o estado de um repositório"
description: "O Claude Code v2.1.126 traz claude project purge, um novo subcomando da CLI que apaga cada transcrição, tarefa, entrada de histórico de arquivos e bloco de configuração ligado a um caminho de projeto em uma única operação. Inclui --dry-run, --yes, --interactive e --all."
pubDate: 2026-05-03
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "pt-br"
translationOf: "2026/05/claude-code-2-1-126-project-purge"
translatedBy: "claude"
translationDate: 2026-05-03
---

A versão Claude Code v2.1.126, lançada em 1 de maio de 2026, adicionou um comando pequeno com uma história de limpeza desproporcional: `claude project purge [path]`. Execute-o contra um repositório e a CLI apaga cada transcrição, tarefa, entrada de histórico de arquivos e bloco de configuração de `~/.claude/projects/...` ligado àquele caminho de projeto em uma única operação. Acabou a garimpagem manual dentro de `~/.claude/projects/` para reiniciar um projeto que acumulou um ano de histórico de sessões.

## Por que um comando dedicado em vez de `rm -rf`

O estado por projeto do Claude Code vive em vários lugares ao mesmo tempo. Existe um diretório do projeto em `~/.claude/projects/<encoded-path>/` que guarda transcrições JSONL, a lista de tarefas salva e snapshots do histórico de arquivos. Também há entradas no `~/.claude/settings.json` global e na configuração por projeto que apontam para esse diretório por caminho absoluto. Remover apenas a pasta do projeto deixa referências penduradas; remover apenas as entradas de configuração deixa megabytes de transcrições órfãs.

Até a v2.1.126, a resposta oficial era uma limpeza manual cuidadosa. O novo subcomando percorre o mesmo mapa interno que o resto da CLI usa, então transcrições, tarefas, histórico de arquivos e entradas de configuração somem em uma única passada consistente. Se você executá-lo contra o diretório em que já está, pode omitir o caminho:

```bash
# Nuke everything Claude Code knows about the current repo
claude project purge

# Or target an absolute path from elsewhere
claude project purge /home/marius/work/legacy-monolith
```

## As flags que tornam isso seguro para script

A parte interessante é a superfície de flags. A versão entrega quatro:

```bash
# Show what would be deleted without touching anything
claude project purge --dry-run

# Skip the confirmation prompt (CI-friendly)
claude project purge -y
claude project purge --yes

# Walk projects one at a time and choose
claude project purge --interactive

# Purge every project Claude Code has ever recorded
claude project purge --all
```

`--dry-run` imprime os IDs de projeto, as contagens de transcrições e os totais em bytes em disco que ele removeria. `--all` é o martelo pesado, útil depois de uma troca de notebook em que a maioria dos caminhos registrados não existe mais em disco. `-i` é o modo intermediário para triar uma lista longa.

## Onde isso se encaixa no quadro da v2.1.126

`project purge` é uma de várias mudanças de gestão de estado nesta versão. A mesma build também deixa `--dangerously-skip-permissions` escrever em caminhos antes protegidos como `.claude/`, `.git/`, `.vscode/` e arquivos de configuração do shell, o que combina com o modelo de purge: o Claude Code está se inclinando para te dar ferramentas mais contundentes para varrer sua própria pegada, assumindo que você sabe o que está fazendo. A anterior [variável de ambiente de Bedrock service tier no Claude Code 2.1.122](/pt-br/2026/04/claude-code-2-1-122-bedrock-service-tier/) foi uma versão semelhante no estilo "um botão, sem mudanças no SDK"; a v2.1.126 segue o mesmo padrão.

Se você executar o Claude Code sob um `~/.claude` gerenciado (uma política de configuração fixada pela organização), `--all` só vai purgar projetos cujo estado vive sob o seu perfil de usuário. O próprio arquivo da política gerenciada permanece intacto.

As notas completas estão na [página da versão Claude Code v2.1.126](https://github.com/anthropics/claude-code/releases/tag/v2.1.126).
