---
title: "Cómo escribir un CLAUDE.md que realmente cambia el comportamiento del modelo"
description: "Una guía 2026 para archivos CLAUDE.md que Claude Code realmente sigue: el objetivo de 200 líneas, cuándo usar reglas con alcance de ruta en .claude/rules/, la jerarquía de @import y el límite de 5 saltos, la diferencia entre mensaje de usuario y prompt de sistema, la línea entre CLAUDE.md y la memoria automática, y cuándo rendirse y escribir un hook. Anclada a Claude Code 2.1.x y verificada contra la documentación oficial de memoria."
pubDate: 2026-04-28
tags:
  - "claude-code"
  - "ai-agents"
  - "agent-skills"
  - "developer-workflow"
lang: "es"
translationOf: "2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour"
translatedBy: "claude"
translationDate: 2026-04-29
---

Un CLAUDE.md que "no funciona" casi siempre significa una de tres cosas: es demasiado largo y las reglas importantes se ahogan, es demasiado vago para verificar, o la instrucción debería ser un hook porque CLAUDE.md es advisorio por diseño. A partir de **Claude Code 2.1.x**, el archivo se carga en el contexto como mensaje de usuario después del prompt del sistema, no dentro del prompt del sistema en sí, lo cual es un detalle nada obvio que explica buena parte de la frustración tipo "Claude está ignorando mis reglas" en `r/ClaudeAI` y `r/cursor` este mes. El comportamiento del modelo sí cambia en respuesta a un buen CLAUDE.md, pero solo si lo tratas como lo describe la propia [documentación de memoria](https://code.claude.com/docs/en/memory) de Anthropic: como contexto, no como configuración.

La versión corta: apunta a menos de 200 líneas, escribe instrucciones específicas y verificables, mueve las reglas por tema a `.claude/rules/` con frontmatter `paths:`, mueve los flujos reutilizables a skills, y usa hooks para cualquier cosa que tenga que ejecutarse sí o sí. Usa `@imports` para organizar, pero entiende que no ahorran tokens. Y si corriges el mismo error dos veces, no lo entierres más profundo en CLAUDE.md, ya está perdiendo la batalla contra tus otras reglas.

Esta publicación asume Claude Code 2.1.59+ (la versión que trae memoria automática) y `claude-sonnet-4-6` o `claude-opus-4-7` como modelo subyacente. Los patrones funcionan igual en ambos, pero Sonnet es más sensible a archivos CLAUDE.md inflados porque la adherencia cae más rápido a medida que el contexto se llena.

## Por qué "se lo dije" no es suficiente

La oración más útil de la [documentación oficial de memoria](https://code.claude.com/docs/en/memory#claude-isn-t-following-my-claude-md) es esta: "El contenido de CLAUDE.md se entrega como un mensaje de usuario después del prompt del sistema, no como parte del prompt del sistema en sí. Claude lo lee e intenta seguirlo, pero no hay garantía de cumplimiento estricto." Esto explica cada hilo de "literalmente escribí `NEVER use console.log` y aun así lo hizo". El modelo ve tu CLAUDE.md igual que ve el resto de tu prompt: como instrucciones a sopesar, no como una directiva no anulable.

De aquí salen tres consecuencias concretas:

1. **Más texto reduce la adherencia.** Cuanto más largo el archivo, más se diluye cualquier regla individual. La documentación oficial recomienda "apuntar a menos de 200 líneas por archivo CLAUDE.md. Los archivos más largos consumen más contexto y reducen la adherencia."
2. **Las reglas vagas se redondean.** "Formatea el código correctamente" lo interpreta el modelo igual que tú lo interpretarías: hacer algo razonable. "Usa indentación de 2 espacios, sin punto y coma al final excepto después de imports" es una instrucción verificable que el modelo sí puede seguir.
3. **Las reglas en conflicto se resuelven de forma arbitraria.** Si tu CLAUDE.md raíz dice "siempre escribe pruebas" y uno anidado en una subcarpeta dice "omite las pruebas para los prototipos", el modelo elige una sin avisarte cuál.

Si realmente necesitas una directiva no anulable, tienes dos opciones. La primera es `--append-system-prompt`, que mete texto dentro del prompt del sistema. Según la [referencia de la CLI](https://code.claude.com/docs/en/cli-reference#system-prompt-flags), hay que pasarla en cada invocación, lo cual está bien para scripts y CI pero es inviable para uso interactivo. La segunda, y casi siempre la mejor, es un hook, al que llegamos enseguida.

## Qué va en CLAUDE.md y qué no

La propia [guía de mejores prácticas](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md) de Anthropic ofrece una tabla concisa de incluir/excluir que copio en cada proyecto que arranco. Reformulada y condensada:

**Incluir**: comandos bash que Claude no puede deducir de tu `package.json` o `Cargo.toml`, reglas de estilo de código que difieren de los valores por defecto del lenguaje, el test runner que realmente quieres que use, convenciones de ramas y PR, decisiones arquitectónicas que no son obvias al leer el código, y trampas como "el contenedor de pruebas de postgres necesita `POSTGRES_HOST_AUTH_METHOD=trust` o las migraciones se cuelgan."

**Excluir**: cualquier cosa que Claude pueda leer de `tsconfig.json`, convenciones de framework que todo desarrollador conoce, descripciones archivo a archivo del codebase, historia de cómo el código llegó a su estado actual, y prácticas evidentes como "escribe código limpio". El documento de mejores prácticas es directo: "Los archivos CLAUDE.md inflados hacen que Claude ignore tus instrucciones reales." Cada línea que añades baja la relación señal-ruido para el resto.

Un CLAUDE.md que sobrevivió este filtro para un backend Next.js + Postgres se ve así:

```markdown
# Project: invoice-api
# Claude Code 2.1.x, Node 22, Next.js 15

## Build and test
- Use `pnpm`, never `npm` or `yarn`. The lockfile is committed.
- Run `pnpm test --filter @app/api` for backend tests, NOT the full workspace.
- Migrations: `pnpm db:migrate` only inside the `apps/api` workspace.

## Code style
- Use ESM (`import`/`export`). Default export is forbidden except in
  Next.js page/route files where the framework requires it.
- Zod schemas for every external input. No `any`, no `as unknown as T`.

## Architecture
- Database access goes through `apps/api/src/db/repositories/`.
  Do not call `db.query` from route handlers.
- All money is `bigint` cents. Never `number`, never decimals.

## Workflow
- After a code change, run `pnpm typecheck` and `pnpm test --filter @app/api`.
- Commit messages: imperative, no scope prefix, max 72 chars on the title.
```

Son 17 líneas y aborda cada corrección recurrente que este equipo había documentado en su plantilla de PR. Fíjate en lo que no está: nada de "siempre escribe código limpio", nada de "ten cuidado con la seguridad", nada de "usa modo strict de TypeScript" (está en `tsconfig.json`, el modelo puede verlo). Cada línea responde "¿quitar esto causaría un error medible?" con sí.

## El techo de 200 líneas y `.claude/rules/`

Una vez que cruzas las 200 líneas, la documentación oficial de memoria recomienda dividir las instrucciones por tema en `.claude/rules/` con frontmatter YAML que limita cada archivo a un glob:

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/api/**/*.tsx"
---

# API endpoint conventions

- Every route under `src/api/` exports a `POST`, `GET`, `PUT`, or `DELETE`
  function. Never a default export.
- Validate the body with the matching Zod schema in `src/api/schemas/`
  before doing anything else. If no schema exists, write one first.
- Return errors with `Response.json({ error }, { status })`. Do not throw.
```

Una regla con `paths:` solo se carga en contexto cuando Claude lee un archivo que coincide con uno de los globs. El costo de tener diez archivos de reglas de 100 líneas cada uno es mucho menor que un CLAUDE.md de 1000 líneas, porque nueve de ellos no están en contexto para una tarea cualquiera. Las reglas sin `paths:` se cargan cada sesión con la misma prioridad que `.claude/CLAUDE.md`, así que no las pongas allí por costumbre a menos que realmente apliquen a cada archivo.

Aquí también es donde muere el "scope creep hacia CLAUDE.md". Si un compañero propone añadir doce líneas sobre una herramienta de migración oscura, la respuesta es "eso va a `.claude/rules/migrations.md` con `paths: ['db/migrations/**/*.sql']`", no "lo recortamos después". Nunca lo recortamos después.

## Imports, jerarquía y el límite de 5 saltos

La sintaxis de import `@path/to/file` es para organización, no para ahorrar tokens. De la [documentación](https://code.claude.com/docs/en/memory#import-additional-files): "Los archivos importados se expanden y cargan en contexto al iniciar junto con el CLAUDE.md que los referencia." Si divides un CLAUDE.md de 600 líneas en una raíz de 50 líneas y un `@docs/conventions.md` de 550 líneas, el modelo sigue viendo 600 líneas.

Los imports son útiles para tres cosas específicas:

1. **Reutilizar las mismas instrucciones en dos repos** sin copiar y pegar. Crea un symlink o importa un archivo compartido desde `~/shared/team-conventions.md`.
2. **Sobrescrituras por desarrollador** que no deben ir al commit. `@~/.claude/my-project-instructions.md` te permite mantener preferencias personales en tu directorio home mientras todos reciben el CLAUDE.md del equipo desde git.
3. **Puente hacia `AGENTS.md`** si tu repo ya tiene uno para otros agentes de codificación. La documentación recomienda explícitamente `@AGENTS.md` seguido de las sobrescrituras específicas de Claude:

```markdown
@AGENTS.md

## Claude Code

Use plan mode for changes under `src/billing/`.
```

Los imports se resuelven recursivamente hasta **cinco saltos de profundidad**. Más allá, el import se descarta silenciosamente. Si tienes un CLAUDE.md que importa un archivo que importa un archivo que importa un archivo cuatro veces, has construido algo frágil: aplánalo.

La jerarquía en sí es aditiva, no sobrescribe. El CLAUDE.md del proyecto, el CLAUDE.md de usuario (`~/.claude/CLAUDE.md`) y cualquier CLAUDE.md subiendo por el árbol de directorios desde el directorio de trabajo se concatenan todos. `CLAUDE.local.md` (excluido de git) se carga después de `CLAUDE.md` al mismo nivel, así que tus notas personales ganan en caso de conflicto. En un monorepo donde no quieres los archivos CLAUDE.md de equipos hermanos en tu contexto, la [opción `claudeMdExcludes`](https://code.claude.com/docs/en/memory#exclude-specific-claude-md-files) toma una lista de patrones glob:

```json
{
  "claudeMdExcludes": [
    "**/monorepo/CLAUDE.md",
    "/home/marius/monorepo/other-team/.claude/rules/**"
  ]
}
```

Pon eso en `.claude/settings.local.json` para que la exclusión sea tuya y no del equipo.

## CLAUDE.md son "tus requisitos", la memoria automática es "lo que Claude notó"

Claude Code 2.1.59 añadió memoria automática: notas que Claude escribe sobre sí mismo a partir de tus correcciones. Vive en `~/.claude/projects/<project>/memory/MEMORY.md` y se carga igual que CLAUDE.md, salvo que solo las primeras 200 líneas o 25KB de `MEMORY.md` se incorporan al inicio de la sesión. El resto del directorio se lee bajo demanda.

La forma más limpia de pensar en la división:

- **CLAUDE.md** contiene reglas que quieres que se apliquen desde el día uno. "Ejecuta `pnpm test --filter @app/api`, no el suite completo." Tú lo escribiste, tú lo subiste, tu equipo lo ve.
- **La memoria automática** contiene patrones que Claude notó. "El usuario prefiere `vitest` sobre `jest` y me corrigió cuando generé un `jest.config.js`." Claude lo escribió, es por máquina, no está en git.

De esto salen dos reglas prácticas. Primera, no dupliques entradas de la memoria automática en CLAUDE.md "por las dudas". La memoria automática también se carga cada sesión. Segunda, cuando la memoria automática acumula un patrón que todo el equipo debería conocer, promuévelo: abre `MEMORY.md`, copia la entrada en CLAUDE.md, y `/memory` te dejará borrar el original. La promoción es el momento en que "Claude observó esto sobre mí" pasa a ser "nosotros como equipo decidimos esto".

Para más sobre la división, la publicación sobre [agendar rutinas de Claude Code](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) cubre lo que sobrevive a una ejecución autónoma sin humano en el loop, lo cual es una prueba de presión útil para ver si tu CLAUDE.md realmente es autocontenido.

## Ajustar la adherencia

Una vez el archivo es corto y específico, puedes exprimirle más cumplimiento con tres técnicas en las que convergen la documentación y los reportes de campo:

1. **Usa el énfasis con moderación.** La guía oficial es "ajustar las instrucciones añadiendo énfasis (por ejemplo, `IMPORTANT` o `YOU MUST`) para mejorar la adherencia." Con moderación es la palabra operativa. Si todo es `IMPORTANT`, nada lo es. Reserva el énfasis para la regla que, al violarse, realmente rompería un build o quemaría a alguien de oncall.
2. **Empieza con el verbo, luego la restricción.** "Ejecuta `pnpm typecheck` después de cada cambio de código en `src/`" se sigue con más fiabilidad que "Se debe realizar la verificación de tipos con regularidad." La primera es una acción; la segunda es una vibra.
3. **Co-localiza la regla con el modo de fallo.** "No llames `db.query` desde los route handlers; el pool de conexiones es por petición y los route handlers tienen fugas. Usa `repositories/` en su lugar." El modo de fallo es lo que hace pegajosa a la regla entre sesiones.

Si corriges el mismo error dos veces y la regla ya está en CLAUDE.md, lo correcto no es añadir otra regla. Es preguntarte por qué la regla existente no está ganando. Normalmente es una de estas: el archivo es demasiado largo, dos reglas se contradicen, o la instrucción es del tipo que necesita un hook.

## Cuándo rendirse con CLAUDE.md y escribir un hook

CLAUDE.md es advisorio. Los hooks son deterministas. De la [guía de hooks](https://code.claude.com/docs/en/hooks-guide), son "scripts que se ejecutan automáticamente en puntos específicos del flujo de Claude" y "garantizan que la acción ocurra." Si tu regla está en la categoría "tiene que ejecutarse sin excepciones", no pertenece a CLAUDE.md.

Un hook `PostToolUse` que ejecuta Prettier después de cada edición de archivo es más fiable que una línea de CLAUDE.md que dice "ejecuta siempre Prettier después de las ediciones." Lo mismo para "bloquear escrituras a `migrations/`", que se convierte en un hook `PreToolUse` con un patrón de denegación. El mismo patrón es lo que hace que la historia más amplia de [skills de agente en Visual Studio 2026](/es/2026/04/visual-studio-2026-copilot-agent-skills/) funcione en la práctica: la skill es la instrucción blanda, el hook es el riel duro.

Este es también el momento de pensar en la línea entre CLAUDE.md y skills. Una instrucción de CLAUDE.md se carga cada sesión y aplica de forma amplia. Una skill en `.claude/skills/SKILL.md` se carga bajo demanda cuando el modelo decide que la tarea es relevante, así que el conocimiento profundo de flujo con efectos secundarios (como un flujo "fix-issue" que abre un PR) pertenece allí. La misma lógica aplica a instrucciones que son enormes pero solo importan para una parte de tu codebase: esas quieren una regla con alcance de ruta, no CLAUDE.md.

## Diagnosticar qué se ha cargado en realidad

Cuando el modelo está haciendo lo incorrecto, el primer paso es confirmar qué ve realmente. Ejecuta `/memory` dentro de una sesión de Claude Code. Lista cada CLAUDE.md, CLAUDE.local.md y archivo de reglas cargado actualmente, con rutas. Si el archivo que esperabas no está en la lista, el resto de la conversación es irrelevante: Claude no puede verlo.

Para reglas con alcance de ruta y archivos CLAUDE.md de subdirectorios cargados de forma diferida, el [hook `InstructionsLoaded`](https://code.claude.com/docs/en/hooks#instructionsloaded) se dispara cada vez que Claude incorpora instrucciones. Conéctalo a un logger para confirmar que un glob `paths:` realmente coincidió, o para depurar por qué un CLAUDE.md anidado nunca se recarga después de `/compact`. El caso de la compactación es un borde afilado conocido: el CLAUDE.md raíz del proyecto se reinyecta después de `/compact`, pero los anidados solo se recargan en la siguiente lectura de archivo en ese subdirectorio. Si dependes de un CLAUDE.md anidado y las instrucciones parecen perdidas a mitad de sesión, es por eso.

El otro diagnóstico que conviene saber: los comentarios de bloque HTML (`<!-- like this -->`) se eliminan de CLAUDE.md antes de la inyección. Úsalos para notas humanas (una línea `<!-- last reviewed 2026-04 -->`) sin pagar costo de tokens.

## Relacionado

- [Cómo agendar una tarea recurrente de Claude Code que clasifique issues de GitHub](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) cubre lo que un CLAUDE.md necesita para ejecuciones autónomas.
- [Claude Code 2.1.119: lanzar desde un PR con GitLab y Bitbucket](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) para la pregunta relacionada de "dónde viven mis instrucciones en una sesión en la nube".
- [Skills de agente Copilot en Visual Studio 2026](/es/2026/04/visual-studio-2026-copilot-agent-skills/) es el análogo más cercano del lado de Microsoft: archivos de skill vs contexto persistente.
- [Construir un servidor MCP en TypeScript](/es/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) para el caso donde la mejor respuesta a "más reglas en CLAUDE.md" es "exponer la herramienta al agente".

## Fuentes

- Oficial: [Cómo Claude recuerda tu proyecto](https://code.claude.com/docs/en/memory) (documentación de memoria de Claude Code y CLAUDE.md).
- Oficial: [Mejores prácticas para Claude Code](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md).
- Oficial: [Referencia de hooks](https://code.claude.com/docs/en/hooks-guide) y [hook `InstructionsLoaded`](https://code.claude.com/docs/en/hooks#instructionsloaded).
- Notas de campo: [Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md) (HumanLayer).
