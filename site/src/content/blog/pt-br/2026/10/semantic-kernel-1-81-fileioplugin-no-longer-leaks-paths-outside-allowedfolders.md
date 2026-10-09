---
title: "Semantic Kernel 1.81 impede que o FileIOPlugin vaze arquivos fora de AllowedFolders"
description: "O Semantic Kernel .NET 1.81.0 corrige um oráculo no FileIOPlugin: WriteAsync dizia ao modelo que um arquivo fora de AllowedFolders existia, era somente leitura e onde ficava. Medido antes e depois."
pubDate: 2026-10-09
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "pt-br"
translationOf: "2026/10/semantic-kernel-1-81-fileioplugin-no-longer-leaks-paths-outside-allowedfolders"
translatedBy: "claude"
translationDate: 2026-10-09
---

O Semantic Kernel .NET [1.81.0](https://github.com/microsoft/semantic-kernel/releases/tag/dotnet-1.81.0) saiu em 6 de outubro de 2026, com o `Microsoft.SemanticKernel.Plugins.Core` 1.81.0-preview no NuGet no mesmo dia. As notas de versão descrevem o [PR #14525](https://github.com/microsoft/semantic-kernel/pull/14525) como "Update file handling for FileIOPlugin", o que subestima a mudança. Até a 1.80.1, o `FileIOPlugin.WriteAsync` verificava se um arquivo era somente leitura *antes* de verificar `AllowedFolders`, e a exceção lançada incluía o caminho canônico completo. Se você expõe esse plugin a um modelo, isso é um oráculo de existência de arquivos para o disco inteiro.

Esta é a segunda rodada seguida de endurecimento de arquivos e rede, depois que a [1.80.0 impediu que plugins OpenAPI seguissem redirecionamentos](/pt-br/2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects/).

## O que o modelo conseguia descobrir na 1.80.1

Rodei o mesmo teste baseado em arquivo contra as duas versões no SDK 10.0.302. Ele cria um `secrets.txt` somente leitura fora da pasta permitida, um `nope.txt` inexistente ao lado dele e um `locked.txt` somente leitura dentro da pasta permitida, e então chama `WriteAsync` em cada um:

```csharp
#:package Microsoft.SemanticKernel.Plugins.Core@1.80.1-preview
#:property PublishAot=false
#:property NoWarn=SKEXP0050
using Microsoft.SemanticKernel.Plugins.Core;

// allowed, readOnlyOutside, missingOutside, readOnlyInside: temp paths set up earlier
var plugin = new FileIOPlugin { AllowedFolders = [allowed], DisableFileOverwrite = false };

foreach (var f in new[] { readOnlyOutside, missingOutside, readOnlyInside })
{
    try { await plugin.WriteAsync(f, "y"); }
    catch (Exception e) { Console.WriteLine($"{Path.GetFileName(f)}: {e.GetType().Name}: {e.Message}"); }
}
```

Saída na 1.80.1-preview (caminho temporário encurtado):

```text
secrets.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/outside/secrets.txt
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/allowed/locked.txt
```

As duas primeiras linhas são o problema. Um arquivo fora do sandbox recebe uma exceção diferente da de um arquivo inexistente, então a existência é observável. O mesmo acontece com um `new FileIOPlugin()` padrão cujo `AllowedFolders` está vazio, a configuração documentada como "nenhuma pasta permitida".

Essa mensagem chega, sim, ao modelo. Com chamada automática de funções, o `FunctionCallsProcessor` captura a exceção e retorna `Error: Exception while invoking function. {e.Message}` como resultado da ferramenta. Um agente sob prompt injection pode sondar caminhos no estilo `~/.ssh/id_rsa` ou `/etc/shadow` e ler a resposta.

## O que muda na 1.81.0

O `TryGetAllowedFilePath` agora retorna `false` imediatamente quando nenhuma pasta está configurada, envolve a canonicalização do caminho em um catch para `IOException`, `UnauthorizedAccessException`, `InvalidOperationException` e `SecurityException` (assim loops de symlink e erros de permissão viram uma negação simples) e só executa a verificação de somente leitura depois que o caminho corresponde a uma pasta permitida. A exceção de somente leitura também perdeu o caminho. O mesmo teste na 1.81.0-preview:

```text
secrets.txt: InvalidOperationException: Writing to the provided location is not allowed.
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only.
```

Fora do sandbox, todos os casos agora são indistinguíveis. Dentro dele, você ainda recebe um erro útil, sem o caminho. O [PR #14476](https://github.com/microsoft/semantic-kernel/pull/14476), também na 1.81.0, aplica o mesmo alinhamento de validação ao `DocumentPlugin` e ao `CloudDrivePlugin`.

## O que fazer

Atualize o `Microsoft.SemanticKernel.Plugins.Core` para `1.81.0-preview` se algum agente puder chamar o `FileIOPlugin`. A API pública não mudou, então é só uma troca de versão. Se você encapsula ferramentas de arquivo próprias, copie o padrão: verifique o sandbox primeiro, faça toda negação retornar a mesma mensagem e nunca coloque um caminho resolvido em uma exceção que um resultado de ferramenta possa levar de volta ao modelo.
