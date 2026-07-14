---
title: "Claude Code 2.1.208 permite remapear jj para Escape no modo de inserção do vim"
description: "Claude Code 2.1.208 (14 de julho de 2026) adiciona vimInsertModeRemaps, para que usuários de vim possam mapear sequências de duas teclas do modo de inserção como jj para Escape no editor de prompts. Além de um modo de leitor de tela e um wrapper de processos corporativo."
pubDate: 2026-07-14
tags:
  - "claude-code"
  - "ai-agents"
  - "vim"
  - "productivity"
lang: "pt-br"
translationOf: "2026/07/claude-code-2-1-208-vim-insert-mode-remaps-jj-to-escape"
translatedBy: "claude"
translationDate: 2026-07-14
---

O Claude Code 2.1.208 foi lançado em 14 de julho de 2026, e escondida em uma versão que é em sua maior parte correções de bugs está uma pequena melhoria de qualidade de vida que os usuários de vim vêm reconstruindo na mão há duas décadas: `vimInsertModeRemaps`. Ela permite mapear uma sequência de duas teclas do modo de inserção como `jj` para Escape, para que você possa sair do modo de inserção sem esticar a mão até a tecla Escape de verdade.

## Por que jj para Escape é memória muscular

Se você usa vim, quase com certeza tem isto na sua configuração:

```vim
inoremap jj <Esc>
```

O motivo é ergonômico. O Escape fica no canto distante do teclado, e esticar a mão até ele dezenas de vezes por minuto quebra o seu fluxo. Como `jj` é um dígrafo que quase nunca aparece em prosa ou código, remapeá-lo para Escape permite que seus dedos permaneçam na linha central. Digite `j` duas vezes em rápida sucessão e você volta ao modo normal.

O Claude Code já tinha um modo de edição vim para sua entrada de prompts há algum tempo, ativado com `/vim` ou definido de forma permanente nas configurações. O que faltava era alguma forma de configurar os escapes do modo de inserção. Se seus dedos esperavam que `jj` funcionasse, você obtinha dois caracteres `j` literais no seu prompt em vez disso. A versão 2.1.208 fecha essa lacuna.

## Como ativar

A configuração fica no seu `settings.json` do Claude Code. Ative o modo vim e depois declare os remapeamentos:

```json
{
  "editorMode": "vim",
  "vimInsertModeRemaps": {
    "jj": "escape"
  }
}
```

O mecanismo corresponde ao comportamento do vim que você já conhece: as duas teclas precisam chegar em rápida sucessão para contar como a sequência. Digite `j` sozinha e faça uma pausa, e ela permanece uma `j` literal. É isso que torna `jj`, `jk` ou `kj` escolhas seguras. Elas quase nunca ocorrem naturalmente, então o remapeamento não engole caracteres que você realmente queria digitar. Escolha o par que suas mãos aprenderam com o seu vimrc existente.

Isto é uma conveniência do editor de prompts, não um sistema geral de mapeamento de teclas. Ele mapeia sequências do modo de inserção para Escape para que você possa voltar ao modo normal e usar os movimentos do vim para editar um prompt longo antes de enviá-lo. Se você redige instruções de vários parágrafos para um agente, é exatamente ali que estava o atrito.

## Mais duas coisas na 2.1.208

A mesma versão adiciona um modo de leitor de tela: uma renderização em texto puro opcional para usuários de leitores de tela, ativada com `claude --ax-screen-reader`, a variável de ambiente `CLAUDE_AX_SCREEN_READER=1`, ou `"axScreenReader": true` nas configurações.

Para ambientes corporativos restritos, a 2.1.208 introduz `CLAUDE_CODE_PROCESS_WRAPPER`. A visão do agente e o serviço em segundo plano agora roteiam cada auto-geração do Claude Code através de um wrapper executável obrigatório, para que uma organização possa impor seu próprio lançador sobre os processos que o Claude Code inicia por conta própria.

O restante da versão são cerca de 32 correções em janelas de contexto, conexões HTTP/2, operações de arquivos, sandboxing e renderização de tabelas de markdown. Mas `vimInsertModeRemaps` é a que vai fazer um usuário de vim sorrir. As notas completas estão no [changelog do Claude Code](https://code.claude.com/docs/en/changelog).
