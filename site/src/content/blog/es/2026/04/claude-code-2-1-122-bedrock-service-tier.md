---
title: "Claude Code 2.1.122 te permite elegir un nivel de servicio de Bedrock desde una variable de entorno"
description: "Claude Code v2.1.122 añade la variable de entorno ANTHROPIC_BEDROCK_SERVICE_TIER, enviada como el encabezado X-Amzn-Bedrock-Service-Tier. Configúrala en flex para un 50 por ciento de descuento en las llamadas del agente o priority para respuestas más rápidas, sin tocar código del SDK."
pubDate: 2026-04-30
tags:
  - "claude-code"
  - "ai-agents"
  - "aws-bedrock"
  - "dotnet"
lang: "es"
translationOf: "2026/04/claude-code-2-1-122-bedrock-service-tier"
translatedBy: "claude"
translationDate: 2026-04-30
---

El lanzamiento de Claude Code v2.1.122 el 28 de abril de 2026 añadió un control de una sola línea que cualquiera que ejecute el agente en AWS Bedrock ha estado esperando en silencio: una nueva variable de entorno `ANTHROPIC_BEDROCK_SERVICE_TIER` que selecciona el nivel de servicio de Bedrock en cada solicitud. Configúrala en `default`, `flex` o `priority`, y el CLI reenvía el valor como el encabezado `X-Amzn-Bedrock-Service-Tier`. Sin cambios de código del SDK. Sin ediciones de configuración JSON. Una variable de entorno.

## Por qué esto importa incluso antes de leer el resto

AWS introdujo los niveles de inferencia Priority y Flex para Bedrock en noviembre de 2025 como una forma de cambiar latencia por costo. Según la [página de niveles de servicio de Bedrock](https://aws.amazon.com/bedrock/service-tiers/), Flex es un 50 por ciento de descuento frente al precio Standard a cambio de "mayor latencia", y Priority es un 75 por ciento de prima que coloca tus solicitudes al frente de la cola. Para un agente como Claude Code que dispara secuencias largas de turnos de uso de herramientas a lo largo de una sesión, las cuentas son evidentes. Una tarea evergreen larga que corría en default podría costar la mitad en Flex si puedes absorber el tiempo de pared adicional, y una sesión de depuración en la que estás cuidando la terminal podría sentirse más ágil en Priority.

Hasta v2.1.122, la única forma de elegir un nivel con Claude Code en Bedrock era envolver tú mismo la capa de solicitudes o pasar por un proxy capaz de inyectar el encabezado. La [solicitud de funcionalidad](https://github.com/anthropics/claude-code/issues/16329) que aterrizó en este lanzamiento cierra esa brecha.

## El uso real

```bash
# Cheap background agents that triage issues overnight
export ANTHROPIC_BEDROCK_SERVICE_TIER=flex
claude --from-pr https://github.acme.internal/acme/api/pull/482

# Interactive debug session, paying for speed
export ANTHROPIC_BEDROCK_SERVICE_TIER=priority
claude
```

El CLI envía el valor textualmente como `X-Amzn-Bedrock-Service-Tier` en la solicitud InvokeModel, que es la misma plomería que CloudTrail y CloudWatch ya registran bajo `ServiceTier` y `ResolvedServiceTier`. Así que si tu equipo de plataforma tiene dashboards sobre el gasto de Bedrock por nivel, el tráfico de Claude Code ahora aterriza en el cubo correcto sin trabajo adicional.

## Cuidado con ResolvedServiceTier

El encabezado es una solicitud, no una garantía. AWS devuelve el nivel que realmente te sirvió en `ResolvedServiceTier`, y las solicitudes Flex pueden ser degradadas si el pool flex del modelo está saturado. La lista completa de qué modelos soportan Priority y Flex está en la [página de precios de Bedrock](https://aws.amazon.com/bedrock/pricing/), y va con semanas de retraso respecto a los lanzamientos más recientes de modelos, así que confirma que el ID del modelo con el que ejecutas Claude Code está en ella antes de fijar `flex` en un trabajo de CI. Si un nivel no está soportado, AWS regresa al nivel por defecto de forma transparente y te factura en consecuencia.

La línea `ANTHROPIC_BEDROCK_SERVICE_TIER` está enterrada en mitad del changelog, pero es la palanca de costo más barata en Claude Code alojado en Bedrock ahora mismo. Las notas completas están en la [página de la versión Claude Code v2.1.122](https://github.com/anthropics/claude-code/releases).
