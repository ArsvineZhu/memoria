use rusqlite::{Connection, OpenFlags};
use std::time::Duration;

pub(crate) fn open_sqlite_readonly(db_path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    configure_sqlite_connection(&conn, true)?;
    Ok(conn)
}

pub(crate) fn open_sqlite_readwrite(db_path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    configure_sqlite_connection(&conn, false)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(conn)
}

fn configure_sqlite_connection(conn: &Connection, readonly: bool) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_secs(30))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "query_only", if readonly { "ON" } else { "OFF" })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::configure_sqlite_connection;
    use rusqlite::Connection;

    #[test]
    fn readonly_connections_enable_foreign_keys_and_query_only() {
        let connection = Connection::open_in_memory().unwrap();
        configure_sqlite_connection(&connection, true).unwrap();

        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        let query_only: i64 = connection
            .query_row("PRAGMA query_only", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
        assert_eq!(query_only, 1);
    }
}
