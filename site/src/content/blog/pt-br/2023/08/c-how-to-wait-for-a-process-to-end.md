---
title: "C# como esperar um processo terminar?"
description: "Espere um processo filho em C# com WaitForExit ou WaitForExitAsync. Exemplo executável com códigos de saída, timeout, cancelamento e limpeza no .NET 8 e 10."
pubDate: 2023-08-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
Use `process.WaitForExit()` para bloquear a thread atual até que um processo iniciado termine. Em código assíncrono, use `await process.WaitForExitAsync()`; ele espera sem bloquear a thread que faz a chamada. Leia `ExitCode` depois que o processo terminar.

> Atualizado em 2 de novembro de 2026: o exemplo original com `cmd.exe /C timeout 5` dependia do Windows e de seu ambiente de comandos. A versão abaixo inicia seu próprio processo filho e verifica os dois métodos de espera, os timeouts e o cancelamento no .NET 8 e no .NET 10.

## Executar o exemplo completo

[Baixe o projeto executável process-wait](/examples/process-wait.zip). Extraia o arquivo e execute estes comandos na pasta do projeto com o SDK do .NET 10. O comando do .NET 8 também precisa do runtime do .NET 8:

```sh
dotnet run -c Release -f net10.0
dotnet run -c Release -f net8.0
```

O mesmo código roda nos dois destinos. Ele inicia cópias de si mesmo, sem chamar um shell nem exigir um executável externo. Os dois primeiros processos filhos retornam o código de saída `7` de propósito; o processo pai verifica esse valor e retorna `0` se todas as verificações passarem. Um terceiro filho espera uma entrada, de modo que as verificações de timeout e cancelamento não dependem da rapidez com que um comando curto termina.

Este é o arquivo `Program.cs` completo:

```cs
using System.Diagnostics;
using System.Reflection;

if (args is ["--child"])
{
    await Task.Delay(100);
    return 7;
}

if (args is ["--child-until-input"])
{
    await Console.In.ReadLineAsync();
    return 0;
}

using (var process = StartChild("--child"))
{
    process.WaitForExit();
    Require(process.ExitCode == 7, "Synchronous child exit code.");
    Console.WriteLine($"sync exit: {process.ExitCode}");
}

using (var process = StartChild("--child"))
{
    await process.WaitForExitAsync();
    Require(process.ExitCode == 7, "Asynchronous child exit code.");
    Console.WriteLine($"async exit: {process.ExitCode}");
}

using (var process = StartChild("--child-until-input"))
{
    try
    {
        bool exited = process.WaitForExit(50);
        Require(!exited, "A timed-out wait must leave the child running.");
        Console.WriteLine($"timed wait exited: {exited}");

        using var cancellation = new CancellationTokenSource(50);
        bool canceled = false;
        try
        {
            await process.WaitForExitAsync(cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            canceled = true;
        }

        Require(canceled && !process.HasExited, "Canceling the wait must not kill the child.");
        Console.WriteLine("canceled wait; child still running");

        process.StandardInput.Close();
        await process.WaitForExitAsync();
        Require(process.ExitCode == 0, "The released child must exit normally.");
        Console.WriteLine($"released child exit: {process.ExitCode}");
    }
    finally
    {
        if (!process.HasExited)
        {
            try { process.Kill(); }
            catch (InvalidOperationException) when (process.HasExited) { }
            await process.WaitForExitAsync();
        }
    }
}

return 0;

static Process StartChild(string mode)
{
    var start = new ProcessStartInfo
    {
        FileName = Environment.ProcessPath ?? throw new InvalidOperationException("No process path."),
        UseShellExecute = false,
        RedirectStandardInput = mode == "--child-until-input"
    };

    if (string.Equals(Path.GetFileNameWithoutExtension(start.FileName), "dotnet", StringComparison.OrdinalIgnoreCase))
        start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);

    start.ArgumentList.Add(mode);
    return Process.Start(start) ?? throw new InvalidOperationException("Child did not start.");
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
```

Saída esperada:

```text
sync exit: 7
async exit: 7
timed wait exited: False
canceled wait; child still running
released child exit: 0
```

## Timeout, cancelamento e limpeza

`WaitForExit(50)` retorna `false` se o filho não terminar dentro do número de milissegundos informado. `WaitForExitAsync(token)` lança `OperationCanceledException` quando a espera é cancelada. Nenhum desses resultados termina o processo filho. No exemplo, fechar a entrada do filho permite que ele termine normalmente; o bloco `finally` só termina o filho criado pelo exemplo se for necessário fazer a limpeza após uma falha.

Para uma ferramenta real, escolha uma política de encerramento explícita: continuar esperando, solicitar um encerramento normal pelo protocolo da ferramenta ou terminar o processo quando for apropriado. `Kill()` solicita a terminação forçada, portanto ainda é preciso esperar o processo terminar depois disso. Liberar um `Process` com `Dispose` libera os recursos do componente; não interrompe o programa em execução.

O [guia da declaração using em C#](/pt-br/2020/05/c-using-var-using-declaration/) explica como `using` controla a liberação dos recursos ao sair de um escopo.

Se você redirecionar a saída padrão ou a saída de erro, comece a ler esses fluxos antes de esperar o processo terminar. Caso contrário, um pipe cheio pode deixar o filho esperando pelo pai enquanto o pai espera pelo filho. O [guia de captura de saída de processos](/pt-br/2026/05/dotnet-11-process-api-deadlock-free-capture/) trata desse outro problema e das novas APIs do .NET 11; este exemplo usa APIs que já existem no .NET 8.

Verificado localmente no macOS arm64 com os runtimes reais .NET 8.0.33 e .NET 10.0.10, tanto com o apphost gerado quanto com `dotnet ProcessWait.dll`. Isso não significa que tenha sido executado no Windows ou no Linux; o download inclui o registro exato de verificação.

Referências de API: [WaitForExit](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit), [WaitForExitAsync](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexitasync) e [Kill](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill).
