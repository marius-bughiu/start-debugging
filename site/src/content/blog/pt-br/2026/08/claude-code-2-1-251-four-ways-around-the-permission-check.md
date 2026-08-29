---
title: "Claude Code 2.1.251 fecha quatro formas de contornar a verificação de permissão"
description: "Um symlink trocado depois da verificação, regras deny que deixavam de valer através de um caminho de busca com symlink, um comando de marketplace apontando para fora do seu plugin e um script de workflow lido antes da aprovação. Quatro correções em uma versão, todas o mesmo bug."
pubDate: 2026-08-29
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
  - "devops"
lang: "pt-br"
translationOf: "2026/08/claude-code-2-1-251-four-ways-around-the-permission-check"
translatedBy: "claude"
translationDate: 2026-08-29
---

O Claude Code 2.1.251 saiu em 28 de agosto de 2026 com um changelog longo o bastante para enterrar a parte interessante. Quatro das suas correções têm o mesmo formato: algo alcançou um arquivo que a verificação de permissão não havia aprovado. Lidas juntas, deixam de parecer quatro bugs e passam a parecer uma única classe.

## A verificação passou, e então o caminho mudou

A correção principal é uma corrida clássica entre o momento da verificação e o momento do uso. Segundo o changelog, as ferramentas de arquivo "seguiam um symlink trocado dentro do diretório de trabalho depois da verificação de permissão" e podiam "ler ou escrever fora do local aprovado". Você aprova uma edição em `src/config.ts`, o caminho é resolvido, a verificação diz sim — e entre esse sim e a escrita, a entrada vira um symlink apontando para outro lugar.

O que vale internalizar é quem consegue fazer essa troca. Um script `postinstall`, um file watcher, um servidor de desenvolvimento, um runner de testes ou o próprio comando Bash anterior do agente rodam enquanto a sessão está aberta. O diretório de trabalho não é um lugar tranquilo, e nunca foi um lugar confiável.

Grep e Glob tinham a versão de leitura do mesmo buraco: as regras deny de `Read(...)` não eram aplicadas a arquivos alcançados através de um caminho de busca com symlink. Uma regra deny em `secrets/**` valia numa leitura direta e silenciosamente deixava de valer quando o mesmo arquivo era encontrado por um symlink apontando para dentro.

## Dois caminhos que vieram da configuração, não de você

Os outros dois entraram por arquivos que viajam junto com o repositório. Comandos de plugin declarados em uma entrada de marketplace podiam apontar para fora do diretório do plugin; esses caminhos agora são rejeitados com um erro explícito de path traversal. E a ferramenta Workflow lia um `scriptPath` fora do que a sessão tinha permissão de ler *antes* de a verificação de permissão rodar — e depois citava o conteúdo na mensagem de erro, o que transforma uma leitura bloqueada em uma leitura bem-sucedida.

## A mesma versão continua apertando as configurações

Meia dúzia de outras mudanças no 2.1.251 apontam na mesma direção, todas tratando um repositório clonado como entrada não confiável:

- Configurações de projeto não podem mais ligar o tracing beta detalhado nem o log de corpos de API crus. Isso eram os seus corpos de requisição.
- `ANTHROPIC_CUSTOM_HEADERS` vindo de configurações gerenciadas ou de projeto agora precisa de aprovação quando define um cabeçalho de credencial, de organização/tenant, de roteamento ou de comportamento de API, como `Authorization` ou `Host`.
- O `env` do `.claude/settings.json` no nível de projeto não define mais `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR` nem `TMPDIR`/`TMP`/`TEMP` — defina-os no seu shell ou nas configurações de usuário ou gerenciadas.
- As verificações de permissão do Bash pararam de aprovar automaticamente atribuições de uma expressão aritmética a uma variável inteira de shell (`OPTIND=1/0`, `RANDOM=2+2`), que passavam como inofensivas.
- Configurações gerenciadas pelo servidor que terminam o TLS do sandbox, roteiam seu tráfego por um proxy, injetam credenciais ou enfraquecem o isolamento do sandbox agora exigem aprovação antes de valer.

Nenhuma delas é um exploit dramático sozinha. Juntas, fecham a distância entre "o sistema de permissões disse não" e "o arquivo continuou sem ser lido".

## Atualizando

`claude update`, ou reinstale pelo npm. Duas notas da mesma semana: o 2.1.250 saiu no mesmo dia e traz apenas correções de bugs, e o 2.1.248 (27 de agosto) adicionou `--restricted` — equivalentemente `CLAUDE_CODE_RESTRICTED=1` — que remove as ferramentas que executam comandos ou código, tira o `WebFetch` a menos que você o nomeie em `--tools`, mantém as ferramentas de arquivo dentro do diretório de trabalho, recusa `bypassPermissions` e ignora por completo os arquivos de configuração de usuário, de projeto e locais. Esse flag e as correções desta semana são o mesmo argumento por dois lados: as configurações e os caminhos que um repositório te entrega são entrada, não configuração.

A correção do marketplace em particular chega uma semana depois de o 2.1.238 dar alcance real aos catálogos, [permitindo que um marketplace de plugins emita seus próprios cabeçalhos de autenticação](/pt-br/2026/08/claude-code-2-1-238-marketplaces-mint-their-own-auth-headers/) — quanto mais uma entrada de marketplace pode fazer, mais o limite de diretório em volta dela precisa aguentar.
