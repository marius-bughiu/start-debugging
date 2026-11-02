---
title: "C# ¿Cómo esperar a que termine un proceso?"
description: "Espera a un proceso hijo en C# con WaitForExit o WaitForExitAsync. Ejemplo ejecutable con códigos de salida, tiempos de espera, cancelación y limpieza en .NET 8 y 10."
pubDate: 2023-08-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
Usa `process.WaitForExit()` para bloquear el hilo actual hasta que termine un proceso iniciado. En código asíncrono, utiliza `await process.WaitForExitAsync()`; espera sin bloquear el hilo que hace la llamada. Lee `ExitCode` después de que el proceso haya terminado.

> Actualizado el 2 de noviembre de 2026: el ejemplo original con `cmd.exe /C timeout 5` dependía de Windows y de su entorno de comandos. El siguiente inicia su propio proceso hijo y comprueba ambos métodos de espera, los tiempos de espera y la cancelación en .NET 8 y .NET 10.

## Ejecutar el ejemplo completo

[Descarga el proyecto ejecutable process-wait](/examples/process-wait.zip). Descomprímelo y ejecuta estos comandos desde su carpeta con el SDK de .NET 10. El comando de .NET 8 también requiere el runtime de .NET 8:

```sh
dotnet run -c Release -f net10.0
dotnet run -c Release -f net8.0
```

El mismo código se ejecuta en ambos destinos. Inicia copias de sí mismo, sin invocar un intérprete de comandos ni necesitar un ejecutable externo. Los dos primeros procesos hijos devuelven intencionadamente el código de salida `7`; el padre comprueba ese valor y devuelve `0` si todas las comprobaciones pasan. Un tercer hijo espera una entrada, de modo que las comprobaciones del tiempo de espera y la cancelación no dependen de la rapidez con la que termine un comando breve.

Este es el archivo `Program.cs` completo:

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

Salida esperada:

```text
sync exit: 7
async exit: 7
timed wait exited: False
canceled wait; child still running
released child exit: 0
```

## Tiempo de espera, cancelación y limpieza

`WaitForExit(50)` devuelve `false` si el hijo no termina en el número de milisegundos indicado. `WaitForExitAsync(token)` lanza `OperationCanceledException` cuando se cancela la espera. Ninguno de los dos resultados termina el proceso hijo. En este ejemplo, cerrar su entrada permite que termine normalmente; el bloque `finally` solo termina el hijo que pertenece al ejemplo si hace falta limpiar tras un fallo.

En una herramienta real, elige una política de cierre explícita: seguir esperando, solicitar un cierre ordenado mediante su protocolo o terminar el proceso cuando corresponda. `Kill()` solicita una terminación forzada, así que después también debes esperar a que el proceso termine. Liberar un `Process` mediante `Dispose` libera los recursos del componente; no detiene el programa en ejecución.

La [guía de la declaración using en C#](/es/2020/05/c-using-var-using-declaration/) explica cómo `using` controla la liberación de recursos al salir de un ámbito.

Si rediriges la salida estándar o la salida de error, empieza a leer esos flujos antes de esperar al proceso. De lo contrario, una tubería llena puede hacer que el hijo espere al padre mientras el padre espera al hijo. La [guía para capturar la salida de procesos](/es/2026/05/dotnet-11-process-api-deadlock-free-capture/) trata ese problema por separado y las nuevas API de .NET 11; este ejemplo usa API ya disponibles en .NET 8.

Verificado localmente en macOS arm64 con los runtimes reales .NET 8.0.33 y .NET 10.0.10, tanto con el apphost generado como con `dotnet ProcessWait.dll`. Esto no afirma que se haya ejecutado en Windows o Linux; la descarga incluye el registro exacto de verificación.

Referencias de API: [WaitForExit](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit), [WaitForExitAsync](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexitasync) y [Kill](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill).
