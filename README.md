# Enderland Discord Bot

Bot oficial de Enderland. Responde en español rioplatense, conoce rangos y reglas desde archivos locales, convierte precios a moneda local y usa Groq (llama-3.3-70b-versatile) con rotación de claves.

## Requisitos

- Node.js >= 18.17
- Cuenta en Discord y token de bot
- Claves de Groq (una o varias)

## Variables de entorno

Crear un archivo `.env` con:

```
DISCORD_TOKEN=tu_token_de_discord
GROQ_API_KEY=opcional_si_usas_una_sola
# o varias claves en cualquiera de estas formas:
GROQ_KEYS=gsk_xxx,gsk_yyy,gsk_zzz
# y/o
GROQ_API_KEY_2=gsk_yyy
GROQ_API_KEY_3=gsk_zzz
```

> Nunca subas `.env` al repositorio (está ignorado en `.gitignore`). En Render carga las variables en el panel.

## Scripts

- `npm install` – instala dependencias
- `npm start` – inicia el bot

## Despliegue en Render (Background Worker)

Este repo incluye `render.yaml` con un servicio `worker`:

1. Sube el repo a GitHub.
2. En Render, crea un servicio desde `render.yaml`.
3. En Variables de entorno de Render, agrega:
   - `DISCORD_TOKEN`
   - `GROQ_API_KEY` o `GROQ_KEYS` (o `GROQ_API_KEY_2`, etc.)
4. Build: `npm install` | Start: `npm start`.

## Comandos (solo canal permitido)

- `!ai <pregunta>` – consulta general (rango, reglas, precios con conversión, etc.).

Solo STAFF (rol configurado):

- `!status` – uptime, totales, latencias, cache.
\- `!keys` – estado de cada clave Groq (ok/cooldown/deshabilitada).
\- `!addgroqkey gsk_xxx` – agrega una clave en caliente.
\- `!rmgroqkey <últimos4|claveCompleta>` – remueve una clave.

## Archivos de datos

- `precios_rangos.txt` – fuente de precios/beneficios de rangos.
- `reglas vanilla.txt` – reglas de Vanilla.
- `reglas semianarquico.txt` – reglas de Semi‑Anárquico.

## Notas

- El bot solo responde en el canal permitido configurado en el código.
- Las respuestas usan formato escaneable (negritas) y tono argentino.
