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
