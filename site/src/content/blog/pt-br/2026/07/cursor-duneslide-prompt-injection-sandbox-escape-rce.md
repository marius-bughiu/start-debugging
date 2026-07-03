---
title: "DuneSlide: duas falhas do Cursor que transformam injeção de prompt em RCE sem clique"
description: "A Cato AI Labs divulgou CVE-2026-50548 e CVE-2026-50549, um par de falhas com CVSS 9.8 no sandbox de terminal do Cursor. Uma resposta MCP ou um resultado web envenenado pode escapar do sandbox e executar código. O Cursor 3.0 é a correção."
pubDate: 2026-07-03
tags:
  - "cursor"
  - "ai-agents"
  - "security"
  - "prompt-injection"
  - "mcp"
lang: "pt-br"
translationOf: "2026/07/cursor-duneslide-prompt-injection-sandbox-escape-rce"
translatedBy: "claude"
translationDate: 2026-07-03
---

A Cato AI Labs [divulgou nesta semana um par de falhas críticas do Cursor](https://www.catonetworks.com/blog/duneslide-two-critical-rce-vulnerabilities/), rastreadas como CVE-2026-50548 e CVE-2026-50549 e batizadas em conjunto de DuneSlide. Ambas têm pontuação CVSS 9.8, e ambas permitem que um único trecho de texto injetado escape do sandbox de terminal do Cursor e execute comandos arbitrários na sua máquina. Sem clique, sem caixa de diálogo de aprovação, sem nenhum repositório malicioso que você tenha clonado à mão. Todas as versões anteriores ao Cursor 3.0 são afetadas.

O vetor de entrega é o que torna isso digno de atenção mesmo se você não usa o Cursor: injeção de prompt como uma primitiva de execução remota de código. O atacante nunca toca no seu editor. Ele planta instruções em algo que seu agente lê em seu nome, como a resposta de um servidor Model Context Protocol (MCP) ou uma página retornada por uma busca web, e o agente faz o resto.

## O sandbox confiou nos próprios parâmetros do agente

O Cursor executa comandos de shell dentro de um sandbox que restringe as escritas ao diretório do seu projeto. O problema com o CVE-2026-50548 é que a lista de escrita permitida é parcialmente controlada pelo agente. A ferramenta `run_terminal_cmd` aceita um parâmetro opcional `working_directory`, e quando o agente o define, o Cursor adiciona esse caminho ao conjunto de escrita sem questionar.

Então uma instrução injetada pode guiar o modelo para uma chamada com esta forma:

```json
{
  "tool": "run_terminal_cmd",
  "command": "cp payload ~/.zshrc",
  "working_directory": "/Users/you"
}
```

O sandbox vê um diretório de trabalho "legítimo" e concede a escrita. Agora o atacante pode deixar um arquivo no seu diretório home, e `~/.zshrc`, `~/.zshenv` ou `~/Library/LaunchAgents` se tornam execução no seu próximo shell ou login.

## A verificação de symlink falhou deixando passar

O CVE-2026-50549 ataca a proteção diretamente. Antes de escrever, o Cursor canonicaliza os symlinks para confirmar que o destino real fica dentro do seu projeto. A falha está no fallback. Quando a canonicalização falha, porque o destino não existe ou o atacante removeu a permissão de leitura de um diretório do caminho, o Cursor desiste e confia no caminho interno ao projeto do symlink.

Isso é um clássico fail-open. Um symlink somente de escrita apontando para o próprio auxiliar de sandbox do Cursor, `cursorsandbox`, passa pela verificação e permite que um atacante sobrescreva justamente o binário que deveria conter o agente.

## Por que ferramentas de agente "confiáveis" são a nova superfície de ataque

A lição incômoda é que `run_terminal_cmd` não é um usuário digitando comandos. É uma ferramenta que o modelo invoca com argumentos que o modelo escolheu, e esses argumentos vieram de texto que o modelo leu. Uma vez que você aceita que qualquer conteúdo fluindo para a janela de contexto é potencialmente adversário, um parâmetro como `working_directory` deixa de parecer configuração e começa a parecer entrada do atacante.

Ambas as falhas estão corrigidas no [Cursor 3.0](https://www.catonetworks.com/blog/duneslide-two-critical-rce-vulnerabilities/), então a correção imediata é atualizar e confirmar que você está na 3.0 ou posterior. A lição mais duradoura sobrevive ao patch: trate a saída de MCP e o conteúdo web obtido como não confiáveis, e limite as permissões das ferramentas do agente como se o prompt já estivesse comprometido, porque o DuneSlide mostra que pode estar.
