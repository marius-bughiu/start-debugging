---
title: "O modo automatico do Claude Code agora pega o rm -rf com variavel vazia"
description: "As versoes da semana 28 do Claude Code (v2.1.202-v2.1.206, de 6 a 10 de julho de 2026) ensinam o modo automatico a pausar antes de um rm -rf cujo caminho veio de uma variavel que se expandiu para nada, fechando o classico problema do rm -rf /."
pubDate: 2026-07-13
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "pt-br"
translationOf: "2026/07/claude-code-auto-mode-guards-empty-variable-rm-rf"
translatedBy: "claude"
translationDate: 2026-07-13
---

Todo mundo que escreve scripts de shell ja viu o desastre: uma linha de limpeza como `rm -rf "$BUILD_DIR/bin"` onde `$BUILD_DIR` nunca foi definido, entao o comando se expande silenciosamente para `rm -rf /bin`. As versoes da semana 28 do Claude Code (da v2.1.202 ate a v2.1.206, publicadas de 6 a 10 de julho de 2026) adicionam uma protecao exatamente para esse caso no modo automatico: o agente agora pausa e pergunta antes de executar um `rm -rf` cujo caminho de destino foi construido a partir de uma variavel que se resolveu para nada.

## Por que um agente cai nisso mais do que voce

Voce escreve um comando destrutivo uma vez e o revisa com os olhos. Um agente no modo automatico monta shell na hora, muitas vezes reutilizando uma variavel que definiu tres turnos atras. Se um passo anterior falhou e deixou essa variavel vazia, o perigo nao e o modelo digitar `rm -rf /` de proposito. E ele digitar algo que *parece* delimitado e seguro, e o shell transformar isso em uma limpeza no nivel da raiz no momento da expansao.

```bash
# The agent set this earlier, but the step that populated it failed
BUILD_DIR=""

# Looks scoped. Expands to: rm -rf /bin
rm -rf "$BUILD_DIR/bin"

# Same trap with an unset var under `set -u` off
rm -rf $ARTIFACTS_DIR/*
```

O classificador do modo automatico agora inspeciona o comando resolvido, nao apenas o texto literal que voce veria na transcricao. Quando o caminho que um `rm -rf` esta prestes a apagar remonta a uma variavel vazia ou nao resolvida, o agente para e o apresenta para sua aprovacao em vez de executar.

## Intencao, nao uma proibicao geral

Essa e a mesma linha de design que o Claude Code tracou na [v2.1.183, que bloqueou os comandos destrutivos de Git e IaC que o agente decidia executar por conta propria](/pt-br/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/). Um `rm -rf ./build` deliberado que voce pediu continua rodando sem perguntar. A protecao dispara no caso especifico em que o destino expandido e muito mais amplo do que a intencao, porque uma variavel ficou vazia.

Antes da semana 28, o modo automatico avaliava `rm -rf "$BUILD_DIR/bin"` pela string de superficie, que se le como uma exclusao local e delimitada. Depois dela, a verificacao acontece contra o que o shell realmente vai remover, entao um `$BUILD_DIR` vazio transforma um sinal verde em uma pergunta.

## O resto da semana 28

O mesmo lote de versoes reforca o modo automatico contra a adulteracao da transcricao (o agente nao pode mais reescrever silenciosamente o proprio historico de sessao), transforma o `/doctor` em uma verificacao completa de configuracao que diagnostica e pode corrigir problemas, com `/checkup` como alias, e refaz a visao `claude agents` para que cada linha mostre uma palavra de estado colorida e um titulo escrito por um classificador em vez da saida crua das ferramentas. O aplicativo de desktop tambem ganhou um navegador integrado nesta semana, entao o Claude pode abrir documentacao e designs do mesmo jeito que ja controla as previas do seu servidor de desenvolvimento local.

Se voce roda agentes no modo automatico contra repositorios reais ou checkouts de CI, esse e o tipo de protecao que voce so percebe no dia em que ela te salva. As notas completas estao no [changelog do Claude Code](https://code.claude.com/docs/en/changelog).
