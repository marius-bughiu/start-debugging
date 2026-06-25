---
title: "Claude Code 2.1.187 impede o sandbox de ler suas chaves da AWS"
description: "A nova opção sandbox.credentials no Claude Code v2.1.187 nega a leitura de arquivos de credenciais e remove variáveis de ambiente secretas antes que comandos Bash rodem no sandbox. Veja por que a política de leitura padrão era uma brecha, e como fechá-la."
pubDate: 2026-06-25
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
lang: "pt-br"
translationOf: "2026/06/claude-code-sandbox-credentials-block-secrets-from-bash"
translatedBy: "claude"
translationDate: 2026-06-25
---

O sandbox de Bash do Claude Code sempre teve uma assimetria que incomoda assim que você lê as letras miúdas: ele bloqueia as escritas com rigor, mas as leituras ficam totalmente abertas. A partir da v2.1.187, lançada em 2026-06-24, finalmente existe uma solução de primeira classe. A nova opção `sandbox.credentials` nega a leitura de arquivos de credenciais específicos e remove variáveis de ambiente secretas antes que qualquer comando rode no sandbox.

## Por que a política de leitura padrão era uma brecha

O sandbox restringe as escritas ao diretório de trabalho e ao diretório temporário da sessão, e roteia o tráfego de rede por um proxy com lista de permitidos. Mas seu comportamento de leitura padrão é "acesso de leitura ao computador inteiro, exceto a certos diretórios negados". Isso inclui explicitamente `~/.aws/credentials` e `~/.ssh/`. Além disso, os comandos Bash no sandbox herdam o ambiente do processo pai, então um `GITHUB_TOKEN` ou `NPM_TOKEN` exportado no seu shell fica visível para cada comando que o Claude roda.

Isso importa porque o lado da rede não é hermético. O proxy integrado toma sua decisão de permissão pelo nome de host enviado pelo cliente e não inspeciona TLS. Permita um domínio amplo como `github.com` e um comando comprometido ou com injeção de prompt terá uma via de exfiltração plausível. Acesso de leitura às suas chaves mais um canal de saída utilizável é exatamente a combinação que você não quer em um agente rodando sem supervisão.

## Como o sandbox.credentials funciona

O novo bloco tem dois arrays, `files` e `envVars`. Os arquivos listados são negados para leitura dentro do sandbox, a mesma aplicação que o `filesystem.denyRead` faz, e as variáveis de ambiente listadas são removidas antes que cada comando do sandbox seja executado.

```json
{
  "sandbox": {
    "enabled": true,
    "credentials": {
      "files": [
        { "path": "~/.aws/credentials", "mode": "deny" },
        { "path": "~/.ssh", "mode": "deny" }
      ],
      "envVars": [
        { "name": "GITHUB_TOKEN", "mode": "deny" },
        { "name": "NPM_TOKEN", "mode": "deny" }
      ]
    }
  }
}
```

Cada entrada carrega `"mode": "deny"`, atualmente o único valor suportado. O campo explícito mantém o esquema aberto para modos futuros. Os caminhos de arquivo seguem as mesmas regras de prefixo do resto de `sandbox.filesystem.*`: `~/` é o seu diretório home, `/` é absoluto e um caminho sem prefixo é relativo ao projeto.

## Por que o bloco dedicado, e não apenas denyRead

Você já podia negar a leitura de credenciais com `filesystem.denyRead`. O propósito do novo bloco é que ele agrupa as negações de arquivos com a remoção de variáveis de ambiente e as combina entre todos os escopos de configuração. As entradas das configurações de usuário, de projeto e gerenciada são combinadas, e como `deny` é o único modo, qualquer escopo pode adicionar restrições mas nenhum pode removê-las.

Isso o torna uma alavanca limpa para implantações gerenciadas. Envie do seu MDM as negações de `~/.aws` e `~/.ssh` mais a remoção de tokens, e os desenvolvedores não conseguirão ampliá-las localmente. Combina naturalmente com uma política restrita: `enabled: true`, `failIfUnavailable: true` e `allowUnsandboxedCommands: false`.

## Duas ressalvas que vale conhecer

Não há lista de negação integrada. Apenas os arquivos e as variáveis que você nomear são restringidos, então uma configuração vazia não protege nada. A opção também afeta apenas os comandos Bash no sandbox. Para remover as credenciais da Anthropic e dos provedores de nuvem de todos os subprocessos, independentemente do sandbox, configure em vez disso a variável de ambiente `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.

Se você roda o Claude Code em modo auto-allow contra um repositório no qual não confia totalmente, esta é a opção para adicionar hoje. Todos os detalhes estão na [documentação do sandbox](https://code.claude.com/docs/en/sandboxing).
