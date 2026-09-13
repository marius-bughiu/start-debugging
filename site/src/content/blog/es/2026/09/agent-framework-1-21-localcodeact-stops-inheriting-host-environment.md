---
title: "Agent Framework 1.21: LocalCodeAct deja de entregar el entorno de tu host al Python escrito por el modelo"
description: "Microsoft Agent Framework .NET 1.21.0 incluye Microsoft.Agents.AI.LocalCodeAct 1.21.0-preview.260911.1, que ya no permite que el subproceso Python de CodeAct herede el entorno del proceso padre cuando Environment es null. En 1.20, el código generado podía leer todas las variables del host, incluidas las API keys."
pubDate: 2026-09-13
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "codeact"
  - "security"
lang: "es"
translationOf: "2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment"
translatedBy: "claude"
translationDate: 2026-09-13
---

Microsoft Agent Framework [dotnet-1.21.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.21.0) se publicó el 2026-09-11, y una línea de su changelog merece más atención de la que va a recibir: "[BREAKING] .NET: Isolate LocalCodeAct subprocess environment" ([PR #8159](https://github.com/microsoft/agent-framework/pull/8159)). Si usas `Microsoft.Agents.AI.LocalCodeAct` y nunca configuraste `LocalCodeActProviderOptions.Environment`, el Python que escribe tu modelo podía leer todas las variables de entorno del proceso host hasta esta versión.

## Dos documentaciones, un solo comportamiento

`LocalCodeAct` es el hermano sin sandbox del proveedor CodeAct de Hyperlight: el modelo escribe Python y el paquete lo ejecuta en un proceso hijo `python` en el host después de una pasada de validación del AST. El README del paquete ya prometía que el subproceso "does NOT inherit the host environment by default". La documentación XML de `Environment` decía lo contrario: `null` significa heredar, y hay que pasar un diccionario vacío para obtener un entorno limpio. El código seguía la documentación XML. `ProcessBridge.ConfigureEnvironment` retornaba antes de tiempo cuando el diccionario era `null`, así que `ProcessStartInfo` conservaba todo el entorno del proceso padre.

Esto importa porque el validador permite a propósito el acceso de solo lectura a `os.environ`. Así que esto pasaba la validación en 1.20:

```csharp
Environment.SetEnvironmentVariable("FAKE_OPENAI_API_KEY", "sk-leaked-from-host");

var fn = new LocalExecuteCodeFunction("/opt/homebrew/bin/python3.14");
var result = await fn.InvokeAsync(new AIFunctionArguments
{
    ["code"] = "import os\nprint(os.environ.get('FAKE_OPENAI_API_KEY', 'NOT_FOUND'))\nprint(len(os.environ))",
});
```

Ejecuté exactamente esa prueba como una aplicación basada en archivo de .NET 10 (SDK 10.0.302, macOS, Python 3.14) contra ambas versiones del paquete:

```text
1.20.0-preview.260831.1  default options   -> sk-leaked-from-host, 63 variables
1.21.0-preview.260911.1  default options   -> NOT_FOUND, 2 variables
both versions            Environment set   -> NOT_FOUND, 3 variables
```

Todo lo que imprime `execute_code` vuelve directamente al contexto del modelo. Una instrucción inyectada en el prompt para "imprimir el entorno" bastaba para meter tu clave de OpenAI, una cadena de conexión de almacenamiento o `AZURE_CLIENT_SECRET` en la transcripción, y de ahí en cualquier herramienta del host que el agente pueda llamar.

## Qué hace ahora 1.21

`ConfigureEnvironment` ahora siempre llama a `startInfo.Environment.Clear()` y luego copia solo lo que pongas en `Environment`. `null` y un diccionario vacío se comportan igual. En Windows, `SYSTEMROOT`, `SYSTEMDRIVE`, `COMSPEC`, `PATHEXT`, `TEMP` y `TMP` se rellenan desde el proceso padre si no los configuraste, porque Python no puede cargar su biblioteca estándar sin ellos.

La otra cara es que desaparece todo aquello de lo que tu código generado dependía de forma implícita, incluidos `PATH` y `HOME` en Linux y macOS. Si un script montado o un módulo permitido necesita una variable, pásala de forma explícita:

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

Mantén los secretos fuera de ese diccionario. Si el código generado necesita hacer una llamada autenticada, registra una herramienta del host que guarde la credencial y deja que el Python llegue a ella mediante `await call_tool(...)`.

## Dos cambios relacionados de LocalCodeAct en la misma versión

[PR #8239](https://github.com/microsoft/agent-framework/pull/8239) endurece el validador para que los alias derivados del sistema operativo, el acceso por reflexión y la mutación del entorno se rechacen de forma consistente, y [PR #8289](https://github.com/microsoft/agent-framework/pull/8289) alinea las aprobaciones con Hyperlight: si alguna herramienta registrada es una `ApprovalRequiredAIFunction`, el propio `execute_code` requiere aprobación, y `LocalCodeActApprovalMode.AlwaysRequire` la exige en cada ejecución.

Nada de esto convierte a `LocalCodeAct` en un sandbox, y el README lo sigue diciendo en un recuadro de advertencia. Su lugar es dentro de un contenedor, una VM o un agente hospedado en Foundry. Si todavía estás decidiendo si el código escrito por el modelo vale ese esfuerzo de configuración, comparé las ventajas y desventajas en [CodeAct frente a un bucle tradicional de llamadas a herramientas](/2026/07/codeact-vs-tool-calling-loop-for-agents/). Si ya lo usas, actualiza a `1.21.0-preview.260911.1` y revisa lo que pasas en `Environment`.
