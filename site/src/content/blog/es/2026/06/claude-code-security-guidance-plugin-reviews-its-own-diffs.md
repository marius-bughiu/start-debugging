---
title: "El plugin security-guidance de Claude Code revisa sus propios diffs antes de que hagas commit"
description: "Anthropic lanzó un plugin gratuito security-guidance para Claude Code que escanea las propias ediciones del agente en busca de vulnerabilidades en tres capas, desde una coincidencia de patrones sin costo hasta una revisión agéntica al hacer commit."
pubDate: 2026-06-08
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
lang: "es"
translationOf: "2026/06/claude-code-security-guidance-plugin-reviews-its-own-diffs"
translatedBy: "claude"
translationDate: 2026-06-08
---

Anthropic lanzó a finales de mayo de 2026 un [plugin security-guidance](https://code.claude.com/docs/en/security-guidance) gratuito para Claude Code que hace algo que la mayoría de las configuraciones de IA para programar pasa por alto: hace que el agente revise sus propios diffs en busca de vulnerabilidades mientras trabaja y luego corrija lo que encuentra en la misma sesión. La idea es simple. El error de seguridad más barato de corregir es el que nunca llega al pull request, y un revisor separado sin compromiso con el enfoque original detecta más que el modelo que escribió el código.

## Tres capas, de las cuales solo una consume tokens

El plugin se ejecuta en tres puntos, cada uno con una profundidad distinta.

El primero se dispara en cada `Edit`, `Write` o `NotebookEdit`. Es una coincidencia de patrones determinista sin llamada al modelo, así que no añade ningún costo de uso. Marca construcciones riesgosas en el momento en que aparecen:

- Ejecución dinámica: `eval(`, `new Function`, `os.system`, `child_process.exec`
- Deserialización insegura: `pickle`
- Inyección en el DOM: `dangerouslySetInnerHTML`, `.innerHTML =`, `document.write`
- Ediciones en `.github/workflows/`, que pueden otorgar permisos a nivel de repositorio de forma silenciosa

Cada advertencia se dispara una vez por patrón, por archivo y por sesión, así que no inunda la conversación.

La segunda capa se ejecuta al final de cada turno. El plugin hace un diff de todo lo que cambió en el árbol de trabajo, incluidas las ediciones de Bash y de los subagentes, y lo entrega a una revisión separada de Claude enfocada en seguridad. Aquí es donde la coincidencia de cadenas no alcanza: bypass de autorización, referencias directas a objetos inseguras, SSRF, criptografía débil. Se ejecuta en segundo plano, cubre hasta 30 archivos modificados y se dispara como máximo tres veces seguidas.

La tercera capa se activa cuando Claude ejecuta `git commit` o `git push` a través de su herramienta Bash. Esta es agéntica: lee a los llamadores, los saneadores y los archivos relacionados para decidir si un hallazgo es real antes de reportarlo, lo que mantiene bajos los falsos positivos en código que parece peligroso de forma aislada pero es seguro en contexto. Está limitada a 20 revisiones por hora móvil. Los commits que ejecutas desde tu propio shell no se revisan.

Ambas capas respaldadas por el modelo usan Claude Opus 4.7 como revisor por defecto.

## Instalación y extensión

Necesitas Claude Code 2.1.144 o posterior y Python 3.8 en tu `PATH`. Instala desde el marketplace oficial:

```text
/plugin install security-guidance@claude-plugins-official
/reload-plugins
```

La capa por edición es extensible sin tocar el modelo. Coloca un `.claude/security-patterns.yaml` en tu repositorio y agrega tus propias reglas:

```yaml
patterns:
  - rule_name: tenant_unfiltered_query
    regex: "\\.objects\\.all\\(\\)"
    paths: ["**/src/tenants/**"]
    reminder: "Multi-tenant code must filter by org_id."
```

Ninguna de las tres capas bloquea escrituras ni commits. Los hallazgos llegan al Claude que escribe como instrucciones, y el revisor todavía puede pasar cosas por alto. Trátalo como una capa de defensa en profundidad: se ubica dentro de la sesión, por delante de `/security-review` a demanda y de la revisión de código completa en el pull request. Para conocer los eventos de hook exactos y los interruptores por variable de entorno, la [documentación del plugin](https://code.claude.com/docs/en/security-guidance) lo detalla todo.
