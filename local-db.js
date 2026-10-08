// Postgres local de prueba (PGlite) para cuando no hay Supabase configurado. Solo para desarrollo.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export async function startLocalDb(dataDir) {
  const server = new PGLiteSocketServer({ db: await PGlite.create(dataDir), port: 0, maxConnections: 10 });
  await server.start();
  return `postgres://postgres:postgres@${server.getServerConn()}/postgres`;
}
