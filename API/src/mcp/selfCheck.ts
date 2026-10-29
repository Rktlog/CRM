import type { Db } from './db.js';

// Run once at start-up. If the database login this server was given can do anything but read, it refuses to start: the usual cause is the project owner's
// connection string being pasted in by mistake, which would hand Claude far more than the ordering data.
export async function assertReadOnlyLogin(db: Db): Promise<string> {
  return db.withClient(async c => {
    const me = (await c.query(`select current_user as u, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls from pg_roles r where r.rolname = current_user`)).rows[0];
    if (!me) throw new Error('Could not look up the database login.');
    if (me.rolsuper || me.rolcreatedb || me.rolcreaterole || me.rolbypassrls) throw new Error(`The database login "${me.u}" has powers beyond reading (superuser, create-database, create-role or bypass-row-security). Use the read-only user from radar-readonly-role.sql.`);
    const writes = (await c.query(`select count(*)::int as n from information_schema.role_table_grants where grantee = current_user and privilege_type <> 'SELECT'`)).rows[0];
    const columnWrites = (await c.query(`select count(*)::int as n from information_schema.role_column_grants where grantee = current_user and privilege_type <> 'SELECT'`)).rows[0];
    if (Number(writes.n) > 0 || Number(columnWrites.n) > 0) throw new Error(`The database login "${me.u}" can change data. Use the read-only user from radar-readonly-role.sql.`);
    return String(me.u);
  });
}
