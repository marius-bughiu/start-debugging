---
title: "La mejor idea del nuevo agente de pruebas unitarias de .NET no es escribir pruebas"
description: "El 2026-07-31 Microsoft publicó un agente poliglota de pruebas unitarias en dotnet/skills. Lo interesante es la validación obligatoria que aplica pseudo-mutación a tus aserciones antes de permitir que el agente declare el trabajo terminado."
pubDate: 2026-08-01
tags:
  - "dotnet"
  - "ai-agents"
  - "testing"
  - "github-copilot"
  - "agent-skills"
lang: "es"
translationOf: "2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate"
translatedBy: "claude"
translationDate: 2026-08-01
---

Cualquier agente de código genera pruebas unitarias sin quejarse. El problema no es que se niegue, sino que terminas con 40 pruebas en verde que solo hacen `Assert.NotNull(result)` y que seguirían pasando si borraras el cuerpo del método. El 2026-07-31 Amaury Levé publicó [From generated code to trusted code with a unit-test agent](https://devblogs.microsoft.com/dotnet/polyglot-unit-testing-agent/), que incluye el plugin `dotnet-test` en [dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-test). Ataca exactamente ese problema, y vale la pena robarle el mecanismo aunque nunca lo instales.

## Instalarlo son dos líneas

El plugin viaja por el marketplace de GitHub Copilot CLI, la misma vía de distribución a la que [el agente modernize-dotnet se mudó a principios de julio](/es/2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin/):

```bash
/plugin marketplace add dotnet/skills
/plugin install dotnet-test@dotnet-agent-skills
```

Aunque vive bajo `dotnet/`, el agente es poliglota: .NET, Python, TypeScript, JavaScript, Java, Go, Ruby, Rust, Swift, Kotlin, PowerShell y C++. Se limita a pruebas unitarias, aislando el código bajo prueba y simulando los servicios externos. Nada de pruebas de integración, e2e ni de rendimiento.

## La validación que corre antes de reportar éxito

Por dentro, `code-testing-generator` es un orquestador interno (`user-invocable: false`) que reparte el trabajo a una cadena de subagentes: researcher, planner, implementer, builder, tester, fixer y linter. Elige uno de tres caminos según el alcance, y la recomendación es refrescantemente conservadora: la mayoría de las solicitudes deberían tomar el camino Direct y saltarse el pipeline por completo, reservando los ciclos completos de Research a Plan a Implement para alcances que abarcan archivos fuente sin relación entre sí.

Lo que importa es lo que ocurre antes de que el agente pueda dar por terminado el trabajo. Para cualquier adición no trivial (aproximadamente cinco pruebas o más, o una lista enumerada de comportamientos), hay una revisión previa obligatoria con tres verificaciones:

1. **Análisis de pseudo-mutación** con el skill `test-gap-analysis`: ¿estas aserciones fallarían de verdad si cambiara la implementación?
2. **Revisión de profundidad de aserciones** con `assertion-quality`: ¿las aserciones son débiles, faltantes o tautológicas?
3. **Mapeo entre prompt y escenarios**: ¿cada comportamiento que pediste tiene una prueba dedicada, y no solo incidental?

Esa es la diferencia entre una prueba que el compilador acepta y una prueba que se gana su lugar:

```csharp
// Fails the assertion-quality check: green even if Apply() returns input unchanged
Assert.NotNull(cart.Apply(coupon));

// Survives pseudo-mutation: pins the actual behavior
var result = cart.Apply(coupon);
Assert.Equal(90.00m, result.Total);
Assert.Single(result.AppliedDiscounts, d => d.Code == "SAVE10");
```

Solo después de eso compila el workspace completo, ejecuta toda la suite y verifica que el descubrimiento de pruebas del propio repositorio encuentre las nuevas.

## Qué dicen los números

Microsoft reporta una tasa de finalización del 92.1% (140 de 152 tareas) frente al 78.9% de Copilot sin el agente, y la brecha se ensancha con prompts vagos: 88.8% contra 66.3%. El tiempo promedio por tarea fue de 359 segundos, con 72.4% de cobertura de líneas y 49.8% de ramas.

Lee el número de ramas con honestidad. La mitad de tus ramas sigue sin cobertura, que es más o menos lo que esperarías de un agente que se detiene cuando su checklist queda limpia y no cuando alcanza un objetivo de cobertura. El valor aquí no es que reemplace tu trabajo escribiendo pruebas. Es que la validación de mutación y aserciones es una respuesta codificada a "¿cómo sé si vale la pena conservar esta prueba generada?", y puedes llevar esa idea a cualquier agente que ya uses.
