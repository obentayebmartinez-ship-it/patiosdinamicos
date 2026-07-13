# Patios Dinámicos · La Rioja

Plataforma de dos capas para que centros educativos de La Rioja implementen y
monitoricen **patios dinámicos** (recreos organizados por zonas temáticas), y para
que el equipo de orientación regional estudie el impacto agregado en convivencia
y bienestar.

**Estado actual (MVP completo + nube opcional):** todos los módulos funcionan en
[index.html](index.html) (archivo autónomo sin build) con persistencia en
localStorage, que sigue siendo el almacén de trabajo (la app funciona offline
en el patio). Con la nube configurada (Supabase) y una cuenta de centro, cada
cambio local se replica y todos los dispositivos del centro ven lo mismo; con
la cuenta de orientación regional, las vistas de la red muestran los centros y
datos reales en vez de la demo.

## Cómo ejecutarlo

Aplicación estática sin build. Las librerías (Leaflet, Leaflet.draw, leaflet-rotate,
turf.js) y las fuentes van incluidas en `lib/` — **la app funciona sin internet**;
solo el fondo del mapa (ortofoto PNOA del IGN, Catastro por WMS, sin API key) y las
búsquedas necesitan conexión.

- Servidor estático: `python -m http.server 8123` (o `npx http-server -p 8123 .`).
- Doble clic en `index.html` también funciona (sin service worker).

Es una **PWA**: servida por https (o localhost) se puede "instalar" en el móvil
(menú del navegador → *Añadir a pantalla de inicio*) y abre a pantalla completa,
incluso sin cobertura en el patio.

**⚠️ Al publicar cualquier cambio** en `index.html` o `lib/`, subir el número de
`VERSION` en [sw.js](sw.js) — si no, los dispositivos con la app instalada pueden
tardar en ver la versión nueva.

## Despliegue estático (sin backend)

No hay build: basta con servir la carpeta. Flujo recomendado (igual que otros
proyectos del equipo, git → Vercel):

1. Repo git en esta carpeta (`git init` ya hecho) y subir a GitHub.
2. En [vercel.com](https://vercel.com) → *Add New Project* → importar el repo.
   Framework *Other*, sin comando de build, directorio de salida `./`.
3. Cada `git push` redespliega. GitHub Pages también sirve (Settings → Pages →
   rama main, carpeta raíz).

Cada dispositivo guarda sus propios datos (localStorage). Para mover datos entre
dispositivos: **Guardar y compartir → Descargar copia completa / Restaurar copia**.

## Módulo 1: editor de patio

- Búsqueda con autocompletado sobre el directorio real de centros escolares de
  La Rioja (OpenStreetMap/Overpass, cacheado 30 días) + Nominatim para
  direcciones, y geolocalización. Capa opcional de parcelas del Catastro para
  trazar el perímetro cuando el arbolado tapa el patio.
- Dibujo del perímetro del patio y de zonas temáticas (deportiva, lectura y calma,
  juegos cognitivos, creativa, otra) sobre vista satélite.
- Validación con turf.js: contención de cada zona en el perímetro (tolerancia 1 %),
  aviso de solapes entre zonas (umbral 1 m²), área en m²/ha.
- "Dividir en N sectores": corta el perímetro en franjas de área similar
  (búsqueda binaria sobre la longitud) como punto de partida editable.
- Guardado en localStorage, exportación/importación de GeoJSON, vista de solo
  lectura "hoy" imprimible con la actividad de cada zona.

## Nube (Supabase)

La app trabaja siempre contra localStorage (offline primero); la nube es una
**réplica sincronizada**: cada cambio local se encola en un *outbox* persistente
y se sube cuando hay conexión; al entrar con la cuenta o pulsar "Sincronizar
ahora" se baja el estado de la nube. Todo el código está en `index.html`
(buscar `NUBE`); sin configurar, la app queda exactamente como antes.

### Puesta en marcha (una vez)

1. Crear un proyecto en [supabase.com](https://supabase.com) (plan gratuito vale).
2. En **SQL Editor**, pegar y ejecutar [supabase/schema.sql](supabase/schema.sql)
   completo (tablas + RLS; es idempotente).
3. En **Authentication → Sign In / Up**: desactivar *Allow new users to sign up*
   (las cuentas las crea orientación regional, no hay registro público).
4. En **Authentication → Users → Add user**: crear las cuentas (email +
   contraseña) y ligarlas a su centro con los `insert` comentados al final de
   `schema.sql` (rol `centro` con `centro_id`; rol `admin` sin centro).
5. En **Settings → API**, copiar la *Project URL* y la clave *anon/public* y
   pegarlas en `index.html` en las constantes `NUBE_URL` y `NUBE_CLAVE_ANON`
   (la clave anon es pública por diseño: la seguridad la pone el RLS).
6. Publicar y **subir `VERSION` en sw.js**.

En el primer inicio de sesión de un centro cuya nube está vacía, la app ofrece
"⬆️ Subir este dispositivo" para volcar todo lo local (este es el traspaso que
antes se hacía con la copia completa).

### Solicitudes de cuenta

En el cuadro de acceso, un centro interesado puede pulsar **"Solicitar una
cuenta"** y rellenar un formulario (centro, contacto, correo, mensaje). La
petición se guarda en la tabla `solicitudes_cuenta` — cualquiera puede crearla
sin estar autenticado, pero solo el rol admin puede leerla. El admin las ve en
la vista **🗂️ Centros** ("Solicitudes de cuenta pendientes"), crea la cuenta a
mano (Authentication → Users + inserts de `centros`/`usuarios`) y pulsa
**✓ Atendida**. El rol admin (orientación regional) es el panel de investigación
privado; los centros solo usan su propia cuenta.

### Esquema y decisiones

- El esquema vive en [supabase/schema.sql](supabase/schema.sql): `centros`,
  `usuarios`, `patios`, `incidencias`, `ocupaciones`, `encuestas`,
  `sesiones_encuesta`.
- El patio se guarda como el **GeoJSON completo en jsonb** (y la rotación como
  documento jsonb) en vez de geometrías PostGIS normalizadas: la app hace todos
  los cálculos con turf en el cliente y así el documento viaja íntegro y sin
  conversiones. Si algún análisis futuro necesita SQL espacial, se puede añadir
  una columna `geometry` generada sin tocar la app.
- Los ids los genera el cliente (texto corto con azar) para poder crear
  registros offline; por eso las claves primarias son `(centro_id, id)` y las
  subidas son `upsert` (reintentables sin duplicar).
- Los borrados en la app borran también en la nube; restaurar una copia
  completa sustituye igualmente el contenido de la nube del centro.

### Cuentas, roles y RLS

- **centro**: ve y edita solo las filas de su `centro_id` (vía tabla `usuarios`
  y funciones `mi_centro()` / `soy_admin()`, `security definer` para evitar
  recursión de políticas).
- **admin** (orientación regional): `select` sobre todas las tablas — que ya
  son agregadas por diseño (curso/grupo, nunca alumnado individual) — y
  gestión de la tabla `centros`. Para la fase de investigación formal se
  añadirán vistas agregadas con mínimo k por celda.
- Las encuestas son anónimas: no llevan ningún identificador de persona.

## Protección de datos (decisión de diseño, no negociable)

- Ningún formulario registra datos identificables de alumnado individual; la
  granularidad mínima es curso/grupo.
- Todos los datos mock son ficticios (CEIP Valdemontes, IES Cierzo Alto,
  CRA Los Sotos — no existen).
- Al nivel regional solo suben agregados anonimizados.

## Hoja de ruta

1. ✅ **Fase 1:** editor de patio con mapa (este entregable).
2. ✅ **Rotación semanal:** editor grupos × días × zonas con generación
   automática round-robin; alimenta la vista de hoy y el cartel imprimible.
3. ✅ **Registro rápido de incidencias:** formulario móvil de 4 toques
   (zona en mini-plano táctil, tipo, curso agregado, gravedad + nota opcional),
   lista del día con borrado, layout responsive (nav horizontal en <700px).
4. ✅ **Encuestas de bienestar:** cuestionario anónimo con escala de pictogramas
   (alumnado, 5 ítems + curso agregado) y de acuerdo (profesorado, 6 ítems),
   con resumen del trimestre en vivo.
5. ✅ **Panel del centro:** KPIs (incidencias hoy / 7 días con delta, bienestar
   por colectivo del trimestre) y gráficos con los datos reales — incidencias por
   zona, por día (14 días), por tipo y gravedad; cada gráfico con vista de tabla.
6. ✅ **Panel regional (demo):** 3 centros ficticios con series inventadas —
   comparativa anonimizada por defecto (toggle de nombres), series temporales de
   incidencias/100 alumnos y participación, bienestar por trimestre, filtros
   etapa/ruralidad/tamaño (los colores siguen al centro, no al filtro),
   exportación CSV real; PDF queda para fase 2.
7. ✅ **Recuento rápido de ocupación:** un toque por zona (vacía/poca/media/llena)
   durante la guardia; KPI y gráfico de ocupación media por zona en el panel.
8. ✅ **Pulido piloto:** franja horaria en incidencias (preseleccionada por hora),
   buscador de centros con directorio real, capa Catastro, informe regional
   imprimible (guardar como PDF), multi-patio con copia completa para traspaso
   entre dispositivos.
9. ✅ **Robustez pre-Supabase:** PWA instalable y offline (librerías y fuentes en
   `lib/`, service worker), autoguardado del patio y de la rotación (sin botones
   de guardar), borrados en dos toques con "Deshacer" en registros, historial de
   incidencias navegable por fecha, cruce ocupación × incidencias por zona con
   lectura automática, medias por pregunta de las encuestas, exportación CSV del
   panel del centro, ids únicos, escapado de textos libres.
10. ✅ **Pase de encuestas por kiosco y papel:** modo kiosco a pantalla completa
    (el dispositivo pasa de mano en mano; contador visible; cerrar requiere
    pulsación mantenida) y formulario de papel imprimible con volcado de
    recuentos por carita (se convierten en filas individuales con medias
    exactas, marcadas `metodo:'papel'`). Anti dobles envíos: cada pase queda
    registrado como **sesión por curso y trimestre** (la encuesta es anónima,
    así que el control es por curso, no por persona); al repetir curso la app
    avisa y pide confirmación.
11. ✅ **Nube (Supabase):** auth por centro con RLS, sincronización offline con
    outbox (localStorage sigue siendo el almacén de trabajo), subida inicial del
    dispositivo, y datos reales para el rol admin en "Centros y patios" y en el
    panel regional (sustituyen a la demo cuando existen). Queda para después:
    vistas agregadas k-anónimas para investigación formal y realtime.
