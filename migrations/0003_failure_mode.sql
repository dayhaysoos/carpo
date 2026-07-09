ALTER TABLE clips ADD COLUMN failure_mode TEXT CHECK (
  failure_mode IS NULL OR failure_mode IN ('confirmed', 'ambiguous')
);
