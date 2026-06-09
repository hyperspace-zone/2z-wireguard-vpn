export function mustRow<T>(result: { rows: T[] }): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error("expected database row");
  }
  return row;
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}
