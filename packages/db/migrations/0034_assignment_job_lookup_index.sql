CREATE INDEX IF NOT EXISTS jobs_assignment_type_operation_phase_idx
  ON jobs (assignment_id, type, ((payload->>'operation')), phase)
  WHERE assignment_id IS NOT NULL;
