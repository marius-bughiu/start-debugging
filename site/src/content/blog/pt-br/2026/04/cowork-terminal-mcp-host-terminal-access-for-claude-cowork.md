---
title: "cowork-terminal-mcp: acesso ao terminal do host para Claude Cowork em um único servidor MCP"
description: "cowork-terminal-mcp v0.4.1 conecta a VM isolada do Claude Cowork à shell do seu host. Uma ferramenta, transporte stdio, Git Bash fixado por caminho absoluto no Windows."
pubDate: 2026-04-29
tags:
  - "mcp"
  - "claude-cowork"
  - "claude-code"
  - "ai-coding-agents"
lang: "pt-br"
translationOf: "2026/04/cowork-terminal-mcp-host-terminal-access-for-claude-cowork"
translatedBy: "claude"
translationDate: 2026-04-29
---

[Claude Cowork](https://www.anthropic.com/claude-cowork) roda dentro de uma VM Linux isolada na sua máquina. Esse isolamento é o que torna confortável deixar o Cowork rodando sem supervisão, mas também significa que o agente não consegue instalar as dependências do seu projeto, compilar seu código ou fazer push de um commit no repositório do host por conta própria. Sem uma ponte, o agente para no limite do sistema de arquivos da VM. [`cowork-terminal-mcp`](https://github.com/marius-bughiu/cowork-terminal-mcp) v0.4.1 é essa ponte: um servidor [MCP](https://modelcontextprotocol.io/) de propósito único que roda no host, expõe uma única ferramenta (`execute_command`) e nada mais. No total são cerca de 200 linhas de TypeScript e ele é distribuído no npm como [`cowork-terminal-mcp`](https://www.npmjs.com/package/cowork-terminal-mcp).

## A única ferramenta que o servidor expõe

`execute_command` é toda a superfície. Seu schema Zod fica em [`src/tools/execute-command.ts`](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/src/tools/execute-command.ts) e aceita quatro parâmetros:

| Parâmetro | Tipo                       | Padrão               | Descrição                                                    |
|-----------|----------------------------|----------------------|--------------------------------------------------------------|
| `command` | `string`                   | obrigatório          | O comando bash a ser executado                               |
| `cwd`     | `string`                   | diretório home       | Diretório de trabalho (prefira-o em vez de `cd <path> &&`)   |
| `timeout` | `number`                   | `30000` ms           | Por quanto tempo esperar antes de abortar a execução         |
| `env`     | `Record<string, string>`   | herdado              | Variáveis de ambiente extras sobrepostas a `process.env`     |

Retorna um objeto JSON com `stdout`, `stderr`, `exitCode` e `timedOut`. A saída é limitada a 1MB por stream, com um sufixo `[stdout truncated at 1MB]` (ou `stderr`) quando o limite é atingido.

Por que uma única ferramenta? Porque toda solicitação de "liste os arquivos", "rode os testes" ou "o que diz o git status" se reduz a um comando de shell. Uma segunda ferramenta seria apenas um wrapper mais fino sobre o mesmo `spawn`. O catálogo MCP fica pequeno, o modelo não escolhe a ferramenta errada e a superfície de ataque do host fica trivial de auditar.

## Como conectar ao Claude Cowork

Claude Cowork lê servidores MCP da configuração do **Claude Desktop** e os encaminha para sua VM isolada. O arquivo de configuração fica em um de três lugares:

- **Windows (instalação pela Microsoft Store):** `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
- **Windows (instalação padrão):** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

A configuração mínima:

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "npx",
      "args": ["-y", "cowork-terminal-mcp"]
    }
  }
}
```

No Windows, envolva o comando em `cmd /c` para que `npx` resolva corretamente (Claude Desktop dispara comandos por meio de uma camada compatível com PowerShell que nem sempre encontra os shims do npm):

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "cowork-terminal-mcp"]
    }
  }
}
```

Para usuários do Claude Code CLI, o mesmo servidor também funciona como uma rota de fuga até o terminal do host e é registrado em uma linha:

```bash
claude mcp add cowork-terminal -- npx -y cowork-terminal-mcp
```

O único pré-requisito é o bash. No macOS e no Linux a shell do sistema basta. No Windows é preciso ter o [Git for Windows](https://git-scm.com/download/win) instalado, e o servidor é opinativo sobre qual `bash.exe` ele aceita, que é o próximo ponto interessante.

## A armadilha do Git Bash no Windows

`spawn("bash")` no Windows parece inocente e quase sempre está errado. A ordem do PATH do Windows coloca `C:\Windows\System32` perto do início, e `System32\bash.exe` existe na maioria das instalações modernas do Windows. Esse binário é o launcher do WSL. Quando o servidor MCP entrega um comando para ele, o comando roda dentro de uma VM Linux que não enxerga o sistema de arquivos do Windows como o host enxerga, não consegue ler o `PATH` do Windows e não consegue executar arquivos `.exe` do Windows. O sintoma visível é curioso: `dotnet --version` retorna "command not found" mesmo com o SDK do .NET claramente instalado e no `PATH`. O mesmo vale para `node`, `npm`, `git` e cada ferramenta nativa do Windows que o agente tenta usar.

`cowork-terminal-mcp` resolve isso na inicialização. `resolveBashPath()` ignora completamente a busca no PATH no Windows e percorre uma lista fixa de locais de instalação do Git Bash:

```typescript
const candidates = [
  path.join(programFiles, "Git", "bin", "bash.exe"),
  path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
];
```

O primeiro candidato que `existsSync` confirmar vence, e o caminho absoluto resolvido é o que vai para `spawn`. Se nenhum existir, o servidor lança uma exceção no carregamento do módulo com um erro que lista cada caminho verificado e aponta para `https://git-scm.com/download/win`. Não há fallback para o bash do System32 e não há degradação silenciosa.

A lição mais ampla: no Windows, "confiar no PATH" é um tiro no pé sempre que o comportamento de um binário específico importa. Resolva por caminho absoluto ou falhe ruidosamente. A correção saiu na v0.4.1 explicitamente porque havia usuários vendo o agente insistir que `dotnet` estava faltando em máquinas onde claramente estava instalado.

## Timeouts, limites de saída e a regra de uma única shell

No executor aparecem mais três escolhas, todas deliberadas.

**AbortController em vez de um timeout de shell.** Quando um comando excede seu `timeout`, o servidor não envolve a invocação do bash em `timeout 30s ...`. Ele chama `abortController.abort()`, o que o Node.js traduz em matar o processo. O filho emite um evento `error` cujo `name` é `AbortError`, o handler limpa o timer e a ferramenta resolve com `exitCode: null` e `timedOut: true`:

```typescript
const timer = setTimeout(() => {
  abortController.abort();
}, options.timeout);

child.on("error", (error) => {
  clearTimeout(timer);
  if (error.name === "AbortError") {
    resolve({ stdout, stderr, exitCode: null, timedOut: true });
  } else {
    reject(error);
  }
});
```

Isso mantém a maquinaria do timeout fora da string de comando do usuário e se comporta de forma idêntica no Windows e no Unix.

**Limite de 1MB, por stream, embutido.** `stdout` e `stderr` são acumulados em strings do JavaScript, mas cada evento `data` é condicionado a `length < MAX_OUTPUT_SIZE` (1.048.576 bytes). Quando o limite é atingido, dados adicionais são descartados e uma flag é ativada. A string de resultado final ganha o sufixo `[stdout truncated at 1MB]`. Esse é o custo de fazer buffer em vez de streaming: o modelo recebe um resultado estruturado e limpo, mas `tail -f some.log` não é um caso de uso para o qual esse servidor foi feito. Um `npm test` ou `dotnet build` típico cabe tranquilamente.

**A shell é bash, ponto final.** v0.3.0 tinha um parâmetro `shell` que deixava o modelo escolher `cmd` no Windows. v0.4.0 removeu. A razão está enterrada no [CHANGELOG](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/CHANGELOG.md): as regras de aspas duplas do `cmd.exe` truncam silenciosamente strings multilinha na primeira quebra de linha, então os corpos de heredoc que o modelo enviava através do `cmd` colapsavam para a primeira linha. O modelo achava que o comando havia rodado com o corpo que ele construiu; o bash do outro lado discordava. Remover a opção saiu mais barato do que ensinar o modelo a sempre escolher bash. Também é por isso que a descrição da ferramenta (em `src/tools/execute-command.ts`) empurra ativamente o modelo para usar heredocs:

```
gh pr create --title "My PR" --body "$(cat <<'EOF'
## Summary

- First item
- Second item
EOF
)"
```

Os caracteres `\n` na string `command` do JSON são decodificados em quebras de linha reais antes do bash vê-las, e a semântica de heredoc do bash dá conta do resto.

## Sem PTY, por design

O processo filho é disparado com `stdio: ["ignore", "pipe", "pipe"]`, sem pseudo-terminal. Não há como anexar a um prompt em execução, não há sinalização de largura de terminal, não há negociação de cor por padrão. Para comandos de build, instalação de pacotes, git e execução de testes, isso está ótimo; o modelo recebe uma saída limpa sem escapes ANSI atrapalhando. Para `vim`, `top`, `lldb` ou qualquer REPL que espere uma TTY interativa, essa é a ferramenta errada. O servidor não tenta fingir uma.

Essa concessão é deliberada. Um servidor MCP baseado em PTY precisaria de streaming, de um protocolo de saída parcial e de semântica de E/S interativa que o próprio MCP ainda não modela bem. `cowork-terminal-mcp` permanece dentro do limite onde a execução de comandos one-shot realmente encaixa no protocolo.

## Quando essa é a ponte certa

`cowork-terminal-mcp` é pequeno de propósito. Uma ferramenta, só stdio, resolução de bash que falha alto, limites de saída deliberados, sem escolha de shell, sem PTY. Se você roda Claude Cowork no Windows e quer que ele de fato execute coisas no host, essa é a ponte que faz o limite do sandbox parar de incomodar. Se você já usa o Claude Code CLI, é um recurso extra barato de manter registrado para o dia em que um workflow precisar sair da ferramenta `Bash` embutida do modelo. O código-fonte e as issues estão em [github.com/marius-bughiu/cowork-terminal-mcp](https://github.com/marius-bughiu/cowork-terminal-mcp); o pacote está no npm em [cowork-terminal-mcp](https://www.npmjs.com/package/cowork-terminal-mcp).
