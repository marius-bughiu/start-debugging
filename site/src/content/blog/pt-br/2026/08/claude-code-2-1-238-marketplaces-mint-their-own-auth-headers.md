---
title: "Claude Code 2.1.238 deixa um marketplace de plugins gerar os próprios cabeçalhos de autenticação"
description: "Um campo headersHelper nos marketplaces url e nas entradas do catálogo executa um comando local que imprime cabeçalhos HTTP, então um catálogo interno de plugins atrás do S3 ou de um repositório de artefatos pode se autenticar com um token de curta duração. Aqui estão o esquema, a mensagem de consentimento e os nomes de cabeçalho que o Claude Code descarta."
pubDate: 2026-08-23
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
  - "security"
lang: "pt-br"
translationOf: "2026/08/claude-code-2-1-238-marketplaces-mint-their-own-auth-headers"
translatedBy: "claude"
translationDate: 2026-08-23
---

Distribuir plugins internos do Claude Code obrigava a hospedar um repositório git no qual o cliente já conseguisse se autenticar. O Claude Code 2.1.238, publicado no npm em 2026-08-20, remove essa restrição: um marketplace agora pode executar um comando local que imprime cabeçalhos HTTP, e esses cabeçalhos vão junto no download do catálogo e no dos plugins. Verifiquei o esquema contra o build de Windows 2.1.239 (commit `9bf8e95`, compilado em 2026-08-21), onde `headersHelper` aparece pela primeira vez nos esquemas de marketplace e de catálogo. No 2.1.224 o campo existia apenas nas definições de servidores MCP.

## Um comando, um objeto JSON de cabeçalhos

O campo fica em um marketplace com origem `url`, ao lado do mapa estático `headers` que já existia:

```json
{
  "source": {
    "source": "url",
    "url": "https://artifacts.internal/claude/marketplace.json",
    "headersHelper": "/usr/local/bin/mint-artifact-token"
  }
}
```

O comando imprime um objeto JSON, a saída dele tem prioridade sobre `headers` e ele é executado de novo a cada atualização daquele marketplace. Dois detalhes doem na prática. Ele roda a partir de um diretório fixo, o diretório de configuração do Claude e não o diretório de trabalho da sessão, então use um comando resolvível no `PATH` ou um caminho absoluto. E os cabeçalhos dele são herdados pelos downloads de arquivos da mesma origem, que é o que torna esse mecanismo útil com a origem de plugin `archive`: um zip simples via HTTPS no S3, GitLab ou nginx, sem git nem npm no cliente. Combine com `sha256` na entrada, que é verificado a cada download e recusa a instalação em caso de divergência.

## Helpers por entrada precisam embutir o manifesto

Uma entrada do catálogo pode carregar o próprio `headersHelper`, que tem prioridade sobre o do marketplace. Esse só roda quando o usuário instala ou atualiza o plugin explicitamente, nunca ao navegar pelo catálogo, e vem com uma regra na qual você vai esbarrar de imediato se ignorá-la:

```text
Plugin "internal-tools" sets headersHelper but is not "strict": false. An entry
with headersHelper must inline its full manifest (strict: false, with
commands/agents/hooks/mcpServers declared in the entry) so users can review what
it ships before the command runs
```

O consentimento precisa ser informado a partir da própria entrada, antes de qualquer comando rodar. Na instalação você vê o destino e o comando literal: "runs a local command and sends its output as headers to:", seguido da URL e da linha de comando. `claude plugin install -y` aceita o comando exibido sem o prompt, e é obrigatório quando stdin não é um TTY.

## Cabeçalhos que você não pode forjar

Nem todo nome de cabeçalho sobrevive. Qualquer um declarado fora das configurações gerenciadas pelo operador é filtrado contra uma lista de bloqueio que cobre `host`, `cookie`, `forwarded`, `connection`, `transfer-encoding`, `content-length`, `via`, a família de IP do cliente (`x-real-ip`, `true-client-ip`, `cf-connecting-ip` e companhia) e os prefixos `x-forwarded-`, `x-original-` e `proxy-`. Os nomes primeiro passam para minúsculas e os underscores são normalizados para hifens, então `X_Real_IP` não escapa. Um cabeçalho descartado registra um aviso em vez de derrubar o download.

Administradores podem desligar o mecanismo inteiro com `disableCommandPluginSources` ou `allowManagedHooksOnly` nas configurações gerenciadas, e nesse caso a instalação é recusada e o comando nunca roda. É a mesma trajetória de [carregar plugins a partir de arquivos .zip no 2.1.128](/pt-br/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/): menos suposições sobre o que o seu cliente consegue alcançar. O [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) tem a entrada da versão; a [documentação de marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) ainda não alcançou.
