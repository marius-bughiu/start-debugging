---
title: "Exporta tus conversaciones de Claude Code a PDF con jsonl-to-pdf"
description: "Una guía práctica para convertir los archivos JSONL que Claude Code escribe en ~/.claude/projects/ a PDFs compartibles usando jsonl-to-pdf, con anidado de subagentes, redacción de secretos, temas compacto y oscuro, y recetas para CI."
pubDate: 2026-04-29
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
  - "pdf"
lang: "es"
translationOf: "2026/04/export-claude-code-conversations-to-pdf-with-jsonl-to-pdf"
translatedBy: "claude"
translationDate: 2026-04-29
---

Cada conversación que tienes con Claude Code vive como un archivo `.jsonl` en lo profundo de `~/.claude/projects/`, una línea por turno, fidelidad completa, sin renderizado. `jsonl-to-pdf` es una pequeña CLI que convierte esos archivos en PDFs que puedes leer en un visor, adjuntar a un pull request, soltar en un hilo de Slack o imprimir en papel real. La forma más rápida de probarlo con tu última sesión es `npx jsonl-to-pdf`, que abre un selector interactivo, pregunta si quieres incluir las conversaciones de los subagentes y escribe un PDF con título en el directorio actual.

Esta publicación recorre de dónde vienen los archivos JSONL, qué contiene realmente el PDF (subagentes anidados en línea, bloques de pensamiento, llamadas a herramientas y resultados, adjuntos de imágenes), las flags que vale la pena conocer para compartir externamente (`--compact`, `--redact`, `--no-thinking`, `--subagents-mode appendix`, `--dark`), y algunas recetas para CI y automatización. La versión cubierta es `jsonl-to-pdf` 0.1.0 contra Claude Code 2.1.x. El repositorio está en [GitHub](https://github.com/marius-bughiu/jsonl-to-pdf), y el paquete está en [npm](https://www.npmjs.com/package/jsonl-to-pdf).

## Dónde guarda Claude Code tus conversaciones

Claude Code escribe un archivo JSONL por sesión en `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. El segmento `<encoded-cwd>` es el directorio de trabajo en el que se ejecutó la sesión, con los separadores de ruta aplanados a `-`. Así, `C:\S\my-app` en Windows se convierte en `C--S-my-app`, y `/Users/marius/work` en macOS o Linux se convierte en `-Users-marius-work`. Cada línea es un objeto JSON: un turno de usuario, un turno del asistente, una llamada a herramienta, un resultado de herramienta, un bloque de pensamiento, o metadatos de sesión como `cwd`, `gitBranch`, `aiTitle` y `permissionMode`.

Las conversaciones de subagentes (sesiones generadas por el agente principal mediante la herramienta `Task`/`Agent`) viven en un directorio hermano: `<session-id>/subagents/<sub-session-id>.jsonl`. Son sesiones completas por derecho propio, con sus propios flujos JSONL, vinculadas a una llamada a herramienta del archivo principal por ID. Este anidado es recursivo en la práctica: un subagente que genera su propio subagente deja un tercer archivo junto al segundo.

Esa disposición importa porque nada en la interfaz de Claude Code la expone directamente. Si necesitas hacer algo con una sesión después de que la conversación se cierra (archivarla, compartirla, auditarla), primero la encuentras en disco. La CLI hace la búsqueda por ti con `jsonl-to-pdf list`, pero vale la pena conocer la codificación de rutas por si haces grep para una sesión específica a mano. El reciente [cambio de PR-from-URL en Claude Code 2.1.119](/es/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) sigue añadiendo más metadatos de sesión a esos archivos, así que el JSONL es cada vez más el registro canónico de lo que realmente hizo una ejecución del agente.

## Inicio rápido: npx jsonl-to-pdf

La ruta sin instalación ejecuta `jsonl-to-pdf` directamente desde npm sin tocar tu `package.json`:

```bash
# Node
npx jsonl-to-pdf

# Bun
bunx jsonl-to-pdf

# pnpm
pnpm dlx jsonl-to-pdf
```

Eso te lleva a un selector interactivo que recorre el directorio local de proyectos de Claude Code, lista cada sesión empezando por la más reciente con título, antigüedad y tamaño, y pregunta si incluir las conversaciones de los subagentes. Elige una sesión, responde la pregunta, y la CLI escribe un PDF con el nombre del título de la sesión en tu directorio de trabajo actual:

```
$ jsonl-to-pdf
◆ Project   C:\S\my-app
◆ Session   Refactor the billing module to use Stripe webhooks  · 2h ago · 412KB
◆ Include sub-agent conversations? › Yes

✓ Wrote refactor-the-billing-module-to-use-stripe-webhooks.pdf
```

Si ya conoces la ruta del archivo, `convert` la toma como argumento posicional y omite el selector:

```bash
jsonl-to-pdf convert ~/.claude/projects/C--S-my-app/abc-123.jsonl
```

Ambas formas aceptan las mismas flags. El selector interactivo es el punto de entrada correcto cuando estás convirtiendo una sesión puntual; la forma `convert` es el punto de entrada correcto cuando estás haciendo scripting contra un archivo conocido (subida de artefacto de CI, hook de automatización, barrido de archivado).

Para instalar globalmente en su lugar, `npm i -g jsonl-to-pdf` o `bun i -g jsonl-to-pdf` ponen tanto `jsonl-to-pdf` como el alias más corto `j2pdf` en tu `PATH`. Se requiere Node 18 o superior.

## Qué termina en el PDF

Por defecto, el PDF preserva la **fidelidad completa** de la sesión, no sólo el chat visible:

- Cada solicitud del usuario y respuesta del asistente, en orden.
- Bloques de *pensamiento* (el razonamiento interno del modelo cuando el pensamiento extendido está activado). Útil al revisar cómo decidió el agente qué hacer.
- Cada llamada a herramienta, con su entrada completa. Una llamada `Bash` muestra su comando, una llamada `Edit` muestra el diff, una llamada MCP muestra sus argumentos.
- Cada resultado de herramienta, incluyendo stdout/stderr completo de bash. Las salidas largas se ajustan, no se cortan.
- Adjuntos de imágenes, incrustados en línea en el punto de la conversación donde se adjuntaron.
- **Subagentes** renderizados anidados en el lugar correcto. Cuando el agente principal generó un `Task` o `Agent`, toda esa subconversación aparece sangrada en la llamada a herramienta que la inició. Los subagentes que generan subagentes se renderizan de la misma manera, recursivamente.

Los bloques de código se renderizan con fuente monoespaciada, ajuste de líneas consciente de la sintaxis, y lógica de salto de página que no se rompe en mitad de un token. Las secciones incluyen un mínimo de elementos de navegación (números de página, el título de la sesión en el encabezado) sin caer en diseño por sí mismo. El tema por defecto es claro; `--dark` cambia a un tema oscuro que se ve mejor en pantalla y peor en papel.

Esa fidelidad es el punto. Los PDFs de sesiones de agente son más útiles cuando el lector puede ver exactamente lo que el modelo vio, exactamente lo que ejecutó, y exactamente lo que volvió. Una exportación resumida se lee como un postmortem; una exportación completa se lee como una transcripción.

## Subagentes en línea o como apéndice

El renderizado por defecto es **en línea**: cada conversación de subagente aparece en la posición de la llamada a herramienta que la generó, sangrada y agrupada visualmente para que el flujo padre sea fácil de seguir. Ese es el valor por defecto correcto para depuración, donde quieres ver el desvío en contexto.

`--subagents-mode appendix` cambia a una disposición distinta: la conversación principal se lee de arriba abajo sin interrupciones, y las conversaciones de los subagentes se mueven al final del documento con anclas que regresan a la llamada a herramienta que generó cada una. Ese es el modo correcto para lectura tipo revisión de código, donde la conversación padre es la historia y los hilos de los subagentes son la evidencia de apoyo:

```bash
# inline (default)
jsonl-to-pdf convert session.jsonl

# appendix
jsonl-to-pdf convert session.jsonl --subagents-mode appendix

# omit sub-agents entirely
jsonl-to-pdf convert session.jsonl --no-subagents
```

La tercera opción, `--no-subagents`, es para casos donde las conversaciones de los subagentes son ruido (a menudo: búsquedas largas estilo Explore que no afectan al cambio final). El PDF entonces sólo contiene el flujo del agente principal.

## Compact y redact: hacer una sesión segura para compartir

Dos flags manejan el caso de "quiero compartir esto externamente".

`--compact` reduce la sesión a lo esencial. Los bloques de pensamiento se ocultan, y cualquier E/S de herramienta más larga de unas 30 líneas se recorta con un marcador claro `[N lines omitted]`. El resultado se lee como lo haría el chat, sin la traza profunda. Útil para entregar la conversación a un compañero al que sólo le importa el resultado.

`--no-thinking` es un corte más fino: oculta sólo los bloques de pensamiento del asistente, deja intactas las llamadas a herramientas y los resultados. Útil cuando la traza importa pero el razonamiento interno es demasiado verboso para imprimir.

`--redact` ejecuta cada cadena del documento a través de un conjunto de expresiones regulares que coinciden con los formatos comunes de secretos: claves de acceso y secretas de AWS, tokens de acceso personal de GitHub (clásicos y de grano fino), claves de API de Anthropic y OpenAI, encabezados `Bearer`, tokens de Slack, y claves privadas codificadas en PEM. Cada coincidencia se reemplaza con `[redacted:<kind>]` para que el lector pueda saber qué tipo de secreto había sin ver el valor. La lista completa de patrones está en [src/utils/redact.ts](https://github.com/marius-bughiu/jsonl-to-pdf/blob/main/src/utils/redact.ts) en el GitHub del proyecto.

```bash
# safe to email
jsonl-to-pdf convert session.jsonl --compact --redact

# safe to share, full fidelity
jsonl-to-pdf convert session.jsonl --redact
```

Usa `--redact` siempre que el destino esté fuera de tu límite de confianza. Incluso cuando estés seguro de que la sesión nunca tocó una clave, el costo de la flag es prácticamente nulo y el costo de equivocarse es una credencial de producción rotada.

## Recetas

Algunos patrones que aparecen a menudo.

**Convierte por lotes la última semana.** Cada sesión más reciente que una fecha, un PDF cada una, escrito junto al lugar donde ejecutaste el comando:

```bash
jsonl-to-pdf list --json |
  jq -r '.[] | select(.modifiedAt > "2026-04-22") | .filePath' |
  while read f; do jsonl-to-pdf convert "$f"; done
```

`jsonl-to-pdf list --json` imprime un registro por sesión con `sessionId`, `projectPath`, `filePath`, `sizeBytes` y `modifiedAt`, así que cualquier filtro que puedas expresar en `jq` funciona.

**Adjunta la sesión activa como artefacto de CI.** Útil en cualquier pipeline donde una ejecución de Claude Code produjo el cambio, y quieres la conversación archivada junto con la salida del build:

```yaml
- run: npx -y jsonl-to-pdf convert "$CLAUDE_SESSION_FILE" -o session.pdf --redact
- uses: actions/upload-artifact@v4
  with:
    name: claude-session
    path: session.pdf
```

**Envía a una impresora o visor de PDF.** La forma `-o -` escribe el PDF a stdout, lo cual es útil para entubar a `lp`, `lpr`, o el binario de impresión que sea de tu plataforma, o a un visor de PDF de un solo uso sin dejar un archivo en disco:

```bash
jsonl-to-pdf convert session.jsonl -o - | lp
```

**Lista cada sesión que la CLI puede ver.** Sin PDF, sólo el índice:

```bash
jsonl-to-pdf list
```

La salida es legible por humanos por defecto y `--json` para legible por máquina. El punto óptimo de scripting para herramientas de agente; la [publicación sobre el triaje recurrente de Claude Code](/es/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) tiene un ejemplo más largo del mismo patrón (un trabajo programado consumiendo `list --json`).

## Binarios independientes cuando no quieres una cadena de herramientas Node

La página de Releases de GitHub envía binarios de un solo archivo construidos con `bun build --compile`, uno por SO y arquitectura, sin runtime de Node requerido. Útil en agentes de build a los que no se les permite instalar una cadena de herramientas Node, o en estaciones de trabajo de desarrollador bloqueadas donde las instalaciones globales de npm están deshabilitadas:

```bash
# macOS / Linux
curl -fsSL https://github.com/marius-bughiu/jsonl-to-pdf/releases/latest/download/install.sh | sh
```

En Windows, descarga `jsonl-to-pdf-win-x64.exe` desde la última versión y ponlo en tu `PATH`. El binario acepta las mismas flags que la instalación de npm: `convert`, `list`, `--compact`, `--redact`, `--dark`, todo.

## Por qué un PDF específicamente, y no "abrir en navegador"

Algunas razones por las que el formato PDF se gana su lugar sobre una vista HTML que existe en el roadmap.

- **Archivar.** Los archivos locales de sesión de Claude Code se rotan, se recolectan como basura, o simplemente se olvidan. Un PDF es una instantánea congelada y autocontenida que puedes poner en una carpeta de proyecto, una issue o un respaldo.
- **Compartir.** La mayoría de las herramientas de revisión de código y chat aceptan un adjunto PDF limpiamente. Pegar un JSONL de 400KB en un hilo de Slack es una experiencia peor que soltar un PDF.
- **Revisar.** Leer el trabajo del agente como lees una revisión de código (en un escritorio, en un vuelo, en papel) es un modo de atención distinto a hacer scroll en un chat. Los PDFs sobreviven ese movimiento.
- **Auditar.** Una exportación firmada y determinista es un registro de lo que realmente se dijo y se ejecutó. Los equipos internos de cumplimiento pueden marcar un PDF; no pueden marcar un JSONL.
- **Onboarding.** Una sesión real es mucho mejor material de estudio para un junior que un tutorial genérico. Un PDF convierte ese traspaso en un problema de un solo adjunto.

## Roadmap, brevemente

La versión 0.1.0 cubre sólo Claude Code. El roadmap en el GitHub del proyecto compromete adaptadores para Aider, OpenAI Codex CLI, Cursor Compose y Gemini CLI, todos los cuales escriben algún sabor de transcripción JSONL o JSON-Lines. Más allá de la cobertura de formatos:

- Salida HTML para compartir en línea, y un pequeño visor estático.
- Resaltado de sintaxis para bloques de código vía tokens de Shiki.
- Una tabla de contenidos con números de página (los builds actuales usan esquemas/marcadores de PDF).
- Flags de filtrado: `--turns 5..15`, `--only assistant`, `--exclude-tool Bash`, para los casos donde la transcripción completa es demasiado.

Si escribes un CLAUDE.md y un hook para mantener tus sesiones en orden (la [guía de CLAUDE.md](/es/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) cubre eso), `jsonl-to-pdf` es el artefacto que combina: una forma de salir de una sesión con algo duradero a lo que apuntar. El repositorio está en [github.com/marius-bughiu/jsonl-to-pdf](https://github.com/marius-bughiu/jsonl-to-pdf).
