---
title: "Aspire 13.5 pone una terminal real dentro del dashboard"
description: "WithTerminal() da a un recurso una sesión PTY interactiva en la que puedes escribir desde el dashboard o a la que puedes conectarte desde tu propia shell. Es experimental, desengancha el depurador y la opción Shell contra la que quizá escribiste ya no existe."
pubDate: 2026-08-28
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "tooling"
lang: "es"
translationOf: "2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard"
translatedBy: "claude"
translationDate: 2026-08-28
---

[Aspire 13.5 llegó el 18 de agosto de 2026](https://devblogs.microsoft.com/aspire/whats-new-aspire-13-5/) con un dashboard rediseñado, los AppHost de TypeScript pasando a GA y una docena de cambios que rompen compatibilidad. El que de verdad cambia el ciclo de desarrollo es más pequeño que todos ellos: `WithTerminal()`, que da a un recurso una pseudo-terminal viva en la que puedes escribir desde el dashboard en lugar de solo leer su log de consola.

## Una llamada, y el recurso obtiene una PTY

```csharp
#pragma warning disable ASPIRETERMINAL001
var agent = builder.AddExecutable("agent", "my-agent", ".")
    .WithTerminal();
#pragma warning restore ASPIRETERMINAL001
```

La API es experimental, así que la llamada lanza `ASPIRETERMINAL001` y tu AppHost no compilará hasta que lo reconozcas, ya sea con el pragma de arriba o añadiendo el ID a `<NoWarn>`. Una vez activo, la página Console Logs del recurso en el dashboard gana una vista de terminal junto al flujo de logs habitual, y los recursos en ejecución abren esa vista por defecto.

La sobrecarga con opciones cubre la geometría de la rejilla:

```csharp
.WithTerminal(options =>
{
    options.Columns = 200;  // por defecto 120
    options.Rows = 50;      // por defecto 30
});
```

Ambos valores deben ser 1 o mayores; cero o negativo lanza `ArgumentOutOfRangeException`. La tercera opción, `ShowTerminalHost` (por defecto `false`), revela la implementación de forma útil: controla "si los recursos ocultos de host de terminal, uno por réplica, aparecen en el dashboard y en las listas de recursos de la CLI". Cada réplica obtiene su propia sesión independiente detrás de su propio recurso host oculto, así que `.WithReplicas(3).WithTerminal()` te da tres, y puedes cambiar entre ellas en el dashboard. El orden de esas dos llamadas da igual. Llamar a `WithTerminal()` dos veces sobre el mismo recurso lanza una excepción.

## Conectarse desde tu propia shell

La mitad de CLI está detrás de un flag de característica:

```bash
aspire config set features.terminalCommandsEnabled true
aspire terminal ps
aspire terminal attach agent --replica 1
```

Las sesiones admiten varios espectadores simultáneos, así que una pestaña del navegador y una shell local pueden manejar el mismo proceso sin que ninguna de las dos cierre la sesión.

## Dos aristas afiladas

La primera es el depurador. Según la documentación, "cuando aplicas `WithTerminal`, Aspire ejecuta el recurso como un proceso plano y no engancha automáticamente el depurador". Eso lo convierte en la herramienta equivocada para el proyecto que estás depurando paso a paso, y en la correcta para una TUI, un REPL o un script de migración que quieras conducir a mano. Aspire lo describe como una limitación temporal.

La segunda muerde a quien probó esto durante las preview de 13.4: no hay forma de elegir qué shell se lanza. La opción `Shell` desapareció, eliminada "porque nunca estuvo conectada a la pseudo-terminal subyacente y no tenía ningún efecto". El código que asignaba `TerminalOptions.Shell` deja de compilar en 13.5, después de no haber hecho nada en 13.4.

Una nota de actualización antes de probar nada de esto: las notas de la versión advierten de que mezclar paquetes 13.4 y 13.5 falla en tiempo de ejecución con `MissingMethodException` o `TypeLoadException`. Mueve el SDK y todos los paquetes `Aspire.Hosting.*` a versiones coincidentes en el mismo commit. Si ejecutas varios AppHost en paralelo, esto combina bien con [el flag `--isolated` de 13.2](/es/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/): cada ejecución aislada obtiene sus propias sesiones de terminal junto con sus propios puertos.
