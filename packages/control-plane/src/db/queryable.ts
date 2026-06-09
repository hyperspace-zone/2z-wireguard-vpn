export interface Queryable {
  query<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export interface TransactionalQueryable extends Queryable {
  transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
}
