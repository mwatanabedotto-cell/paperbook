# Paperbook

Visor de documentos para tablet y computadora: guarda PDF, páginas web e imágenes, escribe encima
como en un lienzo y sincroniza todo con tu Google Drive. Es una aplicación web instalable (PWA),
sin servidor propio y sin paso de compilación.

## Qué hace

- **Biblioteca**: PDF, imágenes, páginas web guardadas y lienzos en blanco. Búsqueda, filtros por tipo y carpetas.
- **Búsqueda**: el buscador de la biblioteca encuentra palabras dentro de los PDF y páginas web (sin
  distinguir acentos ni mayúsculas) y abre el documento en la primera coincidencia. Dentro del visor,
  la lupa o Ctrl+F resalta y recorre los resultados. Los PDF escaneados (solo imagen) no tienen texto que buscar.
- **Lienzo sobre cualquier documento**: bolígrafo (sensible a la presión del lápiz), resaltador, borrador,
  línea, flecha, rectángulo, elipse y texto. Colores, grosor, deshacer/rehacer y zoom.
- **Lienzos en blanco**: papel liso, rayado, cuadriculado o de puntos; páginas ilimitadas.
- **Lápiz y dedo**: al detectar un lápiz, el lápiz dibuja y el dedo desplaza. Con el dedo dibujando,
  dos dedos mueven y hacen zoom. Se cambia en el menú «⋯» del visor.
- **Sin conexión**: los documentos se guardan en el dispositivo (IndexedDB) y la app funciona offline.
- **Google Drive**: documentos y anotaciones se guardan en la carpeta «Paperbook» de tu Drive. Las
  anotaciones hechas en dos dispositivos a la vez se fusionan trazo a trazo, sin perder ninguna.
- **Recuerda** la última página leída de cada documento.
- **Exporta** una página con sus anotaciones como imagen PNG.

## Publicarla (GitHub Pages)

Google solo permite iniciar sesión desde una dirección `https://`, así que la app debe estar publicada:

1. En GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**.
2. Elige la rama que contiene estos archivos y la carpeta `/ (root)`. Guarda.
3. En un par de minutos estará en `https://mwatanabedotto-cell.github.io/paperbook/`.
   (En repositorios privados, Pages requiere un plan de pago de GitHub.)
4. En la tablet o computadora, abre esa dirección y pulsa **Instalar app** (arriba, junto a «Conectar Drive»).
   En iPad/iPhone: Safari → Compartir → «Añadir a pantalla de inicio».

Instalada, se abre a pantalla completa con su propio icono, funciona sin conexión y, en computadora y
Android, aparece en «Abrir con» para los PDF y en «Compartir» desde el navegador.

Para probarla en local: `python3 -m http.server 8000` y abre `http://localhost:8000`.

## Instaladores (Android, Windows, Linux)

Página de descarga: [`descargar.html`](descargar.html) (publicada en
<https://mwatanabedotto-cell.github.io/paperbook/descargar.html> cuando Pages esté activo).

Cada cambio en el repositorio compila los instaladores y los publica en
<https://github.com/mwatanabedotto-cell/paperbook/releases/tag/descargas>:

| Sistema | Archivo | Notas |
| --- | --- | --- |
| Android | `Paperbook-Android.apk` | Al abrirlo, Android pedirá permitir «instalar apps desconocidas». |
| Windows | `Paperbook-Setup-Windows.exe` | Instalador. No está firmado: en el aviso de SmartScreen pulsa «Más información → Ejecutar de todas formas». También hay `Paperbook-Portable-Windows.exe`, que no se instala. |
| Linux | `Paperbook-linux-x86_64.AppImage` | `chmod +x` y doble clic. En Debian/Ubuntu también `Paperbook-linux-amd64.deb`. |

**Windows y Linux** llevan la app completa dentro: funcionan sin publicar nada y sin conexión.
Además guardan páginas web directamente, sin proxy.

**Android** es una «Trusted Web Activity»: abre la versión publicada en GitHub Pages a pantalla
completa usando Chrome, así que **primero hay que publicarla** (sección anterior). Tras la primera
apertura funciona sin conexión. Mientras el dominio no esté verificado, Chrome muestra una barra
fina con la dirección arriba; para quitarla, crea un repositorio público llamado
`mwatanabedotto-cell.github.io` con un archivo vacío `.nojekyll` y este `.well-known/assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "app.paperbook.twa",
    "sha256_cert_fingerprints": ["1E:55:C1:97:F1:9F:67:7A:66:30:97:F5:51:4D:66:E6:68:F3:4E:38:69:5D:5B:FA:6C:07:58:92:F8:48:18:8E"]
  }
}]
```

El APK se firma con la clave `android/app/paperbook.keystore`, incluida en el repositorio para que
las versiones nuevas se instalen encima de las anteriores. Vale para uso personal; para publicar en
una tienda, sustitúyela por una clave privada.

## Emparejar dispositivos con un código

La forma más sencilla de sincronizar, sin cuentas ni configuración:

1. En un dispositivo: **Sincronizar → Mostrar un código**.
2. En el otro: **Sincronizar → Tengo un código**, escribe las 6 cifras y pulsa **Conectar**.
3. De vuelta en el primero, pulsa **Aceptar**.

Desde entonces se sincronizan solos (documentos, anotaciones, cambios de nombre y borrados) cada vez
que los dos tienen Paperbook abierto a la vez. El emparejamiento se recuerda; se pueden añadir más
dispositivos con «Añadir otro dispositivo».

Cómo funciona y límites:

- Los datos viajan cifrados directamente de un dispositivo al otro (WebRTC). Un servidor público
  gratuito de PeerJS (`0.peerjs.com`) solo ayuda a que se encuentren; no recibe los documentos.
- **No hay copia en la nube**: si un dispositivo se pierde, queda lo que haya en los otros.
- Solo sincroniza con los dos abiertos a la vez. En algunas redes restrictivas (hospital,
  universidad) la conexión directa puede no establecerse.
- El código sirve una sola vez y solo mientras está en pantalla, y el primer dispositivo debe
  aceptar la conexión.

## Pasar todo con un archivo de copia

Botón **Sincronizar** → **Guardar copia**. Se genera un archivo `.paperbook` con tus documentos y
anotaciones; súbelo a tu Drive (o pásalo como quieras) y en el otro dispositivo pulsa
**Sincronizar → Cargar copia** y elígelo. Lo cargado se combina con lo que ya hay: no borra nada y
las anotaciones de ambos lados se conservan.

- **Copia completa**: incluye los PDF, imágenes y páginas. Úsala la primera vez.
- **Solo anotaciones y lienzos**: archivo pequeño para el día a día, cuando los documentos ya están en
  los dos dispositivos.

La sección siguiente explica la sincronización automática, que es más cómoda pero requiere crear una
credencial de Google una vez. Si pegas ese ID en `js/config.js`, en cada dispositivo bastará un toque.

## Sincronizar con Google Drive

La app habla directamente con tu Drive, sin servidor intermedio. Para eso Google exige un
«ID de cliente OAuth» propio, que se crea gratis una sola vez:

1. Entra en <https://console.cloud.google.com/> y crea un proyecto (por ejemplo «Paperbook»).
2. **APIs y servicios → Biblioteca**: busca **Google Drive API** y pulsa **Habilitar**.
3. **APIs y servicios → Pantalla de consentimiento de OAuth** (o «Google Auth Platform»): tipo **Externo**,
   pon un nombre y tu correo. En **Usuarios de prueba**, añade tu propia cuenta de Google.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web**.
   En **Orígenes autorizados de JavaScript** añade `https://mwatanabedotto-cell.github.io`
   (y `http://localhost:8000` si la usas en local).
5. Copia el **ID de cliente** (termina en `.apps.googleusercontent.com`).
6. En Paperbook pulsa **Conectar Drive**, pega el ID y pulsa **Conectar con Google**.
   Repite este último paso en cada dispositivo, con el mismo ID.

**En la app de escritorio (Windows/Linux)** el inicio de sesión se hace en tu navegador y necesita
otro tipo de credencial del mismo proyecto: **Credenciales → Crear credenciales → ID de cliente de
OAuth → App de escritorio**. Copia el **ID de cliente** y el **secreto del cliente** y pégalos en
«Conectar Drive». Solo se inicia sesión una vez. Al estar en el mismo proyecto, ve los mismos
archivos que la tablet.

La app pide el permiso mínimo (`drive.file`): solo puede ver los archivos que ella misma crea, no el
resto de tu Drive. Por eso los PDF que ya tienes en Drive hay que añadirlos desde la app
(«Añadir → Subir archivos»).

En Drive, cada documento son dos archivos: el original (`.pdf`, `.html`, imagen) y un
`.paperbook.json` con el título, la carpeta y las anotaciones.

## Guardar páginas web

«Añadir → Guardar página web» descarga la página, le quita los scripts e incrusta imágenes y estilos
para leerla sin conexión. Limitaciones:

- Los navegadores impiden descargar páginas de otros sitios, así que cuando la descarga directa falla
  se usa un proxy público (`api.allorigins.win` por defecto, configurable o desactivable en el diálogo
  de Drive/ajustes). Ese proxy ve la dirección de la página que guardas.
- Las páginas que requieren iniciar sesión o que se construyen con JavaScript no se capturan bien.
  Alternativa fiable: en el navegador, «Imprimir → Guardar como PDF», y sube el PDF.
- En Android, con la app instalada, puedes usar «Compartir → Paperbook» desde el navegador.

## Estructura

```
index.html, css/app.css     interfaz
js/app.js                   biblioteca, importación, navegación
js/viewer.js                visor y herramientas de dibujo
js/ink.js                   motor de tinta (dibujo y borrado de trazos)
js/store.js                 almacenamiento local y fusión de anotaciones
js/drive.js                 sincronización con Google Drive
js/web.js                   captura de páginas web
js/p2p.js                   sincronización directa entre dispositivos emparejados
js/backup.js                archivo de copia y fusión de documentos recibidos
js/search.js                índice de texto para la búsqueda
sw.js                       funcionamiento sin conexión
vendor/pdfjs/               PDF.js 4.10 (Mozilla, licencia Apache 2.0)
desktop/                    app de escritorio (Electron) para Windows y Linux
android/                    proyecto del APK (Trusted Web Activity)
.github/workflows/build.yml compila y publica los instaladores
```
