CREATE TABLE billing_import_cursors (
  source_name text PRIMARY KEY,
  etag text,
  last_modified text,
  last_import_id uuid REFERENCES doublezero_usage_imports(id) ON DELETE SET NULL,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
