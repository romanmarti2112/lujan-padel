# Luján Pádel: reservas online

Node 22.13 o más nuevo, con la base de datos en Supabase (Postgres).

1. Copiá `.env.example` a `.env` y completá `DATABASE_URL` (en Supabase: botón **Connect** → **Transaction pooler**) y `ADMIN_PASSWORD`.
2. `npm install`
3. `npm start` → web en http://localhost:3000, panel en http://localhost:3000/admin

Las tablas se crean solas la primera vez, en el esquema `lujan_padel`. Ese esquema no choca con otra app que use el mismo proyecto y no aparece en la API pública de Supabase.

- Pago: el cliente transfiere por Mercado Pago al alias `lujanpadelclub` y manda el comprobante por WhatsApp. La reserva queda "pendiente" hasta que el admin la marca como "pagado". Si en 30 minutos no se marcó, vence y el turno vuelve a quedar libre (el admin igual puede recuperarla si el turno sigue libre).
- Turnos fijos: se cargan en el panel y ocupan ese día y horario todas las semanas. Las reservas manuales y los fijos no vencen.
- Paletas: el cliente elige de 0 a 4 al reservar; el precio por paleta se cambia en el panel.
- Pruebas: `npm test`. Usan un esquema temporal que se borra al terminar.

## Publicar en Vercel

1. En Vercel: **Add New → Project** → importá este repo (`lujan-padel`). Application Preset: **Node**; no cambies los comandos de build (Output Directory: `public`).
2. En **Environment Variables** cargá `DATABASE_URL` (la del Transaction pooler de Supabase, con la contraseña) y `ADMIN_PASSWORD`.
3. **Deploy**. La web queda en `https://<tu-proyecto>.vercel.app` y el panel en `/admin`.

Vercel sirve `public/` como estático y manda el resto (`/api/*`) a `server.js`, que exporta el handler. `vercel.json` corre la función en `cle1` (Cleveland), al lado de la base de Supabase en `us-east-2`.

## Seguridad

- **Secretos:** `DATABASE_URL` y `ADMIN_PASSWORD` van solo en `.env` (local) y en las variables de entorno de Vercel. `.gitignore` excluye cualquier `.env*` menos `.env.example`, que nunca lleva valores reales.
- **Panel:** la clave tiene que tener 12 caracteres o más (si no, el servidor no arranca). Hay 5 intentos fallidos cada 15 minutos por conexión. La sesión es una cookie `HttpOnly`, `Secure` y `SameSite=Strict`, firmada con una clave derivada con scrypt. Si se cambia `ADMIN_PASSWORD`, se cierran todas las sesiones.
- **Base de datos:** las tablas están en el esquema `lujan_padel`, que no está expuesto por la API de Supabase. Tienen RLS sin políticas, y los roles `anon` y `authenticated` no tienen acceso. Todas las consultas usan parámetros.
- **Navegador:** hay Content-Security-Policy (sin scripts inline), `X-Frame-Options: DENY`, HSTS y `nosniff`, tanto desde `server.js` como desde `vercel.json`. Todo dato de usuario se escapa antes de mostrarlo.
- **Abuso:** se permiten 2 reservas sin pagar por teléfono y 4 reservas por hora por conexión. La IP se guarda solo como huella HMAC.
