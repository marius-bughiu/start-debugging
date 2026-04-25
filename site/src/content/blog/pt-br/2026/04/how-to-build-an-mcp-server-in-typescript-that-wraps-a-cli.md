---
title: "Como criar um servidor MCP personalizado em TypeScript que envolve uma CLI"
description: "Guia passo a passo para envolver qualquer ferramenta de linha de comando como um servidor Model Context Protocol usando o SDK TypeScript 1.29. Cobre a armadilha do stdout, padrões de child_process, propagação de erros, e um servidor git completo e funcional."
pubDate: 2026-04-24
tags:
  - "mcp"
  - "ai-agents"
  - "typescript"
  - "claude-code"
lang: "pt-br"
translationOf: "2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli"
translatedBy: "claude"
translationDate: 2026-04-25
---

A maneira mais rápida de dar a um agente de IA acesso a uma ferramenta de linha de comando é envolvê-la como um servidor Model Context Protocol (MCP). O agente chama uma ferramenta tipada, seu servidor invoca a CLI por subprocesso, captura a saída, e a retorna como uma resposta estruturada -- sem API REST, sem bindings de SDK, sem webhooks necessários.

Este guia constrói esse wrapper do zero usando `@modelcontextprotocol/sdk` 1.29.0 e Node 18+. Ao final você terá um servidor `git-mcp` funcional que expõe `git log` e `git diff` como ferramentas chamáveis, conectado ao Claude Desktop via transporte stdio. Cobre cada detalhe que quebra wrappers de CLI em produção.

## Por que "envolver a CLI" é a primeira jogada certa

A maioria do tooling interno existe somente como CLI: scripts de implantação, executores de migração de banco de dados, exportadores de log de auditoria, pipelines de processamento de imagem. Eles não têm API, não têm superfície gRPC, nada que um agente possa chamar diretamente. Envolvê-los como ferramentas MCP leva 50-100 linhas de TypeScript e produz uma interface descobrível e validada por schema que qualquer cliente compatível com MCP pode usar, incluindo Claude Code, Claude Desktop, Cursor, e qualquer cliente que fale a [especificação MCP (2025-03-26)](https://spec.modelcontextprotocol.io).

A alternativa -- embutir a chamada da CLI dentro de um system prompt ou descrição de ferramenta -- é frágil. Argumentos ficam mutilados, tratamento de erros desaparece, e o agente não consegue distinguir um timeout de uma flag ruim. Um servidor MCP adequado conserta tudo isso.

## Configuração do projeto

Você precisa do Node.js 18 ou posterior. Crie o diretório do projeto e instale as dependências:

```bash
mkdir git-mcp
cd git-mcp
npm init -y
npm install @modelcontextprotocol/sdk@1.29.0 zod@3
npm install -D @types/node typescript
```

Adicione dois campos ao `package.json` e um script de build. O campo `"type": "module"` diz ao Node para tratar arquivos `.js` como módulos ES, o que o SDK exige:

```json
{
  "type": "module",
  "bin": {
    "git-mcp": "./build/index.js"
  },
  "scripts": {
    "build": "tsc && chmod +x build/index.js"
  },
  "files": ["build"]
}
```

Crie `tsconfig.json` na raiz do projeto:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

Crie o arquivo de origem:

```bash
mkdir src
touch src/index.ts
```

## A armadilha do stdout que mata todo servidor MCP stdio

Antes de escrever uma única linha de lógica de negócio, grave esta regra: **nunca chame `console.log()` dentro de um servidor MCP stdio**.

Quando você executa seu servidor sob o transporte stdio, o cliente MCP se comunica com ele sobre `stdin`/`stdout` usando mensagens JSON-RPC. Quaisquer bytes que você escrever no `stdout` fora do protocolo JSON-RPC corrompem o stream de mensagens. O cliente verá JSON malformado, falhará em parsear uma resposta, e desconectará -- geralmente com um erro críptico "MCP server disconnected" que não aponta para perto da sua aparente inocente declaração de debug.

```typescript
// @modelcontextprotocol/sdk 1.29.0, MCP spec 2025-03-26

// Bad -- corrupts the JSON-RPC stream
console.log("Running git log...");

// Good -- stderr is not part of the stdio transport
console.error("Running git log...");
```

Use `console.error()` para cada linha de diagnóstico. Ele escreve em `stderr`, que o cliente MCP ou ignora ou mostra separadamente. Isto não é um caso extremo -- tropeça quase todos os autores iniciantes de servidores MCP.

## O executor da CLI

Adicione um helper tipado que cria um subprocesso, coleta stdout e stderr, e resolve com um resultado estruturado. Usar `spawn` em vez de `exec` evita o limite de buffer padrão de 1 MB que `exec` impõe:

```typescript
// src/index.ts
// @modelcontextprotocol/sdk 1.29.0, Node 18+

import { spawn } from "child_process";

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30_000
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(command, args, {
      cwd,
      shell: false, // never pass shell: true with untrusted input
      timeout: timeoutMs,
    });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}
```

Dois pontos valem a pena destacar:

- `shell: false` não é opcional se qualquer parte dos argumentos vier do LLM. Com `shell: true` um argumento como `--format=%H; rm -rf /` vira uma injeção de shell. Sempre passe argumentos como um array e deixe o `spawn` cuidar do escape.
- O timeout se propaga via a opção `timeout` do `child_process` do Node, que envia `SIGTERM` após o prazo. Adicione um fallback `SIGKILL` se a CLI ignorar `SIGTERM`.

## Registrando as ferramentas

Agora conecte duas ferramentas `git`. A primeira, `git_log`, retorna os últimos N commits de um repo. A segunda, `git_diff`, retorna o diff não staged:

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "git-mcp",
  version: "1.0.0",
});

server.registerTool(
  "git_log",
  {
    description:
      "Return the last N commits for a git repository. " +
      "Includes hash, author, date, and subject line.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      count: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Number of commits to return"),
    },
  },
  async ({ repo, count }) => {
    const result = await runCli(
      "git",
      ["log", `--max-count=${count}`, "--pretty=format:%H|%an|%ad|%s", "--date=iso"],
      repo
    );

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git log failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.stdout || "(no commits)" }],
    };
  }
);

server.registerTool(
  "git_diff",
  {
    description:
      "Return the unstaged diff for a git repository, or the diff for a specific file.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      file: z
        .string()
        .optional()
        .describe("Optional relative path to a specific file"),
      staged: z
        .boolean()
        .default(false)
        .describe("If true, show staged (cached) diff instead of unstaged"),
    },
  },
  async ({ repo, file, staged }) => {
    const args = ["diff"];
    if (staged) args.push("--cached");
    if (file) args.push("--", file);

    const result = await runCli("git", args, repo);

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git diff failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: result.stdout || "(no changes)" },
      ],
    };
  }
);
```

Algumas coisas a prestar atenção nos handlers das ferramentas:

- O `inputSchema` usa schemas Zod diretamente. O SDK os converte para JSON Schema para a validação de chamadas de ferramenta do cliente. Se você passar um objeto JSON Schema simples, perde a semântica de `.default()` e `.optional()`.
- Retorne `isError: true` junto ao conteúdo quando a CLI sair com código diferente de zero. Isso diz ao cliente que a invocação falhou sem lançar uma exceção que crasharia o servidor.
- Mantenha o parâmetro `repo` como um caminho absoluto que o cliente deve fornecer. Não tente inferir de `process.cwd()` -- o diretório de trabalho do servidor é onde quer que o cliente MCP o tenha lançado, que quase nunca é o repo do usuário.

## Conectando o transporte e iniciando o servidor

Adicione o ponto de entrada principal no final de `src/index.ts`:

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0, stdio transport

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("git-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

Compile e verifique que compila:

```bash
npm run build
```

## Conectando ao Claude Desktop

Abra a configuração do Claude Desktop. No macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. No Windows: `%AppData%\Claude\claude_desktop_config.json`.

Adicione seu servidor sob `mcpServers`:

```json
{
  "mcpServers": {
    "git-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/git-mcp/build/index.js"]
    }
  }
}
```

Reinicie o Claude Desktop. O ícone de martelo na barra de ferramentas deve aparecer mostrando `git_log` e `git_diff` como ferramentas disponíveis. Agora você pode pedir ao Claude: "Mostre-me os últimos 10 commits em /Users/me/projects/myrepo" e ele chamará `git_log` diretamente.

Para conectar ao Claude Code, adicione o mesmo bloco às suas configurações MCP do Claude Code (`.claude/settings.json` sob `mcpServers`), ou execute `claude mcp add git-mcp -- node /path/to/build/index.js` do terminal.

## Detalhes a observar em wrappers de CLI em produção

**Truncamento de saída grande.** Algumas CLIs produzem megabytes de saída (`git diff` em uma refatoração grande, `ps aux`, um dump SQL completo). A especificação MCP não impõe um limite rígido de tamanho de conteúdo, mas clientes têm limites práticos. Adicione uma proteção `maxBytes` em `runCli` e retorne um aviso de truncamento:

```typescript
const MAX_BYTES = 512_000; // 500 KB

// after collecting chunks:
const raw = Buffer.concat(chunks);
const text =
  raw.byteLength > MAX_BYTES
    ? raw.slice(0, MAX_BYTES).toString("utf8") + "\n\n[output truncated]"
    : raw.toString("utf8");
```

**Busca de PATH no Windows.** No Windows, `spawn("git", ...)` com `shell: false` pode falhar se `git` não estiver no PATH que o cliente MCP herda. Use o caminho completo ao executável, ou crie um wrapper `cmd.exe /c git ...` (com sanitização adequada de argumentos). Alternativamente, resolva o caminho do executável na inicialização usando o pacote npm `which` e cacheie o resultado.

**Timeout em operações lentas.** `git log` em um repo com 500.000 commits pode levar vários segundos. Ajuste `timeoutMs` por ferramenta em vez de usar um padrão global. Exponha-o como parâmetro opcional se o tamanho do repo do usuário for imprevisível.

**Mensagens de erro do stderr.** Muitas CLIs escrevem erros de uso no stderr com código de saída 0 (um mau hábito conhecido). Verifique `result.stderr` mesmo quando `exitCode === 0` e mostre-o na resposta da ferramenta junto ao conteúdo do stdout.

**Sem globbing do shell.** Com `shell: false`, globs como `*.ts` em um argumento não são expandidos pelo shell. Se sua CLI espera expansão de glob, ou enumere os arquivos você mesmo (usando `glob` do npm) ou aceite somente caminhos explícitos no schema da ferramenta.

## Testando sem um cliente

Instale `@modelcontextprotocol/inspector` globalmente para testar o servidor interativamente sem configurar um cliente MCP completo:

```bash
npm install -g @modelcontextprotocol/inspector
npx @modelcontextprotocol/inspector node build/index.js
```

O inspector abre uma UI no navegador onde você pode listar ferramentas, preencher argumentos, e chamá-las diretamente. Também mostra as mensagens JSON-RPC brutas, o que torna trivial diagnosticar o problema de corrupção de stdout -- você pode ver os bytes lixo aterrissarem no stream imediatamente.

## O que expor a seguir

Duas ferramentas é uma fatia fina. O mesmo padrão escala para qualquer CLI da qual sua equipe dependa:

- Exponha `git blame`, `git show`, e `git grep` para construir um agente de arqueologia de código.
- Envolva `aws s3 ls` e `aws cloudformation describe-stacks` para um agente com consciência de infraestrutura.
- Exponha `sqlite3 :memory: .schema` ou `psql \d tablename` para deixar um agente inspecionar um schema de banco de dados antes de escrever consultas.
- Envolva uma CLI interna personalizada para implantação, criação de tickets, ou exportação de log -- coisas que viveram somente em scripts de shell porque "ninguém precisava de uma API para elas."

O servidor MCP não se importa com o que a CLI faz. Ele só precisa de um schema de entrada bem definido (que o Zod te dá em 3 linhas) e um handler que execute o binário e retorne a saída.

Se sua equipe usa C# em vez de TypeScript, o mesmo padrão está disponível via o [pacote NuGet ModelContextProtocol, que cobrimos ao conectar servidores MCP em .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/). Para uma visão mais ampla de como o MCP fica quando uma IDE o empacota diretamente, [o Azure MCP Server entregue dentro do Visual Studio 2022 17.14.30](/pt-br/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) é um exemplo útil do mundo real da escala que este protocolo mira. E se você está construindo agentes autônomos que coordenam múltiplas ferramentas e precisa de um framework além do MCP cru, [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) cobre o lado do C#. E para integração de agentes em nível de IDE, [agent skills no Visual Studio 2026 18.5](/pt-br/2026/04/visual-studio-2026-copilot-agent-skills/) mostram como o Copilot autodescobre definições de skills do `SKILL.md` do seu repo.

## Links de origem

- [MCP TypeScript SDK -- modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP spec (2025-03-26)](https://spec.modelcontextprotocol.io)
- [Official build-server guide -- modelcontextprotocol.io](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP Inspector -- @modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)
