---
title: "Las API keys de NuGet tendrán un límite de 30 días desde el 17 de agosto, y todas las antiguas expiran el 1 de noviembre"
description: "NuGet.org elimina la opción de API key de 365 días el 2026-08-17, limita las nuevas a 30 días y expira el 1 de noviembre toda key creada antes de esa fecha. Esto es lo que se rompe y cómo mover tu flujo de publicación a trusted publishing con OIDC."
pubDate: 2026-08-04
tags:
  - "dotnet"
  - "nuget"
  - "ci-cd"
  - "security"
  - "github-actions"
lang: "es"
translationOf: "2026/08/nuget-api-keys-capped-at-30-days-from-august-17"
translatedBy: "claude"
translationDate: 2026-08-04
---

El equipo de .NET publicó [Strengthening NuGet Supply Chain Security: Reducing API Key Lifetime](https://devblogs.microsoft.com/dotnet/strengthening-nuget-supply-chain-security-reducing-api-key-lifetime/) el 2026-08-03, y trae dos fechas duras que van a romper pipelines de publicación si las ignoras.

## Las dos fechas

**2026-08-17**: las nuevas API keys quedan limitadas a una duración máxima de 30 días. La opción de 365 días desaparece de la interfaz de creación de keys en nuget.org.

**2026-11-01**: toda API key creada antes del 17 de agosto expira. No solo las de un año. Si tu secreto `NUGET_API_KEY` se generó en junio, deja de funcionar el 1 de noviembre sin importar la fecha de expiración que aparezca junto a él.

Esa segunda fecha es la que duele. Un flujo de trabajo de publicación disparado por tags que no se haya ejecutado desde octubre va a fallar en su primer push después del 1 de noviembre con un 401, y la falla aparece en un job que nadie mira hasta que realmente necesita publicar.

## Por qué una key de 30 días sigue teniendo la forma equivocada

Una key de 30 días es mejor que una de 365, pero sigue siendo un secreto de larga vida guardado en un almacén de secretos del repositorio, y ahora te toca rotarlo doce veces al año en lugar de una. Automatizar la rotación es trabajo real: generar la key en nuget.org con el alcance de paquete correcto, empujarla a GitHub o Azure DevOps, verificar que la anterior quedó revocada.

La alternativa hacia la que Microsoft está empujando a todos es [trusted publishing](https://learn.microsoft.com/en-us/nuget/nuget-org/trusted-publishing), que usa OIDC en su lugar. Tu sistema de CI emite un token firmado de corta duración, nuget.org lo valida contra una política que registraste y devuelve una API key temporal válida por **una hora**. Un token compra exactamente una key. No se almacena nada duradero en ningún lado.

La forma en GitHub Actions es pequeña:

```yaml
publish:
  environment: release
  permissions:
    id-token: write   # required for GitHub to mint the OIDC token
    contents: read
  steps:
    - name: NuGet login (OIDC to temp API key)
      uses: NuGet/login@v1
      id: login
      with:
        user: ${{ secrets.NUGET_USER }}   # nuget.org profile name, not your email
    - name: Push
      run: >
        dotnet nuget push artifacts/*.nupkg
        --api-key ${{ steps.login.outputs.NUGET_API_KEY }}
        --source https://api.nuget.org/v3/index.json
        --skip-duplicate
```

La configuración inicial es una política en nuget.org bajo Account, Trusted Publishing: propietario del repositorio, repositorio, nombre del archivo de workflow (`release.yml`, sin el prefijo `.github/workflows/`) y, opcionalmente, el nombre del entorno. GitLab también funciona, intercambiando un claim de `id_tokens` contra `POST https://www.nuget.org/api/v2/token`.

Un detalle que conviene conocer antes de noviembre: una política creada contra un repositorio privado de GitHub arranca **temporalmente activa durante 7 días**. Si no ocurre ninguna publicación en esa ventana, queda inactiva, porque nuget.org necesita los IDs de repositorio y propietario de un intercambio de token real para fijar la política contra ataques de resurrección. Registra la política y haz un push de prueba; no la registres y te vayas.

Si ya manejas una publicación de múltiples paquetes, el cableado está cubierto en [Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/). Si no, lo mínimo viable esta semana es auditar cuáles de tus pipelines siguen publicando con una key estática y confirmar que la cuenta de nuget.org que recibe los avisos de expiración es una que alguien lee de verdad.
