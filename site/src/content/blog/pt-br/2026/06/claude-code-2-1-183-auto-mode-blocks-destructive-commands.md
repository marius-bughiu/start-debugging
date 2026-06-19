---
title: "Claude Code 2.1.183 impede que o modo automatico execute comandos destrutivos de Git e IaC"
description: "Claude Code v2.1.183 (2026-06-19) bloqueia git reset --hard, git clean -fd e terraform/pulumi/cdk destroy no modo automatico a menos que voce os peca, fechando a brecha agentica em que um turno ruim destroi trabalho nao confirmado."
pubDate: 2026-06-19
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "pt-br"
translationOf: "2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands"
translatedBy: "claude"
translationDate: 2026-06-19
---

O Claude Code v2.1.183 chegou em 2026-06-19, e a mudanca de destaque e uma protecao que deveria ter existido no mesmo dia em que o modo automatico existiu: o agente nao pode mais executar por iniciativa propria um punhado de comandos irreversiveis. Se voce nao pediu explicitamente um `git reset --hard`, o modelo nao tem permissao para decidir que precisa de um no meio da tarefa.

## O modo de falha que isso fecha

O modo automatico (antes a variante "faca e pronto" no estilo YOLO) deixa o agente executar comandos de shell sem um aviso de aprovacao por comando. E exatamente o que voce quer para um ciclo de `dotnet build`, `dotnet test` e edicoes. E exatamente o que voce nao quer quando o modelo, tentando "voltar a um estado limpo" apos uma refatoracao confusa, recorre a `git reset --hard` e apaga uma hora de trabalho nao confirmado, ou executa `terraform destroy` contra o stack errado.

A nova versao traca uma linha: comandos destrutivos e dificeis de desfazer ficam bloqueados no modo automatico a menos que a solicitacao que os disparou tenha nomeado essa acao de forma explicita. O conjunto bloqueado na 2.1.183:

```bash
# Blocked in auto mode unless you asked for them
git reset --hard
git checkout -- .
git clean -fd
git stash drop

# Blocked for commits the agent did not make this session
git commit --amend

# Blocked unless a specific stack is named
terraform destroy
pulumi destroy
cdk destroy
```

A distincao e a intencao, nao uma proibicao geral. Se o seu prompt diz "redefina a arvore de trabalho com `git reset --hard`", o agente executa. Se ele conclui por conta propria que um reset e o caminho, ele para e avisa voce. O mesmo vale para infraestrutura: `terraform destroy` mirando um stack especifico que voce nomeou e permitido; um `destroy` sozinho, nao.

## Por que o amend recebe tratamento especial

A regra do `git commit --amend` e a sutil. Emendar um commit que o proprio agente fez antes na sessao esta tudo bem, e o comportamento normal de iterar sobre o proprio trabalho. Emendar um commit que ele nao criou reescreve um historico que nao lhe pertence, o que pode silenciosamente sobrescrever o commit de um colega ou o seu trabalho anterior a sessao. O classificador agora verifica a autoria dentro da sessao antes de permitir isso.

Isso se encaixa naturalmente com o trabalho de seguranca anterior: [o `--safe-mode` da v2.1.169](/pt-br/2026/06/claude-code-2-1-169-safe-mode-and-cd/) da a voce uma base limpa para depurar, e agora o proprio modo automatico se recusa a ser aquilo que perde os seus dados. Se voce realmente precisa que o agente execute um desses sem pedir, o caminho e dizer isso no prompt, ou sair do modo automatico para aquele passo e aprova-lo manualmente.

## O resto da versao

A 2.1.183 tambem adiciona avisos de descontinuacao quando voce pede um modelo que foi substituido (mostrados em stderr no modo print e no frontmatter do agente), uma nova configuracao `attribution.sessionUrl` para manter os links de sessao do claude.ai fora dos seus commits e PRs, e `/config --help` para listar as chaves abreviadas. As correcoes de bugs cobrem o WebSearch retornando vazio em subagentes, a corrupcao da TUI em tela cheia no Windows Terminal, e turnos que terminam em silencio quando apenas um bloco de pensamento foi produzido.

As notas completas estao no [changelog da v2.1.183](https://code.claude.com/docs/en/changelog).
