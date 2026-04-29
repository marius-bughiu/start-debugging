---
title: "Como adicionar prompt caching a um app do Anthropic SDK e medir a taxa de acerto"
description: "Adicione prompt caching a um app Python ou TypeScript com o Anthropic SDK, posicione os breakpoints de cache_control corretamente e leia cache_read_input_tokens e cache_creation_input_tokens para calcular uma taxa de acerto real. Com a matemática de preços para Claude Sonnet 4.6 e Opus 4.7."
pubDate: 2026-04-29
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "prompt-caching"
  - "claude-code"
lang: "pt-br"
translationOf: "2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate"
translatedBy: "claude"
translationDate: 2026-04-29
---

Se o seu app do Anthropic SDK manda o mesmo system prompt longo ou o mesmo catálogo de ferramentas a cada turno, você está pagando preço cheio de input por tokens que o modelo já viu trinta segundos atrás. O prompt caching corta esses tokens repetidos para **10 por cento do preço base de input** em troca de uma pequena taxa única de escrita. Em um loop de agente com vários turnos e um system prompt de 10k tokens, isso é uma redução de custo de input de 5x a 10x, com cerca de 85ms a menos de latência no prefixo cacheado. A pegadinha: você precisa posicionar os breakpoints de cache_control nos lugares certos e verificar a taxa de acerto com o objeto usage do SDK, porque um breakpoint mal posicionado se degrada silenciosamente para uma chamada de preço cheio.

Este guia caminha pela adição de caching a um app Python ou TypeScript com o Anthropic SDK na API atual (Claude Opus 4.7, Sonnet 4.6, Haiku 4.5), e depois pela medição da taxa real de acerto com um pequeno wrapper. O código foi verificado contra `anthropic` 0.42 (Python) e `@anthropic-ai/sdk` 0.30 (Node), ambos lançados no início de 2026.

## Por que caching não é opcional para loops de agente

Um agente de coding que itera sobre um repositório tipicamente envia:

1. Um system prompt de 5k a 30k tokens (as instruções do agente, descrições de ferramentas, convenções de arquivo).
2. Um histórico de mensagens em crescimento (a requisição do usuário mais chamadas a ferramentas anteriores e resultados de ferramentas).
3. Um novo turno do usuário ou resultado de ferramenta que dispara a próxima resposta.

Sem caching, todo turno re-codifica o prefixo inteiro. No Claude Sonnet 4.6 a $3/MTok de input, um prefixo de 8k tokens custa $0,024 por turno. Uma sessão de 50 turnos é $1,20 só em prefixo refaturado, em cima do trabalho real. Com caching o mesmo prefixo custa $0,0024 por turno cacheado depois da primeira escrita. Mesma resposta, dez por cento da fatura.

O mecanismo está descrito na [documentação oficial de prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching). Você marca um bloco de conteúdo com `cache_control: {"type": "ephemeral"}` e a API trata tudo o que está **antes e incluindo** aquele bloco como uma chave de cache. Na próxima requisição, se o prefixo bater byte por byte, o modelo lê do cache em vez de re-codificar.

O que "byte por byte" realmente significa é a fonte de toda thread no fórum da Anthropic com o título "por que isso não está cacheando". Vamos chegar lá.

## Versões, IDs de modelo e a armadilha do mínimo de tokens

O caching só entra em ação quando o prefixo cacheado ultrapassa um mínimo por modelo:

- **Claude Opus 4.7 (`claude-opus-4-7`)**: 4.096 tokens mínimo.
- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)**: 2.048 tokens mínimo.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)**: 4.096 tokens mínimo.
- **Sonnet 4.5, Opus 4.1, Sonnet 3.7 antigos**: 1.024 tokens mínimo.

Se o seu prefixo for menor que o limite, a requisição ainda tem sucesso, mas `cache_creation_input_tokens` volta como 0 e silenciosamente você está pagando preço cheio de input. Esta é a razão mais comum pela qual desenvolvedores reportam que "o caching não faz nada". Sempre verifique o limite do seu modelo alvo antes.

O SDK Python `anthropic` ganhou suporte nativo a `cache_control` na 0.40 e apertou a tipagem para o detalhamento de usage na 0.42. O SDK Node tem isso desde o `@anthropic-ai/sdk` 0.27. Nenhum beta header é mais necessário, nem para o TTL de 5 minutos nem para o de 1 hora: basta definir `ttl` dentro de `cache_control`.

## Um exemplo Python mínimo com cache_control

O padrão abaixo cacheia um system prompt longo. É o caso de uso mais simples e comum.

```python
# Python 3.11, anthropic 0.42
import anthropic

client = anthropic.Anthropic()

LONG_SYSTEM_PROMPT = open("prompts/system.md").read()  # ~8k tokens

def ask(user_message: str) -> anthropic.types.Message:
    return client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": LONG_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )

first = ask("List the public methods on OrderService.")
second = ask("Now list the private ones.")

print(first.usage)
print(second.usage)
```

O parâmetro `system` precisa ser um **array de blocos de conteúdo** quando você anexa `cache_control`. Passar uma string simples (a forma de conveniência) não permite caching: o SDK não tem onde pôr a flag de cache. Isso pega todo mundo na primeira vez.

A primeira chamada escreve o prefixo no cache. A segunda chamada o lê. Os objetos usage tornam isso visível:

```
# first.usage
{ "cache_creation_input_tokens": 8137, "cache_read_input_tokens": 0,  "input_tokens": 18,  "output_tokens": 124 }
# second.usage
{ "cache_creation_input_tokens": 0,    "cache_read_input_tokens": 8137, "input_tokens": 22, "output_tokens": 156 }
```

Os campos com que você se importa:

- `cache_creation_input_tokens`: tokens escritos no cache nesta requisição, faturados a 1,25x base para o TTL de 5 minutos ou 2,0x para o TTL de 1 hora.
- `cache_read_input_tokens`: tokens lidos do cache, faturados a 0,10x base.
- `input_tokens`: tokens **depois do último cache breakpoint** que não foram elegíveis para caching. Esta é a cauda de mensagem que você fica mudando.

## O mesmo exemplo em TypeScript

O SDK Node tem o mesmo formato. Note que as entradas do array `system` usam literais de objeto puro, não wrappers de classe.

```typescript
// Node 22, @anthropic-ai/sdk 0.30
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const client = new Anthropic();
const SYSTEM = readFileSync("prompts/system.md", "utf8");

async function ask(userMessage: string) {
  return client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });
}

const first = await ask("List the public methods on OrderService.");
const second = await ask("Now list the private ones.");
console.log(first.usage);
console.log(second.usage);
```

Mesmo detalhamento de usage, mesmos preços. Sem ginástica de headers.

## Onde posicionar cache breakpoints em um loop de agente

Um agente de coding não tem só um system prompt longo. Tem um histórico de mensagens longo **e em crescimento** mais um catálogo de ferramentas estático. O ótimo costuma ser três ou quatro breakpoints arrumados do mais estável ao mais volátil.

Você tem até **4 cache breakpoints explícitos** por requisição. A API cacheia tudo antes e incluindo cada bloco marcado, então cada breakpoint cria um prefixo em camadas.

```python
# Python 3.11, anthropic 0.42
client.messages.create(
    model="claude-opus-4-7",
    max_tokens=2048,
    tools=[
        # ... tool schemas ...
        {
            "name": "search_repo",
            "description": "...",
            "input_schema": {"type": "object", "properties": {...}},
            "cache_control": {"type": "ephemeral"},  # breakpoint 1: tools
        },
    ],
    system=[
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},  # breakpoint 2: system
        }
    ],
    messages=[
        # All prior turns...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": stable_repo_summary,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 3: repo state
                }
            ],
        },
        # ... older messages ...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": current_user_turn,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 4: most recent stable point
                }
            ],
        },
    ],
)
```

A regra é "estável por fora, volátil por dentro". Se o seu catálogo de ferramentas muda quando uma feature flag vira, essa mudança invalida toda outra camada atrás dela. Se o seu system prompt embute a data de hoje, toda escrita de cache expira à meia-noite UTC. Tire qualquer coisa dinâmica dos blocos cacheados.

## Medindo a taxa de acerto

O dashboard do fornecedor é bom para uma fatura mensal. Não é bom para tunar um agente em tempo real. Envolva o SDK e agregue os campos de usage você mesmo.

```python
# Python 3.11, anthropic 0.42
from dataclasses import dataclass, field
import anthropic

@dataclass
class CacheStats:
    requests: int = 0
    base_input: int = 0          # uncached
    cache_writes_5m: int = 0
    cache_writes_1h: int = 0
    cache_reads: int = 0
    output: int = 0

    def record(self, usage):
        self.requests += 1
        self.base_input += usage.input_tokens
        self.cache_reads += usage.cache_read_input_tokens or 0
        creation = getattr(usage, "cache_creation", None)
        if creation:
            self.cache_writes_5m += creation.ephemeral_5m_input_tokens or 0
            self.cache_writes_1h += creation.ephemeral_1h_input_tokens or 0
        else:
            self.cache_writes_5m += usage.cache_creation_input_tokens or 0
        self.output += usage.output_tokens

    @property
    def hit_rate(self) -> float:
        cacheable = self.cache_reads + self.cache_writes_5m + self.cache_writes_1h
        return self.cache_reads / cacheable if cacheable else 0.0

    def cost_usd(self, base_input_per_mtok: float, output_per_mtok: float) -> float:
        # Sonnet 4.6: base_input=3.00, output=15.00
        # Opus 4.7:   base_input=15.00, output=75.00
        write_5m = self.cache_writes_5m * base_input_per_mtok * 1.25
        write_1h = self.cache_writes_1h * base_input_per_mtok * 2.0
        reads    = self.cache_reads     * base_input_per_mtok * 0.10
        base     = self.base_input      * base_input_per_mtok
        out      = self.output          * output_per_mtok
        return (write_5m + write_1h + reads + base + out) / 1_000_000

stats = CacheStats()

def cached_call(client, **kwargs):
    response = client.messages.create(**kwargs)
    stats.record(response.usage)
    return response
```

Rode o agente de ponta a ponta e depois imprima a taxa de acerto.

```python
print(f"requests:    {stats.requests}")
print(f"hit rate:    {stats.hit_rate:.1%}")
print(f"cache reads: {stats.cache_reads:,}")
print(f"5m writes:   {stats.cache_writes_5m:,}")
print(f"1h writes:   {stats.cache_writes_1h:,}")
print(f"uncached in: {stats.base_input:,}")
print(f"USD:         ${stats.cost_usd(3.00, 15.00):.4f}")  # Sonnet 4.6 prices
```

Um agente de coding saudável de 50 turnos no Sonnet 4.6 com um system prompt de 8k tipicamente cai em:

- 95-98% de taxa de acerto no bloco do system prompt.
- 70-90% de taxa de acerto no bloco de mensagens dependendo de quão agressivamente você re-prompta.
- 1,5x a 4x menos gasto total que o mesmo agente sem caching.

Se você ver a taxa de acerto travada em 0%, três coisas quase sempre são as culpadas: prefixo abaixo do limite mínimo de tokens, um valor não-determinístico (timestamp, ID aleatório, ordem de dict) embutido no texto cacheado, ou mensagens reordenadas entre turnos.

## O TTL de 1 hora: quando ele se paga

O TTL padrão é de 5 minutos. Para um agente estilo chat tudo bem: cada turno renova o cache, e a pequena taxa de escrita é amortizada sobre muitas leituras.

O TTL de 1 hora custa **2x base de input** para escrever mas dura doze vezes mais. A matemática: se você espera ao menos uma leitura a cada cinco minutos por uma hora, o cache de 5 minutos funciona. Se o seu tráfego é em rajadas (alguém roda o agente a cada 20 minutos), o cache de 5 minutos expira entre turnos e você fica pagando o custo de escrita de novo e de novo. O TTL de 1 hora se paga no momento em que ocorrem duas leituras de cache durante um período ocioso de uma hora.

```python
# Python 3.11, anthropic 0.42 -- mixing TTLs
system=[
    {
        "type": "text",
        "text": STABLE_INSTRUCTIONS,             # the bedrock part
        "cache_control": {"type": "ephemeral", "ttl": "1h"},
    },
    {
        "type": "text",
        "text": SESSION_SCOPED_CONTEXT,          # changes per user session
        "cache_control": {"type": "ephemeral", "ttl": "5m"},
    },
],
```

Ao misturar TTLs, entradas com TTL mais longo precisam aparecer **antes** das de TTL mais curto. Se você inverter, a API rejeita a requisição.

Nenhum beta header é necessário. Os antigos `anthropic-beta: prompt-caching-2024-07-31` e o posterior `extended-cache-ttl-2025-04-11` foram aposentados, embora o SDK ainda os aceite como no-ops por compatibilidade reversa.

## Cinco pegadinhas que destroem a taxa de acerto

**1. Embutir conteúdo não-determinístico.** Um `datetime.now()` no seu system prompt invalida o cache a cada segundo. Suspeitos comuns: timestamps, IDs de requisição, dados de amostra aleatórios injetados por diversidade, serialização JSON que não fixa a ordem das chaves. Se os bytes mudam, o cache erra.

**2. Reordenar ferramentas ou mensagens.** A API faz hash dos bytes em ordem. Ordenar seu array de ferramentas de modo diferente entre chamadas produz um hash diferente. Mantenha uma ordem determinística, idealmente a ordem do seu arquivo de configuração.

**3. Esquecer de trocar system de string para array.** `system="..."` (uma string simples) não aceita `cache_control`. Você precisa usar `system=[{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]`. O SDK não te avisa quando você passa uma string com expectativas de caching.

**4. Cruzar a janela de lookback de 20 blocos.** Um breakpoint só consegue ver 20 blocos de conteúdo antes dele. Em um loop longo de tool-use com muitos blocos tool_result, seu breakpoint perto do começo da conversa eventualmente sai do alcance. Adicione um segundo breakpoint mais próximo do turno atual antes que isso aconteça.

**5. Bater no mesmo cache vindo de organizações ou workspaces diferentes.** Caches são isolados por organização e, desde fevereiro de 2026, também por workspace na API da Anthropic e no Azure. Se você roda dev em um workspace e prod em outro, eles não compartilham prefixos cacheados.

Para um olhar mais profundo no que envolve o Anthropic SDK do lado .NET, veja [Microsoft Agent Framework 1.0 para agentes de IA em C#](/pt-br/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) e [O suporte BYOK do GitHub Copilot para o provider Anthropic no VS Code](/pt-br/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## O que o "caching automático" faz e por que não é suficiente

As versões recentes do SDK adicionaram um parâmetro `cache_control` de nível superior em `messages.create`. Defini-lo diz à API para aplicar caching automaticamente baseado em heurísticas. Funciona, mas escolhe um único breakpoint, e você não controla qual. Para um único system prompt longo tudo bem. Para um loop de agente com catálogos de ferramentas, resumos e histórico de mensagens você quer breakpoints explícitos. O modo automático é melhor tratado como teste de fumaça: ligue uma vez para confirmar que o caching funciona no seu setup, depois passe para blocos `cache_control` explícitos.

Se você também está construindo MCP servers que expõem ferramentas para o mesmo agente, os princípios de layout são os mesmos. Veja [Como construir um MCP server customizado em C# no .NET 11](/pt-br/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), [Como construir um MCP server em TypeScript que envolve um CLI](/pt-br/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) e [Como construir um MCP server customizado em Python com o SDK oficial](/pt-br/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) para o lado servidor. O guia de posicionamento de breakpoints aqui se aplica ao cliente que os chama.

## Uma visão de planilha de quando o caching compensa

Para uma checagem de canto de envelope, pegue o tamanho do prefixo em tokens (`P`), o número de leituras esperadas por escrita (`R`) e o multiplicador de TTL do cache (`m`, onde `m=1.25` para 5m e `m=2.0` para 1h). A contagem de leituras de break-even para um único prefixo cacheado contra a baseline sem cache é:

```
R_breakeven = (m - 1) / (1 - 0.1)
            = (m - 1) / 0.9
```

Isso são **0,28 leituras** para o TTL de 5 minutos e **1,11 leituras** para o TTL de 1 hora. Em outras palavras, o cache de 5 minutos compensa depois de uma única leitura em qualquer cenário realista, e o cache de 1 hora compensa depois da segunda leitura. Não existe essencialmente cenário de loop de agente onde caching seja a escolha errada; a única pergunta é qual TTL escolher.

Para mais sobre padrões de loop de agente que se beneficiam de caching, veja [Como escrever um CLAUDE.md que realmente muda o comportamento do modelo](/pt-br/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) e [Como agendar uma tarefa recorrente do Claude Code que tria issues do GitHub](/pt-br/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/).

## Links de referência

- [Documentação de prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic Python SDK no PyPI](https://pypi.org/project/anthropic/)
- [Anthropic TypeScript SDK no npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [Preços da API Anthropic](https://docs.claude.com/en/docs/about-claude/pricing)
