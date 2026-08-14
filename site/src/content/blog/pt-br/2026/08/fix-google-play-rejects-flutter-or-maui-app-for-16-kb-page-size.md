---
title: "Solução: Google Play rejeita um app Flutter ou .NET MAUI por falta de suporte a páginas de memória de 16 KB"
description: "O Play rejeita o bundle porque um .so de 64 bits ainda tem segmentos ELF de 4 KB. Ache a biblioteca culpada, recompile com NDK r28+ e verifique com zipalign -P 16."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "maui"
  - "dotnet"
  - "dotnet-10"
  - "android"
  - "gradle"
lang: "pt-br"
translationOf: "2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size"
translatedBy: "claude"
translationDate: 2026-08-14
---

A rejeição quase nunca tem a ver com o seu código. O Google Play analisa as bibliotecas nativas de 64 bits do seu app bundle e bloqueia a publicação se alguma delas tiver segmentos `LOAD` do ELF alinhados em 4 KB (`0x1000`) em vez de 16 KB (`0x4000`). Tanto o engine do Flutter quanto o runtime do .NET para Android já publicam binários alinhados em 16 KB há um bom tempo, então o culpado quase sempre é um plugin de terceiros ou uma biblioteca de binding compilada com um NDK antigo. Encontre, atualize ou recompile, e então confirme com `zipalign -c -P 16 -v 4`.

## O erro em contexto

Ao enviar o bundle para o Play Console aparece uma mensagem que bloqueia a publicação, mais ou menos assim:

```
Your app's native libraries are not aligned to 16 KB.
Recompile your app with 16 KB native library alignment.

lib/arm64-v8a/libsomething.so
lib/arm64-v8a/libsomething_jni.so
```

O texto atual da própria documentação do Google não deixa dúvida sobre o escopo nem sobre a data:

> todos os apps que têm como alvo o Android 15 (API nível 35) ou superior precisam suportar páginas de memória de 16 KB em dispositivos de 64 bits no Google Play. A partir de 2027-02-01, se as atualizações do seu app não suportarem páginas de memória de 16 KB, você não vai conseguir publicar essas atualizações.

Vale conhecer o histórico, porque boa parte dos conselhos que ainda circulam cita datas defasadas: a exigência chegou originalmente em 2025-11-01 para apps novos e atualizações que tinham o Android 15+ como alvo, dava para pedir uma prorrogação até 2026-05-31, e o bloqueio definitivo de atualizações não conformes está agora em 2027-02-01, conforme o [guia de tamanhos de página do Android](https://developer.android.com/guide/practices/page-sizes).

## Por que uma biblioteca alinhada em 4 KB quebra em um dispositivo de 16 KB?

O Android historicamente assumiu uma página de memória de 4 KB. Dispositivos que saem com Android 15 ou superior podem usar uma página de 16 KB, o que reduz a pressão sobre a tabela de páginas e melhora de forma mensurável o tempo de inicialização do app. O linker dinâmico mapeia cada segmento `PT_LOAD` de uma biblioteca compartilhada em um endereço alinhado à página. Se o `p_align` do segmento é 4096 mas o tamanho de página do kernel é 16384, o carregador não consegue respeitar os limites do segmento e o `dlopen` falha. O usuário vê uma falha de instalação, ou uma inicialização que morre na hora em `System.loadLibrary`.

Na prática existem dois requisitos de alinhamento distintos, e confundir os dois é a maior fonte de confusão:

- **Alinhamento de segmentos ELF.** Todo segmento `PT_LOAD` dentro de cada `.so` precisa ter `p_align` de pelo menos 16384. Isso é uma propriedade de como a biblioteca foi compilada e linkada.
- **Alinhamento das entradas do zip.** Quando as bibliotecas nativas ficam armazenadas sem compressão no APK (`extractNativeLibs="false"`, o padrão em builds modernos), o linker as mapeia direto do APK. Portanto, as próprias entradas do zip precisam começar em um limite de 16 KB. Isso é uma propriedade de como o pacote foi montado.

Uma biblioteca pode passar em uma verificação e falhar na outra. O Play verifica as duas, e só para ABIs de 64 bits.

## Quais versões do Flutter e do .NET MAUI já estão em conformidade?

As duas toolchains estão em ordem há um tempo, e é por isso que o arquivo problemático normalmente é uma dependência.

**Flutter.** Olhando o SDK estável do Flutter 3.44.2 em disco (revisão do framework `c9a6c48`, engine `77e2e94`), o `packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt` fixa o NDK para o qual `flutter.ndkVersion` resolve:

```kotlin
// Flutter 3.44.2 stable, FlutterExtension.kt
val ndkVersion: String = "28.2.13676358"
```

Esse é o NDK r28, que emite segmentos alinhados em 16 KB por padrão. O `DependencyVersionChecker.kt` do mesmo SDK falha de forma dura abaixo do AGP 8.6.0 e avisa abaixo do AGP 8.11.1, enquanto o `gradle_utils.dart` carimba projetos novos com AGP 9.0.1 e Gradle 9.1.0. Tudo isso fica confortavelmente acima do AGP 8.5.1 que o Google indica como mínimo para o alinhamento correto de bibliotecas sem compressão. Um app com Flutter 3.44 está em conformidade por construção, a menos que um plugin arraste um `.so` velho.

**.NET MAUI.** O SDK do .NET para Android define o alinhamento do pacote de forma explícita. Do `Microsoft.Android.Sdk.DefaultProperties.targets` no `Microsoft.Android.Sdk.Windows` 36.1.53, a versão que vem com a workload do .NET 10:

```xml
<!-- Microsoft.Android.Sdk 36.1.53 (.NET 10) -->
<AndroidZipAlignment Condition=" '$(AndroidZipAlignment)' == '' ">16</AndroidZipAlignment>
```

O comentário ao redor informa que apenas os valores `4` e `16` são suportados. Então a metade do requisito relativa ao zip já vem resolvida por padrão, e você nunca deveria precisar definir essa propriedade na mão. Se você herdou um projeto que fixa `<AndroidZipAlignment>4</AndroidZipAlignment>`, apague a linha.

Para a metade do ELF, rodei uma verificação de alinhamento sobre as bibliotecas nativas dos packs de runtime do .NET 10 para Android nesta máquina (`Microsoft.Android.Runtime.*.36.1.53` e `Microsoft.NETCore.App.Runtime.Mono.android-arm64`). Todas as bibliotecas de runtime de 64 bits reportam `p_align` de `0x4000`: `libmonosgen-2.0.so`, `libmono-android.release.so`, `libnet-android.release.so`, `libSystem.Native.so`, `libSystem.Security.Cryptography.Native.Android.so`, `libxamarin-native-tracing.so` e as bibliotecas de componentes do Mono. Tanto a variante Mono quanto a CoreCLR estão limpas.

## Como verifico o alinhamento de 16 KB em um APK ou AAB?

O `check_elf_alignment.sh` do Google é um script bash, o que é desconfortável se você compila no Windows. A verificação no nível do zip vem com as build tools do Android e funciona em qualquer lugar:

```powershell
# Windows, Android build-tools 35.0.0 or newer
& "$env:LOCALAPPDATA\Android\sdk\build-tools\35.0.0\zipalign.exe" -c -P 16 -v 4 app-release.apk
```

Para um app bundle, o `bundletool` informa o alinhamento configurado:

```bash
bundletool dump config --bundle=app-release.aab
```

Nenhum dos dois inspeciona os cabeçalhos ELF, porém. Para verificar os segmentos em si, o NDK traz o `llvm-objdump`:

```bash
# ANDROID_NDK points at an r28 or newer installation
$ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-objdump -p libfoo.so | grep LOAD
```

Uma biblioteca em conformidade imprime `align 2**14`. Qualquer coisa em `2**12` ou `2**13` falha.

Se você prefere não depender de ter o NDK instalado, os cabeçalhos de programa são triviais de parsear direto. Este é o script que usei para auditar os packs de runtime do .NET acima, e ele roda em qualquer lugar onde o Python rode:

```python
# check_align.py - Python 3.9+, no dependencies
import glob, os, struct, sys

PT_LOAD = 1

def load_aligns(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"\x7fELF":
        return None
    is64 = data[4] == 2
    if is64:
        e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x36)[0]
        e_phnum = struct.unpack_from("<H", data, 0x38)[0]
    else:
        e_phoff = struct.unpack_from("<I", data, 0x1C)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x2A)[0]
        e_phnum = struct.unpack_from("<H", data, 0x2C)[0]
    aligns = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if struct.unpack_from("<I", data, off)[0] != PT_LOAD:
            continue
        fmt, delta = ("<Q", 0x30) if is64 else ("<I", 0x1C)
        aligns.append(struct.unpack_from(fmt, data, off + delta)[0])
    return is64, aligns

for pattern in sys.argv[1:]:
    for path in sorted(glob.glob(pattern, recursive=True)):
        result = load_aligns(path)
        if result is None:
            continue
        is64, aligns = result
        if not is64:
            continue  # Play only checks 64-bit ABIs
        worst = min(aligns) if aligns else 0
        status = "ALIGNED  " if worst >= 16384 else "UNALIGNED"
        print(f"{status} p_align={hex(worst)} {os.path.basename(path)}")
```

Descompacte o AAB ou o APK e aponte o script para o diretório da ABI de 64 bits:

```bash
unzip -q app-release.aab -d extracted
python check_align.py "extracted/**/lib/arm64-v8a/*.so"
```

As bibliotecas impressas como `UNALIGNED` são exatamente as que o Play vai listar.

## Como conserto um app Flutter desalinhado?

Comece identificando qual plugin é dono do arquivo. Procure no seu cache do pub e no APK compilado, e depois relacione o `.so` a um pacote:

```bash
flutter build apk --release
unzip -l build/app/outputs/flutter-apk/app-release.apk | grep "lib/arm64-v8a"
```

Assim que souber quem é o culpado, siga esta ordem:

1. **Atualize o plugin.** De longe a correção mais comum. A maioria dos pacotes mantidos recompilou seus binários durante 2025. Rode `flutter pub outdated`, suba a dependência problemática, recompile e verifique de novo.
2. **Atualize o SDK do Flutter e a toolchain do Android.** Confirme que você está no Flutter 3.32 ou mais novo, AGP 8.5.1 ou mais novo no `settings.gradle.kts`, e que usa `android { ndkVersion = flutter.ndkVersion }` em vez de uma string de NDK antiga fixada na mão. Um `ndkVersion = "25.1.8937393"` explícito e velho no `android/app/build.gradle.kts` derruba silenciosamente todo o resto.
3. **Recompile o código nativo você mesmo** se o plugin compila a partir do código-fonte e está travado no NDK r27 ou anterior. Adicione as opções de link no `CMakeLists.txt` dele:

   ```cmake
   target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
       "-Wl,-z,max-page-size=16384"
       "-Wl,-z,common-page-size=16384")
   ```

4. **Remova a dependência** se ela estiver abandonada. Um pacote sem manutenção com um `.so` pré-compilado em 4 KB e sem código-fonte é um bloqueio definitivo, e nenhuma flag de build do seu lado resolve. Faça um fork ou substitua.

## Como conserto um app .NET MAUI desalinhado?

O runtime do .NET 10 já está em conformidade, então olhe seus pacotes NuGet, e especificamente as bibliotecas de binding do Android que embutem um `.aar` ou um `.so` pré-compilado. SDKs de anúncios, de analytics, de pagamentos e runtimes de ML são os suspeitos de sempre.

```bash
# .NET 10, MAUI
dotnet publish -f net10.0-android -c Release
```

Depois descompacte o `.aab` resultante de `bin/Release/net10.0-android/publish/` e rode o verificador contra `base/lib/arm64-v8a/`. Quando uma biblioteca de binding é a culpada, a correção é atualizar o pacote NuGet para uma versão cujo `.aar` original tenha sido recompilado com NDK r28. Se não existir nenhuma, sobra reempacotar o `.aar` você mesmo com a biblioteca nativa recompilada, ou remover a dependência.

Duas coisas no nível do projeto que vale confirmar já que você está por lá. Garanta que você não desativou as bibliotecas nativas sem compressão, porque todo o mecanismo de alinhamento do zip depende disso, e garanta que você não continua mirando um SDK antigo de um jeito que mascara o problema localmente mas não no Play. Nenhuma das duas é uma má configuração comum, mas ambas produzem resultados confusos quando aparecem.

## E quanto a libc.so e às bibliotecas de 32 bits que meu verificador acusa?

Dois falsos positivos que vão te fazer perder tempo se você auditar o diretório errado. Os dois apareceram na hora quando escaneei os packs de runtime do .NET 10.

**Bibliotecas stub não são publicadas.** Os packs de runtime do Android contêm `libc.so`, `libdl.so`, `liblog.so`, `libm.so` e `libz.so` com `p_align = 0x1000`. São stubs DSO de tempo de link; as implementações reais vêm do dispositivo. Elas nunca entram no seu APK, então o alinhamento delas é irrelevante. É por isso que você precisa auditar o pacote compilado, e não uma pasta `obj/` ou um cache do NuGet.

**Bibliotecas de 32 bits estão isentas.** Todas as bibliotecas do pack de runtime `android-arm` (armeabi-v7a) reportam `0x1000`, e isso está correto e é permanente: um processo de 32 bits não tem modo de página de 16 KB para suportar. O Play só verifica as ABIs de 64 bits, e a própria verificação em tempo de build do SDK do .NET para Android faz o mesmo, com a mensagem de diagnóstico `Not a 64-bit ELF image.  Ignored.` Filtre seu scan para `arm64-v8a` e `x86_64`, exatamente como o script acima faz.

Se você quer provar a correção de ponta a ponta em vez de confiar no scan, crie um AVD a partir da imagem de sistema "Google APIs Experimental 16 KB Page Size" no SDK Manager, e então confirme que o emulador realmente usa páginas de 16 KB antes de instalar:

```bash
adb shell getconf PAGE_SIZE
```

Isso precisa imprimir `16384`. Um app que instala e inicia ali vai passar na verificação do Play.

## Relacionado

Se o build nem chega a produzir um bundle, a falha de fundo geralmente está em outro ponto da cadeia do Gradle: [a task assembleDebug do Gradle falhando com código de saída 1](/pt-br/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) e [Gradle build failed to produce an .apk file no MAUI Android](/pt-br/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) mostram como extrair o erro real de um log embrulhado. Um NDK ou componente do SDK faltando aparece como [flutter doctor reportando que o componente cmdline-tools está faltando](/pt-br/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), e conflitos nativos no nível de dependência costumam aparecer primeiro como um [conflito de AndroidX durante um build Android do Flutter](/pt-br/2026/05/fix-androidx-conflict-during-flutter-android-build/). Times que ainda estão na stack antiga vão esbarrar em tudo isso de uma vez durante a [migração de Xamarin.Forms para MAUI 11](/pt-br/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Fontes

- [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) (Android Developers), para o requisito, a data de 2027-02-01, as verificações com `zipalign` e `llvm-objdump`, e as opções de link para NDK r27 e anteriores.
- [Prepare your apps for Google Play's 16 KB page size compatibility requirement](https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html) (Android Developers Blog), para o anúncio original de 2025-11-01.
- [Preparing your .NET MAUI apps for Google Play's 16 KB page size requirement](https://devblogs.microsoft.com/dotnet/maui-google-play-16-kb-page-size-support/) (.NET Blog), para a orientação do lado .NET e as melhorias reportadas de inicialização e consumo.
- Fatos de versão e alinhamento medidos localmente contra o Flutter 3.44.2 stable e a workload do .NET 10 para Android (`Microsoft.Android.Sdk.Windows` e `Microsoft.Android.Runtime.*` 36.1.53).
