export const migrationsTableName = "schema_migrations";

export interface DatabaseRuntimeConfig {
  connectionString: string;
  applicationName: string;
}
