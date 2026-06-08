---
title: "O plugin security-guidance do Claude Code revisa os próprios diffs antes de você fazer commit"
description: "A Anthropic lançou um plugin gratuito security-guidance para o Claude Code que escaneia as próprias edições do agente em busca de vulnerabilidades em três camadas, de uma correspondência de padrões sem custo a uma revisão agêntica no commit."
pubDate: 2026-06-08
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
lang: "pt-br"
translationOf: "2026/06/claude-code-security-guidance-plugin-reviews-its-own-diffs"
translatedBy: "claude"
translationDate: 2026-06-08
---

A Anthropic lançou no fim de maio de 2026 um [plugin security-guidance](https://code.claude.com/docs/en/security-guidance) gratuito para o Claude Code que faz algo que a maioria das configurações de IA para programar ignora: faz o agente revisar os próprios diffs em busca de vulnerabilidades enquanto trabalha e então corrigir o que encontra na mesma sessão. A proposta é simples. O bug de segurança mais barato de corrigir é aquele que nunca chega ao pull request, e um revisor separado, sem compromisso com a abordagem original, detecta mais do que o modelo que escreveu o código.

## Três camadas, das quais só uma consome tokens

O plugin roda em três pontos, cada um com uma profundidade diferente.

O primeiro dispara a cada `Edit`, `Write` ou `NotebookEdit`. É uma correspondência de padrões determinística sem chamada ao modelo, então não adiciona nenhum custo de uso. Ele sinaliza construções arriscadas no momento em que surgem:

- Execução dinâmica: `eval(`, `new Function`, `os.system`, `child_process.exec`
- Desserialização insegura: `pickle`
- Injeção no DOM: `dangerouslySetInnerHTML`, `.innerHTML =`, `document.write`
- Edições em `.github/workflows/`, que podem conceder permissões no nível do repositório de forma silenciosa

Cada aviso dispara uma vez por padrão, por arquivo e por sessão, então não inunda a conversa.

A segunda camada roda no fim de cada turno. O plugin faz um diff de tudo que mudou na árvore de trabalho, incluindo edições do Bash e de subagentes, e o entrega a uma revisão separada do Claude focada em segurança. É aqui que a correspondência de strings não alcança: bypass de autorização, referências diretas a objetos inseguras, SSRF, criptografia fraca. Roda em segundo plano, cobre até 30 arquivos alterados e dispara no máximo três vezes seguidas.

A terceira camada é acionada quando o Claude executa `git commit` ou `git push` por meio da ferramenta Bash. Esta é agêntica: lê os chamadores, os saneadores e os arquivos relacionados para decidir se um achado é real antes de reportá-lo, o que mantém baixos os falsos positivos em código que parece perigoso isoladamente mas é seguro no contexto. É limitada a 20 revisões por hora móvel. Commits que você roda no seu próprio shell não são revisados.

Ambas as camadas baseadas no modelo usam o Claude Opus 4.7 como revisor por padrão.

## Instalação e extensão

Você precisa do Claude Code 2.1.144 ou posterior e do Python 3.8 no seu `PATH`. Instale a partir do marketplace oficial:

```text
/plugin install security-guidance@claude-plugins-official
/reload-plugins
```

A camada por edição é extensível sem tocar no modelo. Coloque um `.claude/security-patterns.yaml` no seu repositório e adicione suas próprias regras:

```yaml
patterns:
  - rule_name: tenant_unfiltered_query
    regex: "\\.objects\\.all\\(\\)"
    paths: ["**/src/tenants/**"]
    reminder: "Multi-tenant code must filter by org_id."
```

Nenhuma das três camadas bloqueia escritas ou commits. Os achados chegam ao Claude que escreve como instruções, e o revisor ainda pode deixar coisas passar. Trate-o como uma camada de defesa em profundidade: ele fica dentro da sessão, à frente do `/security-review` sob demanda e da revisão de código completa no pull request. Para os eventos de hook exatos e os interruptores por variável de ambiente, a [documentação do plugin](https://code.claude.com/docs/en/security-guidance) detalha tudo.
