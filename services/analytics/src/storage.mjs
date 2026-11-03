export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - count);
  return utcDay(date);
}

// Both statements execute in one D1 transaction. Unique keys, rather than a
// read-before-write check, make concurrent launches safe and idempotent.
export async function recordLaunch(db, event, day) {
  await db.batch([
    db.prepare(`INSERT INTO installations (installation_id, first_seen, last_seen, version, arch)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (installation_id) DO UPDATE SET
        last_seen = excluded.last_seen, version = excluded.version, arch = excluded.arch
      WHERE installations.last_seen < excluded.last_seen
        OR (installations.last_seen = excluded.last_seen AND
          (installations.version <> excluded.version OR installations.arch <> excluded.arch))`)
      .bind(event.installationId, day, day, event.version, event.arch),
    db.prepare(`INSERT INTO daily_activity (day, installation_id, version, arch)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (day, installation_id) DO UPDATE SET
        version = excluded.version, arch = excluded.arch
      WHERE daily_activity.version <> excluded.version OR daily_activity.arch <> excluded.arch`)
      .bind(day, event.installationId, event.version, event.arch),
  ]);
}

export async function readStats(db, day) {
  const week = daysAgo(day, 6);
  const month = daysAgo(day, 29);
  const result = await db.batch([
    db.prepare('SELECT COUNT(*) AS count FROM installations'),
    db.prepare(`SELECT
        COUNT(DISTINCT CASE WHEN day = ? THEN installation_id END) AS dau,
        COUNT(DISTINCT CASE WHEN day >= ? THEN installation_id END) AS active7,
        COUNT(DISTINCT installation_id) AS active30
      FROM daily_activity WHERE day >= ? AND day <= ?`).bind(day, week, month, day),
    db.prepare(`SELECT day, COUNT(*) AS count FROM daily_activity
      WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`).bind(month, day),
    db.prepare(`SELECT version, COUNT(*) AS count FROM installations
      GROUP BY version ORDER BY count DESC, version`),
    db.prepare(`SELECT arch, COUNT(*) AS count FROM installations
      GROUP BY arch ORDER BY count DESC, arch`),
  ]);
  const dailyCounts = new Map(result[2].results.map(row => [row.day, row.count]));
  return {
    date: day,
    totalInstallations: result[0].results[0].count,
    ...result[1].results[0],
    daily: Array.from({ length: 30 }, (_, index) => {
      const date = daysAgo(day, 29 - index);
      return { day: date, count: dailyCounts.get(date) ?? 0 };
    }),
    versions: result[3].results,
    architectures: result[4].results,
  };
}

export async function pruneActivity(db, day) {
  // Lifetime installation totals remain; only daily membership is pruned.
  await db.prepare('DELETE FROM daily_activity WHERE day < ?').bind(daysAgo(day, 34)).run();
}
