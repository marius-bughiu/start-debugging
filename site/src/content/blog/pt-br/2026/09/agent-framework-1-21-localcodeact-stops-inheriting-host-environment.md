---
title: "Agent Framework 1.21: LocalCodeAct deixa de entregar o ambiente do host ao Python escrito pelo modelo"
description: "O Microsoft Agent Framework .NET 1.21.0 traz o Microsoft.Agents.AI.LocalCodeAct 1.21.0-preview.260911.1, que não permite mais que o subprocesso Python do CodeAct herde o ambiente do processo pai quando Environment é null. Na 1.20, o código gerado podia ler todas as variáveis do host, incluindo chaves de API."
pubDate: 2026-09-13
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "codeact"
  - "security"
lang: "pt-br"
translationOf: "2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment"
translatedBy: "claude"
translationDate: 2026-09-13
---

O Microsoft Agent Framework [dotnet-1.21.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.21.0) foi lançado em 11 de setembro de 2026, e uma linha do changelog merece mais atenção do que vai receber: "[BREAKING] .NET: Isolate LocalCodeAct subprocess environment" ([PR #8159](https://github.com/microsoft/agent-framework/pull/8159)). Se você usa o `Microsoft.Agents.AI.LocalCodeAct` e nunca define `LocalCodeActProviderOptions.Environment`, o Python que o seu modelo escreve podia ler todas as variáveis de ambiente do processo host até esta versão.

## Duas documentações, um comportamento

O `LocalCodeAct` é o irmão sem sandbox do provedor CodeAct do Hyperlight: o modelo escreve Python, e o pacote o executa em um processo filho `python` no host depois de uma validação da AST. O README do pacote já prometia que o subprocesso "does NOT inherit the host environment by default". A documentação XML de `Environment` dizia o contrário: `null` significa herdar, e para um ambiente limpo é preciso passar um dicionário vazio. O código seguia a documentação XML. `ProcessBridge.ConfigureEnvironment` retornava cedo quando o dicionário era `null`, então o `ProcessStartInfo` mantinha o ambiente completo do processo pai.

Isso importa porque o validador permite de propósito o acesso somente leitura a `os.environ`. Então isto passava na validação na 1.20:

```csharp
Environment.SetEnvironmentVariable("FAKE_OPENAI_API_KEY", "sk-leaked-from-host");

var fn = new LocalExecuteCodeFunction("/opt/homebrew/bin/python3.14");
var result = await fn.InvokeAsync(new AIFunctionArguments
{
    ["code"] = "import os\nprint(os.environ.get('FAKE_OPENAI_API_KEY', 'NOT_FOUND'))\nprint(len(os.environ))",
});
```

Executei exatamente esse teste como um app baseado em arquivo do .NET 10 (SDK 10.0.302, macOS, Python 3.14) contra as duas versões do pacote:

```text
1.20.0-preview.260831.1  default options   -> sk-leaked-from-host, 63 variables
1.21.0-preview.260911.1  default options   -> NOT_FOUND, 2 variables
both versions            Environment set   -> NOT_FOUND, 3 variables
```

Tudo o que o `execute_code` imprime volta direto para o contexto do modelo. Uma instrução injetada via prompt para "imprimir o ambiente" bastava para colocar a sua chave da OpenAI, uma connection string de storage ou o `AZURE_CLIENT_SECRET` na transcrição, e dali para qualquer ferramenta do host que o agente possa chamar.

## O que a 1.21 faz agora

`ConfigureEnvironment` agora sempre chama `startInfo.Environment.Clear()` e depois copia apenas o que você colocou em `Environment`. `null` e um dicionário vazio se comportam da mesma forma. No Windows, `SYSTEMROOT`, `SYSTEMDRIVE`, `COMSPEC`, `PATHEXT`, `TEMP` e `TMP` são preenchidos a partir do processo pai se você não os definiu, porque o Python não consegue carregar a biblioteca padrão sem eles.

O outro lado é que tudo aquilo de que o seu código gerado dependia implicitamente desapareceu, incluindo `PATH` e `HOME` no Linux e no macOS. Se um script montado ou um módulo permitido precisa de uma variável, passe-a explicitamente:

```csharp
using Microsoft.Agents.AI.LocalCodeAct;

using var provider = new LocalCodeActProvider("/usr/bin/python3", new LocalCodeActProviderOptions
{
    Environment = new Dictionary<string, string>
    {
        ["LOG_LEVEL"] = "INFO",
        ["TZ"] = "UTC",
    },
});
```

Mantenha segredos fora desse dicionário. Se o código gerado precisa fazer uma chamada autenticada, registre uma ferramenta do host que guarde a credencial e deixe o Python acessá-la por meio de `await call_tool(...)`.

## Duas mudanças relacionadas ao LocalCodeAct na mesma versão

O [PR #8239](https://github.com/microsoft/agent-framework/pull/8239) endurece o validador para que aliases derivados do sistema operacional, acesso por reflexão e mutação do ambiente sejam rejeitados de forma consistente, e o [PR #8289](https://github.com/microsoft/agent-framework/pull/8289) alinha as aprovações com o Hyperlight: se qualquer ferramenta registrada for uma `ApprovalRequiredAIFunction`, o próprio `execute_code` exige aprovação, e `LocalCodeActApprovalMode.AlwaysRequire` a força em toda execução.

Nada disso transforma o `LocalCodeAct` em uma sandbox, e o README continua dizendo isso em uma caixa de aviso. O lugar dele é dentro de um contêiner, uma VM ou um agente hospedado no Foundry. Se você ainda está decidindo se código escrito pelo modelo vale essa configuração, comparei os prós e contras em [CodeAct vs um loop tradicional de chamada de ferramentas](/2026/07/codeact-vs-tool-calling-loop-for-agents/). Se você já o executa, atualize para `1.21.0-preview.260911.1` e revise o que você passa em `Environment`.
